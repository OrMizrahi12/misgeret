import path from 'node:path';
import { spawn } from 'node:child_process';

function runUpdate(args: string[]): void {
  const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  try {
    const child = spawn(updateExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    // Squirrel can still repair shortcuts on the next update.
  }
}
/** Returns true when this process is only servicing a Squirrel lifecycle event. */
export function handleSquirrelLifecycle(): boolean {
  if (process.platform !== 'win32') return false;
  const event = process.argv[1];
  const executable = path.basename(process.execPath);

  if (event === '--squirrel-install' || event === '--squirrel-updated') {
    runUpdate(['--createShortcut', executable]);
    return true;
  }
  if (event === '--squirrel-uninstall') {
    runUpdate(['--removeShortcut', executable]);
    return true;
  }
  return event === '--squirrel-obsolete';
}
