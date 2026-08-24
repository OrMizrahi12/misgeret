import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkpointDatabaseFile, recoverInterruptedDatabase } from './db.js';
import type { RuntimePaths } from './paths.js';

export interface Profile {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  lastOpenedAt: string | null;
  order: number;
}

export type ProfileErrorType =
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_NAME_INVALID'
  | 'PROFILE_NAME_EXISTS'
  | 'LAST_PROFILE'
  | 'PROFILE_BUSY'
  | 'PROFILE_DELETE_FAILED'
  | 'PROFILE_OPEN_FAILED'
  | 'RUNTIME_SHUTTING_DOWN'
  | 'INVALID_INPUT';

export class ProfileError extends Error {
  constructor(readonly errorType: ProfileErrorType, readonly errorMessage?: string) {
    super(errorMessage ?? errorType);
    this.name = 'ProfileError';
  }
}

const PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 60;
const REGISTRY_FILE = 'profiles.json';
const PROFILES_DIR = 'profiles';
const DELETED_PROFILES_DIR = 'deleted-profiles';
const QUARANTINE_DIR = 'quarantine';
const MIGRATING_MARKER = '.migrating';
const PROFILE_DB_FILE = 'finance.db';
const LEGACY_CREDENTIALS_FILE = 'credentials.enc';

/** Accents the whole UI tints itself with. Assigned round-robin so two profiles rarely collide. */
const PROFILE_COLORS = [
  '#6ea8ff', '#f2a65a', '#7bd88f', '#e06c9f',
  '#b18cff', '#4fd1c5', '#f6c453', '#ff8f6b',
];

/** A profile id is a UUID and nothing else — a registry hand-edited to `../..` must not escape dataDir. */
export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && PROFILE_ID_PATTERN.test(value);
}

function fileTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Nothing reads these names, but a collision would make renameSync throw and the profile
 *  undeletable. Mirrors `moveProfileToDeleted` in `desktop/src/paths.ts`. */
function uncontestedPath(directory: string, base: string): string {
  let candidate = path.join(directory, base);
  for (let attempt = 1; fs.existsSync(candidate); attempt += 1) {
    candidate = path.join(directory, `${base}-${attempt}`);
  }
  return candidate;
}

