import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RuntimePaths } from '../src/contracts.js';
import { migrateLegacyRuntimeData } from '../src/migration.js';

function makeRuntimePaths(rootDir: string): RuntimePaths {
  const dataDir = path.join(rootDir, 'data');
  return {
    rootDir,
    dataDir,
    dbPath: path.join(dataDir, 'finance.db'),
    backupsDir: path.join(rootDir, 'backups'),
    logsDir: path.join(rootDir, 'logs'),
    browserTempDir: path.join(rootDir, 'browser-temp'),
    electronDir: path.join(rootDir, 'electron'),
  };
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeSandbox(): { legacyRoot: string; target: RuntimePaths } {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-migration-'));
  return {
    legacyRoot: path.join(sandbox, 'legacy'),
    target: makeRuntimePaths(path.join(sandbox, 'roaming')),
  };
}

function seedLegacyProfile(legacyRoot: string): void {
  writeFile(path.join(legacyRoot, 'data', 'finance.db'), 'db-payload');
  writeFile(path.join(legacyRoot, 'data', 'finance.db-wal'), 'wal-payload');
  writeFile(path.join(legacyRoot, 'data', 'finance.db-shm'), 'shm-payload');
  writeFile(path.join(legacyRoot, 'electron', 'preferences.json'), '{"zoomFactor":1.2}');
  writeFile(path.join(legacyRoot, 'electron', 'window-state.json'), '{"x":1,"y":2,"width":1440,"height":900}');
  writeFile(path.join(legacyRoot, 'backups', 'finance-2026-07-01.db'), 'backup-payload');
  // Installer artifacts that must never be copied into the data root.
  writeFile(path.join(legacyRoot, 'Update.exe'), 'squirrel');
  writeFile(path.join(legacyRoot, 'app-1.0.0', 'Misgeret.exe'), 'binary');
  writeFile(path.join(legacyRoot, 'logs', 'desktop.log'), 'old log');
}

test('migrates database, sidecars, preferences, window state, and backups', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, true);
  assert.equal(summary.reason, 'completed');
  assert.equal(fs.readFileSync(target.dbPath, 'utf8'), 'db-payload');
  assert.equal(fs.readFileSync(`${target.dbPath}-wal`, 'utf8'), 'wal-payload');
  assert.equal(fs.readFileSync(`${target.dbPath}-shm`, 'utf8'), 'shm-payload');
  assert.equal(fs.readFileSync(path.join(target.electronDir, 'preferences.json'), 'utf8'), '{"zoomFactor":1.2}');
  assert.equal(
    fs.readFileSync(path.join(target.electronDir, 'window-state.json'), 'utf8'),
    '{"x":1,"y":2,"width":1440,"height":900}',
  );
  assert.equal(fs.readFileSync(path.join(target.backupsDir, 'finance-2026-07-01.db'), 'utf8'), 'backup-payload');

  // Transient and installer files stay behind.
  assert.equal(fs.existsSync(path.join(target.rootDir, 'Update.exe')), false);
  assert.equal(fs.existsSync(path.join(target.logsDir, 'desktop.log')), false);

  // The source is read-only for migration purposes: every legacy file survives untouched.
  assert.equal(fs.readFileSync(path.join(legacyRoot, 'data', 'finance.db'), 'utf8'), 'db-payload');
  assert.equal(fs.readFileSync(path.join(legacyRoot, 'backups', 'finance-2026-07-01.db'), 'utf8'), 'backup-payload');
});

test('copies a pending first-run marker so an unfinished setup stays unfinished', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  writeFile(path.join(legacyRoot, 'electron', 'first-run.pending'), '{"version":1}');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, true);
  assert.equal(fs.readFileSync(path.join(target.electronDir, 'first-run.pending'), 'utf8'), '{"version":1}');
});

