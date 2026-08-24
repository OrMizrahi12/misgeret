import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { DATABASE_SCHEMA_VERSION, FinanceDb } from './db.js';
import { startServer } from './runtime.js';
import { MockScraper } from './scraper.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-runtime-'));
}

interface StoredRegistry {
  version: number;
  activeId: string;
  profiles: Array<{ id: string; name: string; order: number }>;
}

function readRegistry(dataDir: string): StoredRegistry {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')) as StoredRegistry;
}

function profilePath(dataDir: string, id: string, ...rest: string[]): string {
  return path.join(dataDir, 'profiles', id, ...rest);
}

/** Writes the pre-multi-profile layout: a live database at the dataDir root. */
function seedLegacyDatabase(dataDir: string, options: { unversioned?: boolean } = {}): void {
  const dbPath = path.join(dataDir, 'finance.db');
  const initial = new FinanceDb(dbPath);
  initial.setSetting('marker', 'legacy');
  initial.close();
  if (options.unversioned) {
    const raw = new Database(dbPath);
    raw.pragma('user_version = 0');
    raw.close();
  }
}

describe('embedded runtime', () => {
  test('uses a dynamic loopback port and exposes a version handshake', async () => {
    const dataDir = tempDir();
    const handle = await startServer({
      dataDir,
      clientDist: path.join(dataDir, 'missing-client'),
      port: 0,
      appVersion: '1.2.3',
      buildId: 'build-test',
      apiToken: 'a'.repeat(64),
      scraper: new MockScraper(),
    });
    const activeId = handle.runtime.activeProfileId;
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.origin).toBe(`http://127.0.0.1:${handle.port}`);
      expect((await fetch(`${handle.origin}/api/runtime`)).status).toBe(401);
      const response = await fetch(`${handle.origin}/api/runtime`, {
        headers: { authorization: `Bearer ${'a'.repeat(64)}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        appVersion: '1.2.3',
        buildId: 'build-test',
        apiSchemaVersion: 1,
        dbSchemaVersion: DATABASE_SCHEMA_VERSION,
        activeProfileId: activeId,
        initialization: 'ready',
      });
      await request(handle.app)
        .get('/api/runtime')
        .set('Host', 'evil.example')
        .set('Authorization', `Bearer ${'a'.repeat(64)}`)
        .expect(403, { errorType: 'FORBIDDEN_HOST' });
      await request(handle.app)
        .get('/api/runtime')
        .set('Host', `127.0.0.1:${handle.port}`)
        .set('Origin', 'https://evil.example')
        .set('Authorization', `Bearer ${'a'.repeat(64)}`)
        .expect(403, { errorType: 'FORBIDDEN_ORIGIN' });
    } finally {
      await handle.close();
    }

    // Resolved from the registry, never guessed: `new FinanceDb` creates the file it is handed,
    // so asserting against <dataDir>/finance.db would silently check a brand-new empty database.
    expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
    const reopened = new FinanceDb(profilePath(dataDir, readRegistry(dataDir).activeId, 'finance.db'));
    expect(reopened.quickCheck()).toEqual(['ok']);
    reopened.close();
  });

  test('web development remains tokenless when security is not configured', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      expect((await fetch(`${handle.origin}/api/status`)).status).toBe(200);
    } finally {
      await handle.close();
    }
  });

  test('a fresh install boots onto one active profile named ראשי', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const registry = readRegistry(dataDir);
      expect(registry.profiles).toHaveLength(1);
      expect(registry.profiles[0]!.name).toBe('ראשי');
      expect(registry.activeId).toBe(registry.profiles[0]!.id);
      expect(handle.runtime.activeProfileId).toBe(registry.activeId);
    } finally {
      await handle.close();
    }
  });

  test('adopts the legacy layout into the first profile and backs it up before upgrading', async () => {
    const dataDir = tempDir();
    seedLegacyDatabase(dataDir, { unversioned: true });
    fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'backups', 'finance-2026-01-01-00-00-00-000.db'), 'old-backup');

    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const registry = readRegistry(dataDir);
      expect(registry.profiles).toHaveLength(1);
      expect(registry.profiles[0]!.name).toBe('ראשי');
      const id = registry.profiles[0]!.id;
      expect(registry.activeId).toBe(id);

      // The move is proven, not assumed.
      expect(fs.existsSync(profilePath(dataDir, id, 'finance.db'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);

      // The legacy backup history follows its profile, and the empty root directory is gone.
      expect(fs.existsSync(profilePath(dataDir, id, 'backups', 'finance-2026-01-01-00-00-00-000.db'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);

      const backups = fs.readdirSync(profilePath(dataDir, id, 'backups'))
        .filter((file) => /^auto-migration-finance-[\d-]+\.db$/.test(file));
      expect(backups).toHaveLength(1);

      expect(handle.db.getSetting('marker')).toBe('legacy');
      expect(handle.db.getSchemaVersion()).toBe(DATABASE_SCHEMA_VERSION);
    } finally {
      await handle.close();
    }
  });

  test('honors DB_PATH as the legacy source and names the adopted database finance.db', async () => {
    const dataDir = tempDir();
    const legacyDbPath = path.join(dataDir, 'smoke.db');
    const initial = new FinanceDb(legacyDbPath);
    initial.setSetting('marker', 'sandbox');
    initial.close();

    const handle = await startServer({
      dataDir,
      dbPath: legacyDbPath,
      clientDist: path.join(dataDir, 'missing-client'),
      scraper: new MockScraper(),
    });
    try {
      const id = readRegistry(dataDir).activeId;
      expect(fs.existsSync(profilePath(dataDir, id, 'finance.db'))).toBe(true);
      expect(fs.existsSync(legacyDbPath)).toBe(false);
      expect(handle.db.getSetting('marker')).toBe('sandbox');
    } finally {
      await handle.close();
    }
  });

  test('resumes an interrupted migration into the same profile id', async () => {
    const dataDir = tempDir();
    seedLegacyDatabase(dataDir);
    fs.writeFileSync(path.join(dataDir, 'credentials.enc'), Buffer.from('phase-1-dpapi-blob'));

    // The crash window: the directory and the backups moved, the registry write never landed.
    const id = randomUUID();
    fs.mkdirSync(profilePath(dataDir, id, 'backups'), { recursive: true });
    fs.writeFileSync(profilePath(dataDir, id, '.migrating'), JSON.stringify({ version: 1, startedAt: new Date().toISOString() }));
    fs.writeFileSync(profilePath(dataDir, id, 'backups', 'finance-2026-01-01-00-00-00-000.db'), 'already-moved');

    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const registry = readRegistry(dataDir);
      // A fresh UUID here would strand every byte already moved into the first directory.
      expect(registry.profiles).toHaveLength(1);
      expect(registry.profiles[0]!.id).toBe(id);
      expect(registry.activeId).toBe(id);

      expect(fs.readFileSync(profilePath(dataDir, id, 'backups', 'finance-2026-01-01-00-00-00-000.db'), 'utf8')).toBe('already-moved');
      expect(fs.existsSync(profilePath(dataDir, id, '.migrating'))).toBe(false);
      expect(handle.db.getSetting('marker')).toBe('legacy');
      expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);

      // A3: the DPAPI blob was handed to the profile that owns it, and consumed there.
      expect(fs.existsSync(path.join(dataDir, 'credentials.enc'))).toBe(false);
      const connections = handle.db.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.company).toBe('leumi');
      expect(handle.db.getConnectionCredentials(connections[0]!.id)?.toString()).toBe('phase-1-dpapi-blob');
    } finally {
      await handle.close();
    }
  });

  test('one person\'s money is unreachable from another\'s request', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const first = handle.runtime.activeProfileId;
      const created = await request(handle.app).post('/api/profiles').send({ name: 'רותם', color: '#7bd88f' }).expect(201);
      const second = created.body.profile.id as string;

      await request(handle.app)
        .post('/api/assets')
        .set('X-Misgeret-Profile', first)
        .send({ name: 'חופשה', kind: 'asset', amount: 5000 })
        .expect(201);

      // Physical isolation: the other database is not attached, not open, not reachable — there
      // is nothing for a query bug to leak from.
      const fromSecond = await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', second).expect(200);
      expect(fromSecond.body.assets).toHaveLength(0);
      const fromFirst = await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', first).expect(200);
      expect(fromFirst.body.assets).toHaveLength(1);

      // No header means the active profile — what keeps main's header-less runtimeFetch working.
      const headerless = await request(handle.app).get('/api/networth').expect(200);
      expect(headerless.body.assets).toHaveLength(1);

      await request(handle.app)
        .get('/api/networth')
        .set('X-Misgeret-Profile', '00000000-0000-4000-8000-000000000000')
        .expect(404, { errorType: 'PROFILE_NOT_FOUND' });
      await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', '../../evil').expect(404);
    } finally {
      await handle.close();
    }
  });

  test('the profiles router lists, renames, reorders, activates and soft-deletes', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const first = handle.runtime.activeProfileId;
      const second = (await request(handle.app).post('/api/profiles').send({ name: 'רותם' }).expect(201)).body.profile.id as string;

      const listed = await request(handle.app).get('/api/profiles').expect(200);
      expect(listed.body.activeId).toBe(first);
      expect(listed.body.profiles.map((p: { name: string }) => p.name)).toEqual(['ראשי', 'רותם']);
      expect(listed.body.profiles[0]).toMatchObject({ id: first, order: 0, connectionCount: 0, lastSyncAt: null });

      await request(handle.app).post('/api/profiles').send({ name: 'ראשי' }).expect(409, { errorType: 'PROFILE_NAME_EXISTS', errorMessage: 'a profile with this name already exists' });
      await request(handle.app).post('/api/profiles').send({ name: '  ' }).expect(400);

      expect((await request(handle.app).put(`/api/profiles/${second}`).send({ name: 'רותם כהן', color: '#e06c9f' }).expect(200)).body.profile)
        .toMatchObject({ name: 'רותם כהן', color: '#e06c9f' });

      expect((await request(handle.app).post('/api/profiles/reorder').send({ ids: [second, first] }).expect(200)).body.profiles.map((p: { id: string }) => p.id))
        .toEqual([second, first]);

      expect((await request(handle.app).post(`/api/profiles/${second}/activate`).expect(200)).body).toEqual({ activeId: second });
      expect((await request(handle.app).get('/api/profiles').expect(200)).body.activeId).toBe(second);

      // Deleting the profile on screen must reassign activeId in the same write, or every
      // header-less desktop call would resolve to a ghost.
      await request(handle.app).delete(`/api/profiles/${second}`).expect(204);
      expect((await request(handle.app).get('/api/profiles').expect(200)).body.activeId).toBe(first);
      expect(fs.readdirSync(path.join(dataDir, 'deleted-profiles'))).toHaveLength(1);

      await request(handle.app).delete(`/api/profiles/${first}`).expect(400, { errorType: 'LAST_PROFILE', errorMessage: 'the last profile cannot be deleted' });
      await request(handle.app).delete('/api/profiles/00000000-0000-4000-8000-000000000000').expect(404, { errorType: 'PROFILE_NOT_FOUND' });
    } finally {
      await handle.close();
    }
  });

  test('deleting a cached but idle profile closes its database first', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const second = (await request(handle.app).post('/api/profiles').send({ name: 'רותם' }).expect(201)).body.profile.id as string;
      // The common path: switch to a profile, look at it, decide to delete it. The workspace is
      // left cached and idle, and Windows will not rename a directory holding an open db file.
      await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', second).expect(200);
      expect(handle.profiles.openWorkspaceCount).toBe(2);

      await request(handle.app).delete(`/api/profiles/${second}`).expect(204);
      expect(handle.profiles.openWorkspaceCount).toBe(1);
      expect(fs.existsSync(path.join(dataDir, 'profiles', second))).toBe(false);
    } finally {
      await handle.close();
    }
  });

  test('the pre-update backup is global and fans out over every profile', async () => {
    const dataDir = tempDir();
    const handle = await startServer({
      dataDir,
      clientDist: path.join(dataDir, 'missing-client'),
      scraper: new MockScraper(),
      apiToken: 'a'.repeat(64),
      desktopActionToken: 'd'.repeat(64),
    });
    try {
      const auth = { Authorization: `Bearer ${'a'.repeat(64)}`, 'X-Misgeret-Desktop-Action': 'd'.repeat(64) };
      const second = (await request(handle.app).post('/api/profiles').set(auth).send({ name: 'רותם' }).expect(201)).body.profile.id as string;
      await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', second).set(auth).expect(200);

      const response = await request(handle.app).post('/api/backup/automatic').set(auth).send({ reason: 'update' }).expect(201);
      // A snapshot exists to survive a bad new build; per-active it would protect 1/N of the money.
      expect(response.body.results).toHaveLength(2);
      for (const result of response.body.results as Array<{ profileId: string; file: string }>) {
        expect(fs.existsSync(path.join(dataDir, 'profiles', result.profileId, 'backups', result.file))).toBe(true);
      }

      await request(handle.app).post('/api/backup/automatic').set({ Authorization: auth.Authorization }).send({ reason: 'update' })
        .expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    } finally {
      await handle.close();
    }
  });

  test('a manual backup names the profile it belongs to', async () => {
    const dataDir = tempDir();
    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      const second = (await request(handle.app).post('/api/profiles').send({ name: 'רותם' }).expect(201)).body.profile.id as string;
      const backup = await request(handle.app).post('/api/backup').set('X-Misgeret-Profile', second).expect(201);
      // main resolves profiles/<id>/backups/<file> from this; the root backups dir is gone.
      expect(backup.body.profileId).toBe(second);
      expect(path.basename(backup.body.file)).toBe(backup.body.file);
      expect(fs.existsSync(path.join(dataDir, 'profiles', second, 'backups', backup.body.file))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test('import refuses a source path inside the profile store', async () => {
    const dataDir = tempDir();
    const handle = await startServer({
      dataDir,
      clientDist: path.join(dataDir, 'missing-client'),
      scraper: new MockScraper(),
      apiToken: 'a'.repeat(64),
      desktopActionToken: 'd'.repeat(64),
    });
    try {
      const auth = { Authorization: `Bearer ${'a'.repeat(64)}`, 'X-Misgeret-Desktop-Action': 'd'.repeat(64) };
      const first = handle.runtime.activeProfileId;
      // Otherwise import is a supported way to clone one profile's whole database over another.
      await request(handle.app)
        .post('/api/data/import')
        .set(auth)
        .send({ sourcePath: path.join(dataDir, 'profiles', first, 'finance.db') })
        .expect(400, { errorType: 'INVALID_INPUT', errorMessage: 'source path is inside the profile store' });
    } finally {
      await handle.close();
    }
  });

  test('quarantines a stray legacy database rather than adopting or ignoring it', async () => {
    const dataDir = tempDir();
    const first = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    await first.close();

    // A database appearing at the root once profiles exist is not legacy data any more.
    seedLegacyDatabase(dataDir);

    const handle = await startServer({ dataDir, clientDist: path.join(dataDir, 'missing-client'), scraper: new MockScraper() });
    try {
      expect(readRegistry(dataDir).profiles).toHaveLength(1);
      expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
      const quarantined = fs.readdirSync(path.join(dataDir, 'quarantine'));
      expect(quarantined).toHaveLength(1);
      expect(fs.existsSync(path.join(dataDir, 'quarantine', quarantined[0]!, 'finance.db'))).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
