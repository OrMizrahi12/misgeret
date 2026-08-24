import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // <root>/server/src
export const projectRoot = path.resolve(here, '..', '..');
export const dataDir = process.env.DATA_DIR ?? path.join(projectRoot, 'data');
export const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'finance.db');

export interface RuntimePaths {
  dataDir: string;
  /**
   * The pre-multi-profile database to be adopted into the first profile. Read by migration and
   * never again: live databases live at <dataDir>/profiles/<id>/finance.db.
   */
  dbPath: string;
  /**
   * The pre-multi-profile backup directory to be adopted into the first profile. Read by
   * migration and never again: live backups live at <dataDir>/profiles/<id>/backups.
   */
  backupsDir: string;
  logsDir: string;
  browserTempDir: string;
  clientDist: string;
}

export function resolveRuntimePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  const resolvedDataDir = path.resolve(overrides.dataDir ?? dataDir);
  return {
    dataDir: resolvedDataDir,
    dbPath: path.resolve(overrides.dbPath ?? process.env.DB_PATH ?? path.join(resolvedDataDir, 'finance.db')),
    backupsDir: path.resolve(overrides.backupsDir ?? path.join(resolvedDataDir, 'backups')),
    logsDir: path.resolve(overrides.logsDir ?? path.join(resolvedDataDir, 'logs')),
    browserTempDir: path.resolve(overrides.browserTempDir ?? path.join(resolvedDataDir, 'browser-temp')),
    clientDist: path.resolve(overrides.clientDist ?? path.join(projectRoot, 'client', 'dist')),
  };
}

export const defaultRuntimePaths = resolveRuntimePaths();
