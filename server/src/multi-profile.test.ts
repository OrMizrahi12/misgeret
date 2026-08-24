import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { startServer, type ServerHandle } from './runtime.js';
import { MockScraper } from './scraper.js';

/**
 * The end-to-end proof of "כל אחד — והעולם שלו": absolute isolation, asserted through the real
 * HTTP surface of a real `startServer`, never through internals. If someone ever collapses the
 * per-profile databases back into one — a `profile_id` column, a shared handle, a leaked path —
 * these tests are what breaks.
 */

const LEUMI = { company: 'leumi', credentials: { username: 'u', password: 'p' } };
const UNKNOWN_PROFILE = '00000000-0000-4000-8000-000000000000';

const opened: ServerHandle[] = [];

afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-isolation-'));
}

async function boot(dataDir: string): Promise<ServerHandle> {
  const handle = await startServer({
    dataDir,
    clientDist: path.join(dataDir, 'missing-client'),
    scraper: new MockScraper(),
  });
  opened.push(handle);
  return handle;
}

async function createProfile(handle: ServerHandle, name: string): Promise<string> {
  const created = await request(handle.app).post('/api/profiles').send({ name }).expect(201);
  return created.body.profile.id as string;
}

interface Three {
  handle: ServerHandle;
  dataDir: string;
  a: string;
  b: string;
  c: string;
}

async function threeProfiles(): Promise<Three> {
  const dataDir = tempDir();
  const handle = await boot(dataDir);
  return {
    handle,
    dataDir,
    a: handle.runtime.activeProfileId,
    b: await createProfile(handle, 'רותם'),
    c: await createProfile(handle, 'יעל'),
  };
}

