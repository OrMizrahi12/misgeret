import fs from 'node:fs';
import path from 'node:path';
import type { App } from 'electron';
import type { RuntimePaths } from './contracts.js';

// Squirrel.Windows owns %LOCALAPPDATA%\Misgeret: it installs the binaries there and
// deletes that directory wholesale on uninstall and on same-version reinstall. User
// data therefore lives in the Roaming profile, which no installer lifecycle touches.
function roamingAppData(app: App, environment: NodeJS.ProcessEnv): string {
  return environment.APPDATA?.trim() || app.getPath('appData');
}

function localAppData(app: App, environment: NodeJS.ProcessEnv): string {
  // app.getPath('appData') is the ROAMING profile — falling back to it would collapse the
  // legacy (≤1.0.0) root onto the production root and silently skip migration ('same-root').
  // Derive Local AppData explicitly before conceding to that last resort.
  const local = environment.LOCALAPPDATA?.trim();
  if (local) return local;
  const profile = environment.USERPROFILE?.trim();
  if (profile) return path.join(profile, 'AppData', 'Local');
  return app.getPath('appData');
}

export function getProductionRuntimeRoot(
  app: App,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(roamingAppData(app, environment), 'Misgeret');
}

/** Data root used by builds ≤ 1.0.0, which doubled as the Squirrel install directory. */
export function getLegacyRuntimeRoot(
  app: App,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(localAppData(app, environment), 'Misgeret');
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A profile id is a UUID v4 and nothing else — a hand-edited registry must not escape dataDir. */
export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

export function profilesRegistryPath(paths: RuntimePaths): string {
  return path.join(paths.dataDir, 'profiles.json');
}

export function profilesDir(paths: RuntimePaths): string {
  return path.join(paths.dataDir, 'profiles');
}

export function deletedProfilesDir(paths: RuntimePaths): string {
  return path.join(paths.dataDir, 'deleted-profiles');
}

export function profileDir(paths: RuntimePaths, profileId: string): string {
  if (!isProfileId(profileId)) {
    throw Object.assign(new Error('A profile id must be a UUID.'), { code: 'INVALID_PROFILE_ID' });
  }
  return path.join(profilesDir(paths), profileId);
}

export function profileBackupsDir(paths: RuntimePaths, profileId: string): string {
  return path.join(profileDir(paths, profileId), 'backups');
}

/**
 * A registry entry counts only while its directory is still on disk — the same liveness rule
 * ProfileStore.load applies when it drops dangling entries. Keying on the file's mere existence
 * would latch first-run off forever: the "יציאה" path moves the provisional profile aside but is
 * forbidden from touching profiles.json (A13), so a registry naming nothing but that gone profile
 * is exactly what "no data" looks like.
 *
 * Anything unreadable counts as data: never open the welcome wizard over a registry we merely
 * failed to parse.
 */
function registryNamesLiveProfile(paths: RuntimePaths): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(profilesRegistryPath(paths), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
  try {
    const parsed = JSON.parse(raw) as { profiles?: unknown };
    if (!Array.isArray(parsed.profiles)) return true;
    return parsed.profiles.some((entry) => {
      const id = (entry as { id?: unknown } | null)?.id;
      return isProfileId(id) && fs.existsSync(profileDir(paths, id));
    });
  } catch {
    return true;
  }
}

/**
 * The single owner of "is there data here?". Both the first-run gate and the ≤1.0.0 migration
 * gate ask it: once the runtime adopts <dataDir>/finance.db into profiles/<id>/, an
 * existsSync(dbPath) gate is permanently false, so the legacy copy would re-fire on every boot
 * and replay the welcome wizard forever.
 */
export function hasExistingData(paths: RuntimePaths): boolean {
  if (registryNamesLiveProfile(paths)) return true;
  if (fs.existsSync(paths.dbPath)) return true;

  const profilesRoot = profilesDir(paths);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only an absent directory means "no data". Anything else (EPERM, EIO) must abort startup
    // rather than resolve to a first run that would open the wizard over unreadable real data.
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
  return entries.some((entry) => entry.isDirectory()
    && isProfileId(entry.name)
    && fs.existsSync(path.join(profilesRoot, entry.name, 'finance.db')));
}

/**
 * Mirrors ProfileStore.softDelete: the directory is moved aside, never destroyed. Callers must
 * ensure the runtime is stopped — Windows refuses to rename a directory holding an open
 * SQLite handle.
 */
export function moveProfileToDeleted(paths: RuntimePaths, profileId: string): boolean {
  const source = profileDir(paths, profileId);
  if (!fs.existsSync(source)) return false;

  const deletedRoot = deletedProfilesDir(paths);
  fs.mkdirSync(deletedRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let destination = path.join(deletedRoot, `${profileId}-${stamp}`);
  for (let attempt = 1; fs.existsSync(destination); attempt += 1) {
    destination = path.join(deletedRoot, `${profileId}-${stamp}-${attempt}`);
  }
  fs.renameSync(source, destination);
  return true;
}

/**
 * Fail-closed regression guard: a data root that contains the running executable is,
 * by definition, inside the install directory and would be destroyed by the installer.
 */
export function assertRootOutsideInstallDir(rootDir: string, executablePath: string): void {
  if (isPathInside(rootDir, executablePath)) {
    throw Object.assign(
      new Error('The data root must stay outside the application install directory.'),
      { code: 'DATA_ROOT_INSIDE_INSTALL_DIR' },
    );
  }
}

function resolveRuntimeRoot(app: App, environment: NodeJS.ProcessEnv): string {
  const configuredRoot = environment.MISGERET_DATA_ROOT?.trim();
  const overrideAllowed = !app.isPackaged
    || environment.MISGERET_ALLOW_DATA_ROOT_OVERRIDE?.trim() === '1';

  if (configuredRoot && overrideAllowed) return path.resolve(configuredRoot);

  // Development must never share the installed application's real user data.
  if (!app.isPackaged) {
    return path.resolve(app.getAppPath(), '.desktop-smoke', 'profile');
  }

  return getProductionRuntimeRoot(app, environment);
}

export function getRuntimePaths(
  app: App,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath: string = process.execPath,
): RuntimePaths {
  const rootDir = resolveRuntimeRoot(app, environment);
  assertRootOutsideInstallDir(rootDir, executablePath);
  const dataDir = path.join(rootDir, 'data');
  return {
    rootDir,
    dataDir,
    dbPath: path.join(dataDir, 'finance.db'),
    backupsDir: path.join(rootDir, 'backups'),
    logsDir: path.join(rootDir, 'logs'),
    browserTempDir: path.join(rootDir, 'browser-temp'),
    electronDir: path.join(rootDir, 'electron'),
  };
}

export function ensureRuntimePaths(paths: RuntimePaths): void {
  // backupsDir is deliberately absent: it is a legacy *source* the runtime drains into
  // profiles/<id>/backups and then removes. Re-creating it every boot would leave an empty
  // top-level backups/ that reads to the user as "my backups were destroyed".
  for (const directory of [
    paths.rootDir,
    paths.dataDir,
    paths.logsDir,
    paths.browserTempDir,
    paths.electronDir,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function resolveRuntimeModule(app: App): string {
  const override = app.isPackaged ? undefined : process.env.MISGERET_SERVER_RUNTIME?.trim();
  if (override) return path.resolve(override);
  return path.join(app.getAppPath(), 'server', 'dist', 'runtime.js');
}

export function resolveChromiumExecutable(app: App): string | undefined {
  const override = app.isPackaged ? undefined : process.env.MISGERET_CHROMIUM_PATH?.trim();
  if (override) return path.resolve(override);

  const chromiumRoot = path.join(process.resourcesPath, 'chromium');
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(chromiumRoot, 'misgeret-chromium.json'), 'utf8'),
    ) as { executableRelativePath?: unknown };
    if (typeof manifest.executableRelativePath !== 'string' || !manifest.executableRelativePath) {
      throw new Error('Chromium manifest has no executable path.');
    }
    const candidate = path.resolve(chromiumRoot, manifest.executableRelativePath);
    if (!isPathInside(chromiumRoot, candidate) || !fs.existsSync(candidate)) {
      throw new Error('Chromium manifest points outside its resource directory or to a missing file.');
    }
    return candidate;
  } catch (error) {
    if (app.isPackaged) {
      throw Object.assign(new Error('The packaged Chromium executable is missing.', { cause: error }), {
        code: 'CHROMIUM_MISSING',
      });
    }
  }

  // Development keeps the web workflow working with Puppeteer's managed browser.
  if (!app.isPackaged) return undefined;
  throw Object.assign(new Error('The packaged Chromium executable is missing.'), { code: 'CHROMIUM_MISSING' });
}
