import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { BrowserWindow, Session } from 'electron';
import { DesktopSecurity } from '../src/security.js';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

test('desktop import bridge exposes one no-argument action and no source path', () => {
  const preload = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'preload.ts'), 'utf8');
  const rendererContract = fs.readFileSync(path.join(projectRoot, 'client', 'src', 'desktop.ts'), 'utf8');
  const rendererApi = fs.readFileSync(path.join(projectRoot, 'client', 'src', 'api.ts'), 'utf8');

  assert.match(preload, /importLegacyData:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC\.importLegacyData\)/);
  assert.doesNotMatch(preload, /chooseLegacyData|sourcePath/);
  assert.match(rendererContract, /importLegacyData\(\):\s*Promise</);
  assert.doesNotMatch(rendererContract, /chooseLegacyData|sourcePath/);
  assert.doesNotMatch(rendererApi, /\/api\/data\/import|importData\s*:/);
});

test('first-run marker is persisted before runtime start and survives a provisional database', () => {
  const main = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main.ts'), 'utf8');
  const initialize = main.indexOf('async function initialize()');
  const markerCreation = main.indexOf('if (noExistingData) ensureFirstRunPendingMarker();', initialize);
  const runtimeStart = main.indexOf('let started = await startRuntime();', markerCreation);

  assert.ok(markerCreation >= 0, 'first-run marker creation is missing');
  assert.ok(runtimeStart > markerCreation, 'runtime can start before the first-run marker is durable');
  assert.match(main, /noExistingData\s*\|\|\s*fs\.existsSync\(firstRunPendingPath\)/);
  assert.match(main, /first-run\.automated-new-profile'[\s\S]{0,160}completeFirstRun\(\)/);
  assert.match(main, /choice\.response === 0[\s\S]{0,120}completeFirstRun\(\)/);
  assert.match(main, /const unavailable = imported\.parity\.credentialsUnavailable\.length;[\s\S]{0,120}completeFirstRun\(\)/);
});

test('quitting the first-run wizard discards only the recorded provisional profile', () => {
  const main = fs.readFileSync(path.join(projectRoot, 'desktop', 'src', 'main.ts'), 'utf8');

  // The quit path moves one recorded id aside and nothing else. A first-run.pending copied from a
  // ≤1.0.0 root arrives beside real data, so deleting by layout would destroy every profile.
  assert.match(main, /choice\.response === 2[\s\S]{0,200}discardProvisionalFirstRunData\(\)[\s\S]{0,80}completeFirstRun\(\)/);
  assert.match(
    main,
    /function discardProvisionalFirstRunData\(\)[\s\S]{0,400}provisionalProfileId[\s\S]{0,200}moveProfileToDeleted\(paths, provisionalProfileId\)/,
  );
  assert.match(main, /const provisionalProfileId = readFirstRunPendingMarker\(\)\?\.provisionalProfileId;\s*\n\s*if \(!provisionalProfileId\) return;/);

  // No path may delete the profile store, the registry, or the legacy database by layout.
  assert.doesNotMatch(main, /rmSync\([^)]*profiles/i);
  assert.doesNotMatch(main, /rmSync\([^)]*dbPath/);
  assert.doesNotMatch(main, /for \(const suffix of \['', '-wal', '-shm'\]\)/);
});

test('renderer requests cannot smuggle the main-only desktop action header', () => {
  type BeforeHeaders = (
    details: { requestHeaders: Record<string, string>; url: string; webContentsId: number },
    callback: (result: { requestHeaders: Record<string, string> }) => void,
  ) => void;
  let beforeHeaders: BeforeHeaders | undefined;
  const fakeSession = {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    setDevicePermissionHandler() {},
    webRequest: {
      onBeforeSendHeaders(_filter: unknown, callback: BeforeHeaders) { beforeHeaders = callback; },
      onHeadersReceived() {},
    },
  } as unknown as Session;
  const fakeWindow = {
    webContents: {
      id: 42,
      setWindowOpenHandler() {},
      on() {},
    },
  } as unknown as BrowserWindow;
  const security = new DesktopSecurity(fakeSession);
  security.attachWindow(fakeWindow);
  security.setRuntime('http://127.0.0.1:43210', 'renderer-api-token');

  let forwarded: Record<string, string> | undefined;
  assert.ok(beforeHeaders);
  beforeHeaders({
    requestHeaders: {
      Authorization: 'Bearer attacker-value',
      'x-MiSgErEt-DeSkToP-AcTiOn': 'stolen-main-capability',
    },
    url: 'http://127.0.0.1:43210/api/data/import',
    webContentsId: 42,
  }, ({ requestHeaders }) => { forwarded = requestHeaders; });

  assert.equal(forwarded?.Authorization, 'Bearer renderer-api-token');
  assert.equal(forwarded?.['X-Misgeret-Desktop-Action'], undefined);
  assert.equal(forwarded?.['x-misgeret-desktop-action'], undefined);
  assert.equal(forwarded?.['x-MiSgErEt-DeSkToP-AcTiOn'], undefined);
});
