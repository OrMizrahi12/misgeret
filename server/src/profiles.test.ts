import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { FinanceDb } from './db.js';
import { resolveRuntimePaths } from './paths.js';
import { ProfileError, ProfileStore, migrateLegacyIntoProfile } from './profiles.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-profiles-'));
}

function loadedStore(dataDir = tempDir()): { store: ProfileStore; dataDir: string } {
  const store = new ProfileStore();
  store.load(dataDir);
  return { store, dataDir };
}

function writeRegistry(dataDir: string, payload: unknown): void {
  fs.writeFileSync(path.join(dataDir, 'profiles.json'), JSON.stringify(payload));
}

function seedProfileDir(dataDir: string, id: string, withDatabase = true): string {
  const directory = path.join(dataDir, 'profiles', id);
  fs.mkdirSync(directory, { recursive: true });
  if (withDatabase) {
    const db = new FinanceDb(path.join(directory, 'finance.db'));
    db.setSetting('marker', id);
    db.close();
  }
  return directory;
}

function expectProfileError(run: () => unknown, errorType: string): void {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).errorType).toBe(errorType);
    return;
  }
  throw new Error(`expected ${errorType} to be thrown`);
}

describe('ProfileStore validation', () => {
  test('trims names and refuses empty, oversized and control-character ones', () => {
    const { store } = loadedStore();
    expect(store.create({ name: '  אור  ' }).name).toBe('אור');
    expectProfileError(() => store.create({ name: '   ' }), 'PROFILE_NAME_INVALID');
    expectProfileError(() => store.create({ name: 'x'.repeat(61) }), 'PROFILE_NAME_INVALID');
    expectProfileError(() => store.create({ name: 'a\u0001b' }), 'PROFILE_NAME_INVALID');
    expectProfileError(() => store.create({ name: 42 }), 'PROFILE_NAME_INVALID');
    expect(store.create({ name: 'x'.repeat(60) }).name).toHaveLength(60);
  });

  test('names are unique case-insensitively, and a profile may keep its own name', () => {
    const { store } = loadedStore();
    const first = store.create({ name: 'אור' });
    store.create({ name: 'רותם' });
    expectProfileError(() => store.create({ name: 'אור' }), 'PROFILE_NAME_EXISTS');
    store.create({ name: 'Dana' });
    expectProfileError(() => store.create({ name: 'dana' }), 'PROFILE_NAME_EXISTS');
    expect(store.update(first.id, { name: 'אור' }).name).toBe('אור');
    expectProfileError(() => store.update(first.id, { name: 'רותם' }), 'PROFILE_NAME_EXISTS');
  });

  test('colors must be #rrggbb and are stored folded', () => {
    const { store } = loadedStore();
    expect(store.create({ name: 'אור', color: '#6EA8FF' }).color).toBe('#6ea8ff');
    expectProfileError(() => store.create({ name: 'רותם', color: 'red' }), 'INVALID_INPUT');
    expectProfileError(() => store.create({ name: 'רותם', color: '#fff' }), 'INVALID_INPUT');
  });

  test('a rejected patch changes nothing — not in memory, and not on the next unrelated write', () => {
    const { store, dataDir } = loadedStore();
    const first = store.create({ name: 'אור', color: '#111111' });
    const second = store.create({ name: 'דנה', color: '#222222' });

    // `require` hands back the live row, so a half-applied patch would go live the moment the
    // route answered 400 — and ride to disk on the next persist() that has nothing to do with it.
    expectProfileError(() => store.update(first.id, { name: 'נועה', color: 'not-a-color' }), 'INVALID_INPUT');
    expect(store.get(first.id)).toMatchObject({ name: 'אור', color: '#111111' });

    // The mirror: a rejected name must not let the color through either.
    expectProfileError(() => store.update(first.id, { name: 'דנה', color: '#333333' }), 'PROFILE_NAME_EXISTS');
    expect(store.get(first.id)).toMatchObject({ name: 'אור', color: '#111111' });

    store.setActive(second.id);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')) as {
      profiles: Array<{ id: string; name: string }>;
    };
    expect(persisted.profiles.find((profile) => profile.id === first.id)!.name).toBe('אור');
  });

  test('a patch that passes validation applies both halves together', () => {
    const { store } = loadedStore();
    const profile = store.create({ name: 'אור', color: '#6ea8ff' });
    const updated = store.update(profile.id, { name: 'נועה', color: '#F2A65A' });
    expect(updated).toMatchObject({ name: 'נועה', color: '#f2a65a' });
    expect(store.get(profile.id)).toMatchObject({ name: 'נועה', color: '#f2a65a' });
  });

  test('reorder demands every id exactly once', () => {
    const { store } = loadedStore();
    const first = store.create({ name: 'אור' });
    const second = store.create({ name: 'רותם' });
    expect(store.reorder([second.id, first.id]).map((profile) => profile.id)).toEqual([second.id, first.id]);
    expect(store.list().map((profile) => profile.order)).toEqual([0, 1]);
    expectProfileError(() => store.reorder([first.id]), 'INVALID_INPUT');
    expectProfileError(() => store.reorder([first.id, first.id]), 'INVALID_INPUT');
    expectProfileError(() => store.reorder([first.id, randomUUID()]), 'PROFILE_NOT_FOUND');
  });
});

