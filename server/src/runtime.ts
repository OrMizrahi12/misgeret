import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type express from 'express';
import { createApp } from './app.js';
import { configureCredentialEncryptionKey } from './credentials.js';
import type { FinanceDb } from './db.js';
import { OperationCoordinator, type OperationState } from './operation-coordinator.js';
import { resolveRuntimePaths, type RuntimePaths } from './paths.js';
import { ProfileStore, migrateLegacyIntoProfile } from './profiles.js';
import { API_SCHEMA_VERSION, type RuntimeInfo } from './runtime-info.js';
import { createBankScraper, type BankScraper } from './scraper.js';
import { CoordinatorHub, WorkspacePool, createScrapeSemaphore, type ProfileManager } from './workspaces.js';

export interface StartServerConfig {
  paths?: Partial<RuntimePaths>;
  /** Direct aliases keep embedders simple; values override the same field in `paths`. */
  dataDir?: string;
  dbPath?: string;
  clientDist?: string;
  host?: string;
  port?: number;
  appVersion?: string;
  buildId?: string;
  apiToken?: string;
  desktopActionToken?: string;
  credentialEncryptionKey?: string;
  allowedOrigins?: string[];
  browserExecutablePath?: string;
  scraper?: BankScraper;
  onStateChange?: (state: OperationState) => void;
}

/** The aggregate the desktop reads. Both a lone coordinator and the hub satisfy it. */
export interface OperationStateSource {
  readonly state: OperationState;
  subscribe(listener: (state: OperationState) => void): () => void;
}

export interface ServerHandle {
  app: express.Express;
  /** The active profile at boot. Every other profile is opened lazily, by the pool. */
  db: FinanceDb;
  scraper: BankScraper;
  /** Busy iff *any* profile is busy — a sync in one must not read as idle for the whole app. */
  coordinator: OperationStateSource;
  profiles: ProfileManager;
  paths: RuntimePaths;
  host: string;
  port: number;
  origin: string;
  runtime: RuntimeInfo;
  close(): Promise<void>;
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections?.();
  });
}

interface EmbeddedBuildManifest {
  version?: unknown;
  buildId?: unknown;
  apiSchemaVersion?: unknown;
}

function readEmbeddedBuildManifest(): EmbeddedBuildManifest | undefined {
  try {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(moduleDirectory, 'build-manifest.json'), 'utf8')) as EmbeddedBuildManifest;
  } catch {
    return undefined;
  }
}

