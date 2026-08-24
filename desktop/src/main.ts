import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { readAppInfo, readUpdateFeedUrl } from './build-info.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import {
  IPC,
  type BackupResult,
  type DesktopCommand,
  type FileDialogResult,
  type ImportDataResult,
  type ImportParity,
  type PresenceSettings,
  type RestartToUpdateResult,
  type UtilityStartConfig,
} from './contracts.js';
import { RedactedLogger } from './logger.js';
import { installApplicationMenu } from './menu.js';
import { migrateLegacyRuntimeData } from './migration.js';
import {
  ensureRuntimePaths,
  getLegacyRuntimeRoot,
  getProductionRuntimeRoot,
  getRuntimePaths,
  hasExistingData,
  isProfileId,
  moveProfileToDeleted,
  profileBackupsDir,
  resolveChromiumExecutable,
  resolveRuntimeModule,
} from './paths.js';
import { readPresence, readZoomFactor, writePresence, writeZoomFactor } from './preferences.js';
import { QuietPresence } from './presence.js';
import { RuntimeManager, type StartedRuntime } from './runtime-manager.js';
import { DesktopSecurity } from './security.js';
import { handleSquirrelLifecycle } from './squirrel.js';
import { DesktopUpdater } from './updater.js';
import { persistWindowState, restoreWindowState } from './window-state.js';

const APP_NAME = 'מסגרת';
const APP_USER_MODEL_ID = 'com.squirrel.Misgeret.Misgeret';
const WINDOW_PARTITION = 'persist:misgeret';
const MAX_EXPORT_BYTES = 100 * 1024 * 1024;

// Resolve the complete runtime root before Chromium creates its profile. This keeps
// development/package smoke sessions out of the installed application's real profile too.
const paths = getRuntimePaths(app);
const bootstrapElectronDir = paths.electronDir;
fs.mkdirSync(path.join(bootstrapElectronDir, 'session'), { recursive: true });
app.setPath('userData', bootstrapElectronDir);
app.setPath('sessionData', path.join(bootstrapElectronDir, 'session'));
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);

let mainWindow: BrowserWindow | undefined;
let runtimeManager: RuntimeManager | undefined;
let runtimeOrigin: string | undefined;
let runtimeConfig: UtilityStartConfig | undefined;
let security: DesktopSecurity | undefined;
let logger: RedactedLogger | undefined;
let updater: DesktopUpdater | undefined;
let unsavedChanges = false;
let shutdownStarted = false;
let allowWindowClose = false;
let presence: QuietPresence | undefined;
let presenceSettings: PresenceSettings = { enabled: false, launchAtLogin: false };
/** A login-item launch passes --hidden: the app boots straight to the tray, no window flash. */
const startHidden = process.argv.includes('--hidden');
let recoveryInProgress = false;
let rendererBuildAccepted = false;
let rendererReadyTimer: NodeJS.Timeout | undefined;
let firstRunWizardActive = false;
let firstRunRuntime: StartedRuntime | undefined;
let runtimeSuspended = false;
let suspendedDuringFirstRun = false;
let suspendStopPromise: Promise<void> | undefined;
// Only a profile THIS boot caused to be created is provisional. A first-run.pending copied from a
// ≤1.0.0 root arrives beside real data (legacy-migration.test.ts asserts that copy), so the wizard
// can open over a live database — and then the quit path must touch nothing.
let firstRunCreatedData = false;

const windowStatePath = path.join(paths.electronDir, 'window-state.json');
const preferencesPath = path.join(paths.electronDir, 'preferences.json');
const firstRunPendingPath = path.join(paths.electronDir, 'first-run.pending');

interface FirstRunPendingMarker {
  version: number;
  createdAt: string;
  provisionalProfileId?: string;
}

