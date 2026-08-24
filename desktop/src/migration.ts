import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePaths } from './contracts.js';
import { hasExistingData } from './paths.js';

export interface LegacyMigrationSummary {
  migrated: boolean;
  reason: 'completed' | 'no-legacy-data' | 'target-already-initialized' | 'same-root';
  copiedFiles: string[];
}

function copyFileAtomic(source: string, destination: string): void {
  const partial = `${destination}.migrating`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, partial);
  if (fs.statSync(source).size !== fs.statSync(partial).size) {
    fs.rmSync(partial, { force: true });
    throw Object.assign(new Error('Legacy data copy did not match the source size.'), {
      code: 'MIGRATION_COPY_MISMATCH',
    });
  }
  fs.rmSync(destination, { force: true });
  fs.renameSync(partial, destination);
}

function copyIfExists(source: string, destination: string, copied: string[]): void {
  if (!fs.existsSync(source)) return;
  copyFileAtomic(source, destination);
  copied.push(destination);
}

/** Copies a SQLite sidecar, or removes a stale one left by an interrupted attempt. */
function syncSidecar(source: string, destination: string, copied: string[]): void {
  if (fs.existsSync(source)) {
    copyFileAtomic(source, destination);
    copied.push(destination);
  } else {
    fs.rmSync(destination, { force: true });
  }
}

/**
 * One-time move from a legacy Windows data layout whose data root was also the Squirrel install
 * directory. The source is never modified: an interrupted migration
 * simply reruns on the next launch because the target's data — copied last — is the
 * gate that marks it as initialized. Logs, browser-temp, and Chromium session caches are
 * transient and intentionally left behind.
 *
 * The gate asks hasExistingData, not existsSync(dbPath): the runtime adopts <dataDir>/finance.db
 * into profiles/<id>/, so a dbPath gate would be false forever after and re-copy the stale
 * LocalAppData database — and its first-run.pending — on every single boot.
 */
export function migrateLegacyRuntimeData(
  legacyRootDir: string,
  target: RuntimePaths,
): LegacyMigrationSummary {
  const legacyRoot = path.resolve(legacyRootDir);
  if (legacyRoot === path.resolve(target.rootDir)) {
    return { migrated: false, reason: 'same-root', copiedFiles: [] };
  }

  const legacyDbPath = path.join(legacyRoot, 'data', 'finance.db');
  if (!fs.existsSync(legacyDbPath)) {
    return { migrated: false, reason: 'no-legacy-data', copiedFiles: [] };
  }
  if (hasExistingData(target)) {
    return { migrated: false, reason: 'target-already-initialized', copiedFiles: [] };
  }

  const copied: string[] = [];

  const legacyElectronDir = path.join(legacyRoot, 'electron');
  for (const name of ['preferences.json', 'window-state.json', 'first-run.pending']) {
    copyIfExists(path.join(legacyElectronDir, name), path.join(target.electronDir, name), copied);
  }

  const legacyBackupsDir = path.join(legacyRoot, 'backups');
  if (fs.existsSync(legacyBackupsDir)) {
    for (const entry of fs.readdirSync(legacyBackupsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      copyIfExists(path.join(legacyBackupsDir, entry.name), path.join(target.backupsDir, entry.name), copied);
    }
  }

  // Sidecars are synced before the database file so a crash between the two leaves the
  // target uninitialized (no finance.db) rather than initialized with stale sidecars.
  syncSidecar(`${legacyDbPath}-wal`, `${target.dbPath}-wal`, copied);
  syncSidecar(`${legacyDbPath}-shm`, `${target.dbPath}-shm`, copied);
  copyFileAtomic(legacyDbPath, target.dbPath);
  copied.push(target.dbPath);

  return { migrated: true, reason: 'completed', copiedFiles: copied };
}
