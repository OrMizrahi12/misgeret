import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { App } from 'electron';
import { createLaunchEnvironment } from '../../scripts/launch_packaged_desktop.mjs';
import {
  assertRootOutsideInstallDir,
  getLegacyRuntimeRoot,
  getProductionRuntimeRoot,
  getRuntimePaths,
} from '../src/paths.js';

function fakeApp(isPackaged: boolean): App {
  return {
    isPackaged,
    getAppPath: () => path.join('C:\\workspace', 'financial-framework'),
    getPath: () => path.join('C:\\Users', 'owner', 'AppData', 'Roaming'),
  } as unknown as App;
}

test('development defaults to an isolated repository profile', () => {
  const runtime = getRuntimePaths(fakeApp(false), {
    LOCALAPPDATA: path.join('C:\\Users', 'owner', 'AppData', 'Local'),
  });

  assert.equal(
    runtime.rootDir,
    path.resolve('C:\\workspace', 'financial-framework', '.desktop-smoke', 'profile'),
  );
  assert.equal(runtime.rootDir.includes(path.join('AppData', 'Local', 'Misgeret')), false);
});

test('development accepts an explicit data root without the packaged override flag', () => {
  const override = path.resolve('C:\\isolated', 'misgeret-dev');
  const runtime = getRuntimePaths(fakeApp(false), { MISGERET_DATA_ROOT: override });
  assert.equal(runtime.rootDir, override);
});

test('packaged app ignores data-root override unless it is explicitly authorized', () => {
  const roaming = path.join('C:\\Users', 'owner', 'AppData', 'Roaming');
  const localAppData = path.join('C:\\Users', 'owner', 'AppData', 'Local');
  const unauthorized = getRuntimePaths(fakeApp(true), {
    APPDATA: roaming,
    LOCALAPPDATA: localAppData,
    MISGERET_DATA_ROOT: path.resolve('C:\\isolated', 'untrusted'),
  });
  assert.equal(unauthorized.rootDir, path.join(roaming, 'Misgeret'));

  const trustedRoot = path.resolve('C:\\isolated', 'packaged-smoke');
  const authorized = getRuntimePaths(fakeApp(true), {
    APPDATA: roaming,
    LOCALAPPDATA: localAppData,
    MISGERET_DATA_ROOT: trustedRoot,
    MISGERET_ALLOW_DATA_ROOT_OVERRIDE: '1',
  });
  assert.equal(authorized.rootDir, trustedRoot);
});

test('packaged production data root lives in Roaming, outside the Squirrel install directory', () => {
  const roaming = path.join('C:\\Users', 'owner', 'AppData', 'Roaming');
  const localAppData = path.join('C:\\Users', 'owner', 'AppData', 'Local');
  const environment = { APPDATA: roaming, LOCALAPPDATA: localAppData };
  const runtime = getRuntimePaths(
    fakeApp(true),
    environment,
    // Squirrel stub layout: the executable lives inside the legacy install root.
    path.join(localAppData, 'Misgeret', 'app-1.0.1', 'Misgeret.exe'),
  );

  assert.equal(runtime.rootDir, path.join(roaming, 'Misgeret'));
  assert.equal(getProductionRuntimeRoot(fakeApp(true), environment), runtime.rootDir);
  assert.equal(getLegacyRuntimeRoot(fakeApp(true), environment), path.join(localAppData, 'Misgeret'));
  assert.notEqual(
    path.resolve(runtime.rootDir).toLowerCase(),
    path.resolve(getLegacyRuntimeRoot(fakeApp(true), environment)).toLowerCase(),
  );
});

test('legacy root without LOCALAPPDATA derives Local from USERPROFILE — never collapses onto Roaming', () => {
  const roaming = path.join('C:\\Users', 'owner', 'AppData', 'Roaming');
  const environment = { APPDATA: roaming, USERPROFILE: path.join('C:\\Users', 'owner') };
  const legacy = getLegacyRuntimeRoot(fakeApp(true), environment);
  assert.equal(legacy, path.join('C:\\Users', 'owner', 'AppData', 'Local', 'Misgeret'));
  // equal roots would make migration return 'same-root' and silently skip a real ≤1.0.0 install
  assert.notEqual(
    path.resolve(legacy).toLowerCase(),
    path.resolve(getProductionRuntimeRoot(fakeApp(true), environment)).toLowerCase(),
  );
});

