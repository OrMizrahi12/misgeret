import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { FinanceDb } from './db.js';
import { OperationCoordinator, type OperationState } from './operation-coordinator.js';
import { ProfileError, ProfileStore, type Profile } from './profiles.js';
import { MockScraper } from './scraper.js';
import {
  CoordinatorHub,
  WorkspacePool,
  createScrapeSemaphore,
  openProfileDatabase,
} from './workspaces.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-workspaces-'));
}

interface Harness {
  store: ProfileStore;
  pool: WorkspacePool;
  hub: CoordinatorHub;
  globalCoordinator: OperationCoordinator;
  dataDir: string;
  add(name: string): Profile;
}

function harness(maxOpen?: number, onOpenCountChange?: () => void): Harness {
  const dataDir = tempDir();
  const store = new ProfileStore();
  store.load(dataDir);
  const hub = new CoordinatorHub();
  const globalCoordinator = new OperationCoordinator();
  const pool = new WorkspacePool({
    store,
    scraper: new MockScraper(),
    hub,
    globalCoordinator,
    scrapeSemaphore: createScrapeSemaphore(2),
    rootDataDir: dataDir,
    maxOpen,
    onOpenCountChange,
  });
  return { store, pool, hub, globalCoordinator, dataDir, add: (name) => store.create({ name }), };
}

async function expectProfileError(run: () => Promise<unknown>, errorType: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(ProfileError);
    expect((err as ProfileError).errorType).toBe(errorType);
    return;
  }
  throw new Error(`expected ${errorType} to be thrown`);
}

describe('openProfileDatabase', () => {
  test('backs up before an upgrade and stamps the bucketing marker', async () => {
    const directory = tempDir();
    const dbPath = path.join(directory, 'finance.db');
    const backupsDir = path.join(directory, 'backups');
    const legacy = new FinanceDb(dbPath);
    legacy.setSetting('marker', 'legacy');
    legacy.close();

    const db = await openProfileDatabase(dbPath, backupsDir, directory);
    try {
      expect(db.getSetting('marker')).toBe('legacy');
      expect(db.getSetting('month_bucketing')).toBe('charge-v4');
    } finally {
      db.close();
    }
    // The rebucket rewrites rows on a settings marker alone, so an unstamped database is
    // about to be mutated and must be copied first — whatever its schema version says.
    expect(fs.readdirSync(backupsDir).filter((f) => /^auto-migration-finance-/.test(f))).toHaveLength(1);
  });

  test('a fresh profile is created without a pointless backup', async () => {
    const directory = tempDir();
    const backupsDir = path.join(directory, 'backups');
    const db = await openProfileDatabase(path.join(directory, 'finance.db'), backupsDir, directory);
    try {
      expect(db.getSetting('month_bucketing')).toBe('charge-v4');
    } finally {
      db.close();
    }
    expect(fs.existsSync(backupsDir)).toBe(false);
  });

  test('an already-stamped database at the current schema is opened untouched', async () => {
    const directory = tempDir();
    const dbPath = path.join(directory, 'finance.db');
    const backupsDir = path.join(directory, 'backups');
    const first = await openProfileDatabase(dbPath, backupsDir, directory);
    first.close();

    const second = await openProfileDatabase(dbPath, backupsDir, directory);
    second.close();
    expect(fs.existsSync(backupsDir)).toBe(false);
  });
});

