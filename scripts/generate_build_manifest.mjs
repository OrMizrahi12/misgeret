import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.build', 'misgeret-build.json');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function revision() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'source-archive';
  }
}

const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0-development';
const sourceRevision = revision();
const updateChannel = process.env.MISGERET_UPDATE_CHANNEL?.trim() || 'stable';
if (!['stable', 'beta'].includes(updateChannel)) {
  throw new Error('MISGERET_UPDATE_CHANNEL must be either stable or beta.');
}
// The feed URL defaults from release.config.json so every packaged build can receive updates.
// Local installs keep the updater alive; env still overrides for special builds.
// Squirrel never downgrades, so a local build AHEAD of the public feed simply sees "not-available".
function defaultFeedUrl() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'release.config.json'), 'utf8'));
    return typeof cfg.updateFeedUrl === 'string' ? cfg.updateFeedUrl.trim() : undefined;
  } catch {
    return undefined; // no release config — build stays feed-less (updater disabled)
  }
}
const updateFeedUrl = process.env.MISGERET_UPDATE_FEED_URL?.trim() || defaultFeedUrl();
if (updateFeedUrl) {
  const parsed = new URL(updateFeedUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('MISGERET_UPDATE_FEED_URL must be an HTTPS URL without embedded credentials.');
  }
}
const manifest = {
  version,
  sourceRevision,
  buildId: process.env.MISGERET_BUILD_ID?.trim() || `${version}+${sourceRevision}`,
  apiSchemaVersion: process.env.MISGERET_API_SCHEMA_VERSION?.trim() || '1',
  updateChannel,
  updateFeedUrl,
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`Build manifest: ${manifest.buildId}`);
