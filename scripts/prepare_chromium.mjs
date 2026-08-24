import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesRoot = path.join(root, '.desktop-resources');
const destination = path.join(resourcesRoot, 'chromium');
const executable = puppeteer.executablePath();

if (!fs.existsSync(executable)) {
  throw new Error(
    `Puppeteer's pinned Chrome was not found at ${executable}. Run "npx puppeteer browsers install chrome" first.`,
  );
}

const resolvedDestination = path.resolve(destination);
if (!resolvedDestination.startsWith(`${root}${path.sep}`)) {
  throw new Error(`Refusing to prepare Chromium outside the workspace: ${resolvedDestination}`);
}

const appSegmentIndex = executable.split(path.sep).findIndex((segment) => segment.endsWith('.app'));
const isMacBundle = process.platform === 'darwin' && appSegmentIndex >= 0;
const source = isMacBundle
  ? executable.split(path.sep).slice(0, appSegmentIndex + 1).join(path.sep)
  : path.dirname(executable);
const executableRelativePath = isMacBundle
  ? path.join(path.basename(source), path.relative(source, executable))
  : path.basename(executable);
const executableHash = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
const manifestPath = path.join(destination, 'misgeret-chromium.json');
let currentManifest;
try {
  currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch {
  currentManifest = null;
}

if (
  currentManifest?.sha256 === executableHash &&
  currentManifest?.executableRelativePath === executableRelativePath &&
  fs.existsSync(path.join(destination, executableRelativePath))
) {
  console.log(`Chromium resource is current: ${destination}`);
  process.exit(0);
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(resourcesRoot, { recursive: true });
if (isMacBundle) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, path.join(destination, path.basename(source)), { recursive: true, force: true });
} else {
  fs.cpSync(source, destination, { recursive: true, force: true });
}
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      browser: puppeteer.browserVersion,
      platform: process.platform,
      arch: process.arch,
      executableRelativePath,
      sha256: executableHash,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Prepared ${puppeteer.browserVersion} at ${destination}`);
