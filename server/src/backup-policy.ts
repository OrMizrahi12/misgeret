import fs from 'node:fs';
import path from 'node:path';

export type AutomaticBackupReason = 'migration' | 'import' | 'restore' | 'update' | 'wipe';

function timestamp(now: Date): string {
  return now.toISOString().slice(0, 23).replace(/[T:.]/g, '-');
}

export function manualBackupFileName(now = new Date()): string {
  return `finance-${timestamp(now)}.db`;
}

export function automaticBackupFileName(reason: AutomaticBackupReason, now = new Date()): string {
  return `auto-${reason}-finance-${timestamp(now)}.db`;
}

export function isManualBackupFile(fileName: string): boolean {
  return /^finance-[\d-]+\.db$/.test(fileName);
}

export function isAutomaticBackupFile(fileName: string): boolean {
  return /^auto-(?:migration|import|restore|update|wipe)-finance-[\d-]+\.db$/.test(fileName);
}

/** Deletes only old automatic safety copies. Manual backups are never considered. */
export function pruneAutomaticBackups(backupsDir: string, keep = 10): string[] {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('automatic backup retention must be positive');
  if (!fs.existsSync(backupsDir)) return [];
  const candidates = fs.readdirSync(backupsDir)
    .filter(isAutomaticBackupFile)
    .map((file) => ({ file, mtimeMs: fs.statSync(path.join(backupsDir, file)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.file.localeCompare(left.file));
  const removed: string[] = [];
  for (const candidate of candidates.slice(keep)) {
    fs.rmSync(path.join(backupsDir, candidate.file));
    removed.push(candidate.file);
  }
  return removed;
}
