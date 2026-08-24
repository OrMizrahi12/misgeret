import fs from 'node:fs';
import path from 'node:path';
import type { AppInfo } from './contracts.js';

interface BuildManifest {
  buildId?: unknown;
  apiSchemaVersion?: unknown;
  updateFeedUrl?: unknown;
}

function readManifest(): BuildManifest {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-manifest.json'), 'utf8')) as BuildManifest;
  } catch {
    return {};
  }
}

export function readAppInfo(appName: string, version: string): AppInfo {
  const manifest = readManifest();
  return {
    name: appName,
    version,
    buildId: typeof manifest.buildId === 'string' ? manifest.buildId : version,
    apiSchemaVersion: typeof manifest.apiSchemaVersion === 'string' ? manifest.apiSchemaVersion : '1',
  };
}

export function readUpdateFeedUrl(packaged: boolean): string | undefined {
  const manifest = readManifest();
  if (typeof manifest.updateFeedUrl === 'string' && manifest.updateFeedUrl.trim()) return manifest.updateFeedUrl.trim();
  // Runtime overrides are intentionally development-only. Production receives an immutable,
  // signed feed URL from the build manifest rather than trusting the launch environment.
  return packaged ? undefined : process.env.MISGERET_UPDATE_FEED_URL?.trim();
}