function readFirstRunPendingMarker(): FirstRunPendingMarker | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(firstRunPendingPath, 'utf8')) as FirstRunPendingMarker;
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeFirstRunPendingMarker(marker: FirstRunPendingMarker): void {
  const temporary = `${firstRunPendingPath}.partial-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(marker), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, firstRunPendingPath);
}

/**
 * Called twice: once with no id before the runtime starts (the marker must be durable first, so a
 * crash mid-wizard still resumes as a first run), then again once the runtime reports which
 * profile it provisionally created. The id is what the quit path deletes by — without it, cleanup
 * does nothing. Stamping only ever annotates an existing marker: minting one from an id would
 * resurrect a first run the user already finished.
 */
function ensureFirstRunPendingMarker(profileId?: string): void {
  if (!profileId) {
    try {
      fs.writeFileSync(
        firstRunPendingPath,
        JSON.stringify({ version: 1, createdAt: new Date().toISOString() } satisfies FirstRunPendingMarker),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return;
  }
  if (!isProfileId(profileId)) throw new Error('INVALID_PROVISIONAL_PROFILE_ID');
  const existing = readFirstRunPendingMarker();
  if (!existing || existing.provisionalProfileId === profileId) return;
  writeFirstRunPendingMarker({
    version: 1,
    createdAt: existing.createdAt ?? new Date().toISOString(),
    provisionalProfileId: profileId,
  });
}

function completeFirstRun(): void {
  fs.rmSync(firstRunPendingPath, { force: true });
}

/** Records the runtime's provisional profile so "יציאה" can undo exactly it, and nothing else. */
function recordProvisionalProfile(started: StartedRuntime): void {
  if (!firstRunCreatedData) return;
  const profileId = started.runtime.activeProfileId;
  if (!isProfileId(profileId)) {
    // Fail open, not closed: without an id the quit path leaves the provisional profile behind
    // rather than guessing which directory to move. That is the safe half of the failure.
    logger?.warn('first-run.provisional-profile-unreported');
    return;
  }
  ensureFirstRunPendingMarker(profileId);
}

/**
 * The runtime creates a profile before the native wizard can import into it. Until the user
 * commits to "Start new" or completes an import, that one profile is provisional — so it is moved
 * aside exactly as ProfileStore.softDelete would, never deleted, and never by layout: profiles/
 * and profiles.json hold every other person's world and their backups.
 */
function discardProvisionalFirstRunData(): void {
  const provisionalProfileId = readFirstRunPendingMarker()?.provisionalProfileId;
  if (!provisionalProfileId) return;
  try {
    const moved = moveProfileToDeleted(paths, provisionalProfileId);
    logger?.info('first-run.provisional-profile-discarded', { moved });
  } catch (error) {
    logger?.error('first-run.provisional-discard-failed', error);
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return ((error as { code: string }).code).slice(0, 80);
  }
  return 'DESKTOP_ERROR';
}

function sendCommand(command: DesktopCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.command, command);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow
    || event.sender !== mainWindow.webContents
    || !event.senderFrame
    || !security?.isTrustedSender(event.senderFrame.url)
  ) {
    throw Object.assign(new Error('Untrusted IPC sender.'), { code: 'UNTRUSTED_IPC' });
  }
}

function registerHandler(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

async function runtimeFetch(
  route: string,
  init: RequestInit = {},
  options: { desktopAction?: boolean } = {},
): Promise<Response> {
  if (!runtimeOrigin || !runtimeConfig) throw Object.assign(new Error('Runtime is not ready.'), { code: 'RUNTIME_NOT_READY' });
  if (!route.startsWith('/api/')) throw new Error('INVALID_RUNTIME_ROUTE');
  const headers = new Headers(init.headers);
  headers.delete('X-Misgeret-Desktop-Action');
  headers.set('Accept', 'application/json, text/csv');
  headers.set('Origin', runtimeOrigin);
  headers.set('Authorization', `Bearer ${runtimeConfig.apiToken}`);
  if (options.desktopAction) {
    headers.set('X-Misgeret-Desktop-Action', runtimeConfig.desktopActionToken);
  }
  return net.fetch(`${runtimeOrigin}${route}`, {
    ...init,
    headers,
  });
}

async function chooseLegacyDataPath(parentToMainWindow = true): Promise<string | undefined> {
  if (parentToMainWindow && !mainWindow) return undefined;
  const options = {
    title: 'ייבוא נתונים קיימים למסגרת',
    buttonLabel: 'בחר לייבוא',
    defaultPath: app.getPath('desktop'),
    properties: ['openFile'],
    filters: [
      { name: 'גיבויי מסגרת', extensions: ['db', 'misgeret-backup'] },
      { name: 'כל הקבצים', extensions: ['*'] },
    ],
  } satisfies Electron.OpenDialogOptions;
  const result = parentToMainWindow && mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || result.filePaths.length !== 1
    ? undefined
    : path.resolve(result.filePaths[0]);
}

function parseImportParity(value: unknown): ImportParity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { tables?: unknown; quickCheck?: unknown; credentialsUnavailable?: unknown };
  if (
    candidate.quickCheck !== 'ok'
    || !candidate.tables
    || typeof candidate.tables !== 'object'
    || Array.isArray(candidate.tables)
    || !Array.isArray(candidate.credentialsUnavailable)
  ) return undefined;

  const tables: Record<string, number> = {};
  for (const [name, count] of Object.entries(candidate.tables)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(name) || !Number.isSafeInteger(count) || Number(count) < 0) return undefined;
    tables[name] = Number(count);
  }
  const credentialsUnavailable = candidate.credentialsUnavailable.filter(
    (id): id is number => Number.isSafeInteger(id) && Number(id) > 0,
  );
  if (credentialsUnavailable.length !== candidate.credentialsUnavailable.length) return undefined;
  return { tables, quickCheck: 'ok', credentialsUnavailable };
}

interface ImportTargetProfile {
  id: string;
  name: string;
}

/**
 * The registry's active profile, resolved through the same truth every header-less call uses.
 *
 * Import is a full destructive replace, so it pins its destination from this — before the file
 * dialog opens — and sends it explicitly; resolving from the mutable activeId would sample it
 * when the POST lands, potentially minutes later and at a different profile. Export only borrows
 * the name, to label the file it is about to write.
 */
async function resolveActiveProfile(): Promise<ImportTargetProfile | undefined> {
  try {
    const response = await runtimeFetch('/api/profiles');
    if (!response.ok) return undefined;
    const body = await response.json() as { profiles?: unknown; activeId?: unknown };
    if (!isProfileId(body.activeId) || !Array.isArray(body.profiles)) return undefined;
    const active = (body.profiles as Array<{ id?: unknown; name?: unknown }>)
      .find((profile) => profile?.id === body.activeId);
    if (!active || typeof active.name !== 'string' || !active.name.trim()) return undefined;
    return { id: body.activeId, name: active.name };
  } catch (error) {
    logger?.error('import.profile-lookup-failed', error);
    return undefined;
  }
}

async function confirmImportDestination(
  profileName: string,
  parentToMainWindow: boolean,
): Promise<boolean> {
  const options = {
    type: 'warning',
    title: 'אישור ייבוא',
    message: `לייבא את הנתונים אל המשתמש "${profileName}"?`,
    detail: 'כל הנתונים הקיימים של המשתמש הזה יוחלפו בנתונים מקובץ המקור. קובץ המקור עצמו לא ישתנה.',
    buttons: ['ביטול', 'ייבא והחלף'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  } satisfies Electron.MessageBoxOptions;
  const result = parentToMainWindow && mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function performPrivilegedImport(sourcePath: string, profileId: string): Promise<ImportDataResult> {
  try {
    const response = await runtimeFetch('/api/data/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Misgeret-Profile': profileId },
      body: JSON.stringify({ sourcePath }),
    }, { desktopAction: true });
    if (!response.ok) {
      let responseCode: unknown;
      try {
        responseCode = ((await response.json()) as { errorType?: unknown }).errorType;
      } catch {
        // The privileged bridge returns a fixed local code for non-JSON failures.
      }
      const safeCode = typeof responseCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(responseCode)
        ? responseCode
        : 'IMPORT_FAILED';
      return { canceled: false, ok: false, errorCode: safeCode };
    }
    const body = await response.json() as { ok?: unknown; parity?: unknown };
    const parity = parseImportParity(body.parity);
    if (body.ok !== true || !parity) return { canceled: false, ok: false, errorCode: 'INVALID_IMPORT_RESPONSE' };
    return { canceled: false, ok: true, parity };
  } catch (error) {
    logger?.error('import.failed', error);
    return { canceled: false, ok: false, errorCode: errorCode(error) };
  }
}

async function importLegacyData(parentToMainWindow = true): Promise<ImportDataResult> {
  const target = await resolveActiveProfile();
  if (!target) return { canceled: false, ok: false, errorCode: 'PROFILE_LOOKUP_FAILED' };
  const sourcePath = await chooseLegacyDataPath(parentToMainWindow);
  if (!sourcePath) return { canceled: true, ok: false };
  if (!(await confirmImportDestination(target.name, parentToMainWindow))) {
    return { canceled: true, ok: false };
  }
  return performPrivilegedImport(sourcePath, target.id);
}

const FORBIDDEN_FILE_NAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/**
 * A profile name is free Hebrew text; a file name is not. Everything Windows forbids — the path
 * separators above all — is folded away, so a name can never steer the default path out of the
 * folder the dialog opens in. Returns null when nothing usable survives.
 */
function fileSafeProfileName(name: string): string | null {
  const folded = Array.from(name.normalize('NFC'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return '-';
    return FORBIDDEN_FILE_NAME_CHARS.has(character) || character === ' ' ? '-' : character;
  }).join('');
  // Windows silently drops a trailing dot or space from a file name; a leading one reads as junk.
  const cleaned = folded.replace(/-+/g, '-').slice(0, 40).replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

async function exportCsv(): Promise<FileDialogResult> {
  if (!mainWindow) return { canceled: true };
  try {
    const date = new Date().toISOString().slice(0, 10);
    // This is the one place money leaves the app for good, so the artifact carries its owner:
    // exporting two profiles on the same day must not collide on one default file name, with
    // nothing inside either file to tell them apart afterwards.
    const owner = await resolveActiveProfile();
    const label = owner ? fileSafeProfileName(owner.name) : null;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: owner ? `ייצוא העסקאות של ${owner.name} ל־CSV` : 'ייצוא עסקאות ל־CSV',
      buttonLabel: 'שמור',
      defaultPath: path.join(
        app.getPath('documents'),
        label ? `misgeret-${label}-${date}.csv` : `misgeret-transactions-${date}.csv`,
      ),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (result.canceled || !result.filePath) return { canceled: true };

    const response = await runtimeFetch('/api/export.csv');
    if (!response.ok) throw Object.assign(new Error('CSV export failed.'), { code: 'EXPORT_FAILED' });
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_EXPORT_BYTES) {
      throw Object.assign(new Error('CSV export is too large.'), { code: 'EXPORT_TOO_LARGE' });
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > MAX_EXPORT_BYTES) {
      throw Object.assign(new Error('CSV export is too large.'), { code: 'EXPORT_TOO_LARGE' });
    }

    const destination = path.resolve(result.filePath);
    const temporary = `${destination}.partial-${process.pid}`;
    await fs.promises.writeFile(temporary, content, { mode: 0o600 });
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
    logger?.info('export.completed', { bytes: content.byteLength });
    return { canceled: false, filePath: destination };
  } catch (error) {
    logger?.error('export.failed', error);
    return { canceled: false, errorCode: errorCode(error) };
  }
}

async function createBackup(): Promise<BackupResult> {
  try {
    const response = await runtimeFetch('/api/backup', { method: 'POST' });
    if (!response.ok) throw Object.assign(new Error('Backup failed.'), { code: response.status === 409 ? 'APP_BUSY' : 'BACKUP_FAILED' });
    const body = await response.json() as { file?: unknown; profileId?: unknown };
    // Backups live per profile now, so the response names its own; both halves are validated
    // before either is joined onto a path.
    if (
      typeof body.file !== 'string'
      || path.basename(body.file) !== body.file
      || !isProfileId(body.profileId)
    ) {
      throw Object.assign(new Error('Backup response was invalid.'), { code: 'INVALID_BACKUP_RESPONSE' });
    }
    return { ok: true, filePath: path.join(profileBackupsDir(paths, body.profileId), body.file) };
  } catch (error) {
    logger?.error('backup.failed', error);
    return { ok: false, errorCode: errorCode(error) };
  }
}

async function revealDirectory(directory: string): Promise<{ ok: boolean }> {
  ensureRuntimePaths(paths);
  const result = await shell.openPath(directory);
  if (result) logger?.warn('shell.open-path-failed', { reason: result });
  return { ok: result.length === 0 };
}

function setZoom(delta: number | 'reset'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const current = mainWindow.webContents.getZoomFactor();
  const next = delta === 'reset' ? 1 : Math.min(2, Math.max(0.8, Math.round((current + delta) * 10) / 10));
  mainWindow.webContents.setZoomFactor(next);
  writeZoomFactor(preferencesPath, next);
}

function validateHandshake(started: StartedRuntime): void {
  if (!runtimeConfig) throw new Error('RUNTIME_CONFIG_MISSING');
  if (started.runtime.buildId !== runtimeConfig.buildId) {
    throw Object.assign(new Error('Renderer and runtime builds do not match.'), { code: 'BUILD_ID_MISMATCH' });
  }
  const appInfo = readAppInfo(APP_NAME, app.getVersion());
  if (String(started.runtime.apiSchemaVersion) !== appInfo.apiSchemaVersion) {
    throw Object.assign(new Error('API schema versions do not match.'), { code: 'API_SCHEMA_MISMATCH' });
  }
}

async function createPreUpdateBackup(): Promise<boolean> {
  try {
    const response = await runtimeFetch('/api/backup/automatic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'update' }),
    }, { desktopAction: true });
    if (!response.ok) throw Object.assign(new Error('Automatic backup failed.'), { code: 'BACKUP_FAILED' });
    return true;
  } catch (error) {
    logger?.error('update.backup-failed', error);
    return false;
  }
}

async function validateRendererAssetManifest(origin: string, expectedBuildId: string): Promise<void> {
  const response = await net.fetch(
    `${origin}/build-manifest.json?build=${encodeURIComponent(expectedBuildId)}`,
    { headers: { 'Cache-Control': 'no-cache' } },
  );
  if (!response.ok) {
    throw Object.assign(new Error('Renderer build manifest is missing.'), { code: 'RENDERER_MANIFEST_MISSING' });
  }
  const manifest = await response.json() as { buildId?: unknown; apiSchemaVersion?: unknown };
  const appInfo = readAppInfo(APP_NAME, app.getVersion());
  if (manifest.buildId !== expectedBuildId) {
    throw Object.assign(new Error('Renderer assets do not match the desktop build.'), { code: 'RENDERER_BUILD_ID_MISMATCH' });
  }
  if (String(manifest.apiSchemaVersion) !== appInfo.apiSchemaVersion) {
    throw Object.assign(new Error('Renderer assets do not match the API schema.'), { code: 'RENDERER_API_SCHEMA_MISMATCH' });
  }
}

async function startRuntime(): Promise<StartedRuntime> {
  if (!runtimeManager || !runtimeConfig || !mainWindow || !security) throw new Error('DESKTOP_NOT_INITIALIZED');
  const started = await runtimeManager.start(runtimeConfig);
  validateHandshake(started);
  runtimeOrigin = started.origin;
  rendererBuildAccepted = false;
  await validateRendererAssetManifest(started.origin, runtimeConfig.buildId);
  security.setRuntime(started.origin, runtimeConfig.apiToken);
  return started;
}

async function loadRenderer(started: StartedRuntime): Promise<void> {
  if (!runtimeConfig || !mainWindow) throw new Error('DESKTOP_NOT_INITIALIZED');
  await mainWindow.loadURL(`${started.origin}/index.html`);
  mainWindow.webContents.setZoomFactor(readZoomFactor(preferencesPath));
  clearTimeout(rendererReadyTimer);
  rendererReadyTimer = setTimeout(() => {
    if (!rendererBuildAccepted && !shutdownStarted) {
      void showRecovery(Object.assign(new Error('Renderer build handshake timed out.'), {
        code: 'RENDERER_READY_TIMEOUT',
      }));
    }
  }, 15_000);
}

async function showRecovery(error: unknown): Promise<void> {
  clearTimeout(rendererReadyTimer);
  rendererReadyTimer = undefined;
  const code = errorCode(error);
  logger?.error('desktop.recovery', error, { code });
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // next to the bundled main.cjs — desktop/build.mjs copies desktop/static into the dist
  // output, which is the only desktop tree the packager ships
  const recovery = path.join(__dirname, 'static', 'recovery.html');
  await mainWindow.loadFile(recovery, { query: { code } });
  mainWindow.show();
}

async function retryRuntime(): Promise<void> {
  if (recoveryInProgress || shutdownStarted || !runtimeManager || !runtimeConfig) return;
  recoveryInProgress = true;
  try {
    if (runtimeManager.running) await runtimeManager.stop('restart');
    rotateRuntimeCapabilities();
    let started = await startRuntime();
    if (fs.existsSync(firstRunPendingPath)) {
      const resolved = await resolvePendingFirstRun(started);
      if (!resolved) return;
      started = resolved;
    }
    await loadRenderer(started);
  } catch (error) {
    await showRecovery(error);
  } finally {
    recoveryInProgress = false;
  }
}

function rotateRuntimeCapabilities(): void {
  if (!runtimeConfig) throw new Error('RUNTIME_CONFIG_MISSING');
  runtimeConfig = {
    ...runtimeConfig,
    apiToken: crypto.randomBytes(32).toString('base64url'),
    desktopActionToken: crypto.randomBytes(32).toString('base64url'),
  };
}

async function ensureFirstRunRuntime(): Promise<StartedRuntime> {
  if (!runtimeManager || !runtimeConfig) throw new Error('DESKTOP_NOT_INITIALIZED');
  if (runtimeManager.running && firstRunRuntime) return firstRunRuntime;
  if (!runtimeManager.takeRestartAllowance()) {
    throw Object.assign(new Error('Finance runtime stopped during first-run setup.'), {
      code: 'RUNTIME_RESTART_EXHAUSTED',
    });
  }
  rotateRuntimeCapabilities();
  const restarted = await startRuntime();
  firstRunRuntime = restarted;
  return restarted;
}

async function resolvePendingFirstRun(started: StartedRuntime): Promise<StartedRuntime | undefined> {
  firstRunWizardActive = true;
  firstRunRuntime = started;
  try {
    recordProvisionalProfile(started);
    if (!(await runFirstRunWizard())) return undefined;
    return await ensureFirstRunRuntime();
  } finally {
    firstRunWizardActive = false;
    firstRunRuntime = undefined;
  }
}

function registerPowerLifecycle(): void {
  powerMonitor.on('suspend', () => {
    if (shutdownStarted || runtimeSuspended) return;
    runtimeSuspended = true;
    suspendedDuringFirstRun = firstRunWizardActive;
    rendererBuildAccepted = false;
    recoveryInProgress = true;
    firstRunRuntime = undefined;
    logger?.info('desktop.suspend', { firstRun: suspendedDuringFirstRun });
    suspendStopPromise = (runtimeManager?.stop('restart') ?? Promise.resolve()).catch((error) => {
      logger?.error('desktop.suspend-stop-failed', error);
    });
  });

  powerMonitor.on('resume', () => {
    if (!runtimeSuspended || shutdownStarted) return;
    const resumeFirstRun = suspendedDuringFirstRun;
    const stopped = suspendStopPromise;
    runtimeSuspended = false;
    suspendedDuringFirstRun = false;
    suspendStopPromise = undefined;
    void (async () => {
      try {
        await stopped;
        recoveryInProgress = false;
        logger?.info('desktop.resume', { firstRun: resumeFirstRun });
        if (resumeFirstRun && firstRunWizardActive) {
          if (runtimeManager?.running) await runtimeManager.stop('restart');
          rotateRuntimeCapabilities();
          firstRunRuntime = await startRuntime();
          return;
        }
        await retryRuntime();
      } catch (error) {
        recoveryInProgress = false;
        await showRecovery(error);
      }
    })();
  });
}

function mayUseAutomatedFirstRunChoice(): boolean {
  if (!app.isPackaged) return true;
  const overrideRoot = process.env.MISGERET_DATA_ROOT?.trim();
  const normalProductionRoot = getProductionRuntimeRoot(app);
  return Boolean(
    overrideRoot
    && process.env.MISGERET_ALLOW_DATA_ROOT_OVERRIDE === '1'
    && path.resolve(overrideRoot) === path.resolve(paths.rootDir)
    && path.resolve(overrideRoot) !== path.resolve(normalProductionRoot),
  );
}

async function runFirstRunWizard(): Promise<boolean> {
  if (!mainWindow) return false;
  if (
    process.env.MISGERET_FIRST_RUN_ACTION === 'new'
    && mayUseAutomatedFirstRunChoice()
  ) {
    logger?.info('first-run.automated-new-profile');
    await ensureFirstRunRuntime();
    completeFirstRun();
    return true;
  }

  while (!shutdownStarted) {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'ברוכים הבאים למסגרת',
      message: 'איך תרצה להתחיל?',
      detail: 'אפשר להתחיל עם מסד נתונים חדש, או לייבא התקנה קיימת בלי לשנות את קובץ המקור.',
      buttons: ['התחל חדש', 'ייבא התקנה קיימת', 'יציאה'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 0) {
      await ensureFirstRunRuntime();
      completeFirstRun();
      return true;
    }
    if (choice.response === 2) {
      await shutdown('quit', () => {
        discardProvisionalFirstRunData();
        completeFirstRun();
      });
      return false;
    }

    await ensureFirstRunRuntime();
    const imported = await importLegacyData();
    if (imported.canceled) continue;
    if (!imported.ok || !imported.parity) {
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'הייבוא לא הושלם',
        message: 'לא ניתן לייבא את קובץ הנתונים שנבחר.',
        detail: `קוד תקלה: ${imported.errorCode ?? 'IMPORT_FAILED'}\nקובץ המקור והנתונים המקומיים נשארו ללא שינוי.`,
        buttons: ['חזרה'],
        defaultId: 0,
        noLink: true,
      });
      continue;
    }

    const tableCount = Object.keys(imported.parity.tables).length;
    const rowCount = Object.values(imported.parity.tables).reduce((total, count) => total + count, 0);
    const unavailable = imported.parity.credentialsUnavailable.length;
    completeFirstRun();
    await dialog.showMessageBox(mainWindow, {
      type: unavailable > 0 ? 'warning' : 'info',
      title: 'הייבוא הושלם ואומת',
      message: `אומתו ${tableCount} טבלאות ו־${rowCount} רשומות.`,
      detail: unavailable > 0
        ? `${unavailable} חיבורים דורשים הזנת פרטי התחברות מחדש במשתמש ובמחשב הזה.`
        : 'בדיקת תקינות מסד הנתונים הסתיימה בהצלחה.',
      buttons: ['פתח את מסגרת'],
      defaultId: 0,
      noLink: true,
    });
    return true;
  }
  return false;
}

async function confirmAndQuit(): Promise<void> {
  if (shutdownStarted || !mainWindow) return;
  const busy = runtimeManager?.state !== 'idle';
  if (busy || unsavedChanges) {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'יציאה ממסגרת',
      message: busy ? 'מתבצעת כעת פעולה. לצאת ולבטל אותה?' : 'יש שינויים שטרם נשמרו. לצאת בכל זאת?',
      detail: busy ? 'הנתונים שכבר נשמרו לא ייפגעו.' : undefined,
      buttons: ['הישאר באפליקציה', 'צא'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return;
  }
  await shutdown('quit');
}

async function shutdown(
  reason: 'quit' | 'update',
  afterRuntimeStopped?: () => void | Promise<void>,
): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  try {
    presence?.disable(); // the tray icon must not outlive the app
    if (mainWindow && !mainWindow.isDestroyed()) persistWindowState(mainWindow, windowStatePath);
    await runtimeManager?.stop(reason);
    await afterRuntimeStopped?.();
  } catch (error) {
    logger?.error('desktop.shutdown-failed', error);
  } finally {
    allowWindowClose = true;
    if (reason === 'update') updater?.quitAndInstall();
    else app.quit();
  }
}

function registerIpcHandlers(): void {
  const appInfo = readAppInfo(APP_NAME, app.getVersion());
  registerHandler(IPC.getAppInfo, () => appInfo);
  registerHandler(IPC.rendererReady, async (_event, rendererBuildId) => {
    if (typeof rendererBuildId !== 'string' || rendererBuildId !== appInfo.buildId) {
      rendererBuildAccepted = false;
      await showRecovery(Object.assign(new Error('Renderer code does not match the desktop build.'), {
        code: 'RENDERER_CODE_BUILD_ID_MISMATCH',
      }));
      return { accepted: false };
    }
    rendererBuildAccepted = true;
    clearTimeout(rendererReadyTimer);
    rendererReadyTimer = undefined;
    // a --hidden login-item launch boots straight to the tray — the window waits to be asked
    if (mainWindow && !mainWindow.isDestroyed() && !(startHidden && presenceSettings.enabled)) mainWindow.show();
    return { accepted: true };
  });
  registerHandler(IPC.importLegacyData, () => importLegacyData());
  registerHandler(IPC.exportCsv, () => exportCsv());
  registerHandler(IPC.createBackup, () => createBackup());
  registerHandler(IPC.revealData, () => revealDirectory(paths.dataDir));
  registerHandler(IPC.revealLogs, () => revealDirectory(paths.logsDir));
  // Open only the project's own public pages. This remains deliberately narrower than a generic
  // arbitrary-URL launcher so a compromised renderer cannot hand the OS an attacker-controlled URL.
  registerHandler(IPC.openExternal, async (_event, url) => {
    if (typeof url !== 'string') return false;
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    const ownSite = parsed.hostname === 'misgeret-israel.com';
    const ownRepository = parsed.hostname === 'github.com' && parsed.pathname.startsWith('/OrMizrahi12/misgeret');
    if (parsed.protocol !== 'https:' || (!ownSite && !ownRepository)) return false;
    await shell.openExternal(parsed.toString());
    return true;
  });
  registerHandler(IPC.checkForUpdates, () => updater?.check() ?? { status: 'disabled' });
  registerHandler(IPC.setUnsavedChanges, (_event, value) => {
    if (typeof value !== 'boolean') throw new Error('INVALID_UNSAVED_STATE');
    unsavedChanges = value;
  });
  registerHandler(IPC.setTheme, (_event, theme) => {
    if (theme !== 'light' && theme !== 'dark') throw new Error('INVALID_THEME');
    applyWindowTheme(theme);
  });
  registerHandler(IPC.presenceGet, () => presenceSettings);
  registerHandler(IPC.presenceSet, (_event, patch) => {
    if (!patch || typeof patch !== 'object') throw new Error('INVALID_PRESENCE_PATCH');
    const p = patch as Partial<PresenceSettings>;
    presenceSettings = {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : presenceSettings.enabled,
      launchAtLogin: typeof p.launchAtLogin === 'boolean' ? p.launchAtLogin : presenceSettings.launchAtLogin,
    };
    writePresence(preferencesPath, presenceSettings);
    if (presenceSettings.enabled) presence?.enable();
    else presence?.disable();
    applyLoginItem();
    return presenceSettings;
  });
  registerHandler(IPC.restartToUpdate, async (): Promise<RestartToUpdateResult> => {
    if (!updater?.updateReady) return { accepted: false, reason: 'not-ready' };
    if (unsavedChanges) return { accepted: false, reason: 'unsaved' };
    if (runtimeManager?.state !== 'idle') return { accepted: false, reason: 'busy' };
    if (!(await createPreUpdateBackup())) return { accepted: false, reason: 'backup-failed' };
    await shutdown('update');
    return { accepted: true };
  });
  registerHandler(IPC.recoveryAction, async (_event, action) => {
    if (!['retry', 'open-logs', 'quit'].includes(String(action))) throw new Error('INVALID_RECOVERY_ACTION');
    if (action === 'retry') await retryRuntime();
    else if (action === 'open-logs') await revealDirectory(paths.logsDir);
    else await shutdown('quit');
  });
}

/** Squirrel apps register login items through Update.exe, which relaunches the real exe.
 *  --hidden rides along so a boot-time launch lands in the tray, not on the desktop. */
function applyLoginItem(): void {
  if (!app.isPackaged) return; // dev must never touch the user's real login items
  const enable = presenceSettings.enabled && presenceSettings.launchAtLogin;
  try {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: enable, type: 'mainAppService' });
      return;
    }
    if (process.platform === 'linux') {
      const configRoot = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
      const autostartDir = path.join(configRoot, 'autostart');
      const autostartFile = path.join(autostartDir, 'com.misgeret.desktop.desktop');
      if (!enable) {
        fs.rmSync(autostartFile, { force: true });
        return;
      }
      fs.mkdirSync(autostartDir, { recursive: true });
      const escapedExecutable = process.execPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
      const content = `[Desktop Entry]\nType=Application\nName=Misgeret\nExec="${escapedExecutable}" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`;
      const temporary = `${autostartFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, autostartFile);
      return;
    }
    const exeName = path.basename(process.execPath);
    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: updateExe,
      args: ['--processStart', `"${exeName}"`, '--process-start-args', '"--hidden"'],
    });
  } catch (error) {
    logger?.error('presence.login-item-failed', error);
  }
}

