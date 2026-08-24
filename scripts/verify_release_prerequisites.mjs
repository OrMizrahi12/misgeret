import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a signed public release.`);
  return value;
}

if (process.platform !== 'win32') throw new Error('Misgeret v1 releases must be produced on Windows x64.');
if (process.arch !== 'x64') throw new Error(`Misgeret v1 releases require x64, got ${process.arch}.`);
let worktreeStatus;
try {
  worktreeStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  throw new Error('A Git checkout is required to prove release source provenance.');
}
if (worktreeStatus) throw new Error('Public releases require a clean Git worktree.');

// Until an Authenticode certificate is purchased, releases may go out unsigned — but only
// through an explicit, deliberate opt-in. Unsigned builds trigger SmartScreen warnings on
// first install; updates themselves are unaffected (Squirrel does not require signatures).
const allowUnsigned = process.env.MISGERET_ALLOW_UNSIGNED_RELEASE === '1';
if (allowUnsigned) {
  console.warn('WARNING: publishing UNSIGNED artifacts (MISGERET_ALLOW_UNSIGNED_RELEASE=1).');
  console.warn('         New installs will hit Windows SmartScreen. Acquire a code-signing');
  console.warn('         certificate before distributing broadly.');
} else {
  const certificateFile = path.resolve(required('MISGERET_WINDOWS_CERTIFICATE_FILE'));
  required('MISGERET_WINDOWS_CERTIFICATE_PASSWORD');
  required('MISGERET_WINDOWS_PUBLISHER');
  if (!fs.existsSync(certificateFile) || !fs.statSync(certificateFile).isFile()) {
    throw new Error('MISGERET_WINDOWS_CERTIFICATE_FILE does not point to a readable certificate file.');
  }
}
const channel = required('MISGERET_UPDATE_CHANNEL');
const feed = new URL(required('MISGERET_UPDATE_FEED_URL'));
if (!['stable', 'beta'].includes(channel)) {
  throw new Error('MISGERET_UPDATE_CHANNEL must be either stable or beta.');
}
if (feed.protocol !== 'https:' || feed.username || feed.password) {
  throw new Error('MISGERET_UPDATE_FEED_URL must be HTTPS and must not contain credentials.');
}

console.log(`Release prerequisites verified for the ${channel} channel${allowUnsigned ? ' (unsigned)' : ''}.`);