test('any data root containing the running executable is rejected fail-closed', () => {
  const installRoot = path.resolve(path.parse(process.cwd()).root, 'misgeret-test-install');
  const executable = path.join(installRoot, 'app-1.0.1', process.platform === 'win32' ? 'Misgeret.exe' : 'Misgeret');

  assert.throws(
    () => assertRootOutsideInstallDir(installRoot, executable),
    (error: NodeJS.ErrnoException) => error.code === 'DATA_ROOT_INSIDE_INSTALL_DIR',
  );
  if (process.platform === 'win32') {
    // Windows paths compare case-insensitively; a case-twiddled root must not slip through.
    assert.throws(
      () => assertRootOutsideInstallDir(installRoot.toUpperCase(), executable),
      (error: NodeJS.ErrnoException) => error.code === 'DATA_ROOT_INSIDE_INSTALL_DIR',
    );
  }
  assert.throws(
    () => getRuntimePaths(fakeApp(true), {
      MISGERET_DATA_ROOT: installRoot,
      MISGERET_ALLOW_DATA_ROOT_OVERRIDE: '1',
    }, executable),
    (error: NodeJS.ErrnoException) => error.code === 'DATA_ROOT_INSIDE_INSTALL_DIR',
  );

  // Sibling and parent-adjacent roots stay valid.
  assertRootOutsideInstallDir(path.join('C:\\Users', 'owner', 'AppData', 'Roaming', 'Misgeret'), executable);
  assertRootOutsideInstallDir(path.join('C:\\Users', 'owner', 'AppData', 'Local', 'MisgeretData'), executable);
});

test('packaged launcher creates an isolated child environment without mutating its parent', () => {
  const projectRoot = path.resolve('C:\\workspace', 'financial-framework');
  const parentEnvironment = {
    LOCALAPPDATA: path.join('C:\\Users', 'owner', 'AppData', 'Local'),
    PATH: 'test-path',
  };
  const parentSnapshot = { ...parentEnvironment };
  const childEnvironment = createLaunchEnvironment(projectRoot, parentEnvironment);

  assert.deepEqual(parentEnvironment, parentSnapshot);
  assert.notEqual(childEnvironment, parentEnvironment);
  assert.equal(
    childEnvironment.MISGERET_DATA_ROOT,
    path.join(projectRoot, '.desktop-smoke', 'profile'),
  );
  assert.equal(childEnvironment.MISGERET_ALLOW_DATA_ROOT_OVERRIDE, '1');
  assert.equal(childEnvironment.MOCK_BANK, '1');
  assert.equal(childEnvironment.MISGERET_FIRST_RUN_ACTION, 'new');
  assert.equal(childEnvironment.PATH, 'test-path');
});

test('packaged launcher preserves explicit smoke choices and resolves a relative root', () => {
  const projectRoot = path.resolve('C:\\workspace', 'financial-framework');
  const invocationDirectory = path.resolve('C:\\scratch');
  const childEnvironment = createLaunchEnvironment(projectRoot, {
    MISGERET_DATA_ROOT: 'profiles\\qa',
    MOCK_BANK: '0',
    MISGERET_FIRST_RUN_ACTION: 'import',
  }, invocationDirectory);

  assert.equal(
    childEnvironment.MISGERET_DATA_ROOT,
    path.resolve(invocationDirectory, 'profiles\\qa'),
  );
  assert.equal(childEnvironment.MOCK_BANK, '0');
  assert.equal(childEnvironment.MISGERET_FIRST_RUN_ACTION, 'import');
  assert.equal(childEnvironment.MISGERET_ALLOW_DATA_ROOT_OVERRIDE, '1');
});
