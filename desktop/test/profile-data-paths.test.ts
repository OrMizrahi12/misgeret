import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RuntimePaths } from '../src/contracts.js';
import {
  deletedProfilesDir,
  ensureRuntimePaths,
  hasExistingData,
  isProfileId,
  moveProfileToDeleted,
  profileBackupsDir,
  profileDir,
  profilesRegistryPath,
} from '../src/paths.js';
import { shutdownTimeoutMsFor } from '../src/runtime-manager.js';

const PROFILE_A = '3f1c2a4e-9b7d-4c6a-8e10-2d5b7f9a1c34';
const PROFILE_B = 'c0ffee11-dead-4bee-9001-abcdef012345';

function makeSandbox(): RuntimePaths {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-profile-paths-'));
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
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

test('a fresh install has no existing data', () => {
  const paths = makeSandbox();
  assert.equal(hasExistingData(paths), false);

  // An absent profiles/ is the normal fresh-install shape and must never throw.
  ensureRuntimePaths(paths);
  assert.equal(hasExistingData(paths), false);
});

test('a legacy install is existing data even before the runtime adopts it', () => {
  const paths = makeSandbox();
  writeFile(paths.dbPath, 'legacy-payload');
  assert.equal(hasExistingData(paths), true);
});

// DB_PATH is live in the smoke sandbox, and resolveRuntimePaths honors it. Asking
// <dataDir>/finance.db directly instead of paths.dbPath would miss the real database.
test('a legacy database outside dataDir is found through paths.dbPath', () => {
  const paths = makeSandbox();
  const elsewhere = path.join(paths.rootDir, 'elsewhere', 'custom.db');
  writeFile(elsewhere, 'legacy-payload');
  assert.equal(hasExistingData({ ...paths, dbPath: elsewhere }), true);
});

test('an adopted profile is existing data with no registry and no legacy database', () => {
  const paths = makeSandbox();
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'finance.db'), 'adopted');

  assert.equal(fs.existsSync(profilesRegistryPath(paths)), false);
  assert.equal(fs.existsSync(paths.dbPath), false);
  assert.equal(hasExistingData(paths), true);
});

test('a registry counts as data only while it names a profile that still exists', () => {
  const paths = makeSandbox();

  // A registry naming nobody is what a crashed create or a reconciled-empty store leaves behind.
  writeFile(profilesRegistryPath(paths), '{"version":1,"activeId":null,"profiles":[]}');
  assert.equal(hasExistingData(paths), false);

  // What the quit path leaves behind: the provisional profile directory was moved aside, but
  // profiles.json is never deleted (A13). The entry it still names has no world behind it, so
  // this is a fresh install — anything else suppresses the welcome wizard forever.
  writeFile(
    profilesRegistryPath(paths),
    `{"version":1,"activeId":"${PROFILE_A}","profiles":[{"id":"${PROFILE_A}","name":"ראשי"}]}`,
  );
  assert.equal(hasExistingData(paths), false);

  // The directory alone is enough: a profile created but never opened holds no finance.db yet.
  fs.mkdirSync(profileDir(paths, PROFILE_A), { recursive: true });
  assert.equal(hasExistingData(paths), true);
});

test('a registry that cannot be read counts as data', () => {
  const paths = makeSandbox();
  // Never open the welcome wizard over a registry we merely failed to parse. The profiles/<uuid>/
  // scan covers a registry genuinely lost to corruption; this covers one we cannot trust.
  writeFile(profilesRegistryPath(paths), '{"version":1,"profiles":[');
  assert.equal(hasExistingData(paths), true);

  writeFile(profilesRegistryPath(paths), '{"version":1,"activeId":null}');
  assert.equal(hasExistingData(paths), true, 'a registry with no profiles array is not understood');
});

