import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FinanceDb } from './db.js';
import { OperationCoordinator } from './operation-coordinator.js';
import { projectRoot } from './paths.js';
import { createGlobalBackupApi, createProfilesApi, respondProfileError } from './profiles-api.js';
import { createApi, type ApiOptions, type ScrapeSemaphore } from './routes.js';
import type { RuntimeInfo } from './runtime-info.js';
import type { BankScraper } from './scraper.js';
import type { ProfileManager, WorkspaceLease } from './workspaces.js';

export interface ApiSecurityOptions {
  token: string;
  /** Separate capability held by Electron main only. It is never exposed to the renderer. */
  desktopActionToken?: string;
  allowedOrigins?: string[];
}

interface AppDepsBase {
  scraper: BankScraper;
  /** Where backups live; tests pass a temp dir so they never touch real data. */
  dataDir?: string;
  backupsDir?: string;
  clientDist?: string;
  coordinator?: OperationCoordinator;
  runtime?: RuntimeInfo;
  apiSecurity?: ApiSecurityOptions;
  scrapeSemaphore?: ScrapeSemaphore;
  /** Injected in tests; production hits the free public rate providers via global fetch. */
  rateFetcher?: ApiOptions['rateFetcher'];
}

/** The single fixed workspace every existing test builds. */
export interface SingleWorkspaceAppDeps extends AppDepsBase {
  db: FinanceDb;
  profiles?: undefined;
}

/** The dispatching, multi-profile shape. */
export interface MultiProfileAppDeps extends AppDepsBase {
  profiles: ProfileManager;
  db?: undefined;
}

export type AppDeps = SingleWorkspaceAppDeps | MultiProfileAppDeps;

function constantTimeTokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function requestToken(req: express.Request): string | undefined {
  const authorization = req.header('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  return req.header('x-misgeret-token');
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(`http://${host}`);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  } catch {
    return false;
  }
}

function canonicalApiPath(requestPath: string): string | undefined {
  try {
    return decodeURIComponent(requestPath)
      .replace(/[\\/]+/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  } catch {
    return undefined;
  }
}

export function createApp(deps: AppDeps): express.Express {
  const {
    db,
    profiles,
    scraper,
    dataDir,
    backupsDir,
    clientDist = path.join(projectRoot, 'client', 'dist'),
    coordinator = new OperationCoordinator(),
    runtime,
    apiSecurity,
    scrapeSemaphore,
    rateFetcher,
  } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  if (apiSecurity) {
    const allowedOrigins = new Set(apiSecurity.allowedOrigins ?? []);
    app.use('/api', (req, res, next) => {
      if (!isLoopbackHost(req.headers.host)) {
        res.status(403).json({ errorType: 'FORBIDDEN_HOST' });
        return;
      }
      const origin = req.headers.origin;
      const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
      if (origin && !sameOrigin && !allowedOrigins.has(origin)) {
        res.status(403).json({ errorType: 'FORBIDDEN_ORIGIN' });
        return;
      }
      if (!constantTimeTokenMatches(requestToken(req), apiSecurity.token)) {
        res.status(401).json({ errorType: 'UNAUTHORIZED' });
        return;
      }
      const desktopActionAuthorized = Boolean(
        apiSecurity.desktopActionToken
        && constantTimeTokenMatches(req.header('x-misgeret-desktop-action'), apiSecurity.desktopActionToken),
      );
      if (desktopActionAuthorized) res.locals.desktopActionAuthorized = true;
      const canonicalPath = canonicalApiPath(req.path);
      const requiresDesktopAction = req.method === 'POST'
        && (canonicalPath === '/data/import' || canonicalPath === '/backup/automatic');
      if (requiresDesktopAction && !desktopActionAuthorized) {
        res.status(403).json({ errorType: 'DESKTOP_ACTION_REQUIRED' });
        return;
      }
      next();
    });
  }

  app.use(express.json());

  if (profiles) {
    // Global first, so the handshake answers pre-profile and the pre-update snapshot stays global.
    // Both routers fall through, leaving every other /api/* to the dispatcher below.
    const globalRouter = express.Router();
    if (runtime) globalRouter.get('/runtime', (_req, res) => res.json(runtime));
    globalRouter.use('/profiles', createProfilesApi(profiles));
    globalRouter.use(createGlobalBackupApi(profiles, {
      desktopActionAuthorizationRequired: Boolean(apiSecurity),
    }));
    app.use('/api', globalRouter);
    app.use('/api', createProfileDispatch(profiles));
  } else {
    app.use('/api', createApi(db, scraper, dataDir, {
      coordinator,
      runtime,
      backupsDir,
      scrapeSemaphore,
      rateFetcher,
      desktopActionAuthorizationRequired: Boolean(apiSecurity),
    }));
  }

  // In `npm start` mode the server also serves the built client
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
  }
  return app;
}

/**
 * Resolves `/api/*` to one profile's router: the `X-Misgeret-Profile` header when present,
 * otherwise the registry's activeId — which is what keeps main's header-less `runtimeFetch`
 * and every existing test working unchanged.
 *
 * The lease is taken before the router runs and released on both `finish` and `close`: an
 * ordinary read holds no coordinator lease, so the refcount is the only thing standing between
 * an in-flight `/api/dashboard` and an LRU eviction closing its database (A7).
 */
function createProfileDispatch(profiles: ProfileManager): express.RequestHandler {
  return (req, res, next) => {
    void (async () => {
      let lease: WorkspaceLease;
      try {
        const header = req.header('x-misgeret-profile');
        // A5.1: the registry decides before any path is joined — `new FinanceDb` would otherwise
        // conjure profiles/<deletedId>/finance.db and reconciliation would adopt the ghost.
        const id = header === undefined || header === ''
          ? profiles.store.resolveActiveId()
          : profiles.store.get(header)?.id;
        if (!id) {
          res.status(404).json({ errorType: 'PROFILE_NOT_FOUND' });
          return;
        }
        lease = await profiles.pool.acquire(id);
      } catch (err) {
        respondProfileError(res, err);
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        lease.release();
      };
      res.on('finish', release);
      res.on('close', release);
      try {
        lease.workspace.router(req, res, next);
      } catch (err) {
        release();
        respondProfileError(res, err);
      }
    })();
  };
}
