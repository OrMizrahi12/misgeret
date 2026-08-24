import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow, Rectangle, Screen } from 'electron';

interface WindowState extends Rectangle {
  maximized: boolean;
}
const DEFAULT_BOUNDS: Rectangle = { x: 80, y: 80, width: 1440, height: 900 };
const MIN_WIDTH = 1024;
const MIN_HEIGHT = 720;

function readState(filePath: string): WindowState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WindowState>;
    if (![parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite)) return undefined;
    return {
      x: parsed.x as number,
      y: parsed.y as number,
      width: Math.max(MIN_WIDTH, parsed.width as number),
      height: Math.max(MIN_HEIGHT, parsed.height as number),
      maximized: parsed.maximized === true,
    };
  } catch {
    return undefined;
  }
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width >= 80 && height >= 80;
}

export function restoreWindowState(screen: Screen, filePath: string): WindowState {
  const saved = readState(filePath);
  if (saved && screen.getAllDisplays().some((display) => intersects(saved, display.workArea))) return saved;

  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DEFAULT_BOUNDS.width, area.width);
  const height = Math.min(DEFAULT_BOUNDS.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    maximized: false,
  };
}

export function persistWindowState(window: BrowserWindow, filePath: string): void {
  if (window.isDestroyed() || window.isMinimized()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const state: WindowState = { ...bounds, maximized: window.isMaximized() };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch {
    // A read-only profile should not prevent the app from closing.
  }
}