function readDirSafe(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new ProfileError('PROFILE_NAME_INVALID', 'a profile name is required');
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new ProfileError('PROFILE_NAME_INVALID', `a profile name must be 1..${MAX_NAME_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ProfileError('PROFILE_NAME_INVALID', 'a profile name must not contain control characters');
  }
  return trimmed;
}

function normalizeColor(value: unknown): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new ProfileError('INVALID_INPUT', 'a profile color must be #rrggbb');
  }
  return value.toLowerCase();
}

interface RegistryFile {
  version: number;
  activeId: string | null;
  profiles: Profile[];
}

function parseStoredProfile(value: unknown): Profile | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (!isProfileId(row.id)) return null;
  if (typeof row.name !== 'string' || row.name.trim().length === 0) return null;
  return {
    id: row.id,
    name: row.name.trim().slice(0, MAX_NAME_LENGTH),
    color: typeof row.color === 'string' && /^#[0-9a-f]{6}$/i.test(row.color) ? row.color.toLowerCase() : PROFILE_COLORS[0]!,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
    lastOpenedAt: typeof row.lastOpenedAt === 'string' ? row.lastOpenedAt : null,
    order: Number.isFinite(row.order) ? Number(row.order) : Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Registry + filesystem ownership for the per-profile worlds. Deliberately knows nothing about
 * Express or FinanceDb: a live database handle is the pool's problem, and `softDelete` can only
 * be safe once the pool has closed it (A6).
 */
export class ProfileStore {
  private dataDirValue: string | null = null;
  private profiles: Profile[] = [];
  private activeId: string | null = null;

  get dataDir(): string {
    if (!this.dataDirValue) throw new ProfileError('INVALID_INPUT', 'profile store has not been loaded');
    return this.dataDirValue;
  }

  registryPath(): string {
    return path.join(this.dataDir, REGISTRY_FILE);
  }

  profilesDir(): string {
    return path.join(this.dataDir, PROFILES_DIR);
  }

  deletedProfilesDir(): string {
    return path.join(this.dataDir, DELETED_PROFILES_DIR);
  }

  /** Path resolution that only proves the id is a UUID. Callers outside must use `dirFor`. */
  private resolveDir(id: string): string {
    if (!isProfileId(id)) throw new ProfileError('PROFILE_NOT_FOUND', 'a profile id must be a UUID');
    return path.join(this.profilesDir(), id);
  }

  /** A5.1: no path is ever joined for an id the registry does not currently hold. */
  dirFor(id: string): string {
    this.require(id);
    return this.resolveDir(id);
  }

  dbPathFor(id: string): string {
    return path.join(this.dirFor(id), PROFILE_DB_FILE);
  }

  backupsDirFor(id: string): string {
    return path.join(this.dirFor(id), 'backups');
  }

  list(): Profile[] {
    return this.profiles.map((profile) => ({ ...profile }));
  }

  get(id: unknown): Profile | undefined {
    if (!isProfileId(id)) return undefined;
    const found = this.profiles.find((profile) => profile.id === id);
    return found ? { ...found } : undefined;
  }

  private require(id: unknown): Profile {
    const found = isProfileId(id) ? this.profiles.find((profile) => profile.id === id) : undefined;
    if (!found) throw new ProfileError('PROFILE_NOT_FOUND');
    return found;
  }

  /**
   * A5.3: the registry's activeId is the truth for every header-less call. An unresolvable one is
   * repaired to the first profile by order, exactly as `load` would. It never errors, never creates.
   */
  resolveActiveId(): string {
    if (this.activeId && this.profiles.some((profile) => profile.id === this.activeId)) return this.activeId;
    const first = this.profiles[0];
    if (!first) throw new ProfileError('PROFILE_NOT_FOUND', 'no profile exists');
    this.activeId = first.id;
    this.persist();
    return first.id;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  load(dataDir: string): void {
    this.dataDirValue = path.resolve(dataDir);
    const stored = this.readRegistry();
    let changed = stored.changed;
    const profiles = stored.profiles;
    this.activeId = stored.activeId;

    const registered = new Set(profiles.map((profile) => profile.id));
    for (const entry of readDirSafe(this.profilesDir())) {
      if (!entry.isDirectory() || !isProfileId(entry.name)) continue;
      const directory = path.join(this.profilesDir(), entry.name);
      const marker = path.join(directory, MIGRATING_MARKER);
      if (fs.existsSync(marker)) {
        // A2: an unfinished migration is not a profile. Once committed the marker is litter the
        // 8->9 crash window left behind, and only then is it safe to drop.
        if (registered.has(entry.name)) fs.rmSync(marker, { force: true });
        continue;
      }
      if (registered.has(entry.name)) continue;
      if (fs.existsSync(path.join(directory, PROFILE_DB_FILE))) {
        profiles.push({
          id: entry.name,
          name: this.unusedAdoptionName(profiles),
          color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]!,
          createdAt: new Date().toISOString(),
          lastOpenedAt: null,
          order: profiles.length,
        });
        registered.add(entry.name);
        changed = true;
        continue;
      }
      // A6: `create` mkdirs before it writes the registry, so an empty directory is a crashed
      // create and holds nothing. Anything with backups stays untouched.
      if (readDirSafe(directory).length === 0) {
        try {
          fs.rmdirSync(directory);
        } catch {
          // Cleanliness is never worth failing a boot over.
        }
      }
    }

    const alive = profiles.filter((profile) => fs.existsSync(this.resolveDir(profile.id)));
    if (alive.length !== profiles.length) changed = true;

    alive.sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt));
    alive.forEach((profile, index) => {
      if (profile.order !== index) changed = true;
      profile.order = index;
    });
    this.profiles = alive;

    if (!this.activeId || !alive.some((profile) => profile.id === this.activeId)) {
      const repaired = alive[0]?.id ?? null;
      if (repaired !== this.activeId) changed = true;
      this.activeId = repaired;
    }

    // A registry written for zero profiles would make the desktop's `hasExistingData` true and
    // suppress the welcome wizard forever. Nothing to record means nothing to write.
    if (changed && (this.profiles.length > 0 || fs.existsSync(this.registryPath()))) this.persist();
  }

  private readRegistry(): { profiles: Profile[]; activeId: string | null; changed: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath(), 'utf8');
    } catch {
      return { profiles: [], activeId: null, changed: false };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>;
      const rows = Array.isArray(parsed.profiles) ? parsed.profiles : [];
      const profiles: Profile[] = [];
      let changed = rows.length > 0 && !Array.isArray(parsed.profiles);
      for (const row of rows) {
        const profile = parseStoredProfile(row);
        if (profile) profiles.push(profile);
        else changed = true;
      }
      return {
        profiles,
        activeId: isProfileId(parsed.activeId) ? parsed.activeId : null,
        changed,
      };
    } catch {
      // A corrupt registry is not fatal: the directories on disk are the durable fact and
      // reconciliation rebuilds from them.
      console.error('[profiles] registry unreadable; rebuilding from disk');
      return { profiles: [], activeId: null, changed: true };
    }
  }

  private persist(): void {
    const payload: RegistryFile = { version: 1, activeId: this.activeId, profiles: this.profiles };
    const destination = this.registryPath();
    const temporary = `${destination}.tmp-${randomUUID()}`;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.renameSync(temporary, destination);
    } catch (err) {
      fs.rmSync(temporary, { force: true });
      throw err;
    }
  }

  private nameTaken(name: string, exceptId: string | null, within = this.profiles): boolean {
    const folded = name.toLocaleLowerCase();
    return within.some((profile) => profile.id !== exceptId && profile.name.toLocaleLowerCase() === folded);
  }

  private unusedAdoptionName(within: Profile[]): string {
    for (let index = 1; ; index += 1) {
      const candidate = `משתמש ${index}`;
      if (!this.nameTaken(candidate, null, within)) return candidate;
    }
  }

  create(input: { name?: unknown; color?: unknown } = {}): Profile {
    const name = normalizeName(input.name ?? this.unusedAdoptionName(this.profiles));
    if (this.nameTaken(name, null)) throw new ProfileError('PROFILE_NAME_EXISTS', 'a profile with this name already exists');
    const color = input.color === undefined || input.color === null
      ? PROFILE_COLORS[this.profiles.length % PROFILE_COLORS.length]!
      : normalizeColor(input.color);
    const profile: Profile = {
      id: randomUUID(),
      name,
      color,
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
      order: this.profiles.length,
    };
    // A6: mkdir first, registry second. A crash leaves an empty directory adoption ignores; the
    // reverse leaves a registry entry with no world behind it.
    fs.mkdirSync(this.resolveDir(profile.id), { recursive: true });
    this.profiles.push(profile);
    if (!this.activeId) this.activeId = profile.id;
    this.persist();
    return { ...profile };
  }

  /**
   * `require` hands back the live row, so the whole patch is validated before any of it lands.
   * Rejecting the color after assigning the name would leave the rename live in memory with the
   * registry still holding the old one: the route answers 400 while the very next GET already
   * shows the new name, and the next unrelated persist() commits it to disk.
   */
  update(id: string, patch: { name?: unknown; color?: unknown }): Profile {
    const profile = this.require(id);
    const name = patch.name !== undefined ? normalizeName(patch.name) : undefined;
    if (name !== undefined && this.nameTaken(name, profile.id)) {
      throw new ProfileError('PROFILE_NAME_EXISTS', 'a profile with this name already exists');
    }
    const color = patch.color !== undefined ? normalizeColor(patch.color) : undefined;

    const previous = { name: profile.name, color: profile.color };
    if (name !== undefined) profile.name = name;
    if (color !== undefined) profile.color = color;
    try {
      this.persist();
    } catch (err) {
      // A write that did not land must not stay in memory either, or the next persist() smuggles it.
      Object.assign(profile, previous);
      throw err;
    }
    return { ...profile };
  }

  reorder(ids: unknown): Profile[] {
    if (!Array.isArray(ids) || ids.length !== this.profiles.length) {
      throw new ProfileError('INVALID_INPUT', 'reorder requires every profile id exactly once');
    }
    const seen = new Set<string>();
    const ordered: Profile[] = [];
    for (const id of ids) {
      if (!isProfileId(id) || seen.has(id)) throw new ProfileError('INVALID_INPUT', 'reorder requires every profile id exactly once');
      seen.add(id);
      ordered.push(this.require(id));
    }
    ordered.forEach((profile, index) => { profile.order = index; });
    this.profiles = ordered;
    this.persist();
    return this.list();
  }

  setActive(id: string): string {
    const profile = this.require(id);
    this.activeId = profile.id;
    profile.lastOpenedAt = new Date().toISOString();
    this.persist();
    return profile.id;
  }

  /**
   * Moves the world aside; never destroys it. The caller must have closed the database first —
   * on Windows renaming a directory holding an open SQLite file fails with EPERM (A6).
   */
  softDelete(id: string): void {
    const profile = this.require(id);
    if (this.profiles.length === 1) throw new ProfileError('LAST_PROFILE', 'the last profile cannot be deleted');
    const directory = this.resolveDir(profile.id);

    // A6: move first, registry second. A crash here leaves an entry `load` drops; the reverse
    // order leaves a live finance.db that reconciliation resurrects as `משתמש <n>`.
    if (fs.existsSync(directory)) {
      try {
        fs.mkdirSync(this.deletedProfilesDir(), { recursive: true });
        const destination = uncontestedPath(this.deletedProfilesDir(), `${profile.id}-${fileTimestamp()}`);
        fs.renameSync(directory, destination);
      } catch (err) {
        console.error('[profiles] soft delete could not move the profile directory', {
          code: (err as NodeJS.ErrnoException).code,
        });
        throw new ProfileError('PROFILE_DELETE_FAILED', 'the profile directory could not be moved aside');
      }
    }

    const remaining = this.profiles.filter((entry) => entry.id !== profile.id);
    remaining.forEach((entry, index) => { entry.order = index; });
    this.profiles = remaining;
    // A5.2: the reassignment and the deletion are the same write — activeId never names a ghost.
    if (this.activeId === profile.id) this.activeId = remaining[0]?.id ?? null;
    this.persist();
  }

  /** Migration's single commit point (A2 step 8). Valid only while the registry is still empty. */
  commitMigrated(id: string, name: string): Profile {
    if (this.profiles.length > 0) throw new ProfileError('INVALID_INPUT', 'the registry already holds profiles');
    if (!isProfileId(id)) throw new ProfileError('INVALID_INPUT', 'a profile id must be a UUID');
    const profile: Profile = {
      id,
      name: normalizeName(name),
      color: PROFILE_COLORS[0]!,
      createdAt: new Date().toISOString(),
      lastOpenedAt: null,
      order: 0,
    };
    this.profiles = [profile];
    this.activeId = id;
    this.persist();
    return { ...profile };
  }
}

/** Every last-resort copy `db.ts` can leave beside the live file. Leaving one behind at the
 *  dataDir root means nothing would ever look at it again. */
function legacySiblingNames(dbPath: string): string[] {
  const base = path.basename(dbPath);
  return readDirSafe(path.dirname(dbPath))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (
      name === base
      || name === `${base}-wal`
      || name === `${base}-shm`
      || name.startsWith(`${base}.rollback-`)
      || name.startsWith(`${base}.failed-`)
      || name.startsWith(`${base}.restore-`)
    ))
    // The main file moves last: while it sits at the source, the legacy layout still reads as one.
    .sort((left, right) => Number(left === base) - Number(right === base));
}

/** A profile's database is always `finance.db`, whatever DB_PATH called the legacy source. */
function profileFileName(legacyBase: string, name: string): string {
  return `${PROFILE_DB_FILE}${name.slice(legacyBase.length)}`;
}

function moveIfAbsent(source: string, destination: string): void {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

function moveDirectoryFiles(sourceDir: string, destinationDir: string): void {
  const entries = readDirSafe(sourceDir).filter((entry) => entry.isFile());
  if (entries.length === 0) return;
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of entries) {
    moveIfAbsent(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name));
  }
}

/**
 * A2.1: a legacy database still at the dataDir root once profiles exist is one lost registry away
 * from being adopted as bogus legacy data. Quarantine over delete, never silence.
 */
export function quarantineStrayLegacyDb(paths: RuntimePaths): void {
  const quarantineDir = path.join(paths.dataDir, QUARANTINE_DIR);
  fs.mkdirSync(quarantineDir, { recursive: true });
  const destination = uncontestedPath(quarantineDir, `${path.basename(paths.dbPath)}-${fileTimestamp()}`);
  const sourceDir = path.dirname(paths.dbPath);
  for (const name of legacySiblingNames(paths.dbPath)) {
    moveIfAbsent(path.join(sourceDir, name), path.join(destination, name));
  }
  console.log('[migration] stray-legacy-db quarantined', { destination: path.basename(destination) });
}

function findResumableMigration(profilesRoot: string): string | null {
  const candidates: Array<{ id: string; startedMs: number }> = [];
  for (const entry of readDirSafe(profilesRoot)) {
    if (!entry.isDirectory() || !isProfileId(entry.name)) continue;
    const marker = path.join(profilesRoot, entry.name, MIGRATING_MARKER);
    try {
      candidates.push({ id: entry.name, startedMs: fs.statSync(marker).mtimeMs });
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) console.warn(`[migration] ${candidates.length} interrupted migrations found; resuming the earliest`);
  candidates.sort((left, right) => left.startedMs - right.startedMs);
  return candidates[0]!.id;
}

/**
 * Adopts the pre-multi-profile layout into the first profile. Returns the id it migrated or
 * created, or null when profiles already existed.
 *
 * The registry write is the sole commit point and it is last (A2): a crash anywhere before it
 * leaves the registry empty, so the next boot finds the `.migrating` marker, reuses the same id
 * and re-runs the moves idempotently against a source that is still intact. No window can strand
 * the backups or the credentials, and no retry can mint a second UUID.
 */
export function migrateLegacyIntoProfile(paths: RuntimePaths, store: ProfileStore): string | null {
  // Unconditional, and before load(): its whole purpose is the gap where the live file is absent.
  recoverInterruptedDatabase(paths.dbPath);
  store.load(paths.dataDir);

  if (store.list().length > 0) {
    if (fs.existsSync(paths.dbPath)) quarantineStrayLegacyDb(paths);
    return null;
  }

  const profilesRoot = path.join(paths.dataDir, PROFILES_DIR);
  const resumeId = findResumableMigration(profilesRoot);
  const id = resumeId ?? (fs.existsSync(paths.dbPath) ? randomUUID() : null);
  if (id === null) return store.create({ name: 'ראשי' }).id;
  if (resumeId) console.log('[migration] resuming an interrupted legacy migration');

  const profileDir = path.join(profilesRoot, id);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, MIGRATING_MARKER),
    `${JSON.stringify({ version: 1, startedAt: new Date().toISOString() })}\n`,
  );

  moveDirectoryFiles(paths.backupsDir, path.join(profileDir, 'backups'));
  // A3: ownership of the DPAPI blob is physical. Nothing on disk could otherwise record which
  // profile it belongs to, and `migrateLegacy` is whoever-calls-it-first-wins.
  moveIfAbsent(path.join(paths.dataDir, LEGACY_CREDENTIALS_FILE), path.join(profileDir, LEGACY_CREDENTIALS_FILE));

  if (fs.existsSync(paths.dbPath)) checkpointDatabaseFile(paths.dbPath);
  const legacyBase = path.basename(paths.dbPath);
  const legacyDir = path.dirname(paths.dbPath);
  for (const name of legacySiblingNames(paths.dbPath)) {
    moveIfAbsent(path.join(legacyDir, name), path.join(profileDir, profileFileName(legacyBase, name)));
  }

  const profile = store.commitMigrated(id, 'ראשי');
  fs.rmSync(path.join(profileDir, MIGRATING_MARKER), { force: true });
  try {
    // Only if empty. An empty `backups/` beside `profiles/` reads as "my backups were destroyed".
    fs.rmdirSync(paths.backupsDir);
  } catch {
    // The legacy backups directory may hold subdirectories, or may never have existed.
  }
  console.log('[migration] adopted the legacy layout into the first profile');
  return profile.id;
}