/** The presence tick's view of the runtime: same authenticated bridge, but a background
 *  tick never throws — every failure collapses to null and waits for the next tick. */
async function presenceFetchJson(route: string, init?: { method?: string; body?: string }): Promise<unknown> {
  try {
    const response = await runtimeFetch(route, {
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: init.body, headers: { 'Content-Type': 'application/json' } } : {}),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function createPresence(): QuietPresence {
  return new QuietPresence({
    isWindowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
    showWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed() && rendererBuildAccepted) {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    navigate: (target) => sendCommand(target === 'future' ? 'navigate-future' : 'navigate-month'),
    syncNow: async () => {
      const response = await presenceFetchJson('/api/sync', { method: 'POST' });
      if (response === null) logger?.warn('presence.sync-skipped');
    },
    fetchJson: presenceFetchJson,
    quit: () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      void confirmAndQuit();
    },
    log: {
      info: (message, meta) => logger?.info(message, meta),
      warn: (message, meta) => logger?.warn(message, meta),
    },
  }, path.join(__dirname, 'static', process.platform === 'win32' ? 'tray.ico' : 'tray.png'));
}

// Brand 3.0 window chrome — must match tokens.css (:root / [data-theme='dark']).
const WINDOW_THEMES = {
  light: { background: '#f6f5fa', overlay: '#f6f5fa', symbol: '#17131f' },
  dark: { background: '#0b0812', overlay: '#0b0812', symbol: '#f2f0f7' },
} as const;

function applyWindowTheme(theme: keyof typeof WINDOW_THEMES): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const colors = WINDOW_THEMES[theme];
  mainWindow.setBackgroundColor(colors.background);
  if (process.platform !== 'darwin') {
    mainWindow.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbol, height: 40 });
  }
}

