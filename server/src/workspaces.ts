import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type express from 'express';
import { automaticBackupFileName, pruneAutomaticBackups } from './backup-policy.js';
import { companyKind } from './companies.js';
import {
  DATABASE_SCHEMA_VERSION,
  FinanceDb,
  copyDatabaseWalSafe,
  inspectDatabaseFile,
  migrateLegacy,
  recoverInterruptedDatabase,
} from './db.js';
import { OperationCoordinator, type OperationState } from './operation-coordinator.js';
import { ProfileError, ProfileStore } from './profiles.js';
import { createApi, type ApiOptions, type ScrapeSemaphore } from './routes.js';
import type { RuntimeInfo } from './runtime-info.js';
import type { BankScraper } from './scraper.js';
import { monthKey } from './txns.js';

/** Eight open databases is generous for a family and bounded for memory. */
const DEFAULT_MAX_OPEN_WORKSPACES = 8;

export interface Workspace {
  id: string;
  db: FinanceDb;
  paths: { dataDir: string; dbPath: string; backupsDir: string };
  coordinator: OperationCoordinator;
  router: express.Router;
  lastUsedAt: number;
}

export interface WorkspaceLease {
  readonly workspace: Workspace;
  release(): void;
}

export interface ProfileStats {
  connectionCount: number | null;
  lastSyncAt: string | null;
}

/**
 * Today's boot sequence, per profile.
 *
 * The bucketing half of the backup condition is load-bearing: the card rebucket below fires on a
 * settings marker, independent of the schema version, so a build that changes bucketing without
 * bumping DATABASE_SCHEMA_VERSION would rewrite rows with no pre-upgrade backup at all (A4).
 */