describe('CoordinatorHub', () => {
  test('recomputes an aggregate rather than forwarding a child state', () => {
    const hub = new CoordinatorHub();
    const states: OperationState[] = [];
    hub.subscribe((state) => states.push(state));

    const first = new OperationCoordinator();
    hub.add('first', first);
    const sync = first.tryBegin('syncing')!;
    expect(hub.state).toBe('syncing');

    // The trap: subscribe() fires synchronously with the new child's state. A hub that forwarded
    // would emit 'idle' here, the desktop would accept restartToUpdate and tear down mid-sync.
    const second = new OperationCoordinator();
    hub.add('second', second);
    expect(hub.state).toBe('syncing');

    sync.release();
    expect(hub.state).toBe('idle');
    expect(states).toEqual(['idle', 'syncing', 'idle']);
  });

  test('shuttingDown outranks every operation kind', () => {
    const hub = new CoordinatorHub();
    const first = new OperationCoordinator();
    const second = new OperationCoordinator();
    hub.add('first', first);
    hub.add('second', second);
    first.tryBegin('syncing');
    expect(hub.state).toBe('syncing');
    void second.beginShutdown();
    expect(hub.state).toBe('shuttingDown');
  });

  test('remove unsubscribes so an evicted coordinator cannot pin the aggregate', () => {
    const hub = new CoordinatorHub();
    const evicted = new OperationCoordinator();
    hub.add('evicted', evicted);
    void evicted.beginShutdown();
    expect(hub.state).toBe('shuttingDown');

    hub.remove('evicted');
    expect(hub.state).toBe('idle');
    // A stale child must not be able to resurrect a value after it has left the hub.
    evicted.tryBegin('syncing');
    expect(hub.state).toBe('idle');
  });

  test('closing a workspace never publishes shuttingDown to the aggregate', async () => {
    const { pool, hub, add } = harness();
    const profile = add('אור');
    const lease = await pool.acquire(profile.id);
    lease.release();

    const states: OperationState[] = [];
    hub.subscribe((state) => states.push(state));
    await pool.evict(profile.id);

    // The desktop is a separate process reading this aggregate: a `shuttingDown` here — for the
    // length of a TRUNCATE checkpoint — makes quitting ask to cancel, and an update refuse itself
    // as busy, over an eviction the user never asked about.
    expect(states).not.toContain('shuttingDown');
    expect(hub.state).toBe('idle');
  });
});