describe('ProfileStore path safety', () => {
  test('a hand-edited registry cannot escape dataDir', () => {
    const { store, dataDir } = loadedStore();
    const real = store.create({ name: 'אור' });
    writeRegistry(dataDir, {
      version: 1,
      activeId: real.id,
      profiles: [
        { id: real.id, name: 'אור', color: '#6ea8ff', createdAt: new Date().toISOString(), lastOpenedAt: null, order: 0 },
        { id: '../../evil', name: 'evil', color: '#6ea8ff', createdAt: new Date().toISOString(), lastOpenedAt: null, order: 1 },
      ],
    });
    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.list().map((profile) => profile.id)).toEqual([real.id]);
    expect(reloaded.get('../../evil')).toBeUndefined();
    expectProfileError(() => reloaded.dirFor('../../evil'), 'PROFILE_NOT_FOUND');
    expectProfileError(() => reloaded.dbPathFor('..\\..\\evil'), 'PROFILE_NOT_FOUND');
  });

  test('no path is joined for an id the registry does not hold', () => {
    const { store } = loadedStore();
    const unknown = randomUUID();
    expectProfileError(() => store.dirFor(unknown), 'PROFILE_NOT_FOUND');
    expectProfileError(() => store.dbPathFor(unknown), 'PROFILE_NOT_FOUND');
    expectProfileError(() => store.backupsDirFor(unknown), 'PROFILE_NOT_FOUND');
  });
});

describe('ProfileStore reconciliation', () => {
  test('adopts an orphan profile directory that holds a database', () => {
    const dataDir = tempDir();
    const orphan = randomUUID();
    seedProfileDir(dataDir, orphan);
    const store = new ProfileStore();
    store.load(dataDir);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.id).toBe(orphan);
    expect(store.list()[0]!.name).toBe('משתמש 1');
    expect(store.getActiveId()).toBe(orphan);
  });

  test('adoption names never collide with a registered profile', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    store.create({ name: 'משתמש 1' });
    const orphan = randomUUID();
    seedProfileDir(dataDir, orphan);
    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.list().map((profile) => profile.name).sort()).toEqual(['משתמש 1', 'משתמש 2']);
  });

  test('refuses to adopt a directory still carrying a .migrating marker', () => {
    const dataDir = tempDir();
    const interrupted = randomUUID();
    const directory = seedProfileDir(dataDir, interrupted);
    fs.writeFileSync(path.join(directory, '.migrating'), '{"version":1}');
    const store = new ProfileStore();
    store.load(dataDir);
    expect(store.list()).toHaveLength(0);
  });

  test('clears a stale .migrating marker from an already-registered profile', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    const profile = store.create({ name: 'ראשי' });
    const marker = path.join(dataDir, 'profiles', profile.id, '.migrating');
    fs.writeFileSync(marker, '{"version":1}');
    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(fs.existsSync(marker)).toBe(false);
    expect(reloaded.list()).toHaveLength(1);
  });

  test('drops entries whose directory is gone and repairs the activeId', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    const first = store.create({ name: 'אור' });
    const second = store.create({ name: 'רותם' });
    store.setActive(second.id);
    fs.rmSync(path.join(dataDir, 'profiles', second.id), { recursive: true, force: true });

    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.list().map((profile) => profile.id)).toEqual([first.id]);
    expect(reloaded.getActiveId()).toBe(first.id);
  });

  test('rebuilds from disk when the registry is corrupt', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    const profile = store.create({ name: 'אור' });
    const db = new FinanceDb(path.join(dataDir, 'profiles', profile.id, 'finance.db'));
    db.close();
    fs.writeFileSync(path.join(dataDir, 'profiles.json'), '{ this is not json');

    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.list().map((entry) => entry.id)).toEqual([profile.id]);
    expect(reloaded.getActiveId()).toBe(profile.id);
  });

  test('a fresh dataDir is left untouched so the desktop still sees a first run', () => {
    const dataDir = tempDir();
    const store = new ProfileStore();
    store.load(dataDir);
    expect(store.list()).toHaveLength(0);
    // A registry written for zero profiles would suppress the welcome wizard forever.
    expect(fs.existsSync(path.join(dataDir, 'profiles.json'))).toBe(false);
  });

  test('removes an empty unregistered directory left by a crashed create', () => {
    const dataDir = tempDir();
    const abandoned = randomUUID();
    fs.mkdirSync(path.join(dataDir, 'profiles', abandoned), { recursive: true });
    const store = new ProfileStore();
    store.load(dataDir);
    expect(store.list()).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'profiles', abandoned))).toBe(false);
  });

  test('resolveActiveId repairs an activeId naming a profile that is gone', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    const first = store.create({ name: 'אור' });
    writeRegistry(dataDir, {
      version: 1,
      activeId: randomUUID(),
      profiles: [{ id: first.id, name: 'אור', color: '#6ea8ff', createdAt: new Date().toISOString(), lastOpenedAt: null, order: 0 }],
    });
    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.resolveActiveId()).toBe(first.id);
  });
});