test('the first-run quit path leaves a state the next boot reads as a first run', () => {
  const paths = makeSandbox();
  // The full sequence: the runtime provisionally creates ראשי and persists the registry, the user
  // picks "יציאה", and A13's cleanup moves only profiles/<P1> aside.
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'finance.db'), 'provisional');
  writeFile(
    profilesRegistryPath(paths),
    `{"version":1,"activeId":"${PROFILE_A}","profiles":[{"id":"${PROFILE_A}","name":"ראשי","order":0}]}`,
  );
  assert.equal(hasExistingData(paths), true, 'the provisional profile is data while it exists');

  assert.equal(moveProfileToDeleted(paths, PROFILE_A), true);

  assert.equal(fs.existsSync(profilesRegistryPath(paths)), true, 'A13 forbids deleting the registry');
  assert.equal(
    hasExistingData(paths),
    false,
    'the wizard must reopen — otherwise "ייבא התקנה קיימת" is gone forever',
  );
});

test('empty and non-profile directories under profiles/ are not data', () => {
  const paths = makeSandbox();
  // create() mkdirs before it writes the registry; a crash in that window leaves an empty
  // directory that holds nothing. A stray non-UUID directory is likewise not a profile.
  fs.mkdirSync(path.join(paths.dataDir, 'profiles', PROFILE_A), { recursive: true });
  fs.mkdirSync(path.join(paths.dataDir, 'profiles', 'not-a-uuid'), { recursive: true });
  writeFile(path.join(paths.dataDir, 'profiles', 'not-a-uuid', 'finance.db'), 'stray');

  assert.equal(hasExistingData(paths), false);
});

test('a profile store that is absent or not a directory reports no data', () => {
  const paths = makeSandbox();
  // A file where profiles/ should be fails readdir with ENOTDIR. There is genuinely no profile
  // store here, so this resolves to a first run rather than aborting startup.
  writeFile(path.join(paths.dataDir, 'profiles'), 'not-a-directory');
  assert.equal(hasExistingData(paths), false);
});

test('an unreadable profile store aborts rather than reporting a fresh install', () => {
  const paths = makeSandbox();
  fs.mkdirSync(path.join(paths.dataDir, 'profiles'), { recursive: true });

  // Reporting "no data" for a store we merely failed to read would open the welcome wizard over
  // someone's real profiles. Only ENOENT/ENOTDIR mean "no data"; everything else must be loud.
  const realReaddirSync = fs.readdirSync;
  (fs as { readdirSync: unknown }).readdirSync = () => {
    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  };
  try {
    assert.throws(() => hasExistingData(paths), (error: NodeJS.ErrnoException) => error.code === 'EPERM');
  } finally {
    (fs as { readdirSync: unknown }).readdirSync = realReaddirSync;
  }
});

test('ensureRuntimePaths never creates the legacy backups directory', () => {
  const paths = makeSandbox();
  ensureRuntimePaths(paths);

  // An empty top-level backups/ reads to the user as "my backups were destroyed", and it blurs
  // migration's "do legacy backups exist" signal.
  assert.equal(fs.existsSync(paths.backupsDir), false);
  assert.equal(fs.existsSync(paths.logsDir), true);
  assert.equal(fs.existsSync(paths.electronDir), true);
  assert.equal(fs.existsSync(paths.browserTempDir), true);
});

test('profile paths reject anything that is not a UUID', () => {
  const paths = makeSandbox();

  assert.equal(isProfileId(PROFILE_A), true);
  assert.equal(isProfileId('../../etc'), false);
  assert.equal(isProfileId(''), false);
  assert.equal(isProfileId(undefined), false);
  assert.equal(isProfileId(`${PROFILE_A}/..`), false);

  for (const hostile of ['..', '../..', `${PROFILE_A}/../${PROFILE_B}`, 'C:\\Windows', '.migrating']) {
    assert.throws(
      () => profileDir(paths, hostile),
      (error: NodeJS.ErrnoException) => error.code === 'INVALID_PROFILE_ID',
      `profileDir accepted ${hostile}`,
    );
    assert.throws(
      () => profileBackupsDir(paths, hostile),
      (error: NodeJS.ErrnoException) => error.code === 'INVALID_PROFILE_ID',
      `profileBackupsDir accepted ${hostile}`,
    );
  }

  assert.equal(profileDir(paths, PROFILE_A), path.join(paths.dataDir, 'profiles', PROFILE_A));
  assert.equal(
    profileBackupsDir(paths, PROFILE_A),
    path.join(paths.dataDir, 'profiles', PROFILE_A, 'backups'),
  );
});