describe('scrape semaphore', () => {
  test('caps concurrent permits regardless of how many profiles ask', async () => {
    const semaphore = createScrapeSemaphore(2);
    let live = 0;
    let peak = 0;
    const work = async () => {
      const release = await semaphore.acquire();
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live -= 1;
      release();
    };
    await Promise.all(Array.from({ length: 6 }, work));
    expect(peak).toBe(2);
  });

  test('releasing twice does not hand out a phantom permit', async () => {
    const semaphore = createScrapeSemaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    let second = false;
    void semaphore.acquire().then(() => { second = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(second).toBe(true);

    let third = false;
    void semaphore.acquire().then(() => { third = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(third).toBe(false);
  });
});

describe('WorkspacePool', () => {
  test('opens lazily, reuses the workspace and never opens one twice concurrently', async () => {
    const { pool, add } = harness();
    const profile = add('אור');
    expect(pool.openWorkspaceCount).toBe(0);

    const [first, second] = await Promise.all([pool.acquire(profile.id), pool.acquire(profile.id)]);
    expect(pool.openWorkspaceCount).toBe(1);
    expect(first.workspace).toBe(second.workspace);
    first.release();
    second.release();
    await pool.closeAll();
  });

  test('an id outside the registry never reaches a path join', async () => {
    const { pool, store } = harness();
    const profile = store.create({ name: 'אור' });
    const dir = store.dirFor(profile.id);
    store.softDelete(store.create({ name: 'רותם' }).id);

    // `new FinanceDb` creates the file it is handed, so a deleted id must 404, never conjure
    // profiles/<deletedId>/finance.db for the next boot to adopt as a ghost.
    await expectProfileError(() => pool.acquire('00000000-0000-4000-8000-000000000000'), 'PROFILE_NOT_FOUND');
    expect(fs.existsSync(path.join(path.dirname(dir), '00000000-0000-4000-8000-000000000000'))).toBe(false);
    await pool.closeAll();
  });

  test('evict refuses a workspace that a request still holds', async () => {
    const { pool, add } = harness();
    const profile = add('אור');
    const lease = await pool.acquire(profile.id);

    // Ordinary reads take no coordinator lease at all: the refcount is the only thing that
    // knows an /api/dashboard is mid-flight.
    expect(lease.workspace.coordinator.state).toBe('idle');
    await expectProfileError(() => pool.evict(profile.id), 'PROFILE_BUSY');

    lease.release();
    await pool.evict(profile.id);
    expect(pool.openWorkspaceCount).toBe(0);
  });

  test('evict refuses a workspace that is still being opened', async () => {
    const { pool, store, add } = harness();
    const profile = add('אור');

    // Force openProfileDatabase down its awaiting branch: an unversioned file makes A4 take the
    // pre-upgrade backup, whose `await source.backup()` spans macrotasks. The workspace lives in
    // `opening`, not `entries`, for that whole window.
    const seeded = new FinanceDb(store.dbPathFor(profile.id));
    seeded.close();
    const raw = new Database(store.dbPathFor(profile.id));
    raw.pragma('user_version = 0');
    raw.close();

    const opening = pool.acquire(profile.id);
    await new Promise((resolve) => setImmediate(resolve));

    // A DELETE landing here must 409, not report "nothing to close" and let softDelete rename a
    // directory whose SQLite file the in-flight open still holds — that is EPERM, i.e. a 500.
    await expectProfileError(() => pool.evict(profile.id), 'PROFILE_BUSY');

    (await opening).release();
    await pool.evict(profile.id);
    expect(pool.openWorkspaceCount).toBe(0);
  });

  test('an id that leaves the registry mid-open never reaches the pool', async () => {
    const { pool, store, add } = harness();
    const profile = add('אור');

    // The real race — a rename landing in the gap between copyDatabaseWalSafe closing its source
    // and `new FinanceDb` opening the file — cannot be driven from a test on Windows: for the
    // whole rest of the open the handle is held, so the rename fails with EPERM before it can
    // interleave. Drop the id from the registry's answer instead, which is what that gap looks
    // like from `open`'s side, and assert the guard on the far side of the await.
    const realGet = store.get.bind(store);
    store.get = (() => undefined) as typeof store.get;
    try {
      // `new FinanceDb` creates the file it is handed, so an open that ignored this would hand
      // back a live workspace for a profile that no longer exists — and leave a ghost behind it.
      await expectProfileError(() => pool.acquire(profile.id), 'PROFILE_NOT_FOUND');
    } finally {
      store.get = realGet;
    }

    expect(pool.openWorkspaceCount).toBe(0);
    // The handle the aborted open created is closed, not leaked: the directory still moves.
    await pool.evict(profile.id);
    store.softDelete(store.create({ name: 'רותם' }).id);
    await pool.closeAll();
  });

  test('the open workspace count is reported as it changes, not only at boot', async () => {
    const changes: number[] = [];
    const { pool, add } = harness(8, () => changes.push(pool.openWorkspaceCount));

    // The desktop sizes its shutdown timeout from this count and only learns it from a state
    // message — but a lazily opened workspace is idle, so the hub's aggregate never changes and
    // emits nothing. Without its own channel the timeout stays pinned at the boot value (A16).
    const first = await pool.acquire(add('א').id);
    const second = await pool.acquire(add('ב').id);
    expect(changes).toEqual([1, 2]);

    first.release();
    second.release();
    await pool.evict(second.workspace.id);
    expect(changes).toEqual([1, 2, 1]);
  });

  test('evict refuses a workspace whose coordinator is busy', async () => {
    const { pool, add } = harness();
    const profile = add('אור');
    const lease = await pool.acquire(profile.id);
    const operation = lease.workspace.coordinator.tryBegin('syncing')!;
    lease.release();

    await expectProfileError(() => pool.evict(profile.id), 'PROFILE_BUSY');
    operation.release();
    await pool.evict(profile.id);
    expect(pool.openWorkspaceCount).toBe(0);
  });

  test('evict removes the coordinator from the aggregate', async () => {
    const { pool, hub, add } = harness();
    const profile = add('אור');
    (await pool.acquire(profile.id)).release();
    await pool.evict(profile.id);
    // beginShutdown fires during eviction; a coordinator left behind would pin the aggregate
    // to shuttingDown and the desktop would refuse every update from then on.
    expect(hub.state).toBe('idle');
  });

  test('the LRU evicts the coldest workspace once the cap is passed', async () => {
    const { pool, add } = harness(2);
    const first = add('א');
    const second = add('ב');
    const third = add('ג');

    (await pool.acquire(first.id)).release();
    (await pool.acquire(second.id)).release();
    expect(pool.openWorkspaceCount).toBe(2);

    (await pool.acquire(third.id)).release();
    expect(pool.openWorkspaceCount).toBe(2);
    // The coldest went; the newcomer is never a candidate for its own eviction.
    expect(pool.stats(first.id).connectionCount).toBe(0);
    await pool.closeAll();
  });

  test('the LRU never evicts a busy or in-use workspace, and yields the cap instead', async () => {
    const { pool, add } = harness(1);
    const busy = add('א');
    const held = add('ב');
    const newcomer = add('ג');

    const busyLease = await pool.acquire(busy.id);
    const operation = busyLease.workspace.coordinator.tryBegin('syncing')!;
    busyLease.release();
    const heldLease = await pool.acquire(held.id);

    await pool.acquire(newcomer.id);
    // Closing either of these would throw "the database connection is not open" mid-request.
    expect(pool.openWorkspaceCount).toBe(3);
    expect(() => heldLease.workspace.db.getSetting('month_bucketing')).not.toThrow();
    expect(() => busyLease.workspace.db.getSetting('month_bucketing')).not.toThrow();

    operation.release();
    heldLease.release();
    await pool.closeAll();
  });

  test('acquire is refused once the closed gate is set', async () => {
    const { pool, add } = harness();
    const profile = add('אור');
    (await pool.acquire(profile.id)).release();

    await pool.closeAll();
    // Without the gate, a late request builds a brand-new FinanceDb after everything has been
    // checkpointed and closed — with quitAndInstall next in line.
    await expectProfileError(() => pool.acquire(profile.id), 'RUNTIME_SHUTTING_DOWN');
    expect(pool.openWorkspaceCount).toBe(0);
  });

  test('closeAll gates the global profiles coordinator too', async () => {
    const { pool, globalCoordinator } = harness();
    await pool.closeAll();
    // POST /api/profiles must stop admitting: a profile created during shutdown would be
    // acquired by the follow-on /api/* after the pool had closed.
    expect(globalCoordinator.tryBegin('migrating')).toBeNull();
    expect(globalCoordinator.state).toBe('shuttingDown');
  });

  test('closeAll leaves every database closed and checkpointed', async () => {
    const { pool, add } = harness();
    const first = add('א');
    const second = add('ב');
    const firstLease = await pool.acquire(first.id);
    const secondLease = await pool.acquire(second.id);
    firstLease.release();
    secondLease.release();

    await pool.closeAll();
    expect(pool.openWorkspaceCount).toBe(0);
    expect(() => firstLease.workspace.db.getSetting('marker')).toThrow();
    expect(() => secondLease.workspace.db.getSetting('marker')).toThrow();
  });

  test('stats reads outside the pool and never throws', async () => {
    const { pool, store, add } = harness();
    const profile = add('אור');
    // A profile whose database was never opened is not a failure; it is simply empty.
    expect(pool.stats(profile.id)).toEqual({ connectionCount: null, lastSyncAt: null });
    expect(pool.openWorkspaceCount).toBe(0);

    const lease = await pool.acquire(profile.id);
    lease.workspace.db.setSetting('lastSyncAt', '2026-07-15T00:00:00.000Z');
    lease.release();
    expect(pool.stats(profile.id)).toEqual({ connectionCount: 0, lastSyncAt: '2026-07-15T00:00:00.000Z' });
    // Listing fifty profiles must not churn the LRU.
    expect(pool.openWorkspaceCount).toBe(1);

    // Windows refuses to unlink a file better-sqlite3 still holds — the same fact that forces
    // DELETE /api/profiles through the pool before it moves anything.
    await pool.evict(profile.id);
    fs.rmSync(store.dbPathFor(profile.id), { force: true });
    expect(pool.stats(profile.id)).toEqual({ connectionCount: null, lastSyncAt: null });
    expect(() => pool.stats('not-a-uuid')).not.toThrow();
    await pool.closeAll();
  });
});