describe('ProfileStore lifecycle', () => {
  test('create makes the directory before it writes the registry', () => {
    const { store, dataDir } = loadedStore();
    const profile = store.create({ name: 'אור' });
    expect(fs.existsSync(path.join(dataDir, 'profiles', profile.id))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')).activeId).toBe(profile.id);
  });

  test('soft delete moves the world aside and never destroys it', () => {
    const { store, dataDir } = loadedStore();
    const first = store.create({ name: 'אור' });
    const second = store.create({ name: 'רותם' });
    fs.writeFileSync(path.join(dataDir, 'profiles', second.id, 'finance.db'), 'the whole world');

    store.softDelete(second.id);

    expect(store.list().map((profile) => profile.id)).toEqual([first.id]);
    expect(fs.existsSync(path.join(dataDir, 'profiles', second.id))).toBe(false);
    const moved = fs.readdirSync(path.join(dataDir, 'deleted-profiles'));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.startsWith(second.id)).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'deleted-profiles', moved[0]!, 'finance.db'), 'utf8')).toBe('the whole world');
  });

  test('deleting the active profile reassigns activeId in the same write', () => {
    const { store, dataDir } = loadedStore();
    const first = store.create({ name: 'אור' });
    const second = store.create({ name: 'רותם' });
    store.setActive(second.id);

    store.softDelete(second.id);

    // There is never a window where activeId names a gone profile: every header-less desktop
    // call — export, backup, import — resolves through it.
    expect(store.getActiveId()).toBe(first.id);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles.json'), 'utf8')).activeId).toBe(first.id);
  });

  test('the last profile cannot be deleted', () => {
    const { store } = loadedStore();
    const only = store.create({ name: 'אור' });
    expectProfileError(() => store.softDelete(only.id), 'LAST_PROFILE');
    expect(store.list()).toHaveLength(1);
  });

  test('soft delete renumbers the remaining order', () => {
    const { store } = loadedStore();
    const first = store.create({ name: 'א' });
    const second = store.create({ name: 'ב' });
    const third = store.create({ name: 'ג' });
    store.softDelete(second.id);
    expect(store.list().map((profile) => [profile.id, profile.order])).toEqual([[first.id, 0], [third.id, 1]]);
  });

  test('setActive stamps lastOpenedAt and survives a reload', () => {
    const { store, dataDir } = loadedStore();
    store.create({ name: 'אור' });
    const second = store.create({ name: 'רותם' });
    expect(store.setActive(second.id)).toBe(second.id);

    const reloaded = new ProfileStore();
    reloaded.load(dataDir);
    expect(reloaded.getActiveId()).toBe(second.id);
    expect(reloaded.get(second.id)!.lastOpenedAt).not.toBeNull();
  });
});