function todayIsrael(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** Everything one person accumulates: a synced bank connection, cash they typed in themselves,
 *  a category + rule, a savings goal, an asset, and a settings change. */
async function seedWorld(handle: ServerHandle, id: string): Promise<void> {
  const as = { 'X-Misgeret-Profile': id };
  await request(handle.app).post('/api/connections').set(as).send(LEUMI).expect(201);
  await request(handle.app).post('/api/sync').set(as).expect(200);

  const manual = await request(handle.app)
    .post('/api/txns')
    .set(as)
    .send({ date: todayIsrael(), description: 'מזומן לחתונה', amount: -640 })
    .expect(201);
  await request(handle.app)
    .put(`/api/txns/${encodeURIComponent(manual.body.key as string)}/category`)
    .set(as)
    .send({ category: 'leisure', rulePattern: 'מזומן לחתונה' })
    .expect(200);

  await request(handle.app)
    .post('/api/assets')
    .set(as)
    .send({ name: 'קרן השתלמות', kind: 'asset', amount: 90000 })
    .expect(201);
  await request(handle.app).put('/api/settings').set(as).send({ months: 24 }).expect(200);
}

interface ReadSurface {
  name: string;
  path: string;
  /** The evidence this surface would carry if it could see the other world. */
  view: (res: request.Response) => unknown;
  /** What the surface says for a world that holds nothing. */
  whenEmpty: unknown;
}

/** Every read surface a person's money can reach the screen through. */
const READ_SURFACES: ReadSurface[] = [
  {
    name: '/summary',
    path: '/api/summary',
    view: (res) => ({ months: res.body.summary.length, review: res.body.reviewCount }),
    whenEmpty: { months: 0, review: 0 },
  },
  {
    name: '/dashboard',
    path: '/api/dashboard',
    view: (res) => ({
      bankBalance: res.body.pulse.bankBalance,
      monthsNet: res.body.trend.monthsNet.length,
      categories: res.body.composition.categories.length,
    }),
    whenEmpty: { bankBalance: null, monthsNet: 0, categories: 0 },
  },
  {
    name: '/search',
    path: `/api/search?q=${encodeURIComponent('משכורת')}`,
    view: (res) => res.body.total,
    whenEmpty: 0,
  },
  { name: '/connections', path: '/api/connections', view: (res) => res.body.length, whenEmpty: 0 },
  { name: '/balances', path: '/api/balances', view: (res) => res.body.balances.length, whenEmpty: 0 },
  {
    name: '/export.csv',
    path: '/api/export.csv',
    // The header line is always there; every line after it is a transaction.
    view: (res) => res.text.trimEnd().split('\n').length - 1,
    whenEmpty: 0,
  },
  {
    name: '/networth',
    path: '/api/networth',
    view: (res) => ({ netWorth: res.body.netWorth, assets: res.body.assets.length, accounts: res.body.accounts.length }),
    whenEmpty: { netWorth: 0, assets: 0, accounts: 0 },
  },
  {
    name: '/cashflow',
    path: '/api/cashflow',
    view: (res) => ({ latestBankBalance: res.body.latestBankBalance, recurring: res.body.recurring.length }),
    whenEmpty: { latestBankBalance: null, recurring: 0 },
  },
  { name: '/review', path: '/api/review', view: (res) => res.body.txns.length, whenEmpty: 0 },
  { name: '/settings', path: '/api/settings', view: (res) => res.body.months, whenEmpty: 6 },
  {
    name: '/status',
    path: '/api/status',
    view: (res) => ({ connections: res.body.connectionCount, synced: res.body.lastSyncAt !== null }),
    whenEmpty: { connections: 0, synced: false },
  },
];

async function readAs(handle: ServerHandle, surface: ReadSurface, id: string): Promise<unknown> {
  const res = await request(handle.app).get(surface.path).set('X-Misgeret-Profile', id).expect(200);
  return surface.view(res);
}

describe('absolute isolation between profiles', () => {
  test('a seeded profile shows on every read surface — the control for every emptiness assertion', async () => {
    const { handle, a } = await threeProfiles();
    await seedWorld(handle, a);

    // Without this, every "B sees nothing" assertion below would pass against a world where
    // nothing was ever written, and prove nothing at all.
    for (const surface of READ_SURFACES) {
      expect.soft(await readAs(handle, surface, a), `${surface.name} must carry A's data`).not.toEqual(surface.whenEmpty);
    }
  });

  test("one profile's data is invisible on every read surface of the others", async () => {
    const { handle, a, b, c } = await threeProfiles();
    await seedWorld(handle, a);

    // Physical isolation: B's request never opens A's database, so there is nothing to leak from.
    for (const surface of READ_SURFACES) {
      expect.soft(await readAs(handle, surface, b), `${surface.name} leaked into B`).toEqual(surface.whenEmpty);
      expect.soft(await readAs(handle, surface, c), `${surface.name} leaked into C`).toEqual(surface.whenEmpty);
    }
  });

  test('three profiles hold three different worlds at once', async () => {
    const { handle, a, b, c } = await threeProfiles();
    await seedWorld(handle, a);
    await request(handle.app).post('/api/assets').set('X-Misgeret-Profile', b).send({ name: 'רכב', kind: 'asset', amount: 5000 }).expect(201);
    await request(handle.app).post('/api/assets').set('X-Misgeret-Profile', c).send({ name: 'לימודים', kind: 'asset', amount: 5000 }).expect(201);
    await request(handle.app).post('/api/assets').set('X-Misgeret-Profile', c).send({ name: 'חירום', kind: 'asset', amount: 5000 }).expect(201);

    const names = async (id: string) => {
      const res = await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', id).expect(200);
      return (res.body.assets as Array<{ name: string }>).map((goal) => goal.name);
    };
    expect(await names(a)).toEqual(['קרן השתלמות']);
    expect(await names(b)).toEqual(['רכב']);
    expect(await names(c)).toEqual(['לימודים', 'חירום']);
  });

  test('each profile is its own database file on disk, and only its own', async () => {
    const { handle, dataDir, a, b, c } = await threeProfiles();
    await seedWorld(handle, a);
    // Touch B and C so their files exist to be compared.
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', b).expect(200);
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', c).expect(200);

    // Isolation is physical, not logical: no query bug can reach a database that is not a file
    // this request ever opens. Three ids, three directories, three databases.
    const directories = fs.readdirSync(path.join(dataDir, 'profiles')).sort();
    expect(directories).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) {
      expect(fs.existsSync(path.join(dataDir, 'profiles', id, 'finance.db'))).toBe(true);
    }
  });
});

