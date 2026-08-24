import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const mainSource = fs.readFileSync(path.resolve('desktop/src/main.ts'), 'utf8');

test('Chromium profile paths use the same isolated runtime root as financial data', () => {
  const pathsIndex = mainSource.indexOf('const paths = getRuntimePaths(app);');
  const userDataIndex = mainSource.indexOf("app.setPath('userData', bootstrapElectronDir);");
  assert.ok(pathsIndex >= 0 && userDataIndex > pathsIndex);
  assert.match(mainSource, /const bootstrapElectronDir = paths\.electronDir;/);
});

test('Windows suspend stops the runtime and resume restarts without bypassing first-run onboarding', () => {
  assert.match(mainSource, /powerMonitor\.on\('suspend'/);
  assert.match(mainSource, /runtimeManager\?\.stop\('restart'\)/);
  assert.match(mainSource, /powerMonitor\.on\('resume'/);
  assert.match(mainSource, /resumeFirstRun && firstRunWizardActive/);
  assert.match(mainSource, /firstRunRuntime = await startRuntime\(\)/);
  assert.match(mainSource, /await retryRuntime\(\)/);
});
