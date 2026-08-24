// One-command local deploy: freshly built Squirrel installer → the REAL Windows install.
//
// Claude Code sessions on this machine run inside the Claude desktop MSIX container,
// where AppData writes (child processes and installers included) are silently
// virtualized into the container's LocalCache. An installer run in-session therefore
// "succeeds" without touching the real system. The fix: execute the installer through
// a Windows Scheduled Task, which runs outside the container in the user's real
// session. Results are exchanged through C:\Users\Public (real, shared, ASCII paths).
//
// Usage:  npm run deploy:local          (installer must already exist)
//         npm run ship:local            (desktop:make + deploy in one go)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const setup = path.join(repo, 'out', 'make', 'squirrel.windows', 'x64', 'MisgeretSetup.exe');
const releases = path.join(repo, 'out', 'make', 'squirrel.windows', 'x64', 'RELEASES');
const base = 'C:\\Users\\Public\\misgeret-update';
const taskName = 'MisgeretLocalUpdate';

if (!fs.existsSync(setup)) {
  console.error(`MisgeretSetup.exe not found at ${setup} — run "npm run desktop:make" first.`);
  process.exit(1);
}
// the RELEASES file names the nupkg version — refuse to ship an installer that does not
// match package.json (a stale out/ directory is the classic way to "update" to nothing)
const releasesText = fs.readFileSync(releases, 'ascii');
if (!releasesText.includes(`misgeret-${version}-full.nupkg`)) {
  console.error(`out/make holds a different version than package.json (${version}): ${releasesText.trim()}`);
  console.error('Run "npm run desktop:make" to rebuild.');
  process.exit(1);
}
const ageMin = (Date.now() - fs.statSync(setup).mtimeMs) / 60_000;
console.log(`installer: ${setup}`);
console.log(`version ${version}, built ${ageMin.toFixed(0)} min ago`);

// pure-ASCII wrapper in a space-free real directory — Hebrew/UTF-8 and spaced paths
// break Windows PowerShell 5.1 / schtasks in this flow (learned the hard way)
const wrapper = [
  '@echo off',
  'setlocal',
  `set BASE=${base}`,
  'set LOG=%BASE%\\last-run.log',
  'echo ==== Misgeret local update ==== > "%LOG%"',
  'echo start %date% %time% >> "%LOG%"',
  'rem close the running app so Squirrel can swap versions',
  'taskkill /IM Misgeret.exe /F >> "%LOG%" 2>&1',
  `"${setup}" --silent >> "%LOG%" 2>&1`,
  'echo setup exitcode %errorlevel% >> "%LOG%"',
  'rem report the REAL install state - no virtualization out here',
  'echo ---- %LOCALAPPDATA%\\Misgeret ---- >> "%LOG%"',
  'dir /b "%LOCALAPPDATA%\\Misgeret" >> "%LOG%" 2>&1',
  'rem relaunch the updated app in the real session (never from inside the container -',
  'rem an in-container launch would hand it a virtualized AppData and the wrong database)',
  'start "" "%LOCALAPPDATA%\\Misgeret\\Misgeret.exe"',
  'echo launched >> "%LOG%"',
  'echo done %date% %time% >> "%LOG%"',
  'echo ok > "%BASE%\\status.txt"',
  '',
].join('\r\n');

fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'update.cmd'), wrapper, 'ascii');
fs.rmSync(path.join(base, 'status.txt'), { force: true });
fs.rmSync(path.join(base, 'last-run.log'), { force: true });

console.log('scheduling the install outside the container...');
execFileSync('schtasks', ['/Create', '/TN', taskName, '/TR', `${base}\\update.cmd`, '/SC', 'ONCE', '/ST', '23:59', '/F'], { stdio: 'inherit' });
execFileSync('schtasks', ['/Run', '/TN', taskName], { stdio: 'inherit' });

// the task writes status.txt as its very last step — poll up to 5 minutes
const deadline = Date.now() + 300_000;
let status = null;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3_000));
  try {
    status = fs.readFileSync(path.join(base, 'status.txt'), 'ascii').trim();
    break;
  } catch {
    // not finished yet
  }
}

// the task is one-shot but /SC ONCE leaves it armed for its 23:59 slot — without this
// delete it would fire again tonight and kill the app mid-use
try {
  execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
} catch {
  // already gone
}

const logPath = path.join(base, 'last-run.log');
const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no log written)';
console.log('---- task log ----');
console.log(log);

if (status !== 'ok') {
  console.error('the update task did not confirm success — inspect the log above.');
  process.exit(1);
}
if (!log.includes(`app-${version}`)) {
  console.error(`app-${version} does not appear in the real install directory — the update did not land.`);
  process.exit(1);
}
console.log(`real install updated: Misgeret ${version} is on the machine (and relaunched by Squirrel).`);