describe('profile resolution', () => {
  test('no header answers from the active profile', async () => {
    const { handle, a } = await threeProfiles();
    await seedWorld(handle, a);

    // This is what keeps main's header-less runtimeFetch — export, backup, import — working.
    const headerless = await request(handle.app).get('/api/status').expect(200);
    expect(headerless.body.connectionCount).toBe(1);
  });

  test('a header naming an unknown profile is a 404, never a silent fallback', async () => {
    const { handle, a } = await threeProfiles();
    await seedWorld(handle, a);

    for (const header of [UNKNOWN_PROFILE, '../../evil', 'not-a-uuid', '%2e%2e%2f', '..', 'null', a.toUpperCase().slice(0, -1)]) {
      // Falling back to the active profile here would serve A's money to whoever asked wrong.
      await request(handle.app).get('/api/status').set('X-Misgeret-Profile', header).expect(404, { errorType: 'PROFILE_NOT_FOUND' });
    }
  });

  test('an empty header names no profile, so the active one answers', async () => {
    const { handle, a, b } = await threeProfiles();
    await seedWorld(handle, a);

    // Resolution rule 2 is "no header ⇒ the active profile", and a header carrying no id is not
    // a header naming an unknown one. Node trims header values, so ' ' reaches Express as ''.
    for (const header of ['', ' ']) {
      const res = await request(handle.app).get('/api/status').set('X-Misgeret-Profile', header).expect(200);
      expect(res.body.connectionCount).toBe(1);
    }
    // It tracks the registry rather than pinning A — it really is the header-less path.
    await request(handle.app).post(`/api/profiles/${b}/activate`).expect(200);
    expect((await request(handle.app).get('/api/status').set('X-Misgeret-Profile', '').expect(200)).body.connectionCount).toBe(0);
  });

  test('a stale header for a deleted profile is a 404 and conjures no ghost world', async () => {
    const { handle, dataDir, b } = await threeProfiles();
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', b).expect(200);
    await request(handle.app).delete(`/api/profiles/${b}`).expect(204);

    // `new FinanceDb(path)` creates the file it is handed, so an id that reached a path join
    // would conjure profiles/<deletedId>/finance.db and the next boot would adopt the ghost.
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', b).expect(404, { errorType: 'PROFILE_NOT_FOUND' });
    expect(fs.existsSync(path.join(dataDir, 'profiles', b))).toBe(false);
  });

  test('the header wins over the registry active profile', async () => {
    const { handle, a, b } = await threeProfiles();
    await seedWorld(handle, a);
    await request(handle.app).post(`/api/profiles/${b}/activate`).expect(200);
    expect((await request(handle.app).get('/api/profiles').expect(200)).body.activeId).toBe(b);

    // The registry says B; the request names A. A answers — the renderer addresses the profile
    // on screen explicitly and must never be re-pointed by a background activation.
    const addressed = await request(handle.app).get('/api/status').set('X-Misgeret-Profile', a).expect(200);
    expect(addressed.body.connectionCount).toBe(1);
    // And the header-less call follows the registry, which now says B.
    expect((await request(handle.app).get('/api/status').expect(200)).body.connectionCount).toBe(0);
  });
});

describe('per-profile settings', () => {
  test('a settings change in one profile leaves the others at their defaults', async () => {
    const { handle, a, b, c } = await threeProfiles();
    await request(handle.app).put('/api/settings').set('X-Misgeret-Profile', a).send({ months: 24, monthStartDay: 10, overdraftLimit: 5000 }).expect(200);

    expect((await request(handle.app).get('/api/settings').set('X-Misgeret-Profile', a).expect(200)).body)
      .toMatchObject({ months: 24, monthStartDay: 10, overdraftLimit: 5000 });
    for (const id of [b, c]) {
      expect((await request(handle.app).get('/api/settings').set('X-Misgeret-Profile', id).expect(200)).body)
        .toMatchObject({ months: 6, monthStartDay: 1, overdraftLimit: 0 });
    }
  });

  test('settings survive a restart per profile, not globally', async () => {
    const { handle, dataDir, a, b } = await threeProfiles();
    await request(handle.app).put('/api/settings').set('X-Misgeret-Profile', a).send({ months: 24 }).expect(200);
    await request(handle.app).put('/api/settings').set('X-Misgeret-Profile', b).send({ months: 3 }).expect(200);
    await opened.pop()!.close();

    const rebooted = await boot(dataDir);
    expect((await request(rebooted.app).get('/api/settings').set('X-Misgeret-Profile', a).expect(200)).body.months).toBe(24);
    expect((await request(rebooted.app).get('/api/settings').set('X-Misgeret-Profile', b).expect(200)).body.months).toBe(3);
  });
});

