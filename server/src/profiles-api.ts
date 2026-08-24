import { Router, type Response } from 'express';
import path from 'node:path';
import { automaticBackupFileName, pruneAutomaticBackups } from './backup-policy.js';
import { ProfileError, type Profile, type ProfileErrorType } from './profiles.js';
import type { ProfileManager } from './workspaces.js';

export interface ProfileSummary extends Profile {
  connectionCount: number | null;
  lastSyncAt: string | null;
}

const STATUS_BY_ERROR: Record<ProfileErrorType, number> = {
  PROFILE_NOT_FOUND: 404,
  PROFILE_NAME_INVALID: 400,
  PROFILE_NAME_EXISTS: 409,
  LAST_PROFILE: 400,
  PROFILE_BUSY: 409,
  PROFILE_DELETE_FAILED: 500,
  PROFILE_OPEN_FAILED: 500,
  RUNTIME_SHUTTING_DOWN: 503,
  INVALID_INPUT: 400,
};

/** Every profile failure leaves the runtime in the house shape; a raw EPERM never escapes as a 500. */
export function respondProfileError(res: Response, err: unknown): void {
  if (err instanceof ProfileError) {
    res.status(STATUS_BY_ERROR[err.errorType]).json(
      err.errorMessage ? { errorType: err.errorType, errorMessage: err.errorMessage } : { errorType: err.errorType },
    );
    return;
  }
  console.error('[profiles] unexpected failure', { name: err instanceof Error ? err.name : 'Error' });
  res.status(500).json({ errorType: 'PROFILE_OPEN_FAILED' });
}

export function createProfilesApi(profiles: ProfileManager): Router {
  const router = Router();
  const { store, pool, coordinator } = profiles;

  const summarize = (profile: Profile): ProfileSummary => ({ ...profile, ...pool.stats(profile.id) });

  const guard = (res: Response, run: () => void) => {
    try {
      run();
    } catch (err) {
      respondProfileError(res, err);
    }
  };

  /** Serializes registry mutations against each other and stops admitting during shutdown. */
  const mutate = (res: Response, run: () => void) => {
    const operation = coordinator.tryBegin('migrating');
    if (!operation) {
      res.status(coordinator.state === 'shuttingDown' ? 503 : 409).json({
        errorType: coordinator.state === 'shuttingDown' ? 'RUNTIME_SHUTTING_DOWN' : 'APP_BUSY',
        operation: coordinator.state,
      });
      return;
    }
    try {
      run();
    } catch (err) {
      respondProfileError(res, err);
    } finally {
      operation.release();
    }
  };

  router.get('/', (_req, res) => {
    guard(res, () => {
      const listed = store.list();
      // Resolved, not just read: the client boots onto this and it is the same truth every
      // header-less desktop call resolves through. An unresolvable one is repaired here.
      res.json({ profiles: listed.map(summarize), activeId: listed.length > 0 ? store.resolveActiveId() : null });
    });
  });

  router.post('/', (req, res) => {
    mutate(res, () => {
      const { name, color } = (req.body ?? {}) as { name?: unknown; color?: unknown };
      res.status(201).json({ profile: summarize(store.create({ name, color })) });
    });
  });

  // Declared before '/:id' so a literal path can never be read as an id.
  router.post('/reorder', (req, res) => {
    mutate(res, () => {
      const { ids } = (req.body ?? {}) as { ids?: unknown };
      res.json({ profiles: store.reorder(ids).map(summarize) });
    });
  });

  router.put('/:id', (req, res) => {
    mutate(res, () => {
      const { name, color } = (req.body ?? {}) as { name?: unknown; color?: unknown };
      res.json({ profile: summarize(store.update(req.params.id, { name, color })) });
    });
  });

  router.post('/:id/activate', (req, res) => {
    mutate(res, () => {
      res.json({ activeId: store.setActive(req.params.id) });
    });
  });

  /**
   * Ordered by A6: the registry decides the id exists, the pool closes the handle, and only then
   * is the directory moved aside. Windows refuses to rename a directory holding an open SQLite
   * file, and the common path — switch to a profile, look at it, delete it — leaves it cached.
   */
  router.delete('/:id', (req, res) => {
    const operation = coordinator.tryBegin('migrating');
    if (!operation) {
      res.status(coordinator.state === 'shuttingDown' ? 503 : 409).json({
        errorType: coordinator.state === 'shuttingDown' ? 'RUNTIME_SHUTTING_DOWN' : 'APP_BUSY',
        operation: coordinator.state,
      });
      return;
    }
    void (async () => {
      try {
        const id = req.params.id;
        if (!store.get(id)) throw new ProfileError('PROFILE_NOT_FOUND');
        if (store.list().length === 1) throw new ProfileError('LAST_PROFILE', 'the last profile cannot be deleted');
        await pool.evict(id);
        store.softDelete(id);
        res.status(204).end();
      } catch (err) {
        respondProfileError(res, err);
      } finally {
        operation.release();
      }
    })();
  });

  return router;
}

/**
 * A10: the pre-update snapshot is global and fans out over every profile.
 *
 * A snapshot exists to survive a bad new build in ways we cannot predict, which is inherently
 * global — "the addressed profile" is a meaningless notion for it. Before multi-profile this route
 * protected 100% of the user's money; per-active it would protect 1/N.
 */
export function createGlobalBackupApi(
  profiles: ProfileManager,
  options: { desktopActionAuthorizationRequired?: boolean } = {},
): Router {
  const router = Router();

  router.post('/backup/automatic', (req, res) => {
    if (options.desktopActionAuthorizationRequired && res.locals.desktopActionAuthorized !== true) {
      res.status(403).json({ errorType: 'DESKTOP_ACTION_REQUIRED' });
      return;
    }
    if ((req.body as { reason?: unknown } | undefined)?.reason !== 'update') {
      res.status(400).json({ errorType: 'INVALID_INPUT' });
      return;
    }
    void (async () => {
      const targets = profiles.store.list();
      const results: Array<{ profileId: string; file: string }> = [];
      let failed = 0;
      for (const profile of targets) {
        try {
          const lease = await profiles.pool.acquire(profile.id);
          const operation = lease.workspace.coordinator.tryBegin('backingUp');
          if (!operation) {
            lease.release();
            res.status(409).json({ errorType: 'APP_BUSY', operation: lease.workspace.coordinator.state });
            return;
          }
          try {
            const file = automaticBackupFileName('update');
            const backupsDir = profiles.store.backupsDirFor(profile.id);
            await lease.workspace.db.backupTo(path.join(backupsDir, file));
            pruneAutomaticBackups(backupsDir);
            results.push({ profileId: profile.id, file });
          } finally {
            operation.release();
            lease.release();
          }
        } catch (err) {
          failed += 1;
          console.error('[profiles] pre-update backup failed for a profile', {
            name: err instanceof Error ? err.name : 'Error',
          });
        }
      }
      if (failed > 0) {
        // Partial failure is reported as failure: the updater must abort rather than install over
        // data it only half-snapshotted.
        res.status(500).json({ errorType: 'BACKUP_FAILED', errorMessage: `${failed}/${targets.length} profiles failed` });
        return;
      }
      res.status(201).json({ results });
    })();
  });

  return router;
}
