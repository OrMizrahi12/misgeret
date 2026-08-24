export type DesktopView = 'month' | 'overview' | 'future' | 'health' | 'networth' | 'connections' | 'settings';

export type DesktopCommand =
  | 'refresh'
  | 'sync'
  | 'export-csv'
  | 'create-backup'
  | `navigate-${DesktopView}`
  | 'check-for-updates';

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

export interface DesktopAppInfo {
  name: string;
  version: string;
  buildId: string;
  apiSchemaVersion: string;
}

export interface PresenceSettings {
  enabled: boolean;
  launchAtLogin: boolean;
}

export interface MisgeretDesktopBridge {
  readonly isDesktop: true;
  readonly platform: 'win32' | 'darwin' | 'linux';
  getAppInfo(): Promise<DesktopAppInfo>;
  rendererReady(buildId: string): Promise<{ accepted: boolean }>;
  importLegacyData(): Promise<{
    canceled: boolean;
    ok: boolean;
    parity?: {
      tables: Record<string, number>;
      quickCheck: 'ok';
      credentialsUnavailable: number[];
    };
    errorCode?: string;
  }>;
  exportCsv(): Promise<{ canceled: boolean; filePath?: string; errorCode?: string }>;
  createBackup(): Promise<{ ok: boolean; filePath?: string; errorCode?: string }>;
  revealData(): Promise<{ ok: boolean }>;
  revealLogs(): Promise<{ ok: boolean }>;
  openExternal(url: string): Promise<boolean>;
  checkForUpdates(): Promise<UpdateState>;
  restartToUpdate(): Promise<{ accepted: boolean; reason?: 'busy' | 'not-ready' | 'unsaved' | 'backup-failed' }>;
  recoveryAction(action: 'retry' | 'open-logs' | 'quit'): Promise<void>;
  setUnsavedChanges(value: boolean): Promise<void>;
  setTheme(theme: 'light' | 'dark'): Promise<void>;
  /** Optional so the web client can also run without the desktop presence bridge. */
  presenceGet?(): Promise<PresenceSettings>;
  presenceSet?(patch: Partial<PresenceSettings>): Promise<PresenceSettings>;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

declare global {
  interface Window {
    misgeret?: MisgeretDesktopBridge;
  }
}

export const desktop = typeof window === 'undefined' ? undefined : window.misgeret;

/** Public project pages exposed through the desktop's narrow external-link allowlist. */
export const PROJECT_URLS = {
  source: 'https://github.com/OrMizrahi12/misgeret',
  license: 'https://github.com/OrMizrahi12/misgeret/blob/main/LICENSE',
  privacy: 'https://misgeret-israel.com/privacy',
} as const;

/** Open a project page in the user's browser — via the desktop bridge when packaged,
 *  or a new tab on the web. The bridge accepts only our own site and repository. */
export function openProjectPage(url: string): void {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function fileName(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  return filePath.split(/[\\/]/).filter(Boolean).at(-1);
}

export function updateStateHe(state: UpdateState): string {
  switch (state.status) {
    case 'disabled':
      return 'עדכונים אוטומטיים אינם זמינים בגרסה זו.';
    case 'checking':
      return 'בודק אם יש עדכון…';
    case 'available':
      return state.version ? `נמצא עדכון ${state.version}.` : 'נמצא עדכון חדש.';
    case 'downloading':
      return state.percent == null ? 'מוריד את העדכון…' : `מוריד את העדכון… ${Math.round(state.percent)}%`;
    case 'downloaded':
      return state.version ? `גרסה ${state.version} מוכנה להתקנה.` : 'העדכון מוכן להתקנה.';
    case 'not-available':
      return 'מסגרת מעודכנת לגרסה האחרונה.';
    case 'error':
      return state.message ?? 'לא ניתן לבדוק עדכונים כרגע.';
    default:
      return 'עדכונים נבדקים לאחר פתיחת האפליקציה.';
  }
}