test('never overwrites a target whose registry names a profile that exists', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  const profileId = '3f1c2a4e-9b7d-4c6a-8e10-2d5b7f9a1c34';
  writeFile(
    path.join(target.dataDir, 'profiles.json'),
    `{"version":1,"activeId":"${profileId}","profiles":[{"id":"${profileId}","name":"ראשי","order":0}]}`,
  );
  writeFile(path.join(target.dataDir, 'profiles', profileId, 'finance.db'), 'adopted-profile-data');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, false);
  assert.equal(summary.reason, 'target-already-initialized');
  assert.equal(fs.existsSync(target.dbPath), false);
});

// A registry naming nobody is what the first-run "יציאה" path leaves behind: it moves the
// provisional profile aside and is forbidden from deleting profiles.json. The target genuinely
// holds nothing, so the ≤1.0.0 install is still there to be adopted — treating the file's mere
// existence as data would strand the user in an empty app with their real data never copied.
test('a registry that names nothing does not block the legacy migration', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  writeFile(path.join(target.dataDir, 'profiles.json'), '{"version":1,"activeId":null,"profiles":[]}');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, true);
  assert.equal(fs.readFileSync(target.dbPath, 'utf8'), 'db-payload');
});

test('never overwrites a target that still holds an unadopted legacy database', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  writeFile(target.dbPath, 'existing-target-data');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, false);
  assert.equal(summary.reason, 'target-already-initialized');
  assert.equal(fs.readFileSync(target.dbPath, 'utf8'), 'existing-target-data');
});

// The re-fire-forever regression: once the runtime adopts <dataDir>/finance.db into
// profiles/<id>/, a dbPath gate is false on every later boot — so the stale LocalAppData
// database, its backups, and its first-run.pending would be copied back again and again.
test('a target whose only data is an adopted profile is already initialized', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  const profileId = '3f1c2a4e-9b7d-4c6a-8e10-2d5b7f9a1c34';
  writeFile(path.join(target.dataDir, 'profiles', profileId, 'finance.db'), 'adopted-profile-data');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, false);
  assert.equal(summary.reason, 'target-already-initialized');
  assert.equal(fs.existsSync(target.dbPath), false);
  assert.equal(fs.existsSync(path.join(target.electronDir, 'first-run.pending')), false);
  assert.equal(
    fs.readFileSync(path.join(target.dataDir, 'profiles', profileId, 'finance.db'), 'utf8'),
    'adopted-profile-data',
  );
});

test('skips when there is no legacy database', () => {
  const { legacyRoot, target } = makeSandbox();
  writeFile(path.join(legacyRoot, 'Update.exe'), 'squirrel');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, false);
  assert.equal(summary.reason, 'no-legacy-data');
  assert.equal(fs.existsSync(target.dbPath), false);
});

test('skips when legacy and target roots are the same directory', () => {
  const { target } = makeSandbox();
  writeFile(target.dbPath, 'data');

  const summary = migrateLegacyRuntimeData(target.rootDir, target);

  assert.equal(summary.migrated, false);
  assert.equal(summary.reason, 'same-root');
});

test('an interrupted attempt is retried cleanly, including stale sidecar cleanup', () => {
  const { legacyRoot, target } = makeSandbox();
  seedLegacyProfile(legacyRoot);
  // Simulate a crash from a previous attempt: stale sidecars and a partial copy exist,
  // but finance.db — the migration gate — was never written.
  fs.rmSync(path.join(legacyRoot, 'data', 'finance.db-wal'));
  writeFile(`${target.dbPath}-wal`, 'stale-wal-from-crashed-attempt');
  writeFile(`${target.dbPath}.migrating`, 'partial');

  const summary = migrateLegacyRuntimeData(legacyRoot, target);

  assert.equal(summary.migrated, true);
  assert.equal(fs.readFileSync(target.dbPath, 'utf8'), 'db-payload');
  assert.equal(fs.existsSync(`${target.dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${target.dbPath}.migrating`), false);
  assert.equal(fs.readFileSync(`${target.dbPath}-shm`, 'utf8'), 'shm-payload');
});