/** Starts the local financial engine without any CLI or Electron side effects. */
export async function startServer(config: StartServerConfig = {}): Promise<ServerHandle> {
  const configuredCredentialKey = config.credentialEncryptionKey ?? process.env.MISGERET_CREDENTIAL_KEY;
  if (configuredCredentialKey) configureCredentialEncryptionKey(configuredCredentialKey);
  const embeddedBuild = readEmbeddedBuildManifest();
  if (
    embeddedBuild?.apiSchemaVersion !== undefined
    && String(embeddedBuild.apiSchemaVersion) !== String(API_SCHEMA_VERSION)
  ) {
    throw new Error('compiled server manifest does not match the API schema implemented by this runtime');
  }
  const host = config.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('financial runtime may only bind to a loopback address');
  }
  const paths = resolveRuntimePaths({
    ...config.paths,
    ...(config.dataDir ? { dataDir: config.dataDir } : {}),
    ...(config.dbPath ? { dbPath: config.dbPath } : {}),
    ...(config.clientDist ? { clientDist: config.clientDist } : {}),
  });
  // `backupsDir` is deliberately absent: it is a migration source, and an empty `backups/` beside
  // `profiles/` reads to the user as "my backups were destroyed" (A1).
  for (const dir of [paths.dataDir, paths.logsDir, paths.browserTempDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const store = new ProfileStore();
  migrateLegacyIntoProfile(paths, store);

  // Beside the logs, because that is the folder "פתיחת יומן האבחון" already opens: when a sync
  // fails on someone else's machine, the picture of the moment it stuck is the only evidence
  // anyone has. It never leaves this computer — nothing uploads or exports this directory.
  const scraper = config.scraper ?? createBankScraper({
    browserExecutablePath: config.browserExecutablePath,
    failureScreenshotDir: path.join(paths.logsDir, 'scrape-failures'),
  });
  const hub = new CoordinatorHub();
  const globalCoordinator = new OperationCoordinator();
  hub.add('__profiles__', globalCoordinator);
  if (config.onStateChange) hub.subscribe(config.onStateChange);

  const runtime: RuntimeInfo = {
    appVersion:
      (typeof embeddedBuild?.version === 'string' ? embeddedBuild.version : undefined)
      ?? config.appVersion
      ?? process.env.npm_package_version
      ?? '0.0.0-dev',
    buildId:
      (typeof embeddedBuild?.buildId === 'string' ? embeddedBuild.buildId : undefined)
      ?? config.buildId
      ?? 'web-dev',
    apiSchemaVersion: API_SCHEMA_VERSION,
    // Both are stamped from the eager acquire below, before anything can listen and ask.
    dbSchemaVersion: 0,
    activeProfileId: '',
    initialization: 'ready',
  };

  const pool = new WorkspacePool({
    store,
    scraper,
    hub,
    globalCoordinator,
    scrapeSemaphore: createScrapeSemaphore(2),
    runtime,
    rootDataDir: paths.dataDir,
    desktopActionAuthorizationRequired: Boolean(config.apiToken),
    // A16: the desktop sizes its shutdown timeout from the open workspace count, and the only
    // message that carries it is the state message. Re-report the aggregate — unchanged as it
    // usually is — so the count riding along with it is current when the user quits.
    onOpenCountChange: config.onStateChange
      ? () => config.onStateChange?.(hub.state)
      : undefined,
  });
  const profiles: ProfileManager = {
    store,
    pool,
    hub,
    coordinator: globalCoordinator,
    get openWorkspaceCount() {
      return pool.openWorkspaceCount;
    },
  };

  // A9: the active profile is opened eagerly, and only it. Boot must still prove the database
  // opens, migrates and rebuckets before `initialization: 'ready'` — a failure has to abort the
  // launch loudly rather than surface at the first /api/* request.
  let bootDb: FinanceDb;
  try {
    const activeId = store.resolveActiveId();
    const lease = await pool.acquire(activeId);
    bootDb = lease.workspace.db;
    runtime.dbSchemaVersion = bootDb.getSchemaVersion();
    runtime.activeProfileId = activeId;
    // Seeds the pool; it must not pin it.
    lease.release();
  } catch (err) {
    await scraper.dispose?.();
    await pool.closeAll();
    throw err;
  }

  const app = createApp({
    profiles,
    scraper,
    dataDir: paths.dataDir,
    clientDist: paths.clientDist,
    runtime,
    apiSecurity: config.apiToken
      ? {
          token: config.apiToken,
          desktopActionToken: config.desktopActionToken,
          allowedOrigins: config.allowedOrigins,
        }
      : undefined,
  });

  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(config.port ?? 0, host);
      const onError = (err: Error) => reject(err);
      candidate.once('error', onError);
      candidate.once('listening', () => {
        candidate.off('error', onError);
        resolve(candidate);
      });
    });
  } catch (err) {
    await scraper.dispose?.();
    await pool.closeAll();
    throw err;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    await pool.closeAll();
    throw new Error('runtime did not receive a TCP address');
  }
  const port = address.port;
  const origin = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  let closePromise: Promise<void> | null = null;

  const handle: ServerHandle = {
    app,
    db: bootDb,
    scraper,
    coordinator: hub,
    profiles,
    paths,
    host,
    port,
    origin,
    runtime,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        // Gates first and synchronously, so nothing new is admitted anywhere while we drain.
        pool.beginShutdown();
        // Disposed before the drain, and exactly once: an in-flight scrape aborts and releases
        // its lease, which is what keeps the drain inside the desktop's shutdown budget.
        await scraper.dispose?.();
        await closeHttpServer(server);
        await pool.closeAll();
      })();
      return closePromise;
    },
  };
  return handle;
}