export async function openProfileDatabase(
  dbPath: string,
  backupsDir: string,
  profileDir: string,
): Promise<FinanceDb> {
  fs.mkdirSync(profileDir, { recursive: true });
  recoverInterruptedDatabase(dbPath);

  if (fs.existsSync(dbPath)) {
    const metadata = inspectDatabaseFile(dbPath);
    if (metadata.schemaVersion < DATABASE_SCHEMA_VERSION || metadata.bucketing !== 'charge-v4') {
      await copyDatabaseWalSafe(dbPath, path.join(backupsDir, automaticBackupFileName('migration')));
      pruneAutomaticBackups(backupsDir);
    }
  }

  const db = new FinanceDb(dbPath);
  try {
    // A3: unconditional. A profile that does not own the blob finds no file and returns.
    migrateLegacy(db, profileDir);
    if (db.getSetting('month_bucketing') !== 'charge-v4') {
      const changed = db.rebucketCardMonths((company) => companyKind(company) === 'card', monthKey);
      db.setSetting('month_bucketing', 'charge-v4');
      if (changed > 0) console.log(`[migrate] re-bucketed ${changed} card transactions to their charge month`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * Fans every per-profile coordinator into the one scalar the desktop consumes.
 *
 * It recomputes on every child change and never forwards a child state. `subscribe` invokes its
 * listener synchronously with the current state, so a forwarding hub would emit 'idle' the moment
 * a second workspace was lazily created during another profile's sync — and the desktop would
 * accept `restartToUpdate` and tear the runtime down mid-scrape (A8).
 */
export class CoordinatorHub {
  private members = new Map<string, { coordinator: OperationCoordinator; unsubscribe: () => void }>();
  private listeners = new Set<(state: OperationState) => void>();
  private current: OperationState = 'idle';

  get state(): OperationState {
    return this.current;
  }

  add(id: string, coordinator: OperationCoordinator): void {
    if (this.members.has(id)) return;
    const member = { coordinator, unsubscribe: () => {} };
    // Registered before subscribing so the synchronous first callback already sees this member.
    this.members.set(id, member);
    member.unsubscribe = coordinator.subscribe(() => this.recompute());
    this.recompute();
  }

  remove(id: string): void {
    const member = this.members.get(id);
    if (!member) return;
    member.unsubscribe();
    this.members.delete(id);
    this.recompute();
  }

  subscribe(listener: (state: OperationState) => void): () => void {
    this.listeners.add(listener);
    try {
      listener(this.current);
    } catch {
      // Runtime observers must never be able to break operation admission.
    }
    return () => this.listeners.delete(listener);
  }

  /** shuttingDown > any OperationKind > idle; among kinds, first non-idle by insertion order. */
  private recompute(): void {
    let next: OperationState = 'idle';
    for (const { coordinator } of this.members.values()) {
      const state = coordinator.state;
      if (state === 'shuttingDown') {
        next = 'shuttingDown';
        break;
      }
      if (state !== 'idle' && next === 'idle') next = state;
    }
    if (next === this.current) return;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        // State reporting is advisory; operation safety remains authoritative here.
      }
    }
  }
}

/** Two headless browsers total, however many profiles are syncing. They are the scarce resource. */
export function createScrapeSemaphore(limit = 2): ScrapeSemaphore {
  let available = limit;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    available += 1;
  };
  return {
    acquire(): Promise<() => void> {
      if (available > 0) {
        available -= 1;
        return Promise.resolve(once(release));
      }
      return new Promise<() => void>((resolve) => {
        waiting.push(() => resolve(once(release)));
      });
    },
  };
}

function once(fn: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

export interface WorkspacePoolOptions {
  store: ProfileStore;
  scraper: BankScraper;
  hub: CoordinatorHub;
  /** Gated at shutdown alongside every workspace, so POST /api/profiles stops admitting too (A7). */
  globalCoordinator: OperationCoordinator;
  scrapeSemaphore: ScrapeSemaphore;
  runtime?: RuntimeInfo;
  rootDataDir: string;
  desktopActionAuthorizationRequired?: boolean;
  /** Injected in tests; production hits the free public rate providers via global fetch. */
  rateFetcher?: ApiOptions['rateFetcher'];
  maxOpen?: number;
  /**
   * Fired whenever the number of open workspaces changes. The desktop sizes its shutdown timeout
   * from this count and only ever learns it from a runtime state message — but the hub cannot
   * carry it: a lazily opened workspace is idle, so the aggregate does not change and `recompute`
   * emits nothing. Without this the timeout stays pinned at the boot value forever (A16).
   */
  onOpenCountChange?: () => void;
}

interface PoolEntry {
  workspace: Workspace;
  refcount: number;
}

export class WorkspacePool {
  private entries = new Map<string, PoolEntry>();
  private opening = new Map<string, Promise<PoolEntry>>();
  private closed = false;
  private readonly maxOpen: number;

  constructor(private readonly options: WorkspacePoolOptions) {
    this.maxOpen = options.maxOpen ?? DEFAULT_MAX_OPEN_WORKSPACES;
  }

  get openWorkspaceCount(): number {
    return this.entries.size;
  }

  /**
   * Leases are refcounted, never inferred. Only six handlers take a coordinator lease and every
   * ordinary read takes none, so an idle-looking workspace can be mid-`/api/dashboard` — closing
   * it under that read throws "database connection is not open" (A7).
   */
  async acquire(id: string): Promise<WorkspaceLease> {
    if (this.closed) throw new ProfileError('RUNTIME_SHUTTING_DOWN', 'the runtime is shutting down');
    // A5.1: the registry decides an id exists before any path is joined. `new FinanceDb` creates
    // the file it is handed, so a deleted id must never reach `openProfileDatabase`.
    this.options.store.dirFor(id);

    const entry = await this.entryFor(id);
    if (this.closed) throw new ProfileError('RUNTIME_SHUTTING_DOWN', 'the runtime is shutting down');
    entry.refcount += 1;
    entry.workspace.lastUsedAt = Date.now();
    let released = false;
    return {
      workspace: entry.workspace,
      release: () => {
        if (released) return;
        released = true;
        entry.refcount -= 1;
        entry.workspace.lastUsedAt = Date.now();
      },
    };
  }

  private async entryFor(id: string): Promise<PoolEntry> {
    const existing = this.entries.get(id);
    if (existing) return existing;
    const inFlight = this.opening.get(id);
    if (inFlight) return inFlight;

    const opening = this.open(id).finally(() => this.opening.delete(id));
    this.opening.set(id, opening);
    return opening;
  }

  private async open(id: string): Promise<PoolEntry> {
    const store = this.options.store;
    const profileDir = store.dirFor(id);
    const dbPath = store.dbPathFor(id);
    const backupsDir = store.backupsDirFor(id);

    let db: FinanceDb;
    try {
      db = await openProfileDatabase(dbPath, backupsDir, profileDir);
    } catch (err) {
      console.error('[profiles] could not open a profile database', {
        name: err instanceof Error ? err.name : 'Error',
      });
      throw new ProfileError('PROFILE_OPEN_FAILED', 'the profile database could not be opened');
    }
    // closeAll may have run while this open was in flight; it would never see this handle.
    if (this.closed) {
      db.close();
      throw new ProfileError('RUNTIME_SHUTTING_DOWN', 'the runtime is shutting down');
    }
    // A5.1 again, on the far side of the await: `openProfileDatabase` genuinely spans macrotasks,
    // and `new FinanceDb` creates the file it is handed. An id that left the registry mid-open
    // must never reach `entries` — it would be served, and the next boot's reconciliation would
    // adopt it as `משתמש <n>`: the profile the user just deleted, back as an empty ghost.
    if (!store.get(id)) {
      db.close();
      throw new ProfileError('PROFILE_NOT_FOUND');
    }

    const coordinator = new OperationCoordinator();
    const workspace: Workspace = {
      id,
      db,
      paths: { dataDir: profileDir, dbPath, backupsDir },
      coordinator,
      router: createApi(db, this.options.scraper, profileDir, {
        coordinator,
        runtime: this.options.runtime,
        backupsDir,
        profileId: id,
        rootDataDir: this.options.rootDataDir,
        scrapeSemaphore: this.options.scrapeSemaphore,
        desktopActionAuthorizationRequired: this.options.desktopActionAuthorizationRequired,
        rateFetcher: this.options.rateFetcher,
      }),
      lastUsedAt: Date.now(),
    };
    const entry: PoolEntry = { workspace, refcount: 0 };
    this.entries.set(id, entry);
    this.options.hub.add(id, coordinator);
    this.notifyOpenCount();
    await this.enforceCap(id);
    return entry;
  }

  private notifyOpenCount(): void {
    try {
      this.options.onOpenCountChange?.();
    } catch {
      // Reporting is advisory; it must never break admission, eviction or shutdown.
    }
  }

  /** Never evicts a workspace that is busy or in use; the cap yields rather than break a request. */
  private async enforceCap(keepId: string): Promise<void> {
    if (this.entries.size <= this.maxOpen) return;
    const evictable = [...this.entries.values()]
      // The workspace this open is about to hand back is not a candidate for its own eviction.
      .filter((entry) => entry.workspace.id !== keepId && this.isEvictable(entry))
      .sort((left, right) => left.workspace.lastUsedAt - right.workspace.lastUsedAt);
    for (const entry of evictable) {
      if (this.entries.size <= this.maxOpen) return;
      await this.closeEntry(entry);
    }
  }

  private isEvictable(entry: PoolEntry): boolean {
    return entry.refcount === 0 && entry.workspace.coordinator.state === 'idle';
  }

  /** Closes the handle so the directory can be renamed. Windows refuses to move an open SQLite file. */
  async evict(id: string): Promise<void> {
    // A workspace being opened lives in `opening`, not `entries`, and the open is not instant:
    // A4's pre-upgrade backup awaits a real `db.backup()` on every profile's first open after a
    // schema or bucketing change. Reporting "nothing to close" here lets softDelete rename a
    // directory whose SQLite file the in-flight open still holds — EPERM, surfaced as a 500,
    // which is exactly the failure A6's 409 exists to prevent.
    if (this.opening.has(id)) throw new ProfileError('PROFILE_BUSY', 'the profile is being opened');
    const entry = this.entries.get(id);
    if (!entry) return;
    if (!this.isEvictable(entry)) throw new ProfileError('PROFILE_BUSY', 'the profile is in use');
    await this.closeEntry(entry);
  }

  private async closeEntry(entry: PoolEntry): Promise<void> {
    const { workspace } = entry;
    // The member leaves the hub BEFORE its coordinator is shut down: `beginShutdown` emits, and a
    // member still in the hub would push `shuttingDown` into the aggregate for the whole length of
    // the checkpoint below — seconds, on a large WAL. Main is a separate process and reads that as
    // "an operation is running", so an eviction the user never asked about would make quitting ask
    // "לצאת ולבטל אותה?" and an update refuse itself as busy. Removing first also keeps the
    // guarantee this ordering originally protected: a coordinator left in `shuttingDown` by a
    // failed close is already out of the hub and can never pin the aggregate non-idle.
    this.options.hub.remove(workspace.id);
    try {
      await workspace.coordinator.beginShutdown();
      workspace.db.checkpoint('TRUNCATE');
      workspace.db.close();
    } finally {
      this.entries.delete(workspace.id);
      this.notifyOpenCount();
    }
  }

  /**
   * A7 steps 1-2, synchronously: the closed gate and every admission gate, before any await. A
   * request landing after a snapshot of the map would otherwise build a brand-new FinanceDb after
   * everything had been checkpointed and closed — with `quitAndInstall` next in line.
   */
  beginShutdown(): void {
    this.closed = true;
    void this.options.globalCoordinator.beginShutdown();
    for (const entry of this.entries.values()) void entry.workspace.coordinator.beginShutdown();
  }

  /** Concurrent by design: serial checkpoints do not fit the desktop's shutdown budget (A16). */
  async closeAll(): Promise<void> {
    this.beginShutdown();
    const entries = [...this.entries.values()];
    await Promise.all([
      this.options.globalCoordinator.waitForIdle(),
      ...entries.map((entry) => entry.workspace.coordinator.waitForIdle()),
    ]);
    await Promise.all(entries.map(async (entry) => {
      try {
        entry.workspace.db.checkpoint('TRUNCATE');
        entry.workspace.db.close();
      } catch (err) {
        console.error('[profiles] a profile database did not close cleanly', {
          name: err instanceof Error ? err.name : 'Error',
        });
      } finally {
        this.options.hub.remove(entry.workspace.id);
        this.entries.delete(entry.workspace.id);
      }
    }));
  }

  /**
   * Outside the pool and outside the refcount on purpose: listing fifty profiles must not churn
   * the LRU, and it must never throw — an unreadable file is reported as nulls.
   */
  stats(id: string): ProfileStats {
    try {
      const dbPath = this.options.store.dbPathFor(id);
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      try {
        const connections = db.prepare('SELECT COUNT(*) AS total FROM connections').get() as { total: number };
        const lastSync = db.prepare("SELECT value FROM settings WHERE key = 'lastSyncAt'").get() as
          | { value?: string }
          | undefined;
        return { connectionCount: Number(connections.total), lastSyncAt: lastSync?.value ?? null };
      } finally {
        db.close();
      }
    } catch {
      return { connectionCount: null, lastSyncAt: null };
    }
  }
}

/** Everything `createApp` and the desktop need to reach the live per-profile stacks. */
export interface ProfileManager {
  store: ProfileStore;
  pool: WorkspacePool;
  hub: CoordinatorHub;
  /** The global /api/profiles coordinator. */
  coordinator: OperationCoordinator;
  readonly openWorkspaceCount: number;
}
