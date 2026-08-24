import fs from 'node:fs';
import path from 'node:path';
import type { PresenceSettings } from './contracts.js';

interface DesktopPreferences {
  zoomFactor: number;
  presence: PresenceSettings;
}

/** Every writer merges over what is on disk — two preferences must never erase each other. */
function readAll(filePath: string): Partial<DesktopPreferences> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<DesktopPreferences>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMerged(filePath: string, patch: Partial<DesktopPreferences>): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const merged = { ...readAll(filePath), ...patch };
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(merged), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch {
    // Preferences are non-critical.
  }
}

export function readZoomFactor(filePath: string): number {
  const { zoomFactor } = readAll(filePath);
  if (typeof zoomFactor === 'number' && zoomFactor >= 0.8 && zoomFactor <= 2) return zoomFactor;
  return 1;
}

export function writeZoomFactor(filePath: string, zoomFactor: number): void {
  writeMerged(filePath, { zoomFactor });
}

/** נוכחות שקטה is opt-in: anything unreadable or half-formed collapses to OFF. */
export function readPresence(filePath: string): PresenceSettings {
  const { presence } = readAll(filePath);
  return {
    enabled: presence?.enabled === true,
    launchAtLogin: presence?.launchAtLogin === true,
  };
}

export function writePresence(filePath: string, presence: PresenceSettings): void {
  writeMerged(filePath, { presence: { enabled: presence.enabled === true, launchAtLogin: presence.launchAtLogin === true } });
}