test('discarding a provisional profile moves it aside and destroys nothing', () => {
  const paths = makeSandbox();
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'finance.db'), 'provisional');
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'backups', 'finance-2026-07-01.db'), 'backup');
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_B, 'finance.db'), 'someone-elses-world');
  writeFile(profilesRegistryPath(paths), '{"version":1}');

  assert.equal(moveProfileToDeleted(paths, PROFILE_A), true);

  // Gone from the live store...
  assert.equal(fs.existsSync(profileDir(paths, PROFILE_A)), false);
  // ...but moved, not destroyed — data and backups both survive.
  const moved = fs.readdirSync(deletedProfilesDir(paths));
  assert.equal(moved.length, 1);
  assert.ok(moved[0].startsWith(`${PROFILE_A}-`), `unexpected deleted directory name: ${moved[0]}`);
  const movedDir = path.join(deletedProfilesDir(paths), moved[0]);
  assert.equal(fs.readFileSync(path.join(movedDir, 'finance.db'), 'utf8'), 'provisional');
  assert.equal(fs.readFileSync(path.join(movedDir, 'backups', 'finance-2026-07-01.db'), 'utf8'), 'backup');

  // Every other profile, and the registry, are untouched.
  assert.equal(fs.readFileSync(path.join(profileDir(paths, PROFILE_B), 'finance.db'), 'utf8'), 'someone-elses-world');
  assert.equal(fs.existsSync(profilesRegistryPath(paths)), true);
});

test('discarding is idempotent, collision-safe, and never leaves the data directory', () => {
  const paths = makeSandbox();
  assert.equal(moveProfileToDeleted(paths, PROFILE_A), false, 'an absent profile is not an error');

  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'finance.db'), 'first');
  assert.equal(moveProfileToDeleted(paths, PROFILE_A), true);
  writeFile(path.join(paths.dataDir, 'profiles', PROFILE_A, 'finance.db'), 'second');
  assert.equal(moveProfileToDeleted(paths, PROFILE_A), true);

  const moved = fs.readdirSync(deletedProfilesDir(paths));
  assert.equal(moved.length, 2, 'a same-second retry must not clobber the earlier copy');
  const payloads = moved.map((name) => fs.readFileSync(path.join(deletedProfilesDir(paths), name, 'finance.db'), 'utf8'));
  assert.deepEqual(payloads.sort(), ['first', 'second']);

  assert.throws(
    () => moveProfileToDeleted(paths, '..'),
    (error: NodeJS.ErrnoException) => error.code === 'INVALID_PROFILE_ID',
  );
});

test('the shutdown budget grows with open profiles and stays bounded', () => {
  // A hard taskkill on expiry lands on live WALs, so the budget must cover N checkpoints.
  assert.equal(shutdownTimeoutMsFor(undefined), 15_000, 'an unknown count assumes one workspace');
  assert.equal(shutdownTimeoutMsFor(1), 15_000);
  assert.equal(shutdownTimeoutMsFor(4), 30_000);
  assert.equal(shutdownTimeoutMsFor(8), 45_000, 'the LRU cap must fit inside the budget');
  assert.equal(shutdownTimeoutMsFor(64), 45_000, 'the budget is capped');
  assert.equal(shutdownTimeoutMsFor(0), 15_000);
  assert.equal(shutdownTimeoutMsFor(-3), 15_000);
  assert.equal(shutdownTimeoutMsFor(Number.NaN), 15_000);
});