describe('per-profile backups', () => {
  test('a backup made in one profile is not listed in another and cannot be restored from it', async () => {
    const { handle, dataDir, a, b } = await threeProfiles();
    await seedWorld(handle, a);

    const created = await request(handle.app).post('/api/backup').set('X-Misgeret-Profile', a).expect(201);
    const file = created.body.file as string;
    expect(created.body.profileId).toBe(a);
    expect(fs.existsSync(path.join(dataDir, 'profiles', a, 'backups', file))).toBe(true);

    expect((await request(handle.app).get('/api/backups').set('X-Misgeret-Profile', a).expect(200)).body.backups.map((entry: { file: string }) => entry.file))
      .toEqual([file]);
    // B's backups directory is a different directory. A's history is not B's to see.
    expect((await request(handle.app).get('/api/backups').set('X-Misgeret-Profile', b).expect(200)).body.backups).toEqual([]);

    // Nor to restore from: a backup name is resolved inside the addressed profile's own dir,
    // so this can never be a supported way to clone A's whole world over B.
    await request(handle.app).post('/api/backups/restore').set('X-Misgeret-Profile', b).send({ file }).expect(404, { errorType: 'NOT_FOUND' });
    expect((await request(handle.app).get('/api/status').set('X-Misgeret-Profile', b).expect(200)).body.connectionCount).toBe(0);
  });

  test('restoring in one profile does not touch another', async () => {
    const { handle, a, b } = await threeProfiles();
    await seedWorld(handle, a);
    const file = (await request(handle.app).post('/api/backup').set('X-Misgeret-Profile', a).expect(201)).body.file as string;

    await request(handle.app).post('/api/assets').set('X-Misgeret-Profile', b).send({ name: 'רכב', kind: 'asset', amount: 5000 }).expect(201);

    const doomed = (await request(handle.app).get('/api/connections').set('X-Misgeret-Profile', a).expect(200)).body[0].id;
    await request(handle.app).delete(`/api/connections/${doomed}`).set('X-Misgeret-Profile', a).expect(204);
    await request(handle.app).post('/api/backups/restore').set('X-Misgeret-Profile', a).send({ file }).expect(200);

    // A came back; B never moved.
    expect((await request(handle.app).get('/api/status').set('X-Misgeret-Profile', a).expect(200)).body.connectionCount).toBe(1);
    const bGoals = (await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', b).expect(200)).body.assets;
    expect(bGoals.map((goal: { name: string }) => goal.name)).toEqual(['רכב']);
  });
});

describe('deleting a profile', () => {
  test('the world is moved aside: gone from the API, still on disk', async () => {
    const { handle, dataDir, b } = await threeProfiles();
    await seedWorld(handle, b);
    const savedGoals = (await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', b).expect(200)).body.assets.length;
    expect(savedGoals).toBe(1);

    await request(handle.app).delete(`/api/profiles/${b}`).expect(204);

    // Gone from every API surface...
    await request(handle.app).get('/api/networth').set('X-Misgeret-Profile', b).expect(404, { errorType: 'PROFILE_NOT_FOUND' });
    expect((await request(handle.app).get('/api/profiles').expect(200)).body.profiles.map((p: { id: string }) => p.id)).not.toContain(b);
    expect(fs.existsSync(path.join(dataDir, 'profiles', b))).toBe(false);

    // ...and never destroyed. Quarantine over delete: the money is still there to be recovered.
    const moved = fs.readdirSync(path.join(dataDir, 'deleted-profiles'));
    expect(moved).toHaveLength(1);
    expect(moved[0]!.startsWith(`${b}-`)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'deleted-profiles', moved[0]!, 'finance.db'))).toBe(true);
  });

  test('a deleted profile is not resurrected by the next boot', async () => {
    const { handle, dataDir, b } = await threeProfiles();
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', b).expect(200);
    await request(handle.app).delete(`/api/profiles/${b}`).expect(204);
    await opened.pop()!.close();

    // Reconciliation adopts any orphan profiles/<uuid>/finance.db as `משתמש <n>`. A delete that
    // left the directory behind would hand the user back the profile they just deleted.
    const rebooted = await boot(dataDir);
    const listed = (await request(rebooted.app).get('/api/profiles').expect(200)).body;
    expect(listed.profiles.map((p: { id: string }) => p.id)).not.toContain(b);
    expect(listed.profiles).toHaveLength(2);
  });

  test('the last profile cannot be deleted', async () => {
    const { handle, a, b, c } = await threeProfiles();
    await request(handle.app).delete(`/api/profiles/${b}`).expect(204);
    await request(handle.app).delete(`/api/profiles/${c}`).expect(204);

    // There is no such thing as an app with nobody in it.
    await request(handle.app).delete(`/api/profiles/${a}`).expect(400, { errorType: 'LAST_PROFILE', errorMessage: 'the last profile cannot be deleted' });
    expect((await request(handle.app).get('/api/profiles').expect(200)).body.profiles).toHaveLength(1);
    await request(handle.app).get('/api/status').expect(200);
  });

  test('deleting the active profile reassigns activeId in the same write', async () => {
    const { handle, a, b } = await threeProfiles();
    await seedWorld(handle, a);
    await request(handle.app).post(`/api/profiles/${b}/activate`).expect(200);
    await request(handle.app).delete(`/api/profiles/${b}`).expect(204);

    // Every header-less desktop call resolves through activeId. A window where it names a ghost
    // is a window where ייצוא CSV exports nothing from a profile that does not exist.
    expect((await request(handle.app).get('/api/profiles').expect(200)).body.activeId).toBe(a);
    expect((await request(handle.app).get('/api/status').expect(200)).body.connectionCount).toBe(1);
  });
});

