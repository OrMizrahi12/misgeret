// Acceptance test for the customer update path, run on the REAL install.
//
// Restarts the installed Misgeret (outside the MSIX container, via a scheduled
// task), then watches %LOCALAPPDATA%\Misgeret for the expected app-<version>
// directory to appear — proof that the running app discovered the published
// release on the public feed, downloaded it, and staged it, exactly as it will
// on a customer machine. The app keeps running with the update button visible;
// this script never clicks it.
//
// Usage: node scripts/verify_update_path.mjs [expected-version]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Expected a semver version, got: ${version}`);
  process.exit(1);
}
const base = 'C:\\Users\\Public\\misgeret-update';
const taskName = 'MisgeretUpdateVerify';

// Same constraints as deploy_local.mjs: pure-ASCII wrapper in a space-free real path.
const wrapper = [
  '@echo off',
  'setlocal enabledelayedexpansion',
  `set BASE=${base}`,
  'set LOG=%BASE%\\verify-update.log',
  'set APPDIR=%LOCALAPPDATA%\\Misgeret',
  'echo ==== Misgeret update-path verification ==== > "%LOG%"',
  'echo start %date% %time% >> "%LOG%"',
  'rem restart the app so its launch-time update check runs against the new feed state',
  'taskkill /IM Misgeret.exe /F >> "%LOG%" 2>&1',
  'start "" "%APPDIR%\\Misgeret.exe"',
  'echo relaunched, waiting for the update to stage... >> "%LOG%"',
  'for /L %%i in (1,1,60) do (',
  `  if exist "%APPDIR%\\app-${version}" (`,
  `    echo app-${version} staged after about %%i x 5s >> "%LOG%"`,
  '    goto :found',
  '  )',
  '  timeout /t 5 /nobreak > nul',
  ')',
  `echo TIMEOUT waiting for app-${version} >> "%LOG%"`,
  'dir /b "%APPDIR%" >> "%LOG%" 2>&1',
  'echo fail > "%BASE%\\verify-status.txt"',
  'goto :end',
  ':found',
  'dir /b "%APPDIR%" >> "%LOG%" 2>&1',
  'echo ---- packages ---- >> "%LOG%"',
  'dir /b "%APPDIR%\\packages" >> "%LOG%" 2>&1',
  'echo ok > "%BASE%\\verify-status.txt"',
  ':end',
  'echo done %date% %time% >> "%LOG%"',
  '',
].join('\r\n');

fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'verify-update.cmd'), wrapper, 'ascii');
fs.rmSync(path.join(base, 'verify-status.txt'), { force: true });
fs.rmSync(path.join(base, 'verify-update.log'), { force: true });

console.log(`Verifying that the installed app self-updates to ${version}...`);
execFileSync('schtasks', ['/Create', '/TN', taskName, '/TR', `${base}\\verify-update.cmd`, '/SC', 'ONCE', '/ST', '23:59', '/F'], { stdio: 'inherit' });
execFileSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'inherit' });

const deadline = Date.now() + 420_000;
let status = null;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  try {
    status = fs.readFileSync(path.join(base, 'verify-status.txt'), 'ascii').trim();
    break;
  } catch {
    // not finished yet
  }
}
try {
  execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
} catch {
  // already gone
}

const logPath = path.join(base, 'verify-update.log');
console.log('---- verification log ----');
console.log(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no log written)');

if (status !== 'ok') {
  console.error('The installed app did not stage the update — inspect the log above.');
  process.exit(1);
}
console.log(`Customer update path verified: the installed app discovered, downloaded, and staged ${version} on its own.`);
console.log('The running app is now showing the update button; restarting it applies the update.');
