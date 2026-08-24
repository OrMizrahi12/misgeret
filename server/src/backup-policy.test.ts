import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  automaticBackupFileName,
  isAutomaticBackupFile,
  isManualBackupFile,
  manualBackupFileName,
  pruneAutomaticBackups,
} from './backup-policy.js';

describe('desktop backup retention', () => {
  test('manual and automatic files have disjoint validated names', () => {
    const now = new Date('2026-07-14T08:00:00.123Z');
    expect(manualBackupFileName(now)).toBe('finance-2026-07-14-08-00-00-123.db');
    expect(automaticBackupFileName('update', now)).toBe('auto-update-finance-2026-07-14-08-00-00-123.db');
    expect(isManualBackupFile(manualBackupFileName(now))).toBe(true);
    expect(isAutomaticBackupFile(automaticBackupFileName('update', now))).toBe(true);
    expect(isAutomaticBackupFile(manualBackupFileName(now))).toBe(false);
  });

  test('retains ten newest automatic backups and never removes manual backups', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-backup-retention-'));
    const manual = manualBackupFileName(new Date('2026-01-01T00:00:00.000Z'));
    fs.writeFileSync(path.join(directory, manual), 'MANUAL');
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
      const file = automaticBackupFileName('restore', date);
      const target = path.join(directory, file);
      fs.writeFileSync(target, String(index));
      fs.utimesSync(target, date, date);
    }

    expect(pruneAutomaticBackups(directory)).toHaveLength(2);
    expect(fs.readFileSync(path.join(directory, manual), 'utf8')).toBe('MANUAL');
    expect(fs.readdirSync(directory).filter(isAutomaticBackupFile)).toHaveLength(10);
  });
});