function createMainWindow(): BrowserWindow {
  const state = restoreWindowState(screen, windowStatePath);
  const window = new BrowserWindow({
    ...state,
    show: false,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: WINDOW_THEMES.light.background,
    title: APP_NAME,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? {} : {
      titleBarOverlay: { color: WINDOW_THEMES.light.overlay, symbolColor: WINDOW_THEMES.light.symbol, height: 40 },
    }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition: WINDOW_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
  if (state.maximized) window.maximize();

  window.on('close', (event) => {
    persistWindowState(window, windowStatePath);
    if (allowWindowClose) return;
    event.preventDefault();
    if (process.platform === 'darwin' && !shutdownStarted) {
      window.hide();
      return;
    }
    // נוכחות שקטה: closing keeps the app alive in the tray. יציאה lives in the tray menu.
    if (presenceSettings.enabled && presence?.active && !shutdownStarted) {
      window.hide();
      return;
    }
    void confirmAndQuit();
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const command = input.control || input.meta;
    if ((input.key === 'F5') || (command && input.key.toLowerCase() === 'r')) {
      event.preventDefault();
      sendCommand('refresh');
    } else if (command && ['+', '='].includes(input.key)) {
      event.preventDefault();
      setZoom(0.1);
    } else if (command && input.key === '-') {
      event.preventDefault();
      setZoom(-0.1);
    } else if (command && input.key === '0') {
      event.preventDefault();
      setZoom('reset');
    } else if (app.isPackaged && (input.key === 'F12' || (command && input.shift && input.key.toLowerCase() === 'i'))) {
      event.preventDefault();
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.warn('renderer.gone', { reason: details.reason, exitCode: details.exitCode });
    rendererBuildAccepted = false;
    if (!shutdownStarted && runtimeOrigin) void window.loadURL(`${runtimeOrigin}/index.html`);
  });
  return window;
}

// Migration failures propagate and abort startup: offering the first-run wizard while
// legacy data still exists in the old install directory invites accidental data loss.
function runLegacyMigration(): void {
  if (!app.isPackaged || process.platform !== 'win32') return;
  if (path.resolve(paths.rootDir) !== path.resolve(getProductionRuntimeRoot(app))) return;
  const summary = migrateLegacyRuntimeData(getLegacyRuntimeRoot(app), paths);
  if (summary.migrated) logger?.info('migration.completed', { files: summary.copiedFiles.length });
  else if (summary.reason !== 'no-legacy-data') logger?.info('migration.skipped', { reason: summary.reason });
}

async function initialize(): Promise<void> {
  ensureRuntimePaths(paths);
  const credentialEncryptionKey = await loadOrCreateCredentialKey(paths.electronDir, safeStorage);
  logger = new RedactedLogger(paths.logsDir);
  logger.info('desktop.start', { version: app.getVersion(), packaged: app.isPackaged });
  runLegacyMigration();
  const noExistingData = !hasExistingData(paths);
  if (noExistingData) ensureFirstRunPendingMarker();
  const firstRun = noExistingData || fs.existsSync(firstRunPendingPath);
  firstRunCreatedData = noExistingData;
  runtimeManager = new RuntimeManager(logger);
  registerPowerLifecycle();

  const partition = session.fromPartition(WINDOW_PARTITION, { cache: true });
  security = new DesktopSecurity(partition);
  mainWindow = createMainWindow();
  security.attachWindow(mainWindow);
  registerIpcHandlers();

  // נוכחות שקטה: restore the user's choice before anything can show or hide the window
  presenceSettings = readPresence(preferencesPath);
  presence = createPresence();
  if (presenceSettings.enabled) presence.enable();

  const appInfo = readAppInfo(APP_NAME, app.getVersion());
  updater = new DesktopUpdater(logger, readUpdateFeedUrl(app.isPackaged));
  updater.configure(mainWindow, (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.updateState, state);
  });

  installApplicationMenu(mainWindow, {
    command: sendCommand,
    exportCsv: async () => {
      const result = await exportCsv();
      if (result.errorCode) throw Object.assign(new Error('Export failed.'), { code: result.errorCode });
    },
    createBackup: async () => {
      const result = await createBackup();
      if (!result.ok) throw Object.assign(new Error('Backup failed.'), { code: result.errorCode });
      await dialog.showMessageBox(mainWindow!, {
        type: 'info',
        title: 'הגיבוי הושלם',
        message: 'נוצר גיבוי מקומי חדש.',
        buttons: ['אישור'],
      });
    },
    quit: () => void confirmAndQuit(),
    zoom: setZoom,
    checkForUpdates: async () => { await updater?.check(); },
    revealData: async () => { await revealDirectory(paths.dataDir); },
    revealLogs: async () => { await revealDirectory(paths.logsDir); },
    appInfo,
  });

  runtimeConfig = {
    runtimeModulePath: resolveRuntimeModule(app),
    paths,
    host: '127.0.0.1',
    port: 0,
    appVersion: appInfo.version,
    buildId: appInfo.buildId,
    apiToken: crypto.randomBytes(32).toString('base64url'),
    desktopActionToken: crypto.randomBytes(32).toString('base64url'),
    credentialEncryptionKey,
    browserExecutablePath: resolveChromiumExecutable(app),
  };

  runtimeManager.on('exit', ({ expected }: { expected: boolean }) => {
    if (expected || shutdownStarted || recoveryInProgress) return;
    if (firstRunWizardActive) {
      firstRunRuntime = undefined;
      return;
    }
    if (runtimeManager?.takeRestartAllowance()) void retryRuntime();
    else void showRecovery(Object.assign(new Error('Finance runtime stopped unexpectedly.'), { code: 'RUNTIME_CRASHED' }));
  });

  try {
    let started = await startRuntime();
    if (firstRun) {
      const resolved = await resolvePendingFirstRun(started);
      if (!resolved) return;
      started = resolved;
    }
    await loadRenderer(started);
    updater.scheduleInitialCheck();
  } catch (error) {
    await showRecovery(error);
  }
}

function bootstrap(): void {
  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (firstRunWizardActive) {
      app.focus({ steal: true });
      mainWindow.focus();
      return;
    }
    if (rendererBuildAccepted) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('before-quit', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void shutdown('quit');
  });
  app.on('activate', () => {
    if (firstRunWizardActive && mainWindow) {
      app.focus({ steal: true });
      mainWindow.focus();
      return;
    }
    if (mainWindow && rendererBuildAccepted) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !shutdownStarted) void shutdown('quit');
  });

  void app.whenReady().then(initialize).catch((error) => {
    logger?.error('desktop.initialize-failed', error);
    void dialog.showErrorBox('מסגרת לא נפתחה', `קוד תקלה: ${errorCode(error)}`);
    allowWindowClose = true;
    app.quit();
  });
}

if (handleSquirrelLifecycle()) app.quit();
else bootstrap();