describe('a profile name is a label, never a path', () => {
  test('path-traversal text in a name creates nothing outside dataDir/profiles', async () => {
    const { handle, dataDir } = await threeProfiles();
    const before = fs.readdirSync(dataDir).sort();

    const hostile = ['../../evil', '..\\..\\evil', '/etc/passwd', 'C:\\Windows\\System32', '.'];
    const created: string[] = [];
    for (const name of hostile) {
      const res = await request(handle.app).post('/api/profiles').send({ name });
      if (res.status === 201) created.push(res.body.profile.id as string);
      else expect(res.status).toBe(400);
    }
    expect(created.length).toBeGreaterThan(0);

    // The id is a UUID and the name is only ever displayed. Nothing new appears beside the
    // dataDir, and every profile directory is a bare UUID under profiles/.
    expect(fs.readdirSync(dataDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(dataDir, '..', 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, '..', '..', 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'evil'))).toBe(false);
    for (const entry of fs.readdirSync(path.join(dataDir, 'profiles'))) {
      expect(entry).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }

    // And the hostile-named worlds are real, isolated profiles like any other.
    for (const id of created) {
      await request(handle.app).get('/api/status').set('X-Misgeret-Profile', id).expect(200, { connectionCount: 0, lastSyncAt: null, autoSyncOnOpen: true });
      expect(fs.existsSync(path.join(dataDir, 'profiles', id, 'finance.db'))).toBe(true);
    }
  });

  test('a hostile name survives a restart as a name, not a path', async () => {
    const { handle, dataDir } = await threeProfiles();
    const id = await createProfile(handle, '../../evil');
    await request(handle.app).get('/api/status').set('X-Misgeret-Profile', id).expect(200);
    await opened.pop()!.close();

    const rebooted = await boot(dataDir);
    const profile = (await request(rebooted.app).get('/api/profiles').expect(200)).body.profiles
      .find((p: { id: string }) => p.id === id);
    expect(profile.name).toBe('../../evil');
    expect(fs.existsSync(path.join(dataDir, '..', 'evil'))).toBe(false);
  });
});
