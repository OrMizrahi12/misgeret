import { contextBridge, ipcRenderer } from 'electron';
import {
  DESKTOP_COMMANDS,
  IPC,
  type DesktopCommand,
  type MisgeretDesktopApi,
  type UpdateState,
} from './contracts.js';

function subscribe<T>(channel: string, guard: (value: unknown) => value is T, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: unknown): void => {
    if (guard(value)) callback(value);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function isDesktopCommand(value: unknown): value is DesktopCommand {
  return typeof value === 'string' && (DESKTOP_COMMANDS as readonly string[]).includes(value);
}

function isUpdateState(value: unknown): value is UpdateState {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'string' && [
    'disabled', 'idle', 'checking', 'available', 'not-available', 'downloading', 'downloaded', 'error',
  ].includes(status);
}

if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('UNSUPPORTED_DESKTOP_PLATFORM');
const desktopPlatform = process.platform as 'win32' | 'darwin' | 'linux';

const api: MisgeretDesktopApi = Object.freeze({
  isDesktop: true,
  platform: desktopPlatform,
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo),
  rendererReady: (buildId: string) => ipcRenderer.invoke(IPC.rendererReady, String(buildId).slice(0, 160)),
  importLegacyData: () => ipcRenderer.invoke(IPC.importLegacyData),
  exportCsv: () => ipcRenderer.invoke(IPC.exportCsv),
  createBackup: () => ipcRenderer.invoke(IPC.createBackup),
  revealData: () => ipcRenderer.invoke(IPC.revealData),
  revealLogs: () => ipcRenderer.invoke(IPC.revealLogs),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, String(url)),
  checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
  restartToUpdate: () => ipcRenderer.invoke(IPC.restartToUpdate),
  setUnsavedChanges: (value: boolean) => ipcRenderer.invoke(IPC.setUnsavedChanges, value === true),
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke(IPC.setTheme, theme === 'dark' ? 'dark' : 'light'),
  presenceGet: () => ipcRenderer.invoke(IPC.presenceGet),
  presenceSet: (patch: { enabled?: boolean; launchAtLogin?: boolean }) =>
    ipcRenderer.invoke(IPC.presenceSet, {
      ...(typeof patch?.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch?.launchAtLogin === 'boolean' ? { launchAtLogin: patch.launchAtLogin } : {}),
    }),
  recoveryAction: (action: 'retry' | 'open-logs' | 'quit') => ipcRenderer.invoke(IPC.recoveryAction, action),
  onCommand: (callback: (command: DesktopCommand) => void) =>
    subscribe(IPC.command, isDesktopCommand, callback),
  onUpdateState: (callback: (state: UpdateState) => void) =>
    subscribe(IPC.updateState, isUpdateState, callback),
});

contextBridge.exposeInMainWorld('misgeret', api);