describe('migrateLegacyIntoProfile', () => {
  test('returns null and leaves the registry alone once profiles exist', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    const existing = store.create({ name: 'אור' });
    const paths = resolveRuntimePaths({ dataDir });

    const reloaded = new ProfileStore();
    expect(migrateLegacyIntoProfile(paths, reloaded)).toBeNull();
    expect(reloaded.list().map((profile) => profile.id)).toEqual([existing.id]);
  });

  test('creates ראשי on a fresh install without inventing a database', () => {
    const dataDir = tempDir();
    const paths = resolveRuntimePaths({ dataDir });
    const store = new ProfileStore();
    const id = migrateLegacyIntoProfile(paths, store);
    expect(id).not.toBeNull();
    expect(store.list()[0]!.name).toBe('ראשי');
    expect(fs.existsSync(path.join(dataDir, 'profiles', id!, 'finance.db'))).toBe(false);
  });

  test('moves the legacy database, its rollback siblings and the credentials blob', () => {
    const dataDir = tempDir();
    const legacyDb = new FinanceDb(path.join(dataDir, 'finance.db'));
    legacyDb.setSetting('marker', 'legacy');
    legacyDb.close();
    fs.writeFileSync(path.join(dataDir, 'finance.db.failed-abc'), 'last-resort-copy');
    fs.writeFileSync(path.join(dataDir, 'finance.db.restore-abc'), 'staged-copy');
    fs.writeFileSync(path.join(dataDir, 'credentials.enc'), 'blob');
    fs.mkdirSync(path.join(dataDir, 'backups'));
    fs.writeFileSync(path.join(dataDir, 'backups', 'finance-2026-01-01-00-00-00-000.db'), 'history');

    const paths = resolveRuntimePaths({ dataDir });
    const store = new ProfileStore();
    const id = migrateLegacyIntoProfile(paths, store)!;

    const profileDir = path.join(dataDir, 'profiles', id);
    expect(fs.existsSync(path.join(profileDir, 'finance.db'))).toBe(true);
    // A last-resort copy left at the root is a copy nothing would ever look at again.
    expect(fs.readFileSync(path.join(profileDir, 'finance.db.failed-abc'), 'utf8')).toBe('last-resort-copy');
    expect(fs.readFileSync(path.join(profileDir, 'finance.db.restore-abc'), 'utf8')).toBe('staged-copy');
    expect(fs.readFileSync(path.join(profileDir, 'credentials.enc'), 'utf8')).toBe('blob');
    expect(fs.readFileSync(path.join(profileDir, 'backups', 'finance-2026-01-01-00-00-00-000.db'), 'utf8')).toBe('history');
    expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'credentials.enc'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'backups'))).toBe(false);
    expect(fs.existsSync(path.join(profileDir, '.migrating'))).toBe(false);
  });

  test('leaves the legacy schema version intact so the pre-upgrade backup still fires', async () => {
    const dataDir = tempDir();
    const legacyPath = path.join(dataDir, 'finance.db');
    const legacyDb = new FinanceDb(legacyPath);
    legacyDb.close();
    const raw = new (await import('better-sqlite3')).default(legacyPath);
    raw.pragma('user_version = 0');
    raw.close();

    const paths = resolveRuntimePaths({ dataDir });
    const store = new ProfileStore();
    const id = migrateLegacyIntoProfile(paths, store)!;

    // The checkpoint must not construct a FinanceDb: that would stamp user_version and rob
    // openProfileDatabase of the one signal that tells it to back up before upgrading.
    const moved = new (await import('better-sqlite3')).default(path.join(dataDir, 'profiles', id, 'finance.db'), { readonly: true });
    expect(Number(moved.pragma('user_version', { simple: true }))).toBe(0);
    moved.close();
  });

  test('resumes into the marked id rather than minting a second UUID', () => {
    const dataDir = tempDir();
    const legacyDb = new FinanceDb(path.join(dataDir, 'finance.db'));
    legacyDb.close();
    const interrupted = randomUUID();
    fs.mkdirSync(path.join(dataDir, 'profiles', interrupted), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'profiles', interrupted, '.migrating'), '{"version":1}');

    const paths = resolveRuntimePaths({ dataDir });
    const store = new ProfileStore();
    expect(migrateLegacyIntoProfile(paths, store)).toBe(interrupted);
    expect(fs.readdirSync(path.join(dataDir, 'profiles'))).toEqual([interrupted]);
  });

  test('quarantines a stray legacy database instead of ignoring it', () => {
    const dataDir = tempDir();
    const { store } = loadedStore(dataDir);
    store.create({ name: 'אור' });
    const legacyDb = new FinanceDb(path.join(dataDir, 'finance.db'));
    legacyDb.close();
    fs.writeFileSync(path.join(dataDir, 'finance.db-wal'), 'wal');

    const paths = resolveRuntimePaths({ dataDir });
    const reloaded = new ProfileStore();
    expect(migrateLegacyIntoProfile(paths, reloaded)).toBeNull();

    expect(fs.existsSync(path.join(dataDir, 'finance.db'))).toBe(false);
    const quarantined = fs.readdirSync(path.join(dataDir, 'quarantine'));
    expect(quarantined).toHaveLength(1);
    expect(fs.readdirSync(path.join(dataDir, 'quarantine', quarantined[0]!)).sort()).toEqual(['finance.db', 'finance.db-wal']);
  });
});
