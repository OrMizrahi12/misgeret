export const IPC = {
  getAppInfo: 'misgeret:get-app-info',
  rendererReady: 'misgeret:renderer-ready',
  importLegacyData: 'misgeret:import-legacy-data',
  exportCsv: 'misgeret:export-csv',
  createBackup: 'misgeret:create-backup',
  revealData: 'misgeret:reveal-data',
  revealLogs: 'misgeret:reveal-logs',
  openExternal: 'misgeret:open-external',
  checkForUpdates: 'misgeret:check-for-updates',
  restartToUpdate: 'misgeret:restart-to-update',
  setUnsavedChanges: 'misgeret:set-unsaved-changes',
  setTheme: 'misgeret:set-theme',
  presenceGet: 'misgeret:presence-get',
  presenceSet: 'misgeret:presence-set',
  recoveryAction: 'misgeret:recovery-action',
  command: 'misgeret:command',
  updateState: 'misgeret:update-state',
} as const;

export const DESKTOP_COMMANDS = [
  'refresh',
  'sync',
  'export-csv',
  'create-backup',
  'navigate-month',
  'navigate-overview',
  'navigate-future',
  'navigate-health',
  'navigate-networth',
  'navigate-connections',
  'navigate-settings',
  'check-for-updates',
] as const;

export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export type OperationState =
  | 'idle'
  | 'syncing'
  | 'backingUp'
  | 'restoring'
  | 'migrating'
  | 'shuttingDown';

export interface AppInfo {
  name: string;
  version: string;
  buildId: string;
  apiSchemaVersion: string;
}

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  message?: string;
  percent?: number;
}

export interface FileDialogResult {
  canceled: boolean;
  filePath?: string;
  errorCode?: string;
}

export interface ImportParity {
  tables: Record<string, number>;
  quickCheck: 'ok';
  credentialsUnavailable: number[];
}

/** Contains summary counts only. The selected absolute path never crosses into the renderer. */
export interface ImportDataResult {
  canceled: boolean;
  ok: boolean;
  parity?: ImportParity;
  errorCode?: string;
}

export interface BackupResult {
  ok: boolean;
  filePath?: string;
  errorCode?: string;
}

export interface RevealResult {
  ok: boolean;
}

export interface RestartToUpdateResult {
  accepted: boolean;
  reason?: 'busy' | 'not-ready' | 'unsaved' | 'backup-failed';
}

export interface RendererReadyResult {
  accepted: boolean;
}

/** נוכחות שקטה — the desktop shell's background life. Everything defaults to OFF. */
export interface PresenceSettings {
  /** Master switch: closing hides to the tray, sync ticks in the background while hidden,
   *  and the three quiet alerts (duplicate charge, price hike, forecast floor) may notify. */
  enabled: boolean;
  /** Start מסגרת minimized to the tray when the user logs in. Meaningful only while enabled. */
  launchAtLogin: boolean;
}

export interface MisgeretDesktopApi {
  readonly isDesktop: true;
  readonly platform: 'win32' | 'darwin' | 'linux';
  getAppInfo(): Promise<AppInfo>;
  rendererReady(buildId: string): Promise<RendererReadyResult>;
  importLegacyData(): Promise<ImportDataResult>;
  exportCsv(): Promise<FileDialogResult>;
  createBackup(): Promise<BackupResult>;
  revealData(): Promise<RevealResult>;
  revealLogs(): Promise<RevealResult>;
  openExternal(url: string): Promise<boolean>;
  checkForUpdates(): Promise<UpdateState>;
  restartToUpdate(): Promise<RestartToUpdateResult>;
  setUnsavedChanges(value: boolean): Promise<void>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  presenceGet(): Promise<PresenceSettings>;
  presenceSet(patch: Partial<PresenceSettings>): Promise<PresenceSettings>;
  recoveryAction(action: 'retry' | 'open-logs' | 'quit'): Promise<void>;
  onCommand(callback: (command: DesktopCommand) => void): () => void;
  onUpdateState(callback: (state: UpdateState) => void): () => void;
}

export interface RuntimePaths {
  rootDir: string;
  dataDir: string;
  /**
   * The pre-multi-profile database to be adopted into the first profile. Read by migration and
   * never again: live databases live at <dataDir>/profiles/<id>/finance.db.
   */
  dbPath: string;
  /**
   * The pre-multi-profile backup directory to be adopted into the first profile. Read by
   * migration and never again: live backups live at <dataDir>/profiles/<id>/backups.
   */
  backupsDir: string;
  logsDir: string;
  browserTempDir: string;
  electronDir: string;
}

export interface RuntimeHandshake {
  appVersion: string;
  buildId: string;
  apiSchemaVersion: string | number;
  dbSchemaVersion: number;
  initialization: string;
  /** The profile the runtime opened at boot — the registry's activeId. */
  activeProfileId: string;
}

export interface UtilityStartConfig {
  runtimeModulePath: string;
  paths: RuntimePaths;
  host: '127.0.0.1';
  port: 0;
  appVersion: string;
  buildId: string;
  apiToken: string;
  desktopActionToken: string;
  credentialEncryptionKey: string;
  browserExecutablePath?: string;
}

export type MainToUtilityMessage =
  | { type: 'start'; config: UtilityStartConfig }
  | { type: 'get-state' }
  | { type: 'shutdown'; reason: 'quit' | 'update' | 'restart' };

// openWorkspaceCount sizes the shutdown timeout: closeAll() checkpoints and closes one database
// per open profile, and a hard taskkill on expiry lands on live WALs.
export type UtilityToMainMessage =
  | {
    type: 'ready';
    origin: string;
    runtime: RuntimeHandshake;
    state: OperationState;
    openWorkspaceCount?: number;
  }
  | { type: 'state'; state: OperationState; openWorkspaceCount?: number }
  | { type: 'error'; phase: 'startup' | 'runtime' | 'shutdown'; code: string; message: string }
  | { type: 'stopped' };
