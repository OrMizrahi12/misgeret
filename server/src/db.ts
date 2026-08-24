import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { kindForType, type HoldingType } from './account-state.js';
import type { FlowClass } from './companies.js';
import { deleteLegacyCredentialsFile, readLegacyCredentialsFile } from './credentials.js';
import type { FrameEntry } from './frame.js';
import type { TxnRow } from './txns.js';

/** ASCII "MISG". A non-zero application id prevents importing an unrelated SQLite file. */
export const DATABASE_APPLICATION_ID = 0x4d495347;
/** 2: `assets` gained the semantic layer (type/institution/monthly_payment). The bump is what makes
 *  openProfileDatabase take a pre-upgrade backup before the migration runs (workspaces.ts:61). */
export const DATABASE_SCHEMA_VERSION = 2;

export type SchemaReconciliationStage = 'after-core-schema' | 'after-columns' | 'before-version-stamp';

export interface DatabaseFileOps {
  rename(sourcePath: string, destinationPath: string): void;
  copyExclusive(sourcePath: string, destinationPath: string): void;
  exists(filePath: string): boolean;
  remove(filePath: string): void;
}

export interface FinanceDbOptions {
  /** Test-only fault hook; production callers leave this unset. */
  migrationFault?: (stage: SchemaReconciliationStage) => void;
  /** Injectable filesystem boundary used to prove restore recovery behavior. */
  fileOps?: Partial<DatabaseFileOps>;
}

const DEFAULT_FILE_OPS: DatabaseFileOps = {
  rename: (sourcePath, destinationPath) => fs.renameSync(sourcePath, destinationPath),
  copyExclusive: (sourcePath, destinationPath) =>
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL),
  exists: (filePath) => fs.existsSync(filePath),
  remove: (filePath) => fs.rmSync(filePath, { force: true }),
};

export class DatabaseRecoveryError extends Error {
  constructor(
    message: string,
    readonly recoveryPath: string,
    readonly originalError: unknown,
  ) {
    super(`${message}; original database retained at ${recoveryPath}`);
    this.name = 'DatabaseRecoveryError';
  }
}

export interface DatabaseRestoreOptions {
  preRestorePath?: string;
}

export interface DatabaseMetadata {
  applicationId: number;
  schemaVersion: number;
  quickCheck: string[];
  /** `month_bucketing`, or null on a legacy file that predates the `settings` table. */
  bucketing: string | null;
}

function quickCheckConnection(db: Database.Database): string[] {
  return (db.pragma('quick_check') as { quick_check: string }[]).map((row) => row.quick_check);
}

function assertConnectionHealthy(db: Database.Database): void {
  const result = quickCheckConnection(db);
  if (result.length !== 1 || result[0] !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${result.join('; ')}`);
  }
}

interface TableColumn {
  name: string;
  type: string;
  notnull: 0 | 1;
  pk: number;
}

interface ExpectedColumn {
  type: 'TEXT' | 'REAL' | 'INTEGER' | 'BLOB';
  notNull?: boolean;
  primaryKey?: boolean;
}

const LEGACY_TABLE_SCHEMAS: Record<string, Record<string, ExpectedColumn>> = {
  transactions: {
    key: { type: 'TEXT', primaryKey: true },
    account: { type: 'TEXT', notNull: true },
    date: { type: 'TEXT', notNull: true },
    month: { type: 'TEXT', notNull: true },
    processed_date: { type: 'TEXT' },
    amount: { type: 'REAL', notNull: true },
    original_amount: { type: 'REAL' },
    currency: { type: 'TEXT' },
    description: { type: 'TEXT', notNull: true },
    memo: { type: 'TEXT' },
    status: { type: 'TEXT', notNull: true },
    company: { type: 'TEXT' },
    connection_id: { type: 'INTEGER' },
    type: { type: 'TEXT', notNull: true },
    installment_number: { type: 'INTEGER' },
    installment_total: { type: 'INTEGER' },
    charged_currency: { type: 'TEXT' },
    issuer_category: { type: 'TEXT' },
    category: { type: 'TEXT' },
    category_source: { type: 'TEXT' },
  },
  settings: {
    key: { type: 'TEXT', primaryKey: true },
    value: { type: 'TEXT', notNull: true },
  },
  connections: {
    id: { type: 'INTEGER', primaryKey: true },
    company: { type: 'TEXT', notNull: true },
    nickname: { type: 'TEXT' },
    credentials: { type: 'BLOB', notNull: true },
    created_at: { type: 'TEXT', notNull: true },
    last_sync_at: { type: 'TEXT' },
    last_error: { type: 'TEXT' },
  },
  account_snapshots: {
    id: { type: 'INTEGER', primaryKey: true },
    connection_id: { type: 'INTEGER', notNull: true },
    account: { type: 'TEXT', notNull: true },
    balance: { type: 'REAL', notNull: true },
    balance_date: { type: 'TEXT' },
    taken_at: { type: 'TEXT', notNull: true },
  },
  category_rules: {
    id: { type: 'INTEGER', primaryKey: true },
    pattern: { type: 'TEXT', notNull: true },
    category: { type: 'TEXT', notNull: true },
    created_at: { type: 'TEXT', notNull: true },
  },
  assets: {
    id: { type: 'INTEGER', primaryKey: true },
    name: { type: 'TEXT', notNull: true },
    kind: { type: 'TEXT', notNull: true },
    amount: { type: 'REAL', notNull: true },
    updated_at: { type: 'TEXT', notNull: true },
    liquid: { type: 'INTEGER', notNull: true },
  },
  recurring_overrides: {
    merchant: { type: 'TEXT', primaryKey: true, notNull: true },
    kind: { type: 'TEXT', primaryKey: true, notNull: true },
  },
  asset_snapshots: {
    id: { type: 'INTEGER', primaryKey: true },
    asset_id: { type: 'INTEGER', notNull: true },
    // vestigial: /networth signs by the asset's current kind (A9). Never read this.
    kind: { type: 'TEXT', notNull: true },
    amount: { type: 'REAL', notNull: true },
    taken_at: { type: 'TEXT', notNull: true },
  },
};

const REQUIRED_TRANSACTION_COLUMNS = [
  'key',
  'account',
  'date',
  'month',
  'processed_date',
  'amount',
  'original_amount',
  'currency',
  'description',
  'memo',
  'status',
] as const;

const REQUIRED_TABLE_COLUMNS: Record<string, readonly string[]> = {
  transactions: REQUIRED_TRANSACTION_COLUMNS,
  settings: ['key', 'value'],
  connections: ['id', 'company', 'nickname', 'credentials', 'created_at', 'last_sync_at', 'last_error'],
  account_snapshots: ['id', 'connection_id', 'account', 'balance', 'balance_date', 'taken_at'],
  category_rules: ['id', 'pattern', 'category', 'created_at'],
  assets: ['id', 'name', 'kind', 'amount', 'updated_at'],
  recurring_overrides: ['merchant', 'kind'],
  asset_snapshots: ['id', 'asset_id', 'kind', 'amount', 'taken_at'],
};

function tableColumns(db: Database.Database, table: string): TableColumn[] {
  const escaped = table.replace(/"/g, '""');
  return db.prepare(`PRAGMA table_info("${escaped}")`).all() as TableColumn[];
}

function assertLegacyTableShape(db: Database.Database, table: string): void {
  const expected = LEGACY_TABLE_SCHEMAS[table];
  const columns = tableColumns(db, table);
  if (columns.length === 0 || columns.some((column) => !(column.name in expected))) {
    throw new Error('SQLite file is not a recognized Misgeret database');
  }
  for (const column of columns) {
    const contract = expected[column.name];
    const actualType = column.type.trim().toUpperCase();
    if (
      actualType !== contract.type ||
      Boolean(column.pk) !== Boolean(contract.primaryKey) ||
      column.notnull !== (contract.notNull ? 1 : 0)
    ) {
      throw new Error('SQLite file is not a recognized Misgeret database');
    }
  }
  const names = new Set(columns.map((column) => column.name));
  if (!REQUIRED_TABLE_COLUMNS[table].every((column) => names.has(column))) {
    throw new Error('SQLite file is not a recognized Misgeret database');
  }
}

/** application_id=0 is accepted only for a newly-created file or an exact historical Misgeret shape. */
function assertMisgeretIdentity(db: Database.Database, options: { allowEmpty?: boolean } = {}): void {
  const applicationId = Number(db.pragma('application_id', { simple: true }));
  if (applicationId === DATABASE_APPLICATION_ID) return;
  if (applicationId !== 0) throw new Error('SQLite file belongs to another application');

  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  ).map((row) => row.name);
  if (tables.length === 0) {
    if (options.allowEmpty) return;
    throw new Error('SQLite file is not a recognized Misgeret database');
  }
  if (!tables.includes('transactions') || tables.some((table) => !(table in LEGACY_TABLE_SCHEMAS))) {
    throw new Error('SQLite file is not a recognized Misgeret database');
  }
  for (const table of tables) assertLegacyTableShape(db, table);

  if (tables.includes('settings')) {
    const settings = new Set(tableColumns(db, 'settings').map((column) => column.name));
    if (settings.size !== 2 || !settings.has('key') || !settings.has('value')) {
      throw new Error('SQLite file is not a recognized Misgeret database');
    }
  }
}

function readBucketingMarker(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'month_bucketing'").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    // an unversioned legacy file has no `settings` table
    return null;
  }
}

export function inspectDatabaseFile(filePath: string): DatabaseMetadata {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    assertConnectionHealthy(db);
    assertMisgeretIdentity(db);
    return {
      applicationId: Number(db.pragma('application_id', { simple: true })),
      schemaVersion: Number(db.pragma('user_version', { simple: true })),
      quickCheck: quickCheckConnection(db),
      bucketing: readBucketingMarker(db),
    };
  } finally {
    db.close();
  }
}

/**
 * Raw checkpoint for a database that is about to be moved: it must NOT construct a FinanceDb,
 * whose constructor would run reconcileSchema and stamp user_version — the legacy value has to
 * survive the move so openProfileDatabase still takes its pre-upgrade backup (A2).
 */
export function checkpointDatabaseFile(dbPath: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** Copies a live WAL database through SQLite's online-backup API. */
export async function copyDatabaseWalSafe(sourcePath: string, destinationPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.rmSync(destinationPath, { force: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    assertConnectionHealthy(source);
    assertMisgeretIdentity(source);
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

export interface CrashRecoveryResult {
  recovered: boolean;
  rollbackPath?: string;
}

/** Recovers the crash gap after live->rollback but before a replacement reached the live path. */
export function recoverInterruptedDatabase(dbPath: string): CrashRecoveryResult {
  const directory = path.dirname(dbPath);
  if (!fs.existsSync(directory)) return { recovered: false };
  const prefix = `${path.basename(dbPath)}.rollback-`;
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ path: path.join(directory, name), mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 0) return { recovered: false };

  const valid = candidates.find((candidate) => {
    try {
      inspectDatabaseFile(candidate.path);
      return true;
    } catch {
      return false;
    }
  });
  if (!valid) throw new Error('database recovery files exist but none pass identity and integrity checks');

  let quarantinePath: string | undefined;
  if (fs.existsSync(dbPath)) {
    try {
      inspectDatabaseFile(dbPath);
      return { recovered: false };
    } catch {
      quarantinePath = `${dbPath}.failed-recovery-${randomUUID()}`;
      const moved: Array<{ source: string; destination: string }> = [];
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const source = `${dbPath}${suffix}`;
          if (!fs.existsSync(source)) continue;
          const destination = `${quarantinePath}${suffix}`;
          fs.renameSync(source, destination);
          moved.push({ source, destination });
        }
      } catch (quarantineError) {
        for (const entry of moved.reverse()) {
          try {
            fs.renameSync(entry.destination, entry.source);
          } catch {
            // Both the known-good rollback and every successfully quarantined file remain retained.
          }
        }
        throw new DatabaseRecoveryError('corrupt live database could not be quarantined', valid.path, quarantineError);
      }
    }
  }

  fs.copyFileSync(valid.path, dbPath, fs.constants.COPYFILE_EXCL);
  try {
    inspectDatabaseFile(dbPath);
  } catch (err) {
    fs.rmSync(dbPath, { force: true });
    throw new DatabaseRecoveryError('rollback copy failed validation', valid.path, err);
  }
  return { recovered: true, rollbackPath: valid.path };
}

export interface ConnectionRow {
  id: number;
  company: string;
  nickname: string | null;
  createdAt: string;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SnapshotRow {
  connectionId: number;
  account: string;
  balance: number;
  balanceDate: string | null;
  takenAt: string;
}

export interface AssetRow {
  id: number;
  name: string;
  /** The arithmetic truth: the only carrier of the sign. Derived from `type` unless `type='other'`. */
  kind: 'asset' | 'liability';
  /** Always the magnitude, non-negative (A8). */
  amount: number;
  liquid: boolean;
  type: HoldingType;
  institution: string | null;
  /** Display-only — see the column's definition in reconcileSchema. */
  monthlyPayment: number | null;
  /** ISO 4217; `amount` is denominated in it. Conversion happens at read time. */
  currency: string;
  /** Last touched or confirmed. "When the value last changed" is MAX(taken_at) over its snapshots. */
  updatedAt: string;
}

/** The household's verdict on one recommendation, plus the figures frozen at the moment it was
 *  made. Frozen deliberately: once a subscription is cancelled the data no longer contains the
 *  charge, so a recomputed "what this was worth" would read zero. */
export interface AdviceStateRow {
  key: string;
  status: 'accepted' | 'dismissed' | 'done';
  kind: string;
  valueKind: 'saving' | 'resilience' | 'accuracy';
  monthlyValue: number;
  /** 1 ⇒ the figure is money that provably stops leaving; only these are summed into the ledger. */
  valueCertain: number;
  actionHe: string | null;
  actedAt: string;
}

/** An intention. Unlike a savings goal (a jar with money in it) a plan goal may be about
 *  spending LESS, in which case there is no jar and progress is read off the transactions. */
export interface PlanGoalRow {
  id: number;
  type: 'buffer' | 'reduction' | 'set-aside';
  name: string;
  targetAmount: number | null;
  monthlyAmount: number | null;
  /** Reduction goals: the category being steered, and the ceiling it should come back to. */
  category: string | null;
  categoryCeiling: number | null;
  /** The recommendation this goal grew from, when it grew from one. */
  adviceKey: string | null;
  /** The envelope funding it, for set-aside goals. Buffer goals measure real liquid instead. */
  savingsGoalId: number | null;
  status: 'active' | 'achieved' | 'abandoned';
  /** Progress is measured from this flow month on — a goal never claims credit for the past. */
  startMonth: string;
  createdAt: string;
  closedAt: string | null;
}

/** A recurring charge the user typed in by hand — the detector never saw it (paid in cash,
 *  a card that isn't connected, or too new to have a rhythm yet). `amount` is the magnitude. */
export interface ManualRecurringRow {
  id: number;
  name: string;
  amount: number;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'yearly';
  dayOfMonth: number | null;
  category: string | null;
  mark: 'subscription' | 'fixed';
  createdAt: string;
}

export class FinanceDb {
  private db: Database.Database;
  private readonly dbPath: string;
  private readonly fileOps: DatabaseFileOps;

  constructor(dbPath: string, options: FinanceDbOptions = {}) {
    this.dbPath = dbPath;
    this.fileOps = { ...DEFAULT_FILE_OPS, ...options.fileOps };
    const allowEmpty = dbPath === ':memory:' || !fs.existsSync(dbPath);
    this.db = new Database(dbPath);
    try {
      assertMisgeretIdentity(this.db, { allowEmpty });
      this.db.pragma('journal_mode = WAL');
      const schemaVersion = Number(this.db.pragma('user_version', { simple: true }));
      if (schemaVersion > DATABASE_SCHEMA_VERSION) {
        throw new Error(`database schema ${schemaVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`);
      }
      this.db.transaction(() => this.reconcileSchema(options.migrationFault))();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  /** Every schema mutation and its version stamp commit as one SQLite transaction. */
  private reconcileSchema(migrationFault?: (stage: SchemaReconciliationStage) => void): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        key TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        date TEXT NOT NULL,
        month TEXT NOT NULL,
        processed_date TEXT,
        amount REAL NOT NULL,
        original_amount REAL,
        currency TEXT,
        description TEXT NOT NULL,
        memo TEXT,
        status TEXT NOT NULL,
        company TEXT,
        connection_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_month ON transactions(month);
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        nickname TEXT,
        credentials BLOB NOT NULL,
        created_at TEXT NOT NULL,
        last_sync_at TEXT,
        last_error TEXT
      );
    `);
    migrationFault?.('after-core-schema');
    // Reconcile columns independently so interrupted historical migrations are repairable.
    this.ensureColumn('transactions', 'company', 'TEXT');
    this.ensureColumn('transactions', 'connection_id', 'INTEGER');
    this.ensureColumn('transactions', 'type', "TEXT NOT NULL DEFAULT 'normal'");
    this.ensureColumn('transactions', 'installment_number', 'INTEGER');
    this.ensureColumn('transactions', 'installment_total', 'INTEGER');
    this.ensureColumn('transactions', 'charged_currency', 'TEXT');
    this.ensureColumn('transactions', 'issuer_category', 'TEXT');
    this.ensureColumn('transactions', 'category', 'TEXT');
    this.ensureColumn('transactions', 'category_source', 'TEXT');
    migrationFault?.('after-columns');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL,
        account TEXT NOT NULL,
        balance REAL NOT NULL,
        balance_date TEXT,
        taken_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_conn_account ON account_snapshots(connection_id, account);
      CREATE TABLE IF NOT EXISTS category_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability')),
        amount REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recurring_overrides (
        merchant TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
        PRIMARY KEY (merchant, kind)
      );
      CREATE TABLE IF NOT EXISTS sector_overrides (
        sector TEXT PRIMARY KEY,
        category TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flow_overrides (
        pattern TEXT PRIMARY KEY,
        class TEXT NOT NULL CHECK (class IN ('internal', 'flow'))
      );
      CREATE TABLE IF NOT EXISTS recurring_marks (
        merchant TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
        mark TEXT NOT NULL CHECK (mark IN ('subscription', 'fixed')),
        PRIMARY KEY (merchant, kind)
      );
      CREATE TABLE IF NOT EXISTS manual_recurring (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        amount REAL NOT NULL,
        cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'biweekly', 'monthly', 'bimonthly', 'yearly')),
        day_of_month INTEGER,
        category TEXT,
        mark TEXT NOT NULL DEFAULT 'subscription' CHECK (mark IN ('subscription', 'fixed')),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS txn_marks (
        txn_key TEXT PRIMARY KEY,
        mark TEXT NOT NULL CHECK (mark IN ('subscription', 'fixed', 'habit', 'dismissed')),
        created_at TEXT NOT NULL
      );
      -- The user-anchored monthly cost of a classified subscription/fixed charge: the amount they
      -- pointed at when they tagged it (not a statistical guess), plus the last deviating amount we
      -- already alerted about (so a one-off, once dismissed, does not nag again). Keyed by merchant.
      CREATE TABLE IF NOT EXISTS merchant_expected (
        merchant_key TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        source_txn_key TEXT,
        alerted_amount REAL,
        updated_at TEXT NOT NULL
      );
    `);
    // liquid flag: manual assets the user marks as an emergency-buffer resource
    this.ensureColumn('assets', 'liquid', 'INTEGER NOT NULL DEFAULT 0');
    // The semantic layer over `kind`. Type-legality lives in the API layer (isHoldingType) —
    // a DB CHECK froze the 2.8-era four-type list into every existing file and SQLite cannot
    // widen a CHECK, which is exactly the migration below. Existing rows back-fill to 'other'.
    this.ensureColumn('assets', 'type', "TEXT NOT NULL DEFAULT 'other'");
    this.ensureColumn('assets', 'institution', 'TEXT');
    // display-only: the payment is already a transaction and the recurring engine already detects it.
    // Adding it to the forecast or to the plan's fixed commitments double-counts it.
    this.ensureColumn('assets', 'monthly_payment', 'REAL');
    // multi-currency holdings: `amount` stays the RAW figure the institution prints, in `currency`;
    // conversion into shekels happens at read time with the cached rate (see exchange_rates).
    this.ensureColumn('assets', 'currency', "TEXT NOT NULL DEFAULT 'ILS'");
    // A database with the narrow four-type CHECK carries it inside the
    // column definition, and SQLite cannot alter a CHECK — the table is rebuilt once, row-for-row
    // and id-for-id (asset_snapshots reference the ids), with type-legality moved to the API layer.
    const assetsSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assets'")
      .get() as { sql?: string } | undefined)?.sql ?? '';
    if (assetsSql.includes("CHECK (type IN ('deposit','loan','securities','other'))")) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE assets_rebuilt (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability')),
            amount REAL NOT NULL,
            updated_at TEXT NOT NULL,
            liquid INTEGER NOT NULL DEFAULT 0,
            type TEXT NOT NULL DEFAULT 'other',
            institution TEXT,
            monthly_payment REAL,
            currency TEXT NOT NULL DEFAULT 'ILS'
          );
          INSERT INTO assets_rebuilt (id, name, kind, amount, updated_at, liquid, type, institution, monthly_payment, currency)
            SELECT id, name, kind, amount, updated_at, liquid, type, institution, monthly_payment, currency FROM assets;
          DROP TABLE assets;
          ALTER TABLE assets_rebuilt RENAME TO assets;
        `);
      })();
    }
    // 'habit' is one of the transaction-mark verdicts (מנוי/קבוע/הרגל/הסתרה). A database
    // written before it carries the three-value CHECK inside the column definition, and SQLite cannot
    // widen a CHECK — the table is rebuilt once, row-for-row.
    const txnMarksSql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'txn_marks'")
      .get() as { sql?: string } | undefined)?.sql ?? '';
    if (txnMarksSql.includes("CHECK (mark IN ('subscription', 'fixed', 'dismissed'))")) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE txn_marks_rebuilt (
            txn_key TEXT PRIMARY KEY,
            mark TEXT NOT NULL CHECK (mark IN ('subscription', 'fixed', 'habit', 'dismissed')),
            created_at TEXT NOT NULL
          );
          INSERT INTO txn_marks_rebuilt (txn_key, mark, created_at)
            SELECT txn_key, mark, created_at FROM txn_marks;
          DROP TABLE txn_marks;
          ALTER TABLE txn_marks_rebuilt RENAME TO txn_marks;
        `);
      })();
    }
    // Obsolete savings-goal tables are removed unconditionally and idempotently. An invisible
    // envelope must never continue reserving money.
    this.db.exec(`
      DROP TABLE IF EXISTS savings_entries;
      DROP TABLE IF EXISTS savings_goals;
    `);
    // every forecast leaves a receipt: what we predicted, for when, from when. The accuracy
    // audit ("חזינו X, קרה Y") reads these — a forecast that never faces reality is a rumor.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forecast_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        taken_on TEXT NOT NULL,
        horizon_days INTEGER NOT NULL,
        target_date TEXT NOT NULL,
        predicted_balance REAL NOT NULL,
        UNIQUE(taken_on, horizon_days)
      );
    `);
    // manual assets get a timeline: every value change is a snapshot, so net worth has history.
    // Existing assets are seeded with their current value (idempotent).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asset_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        taken_at TEXT NOT NULL
      );
      INSERT INTO asset_snapshots (asset_id, kind, amount, taken_at)
        SELECT id, kind, amount, updated_at FROM assets
        WHERE id NOT IN (SELECT DISTINCT asset_id FROM asset_snapshots);
    `);
    // a snapshot freezes the value AS OBSERVED: raw amount, its currency, and the shekel rate
    // of that day — so the history layer never re-prices the past with today's rate (A5-spirit).
    this.ensureColumn('asset_snapshots', 'currency', "TEXT NOT NULL DEFAULT 'ILS'");
    this.ensureColumn('asset_snapshots', 'rate', 'REAL NOT NULL DEFAULT 1');
    // the local rates cache: ILS per one unit, with the honest fetch time. Public data only —
    // fetching it sends nothing personal, and ILS-only users never trigger a fetch at all.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchange_rates (
        currency TEXT PRIMARY KEY,
        rate REAL NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `);
    // המסגרת החודשית: the household's declared ceiling for variable spending. Append-per-month —
    // one row per flow month in which the number was (re)declared, NULL amount = switched off.
    // A finished month is judged against the frame in force THEN, so rows are never rewritten
    // for past months (frameForMonth resolves which declaration governs which month).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS frame_history (
        month TEXT PRIMARY KEY,
        amount REAL,
        set_at TEXT NOT NULL
      );
    `);
    // נוכחות שקטה: every Windows notification ever shown, by its stable fact-key — the table
    // whose whole job is making sure no alert ever fires twice.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notified_alerts (
        key TEXT PRIMARY KEY,
        notified_at TEXT NOT NULL
      );
    `);
    // ההמלצות: the household's verdict on each proposal. The engine RE-DERIVES the queue from
    // data on every request — this table holds only what the engine can never know: what the
    // household decided. `done` rows are also the ledger of what those decisions are worth, so
    // the figures are frozen at the moment of the decision rather than recomputed later against
    // data that has already changed BECAUSE of it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS advice_state (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        value_kind TEXT NOT NULL,
        monthly_value REAL NOT NULL DEFAULT 0,
        value_certain INTEGER NOT NULL DEFAULT 0,
        action_he TEXT,
        acted_at TEXT NOT NULL
      );
    `);
    // המטרות: intentions, which are not the same thing as envelopes. A savings goal is a jar
    // with money in it; a plan goal may be "spend less on restaurants" — no jar, measured
    // straight off the transactions. Keeping them apart is what lets a reduction goal exist
    // without polluting the savings commitment the monthly plan subtracts from spendable money.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        target_amount REAL,
        monthly_amount REAL,
        category TEXT,
        category_ceiling REAL,
        advice_key TEXT,
        savings_goal_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        start_month TEXT NOT NULL,
        created_at TEXT NOT NULL,
        closed_at TEXT
      );
    `);
    migrationFault?.('before-version-stamp');
    this.db.pragma(`application_id = ${DATABASE_APPLICATION_ID}`);
    this.db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
    assertConnectionHealthy(this.db);
  }

  private ensureColumn(table: 'transactions' | 'assets' | 'asset_snapshots', column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    }
  }

  /** Insert rows, silently skipping keys that already exist. Returns number actually inserted. */
  insertTxns(rows: TxnRow[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO transactions
        (key, account, date, month, processed_date, amount, original_amount, currency, description, memo, status,
         company, connection_id, type, installment_number, installment_total, charged_currency,
         issuer_category, category, category_source)
      VALUES
        (@key, @account, @date, @month, @processedDate, @amount, @originalAmount, @currency, @description, @memo, @status,
         @company, @connectionId, @type, @installmentNumber, @installmentTotal, @chargedCurrency,
         @issuerCategory, @category, @categorySource)
    `);
    const runAll = this.db.transaction((rs: TxnRow[]) => {
      let inserted = 0;
      for (const r of rs) inserted += stmt.run(r).changes;
      return inserted;
    });
    return runAll(rows);
  }

  /** Sync-time insert for one connection: stale pending rows are dropped first, in the same
   *  transaction. Pending rows are transient bank state — the fresh scrape re-delivers the ones
   *  that still exist. Without this, a pending that settled under the same key stays 'pending'
   *  forever (excluded from every sum), and one that settled under a new key leaves a ghost
   *  that the forecast keeps re-projecting as an upcoming charge. */
  insertTxnsForSync(connectionId: number, rows: TxnRow[]): number {
    const priorPendingKeys = new Set(
      (this.db.prepare("SELECT key FROM transactions WHERE connection_id = ? AND status = 'pending'")
        .all(connectionId) as { key: string }[]).map((r) => r.key),
    );
    const clearPending = this.db.prepare(
      "DELETE FROM transactions WHERE connection_id = ? AND status = 'pending'",
    );
    const run = this.db.transaction((rs: TxnRow[]) => {
      clearPending.run(connectionId);
      const inserted = this.insertTxns(rs);
      // a re-delivered pending (or its settled form under the same key) is not news to the user
      const redelivered = rs.filter((r) => priorPendingKeys.has(r.key)).length;
      return Math.max(0, inserted - redelivered);
    });
    return run(rows);
  }

  private static readonly TXN_SELECT = `
    SELECT key, account, date, month, processed_date AS processedDate, amount,
           original_amount AS originalAmount, currency, description, memo, status,
           company, connection_id AS connectionId,
           type, installment_number AS installmentNumber, installment_total AS installmentTotal,
           charged_currency AS chargedCurrency, issuer_category AS issuerCategory,
           category, category_source AS categorySource
    FROM transactions
  `;

  getTxnsSinceMonth(month: string): TxnRow[] {
    return this.db.prepare(`${FinanceDb.TXN_SELECT} WHERE month >= ? ORDER BY date DESC`).all(month) as TxnRow[];
  }

  getTxnsForMonth(month: string): TxnRow[] {
    return this.db.prepare(`${FinanceDb.TXN_SELECT} WHERE month = ? ORDER BY date DESC`).all(month) as TxnRow[];
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** Every frame declaration ever made, oldest first — frameForMonth resolves which governs a month. */
  getFrameHistory(): FrameEntry[] {
    return this.db
      .prepare('SELECT month, amount, set_at AS setAt FROM frame_history ORDER BY month')
      .all() as FrameEntry[];
  }

  /** (Re)declare the frame for a flow month. Same-month re-declaration overwrites — within the
   *  month the user is changing their mind, not their history. amount null = switch off. */
  setFrameForMonth(month: string, amount: number | null, setAt: string): void {
    this.db
      .prepare(`INSERT INTO frame_history (month, amount, set_at) VALUES (?, ?, ?)
        ON CONFLICT(month) DO UPDATE SET amount = excluded.amount, set_at = excluded.set_at`)
      .run(month, amount, setAt);
  }

  listNotifiedAlertKeys(): string[] {
    return (this.db.prepare('SELECT key FROM notified_alerts').all() as { key: string }[]).map((r) => r.key);
  }

  markAlertsNotified(keys: string[], notifiedAt: string): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO notified_alerts (key, notified_at) VALUES (?, ?)');
    this.db.transaction((all: string[]) => {
      for (const key of all) insert.run(key, notifiedAt);
    })(keys);
  }

  /* ——— ההמלצות ——————————————————————————————————————————————————————————————————— */

  listAdviceState(): AdviceStateRow[] {
    return this.db
      .prepare(`SELECT key, status, kind, value_kind AS valueKind, monthly_value AS monthlyValue,
                       value_certain AS valueCertain, action_he AS actionHe, acted_at AS actedAt
                FROM advice_state ORDER BY acted_at DESC`)
      .all() as AdviceStateRow[];
  }

  /** Record the household's verdict on one proposal. Re-acting on the same key overwrites: a
   *  household that dismissed something and then did it should see the second decision. */
  setAdviceState(row: AdviceStateRow): void {
    this.db
      .prepare(`INSERT INTO advice_state (key, status, kind, value_kind, monthly_value, value_certain, action_he, acted_at)
        VALUES (@key, @status, @kind, @valueKind, @monthlyValue, @valueCertain, @actionHe, @actedAt)
        ON CONFLICT(key) DO UPDATE SET status = excluded.status, kind = excluded.kind,
          value_kind = excluded.value_kind, monthly_value = excluded.monthly_value,
          value_certain = excluded.value_certain, action_he = excluded.action_he, acted_at = excluded.acted_at`)
      .run(row);
  }

  /** Put a proposal back in the queue — the household changed their mind about changing it. */
  clearAdviceState(key: string): boolean {
    return this.db.prepare('DELETE FROM advice_state WHERE key = ?').run(key).changes > 0;
  }

  /* ——— המטרות ——————————————————————————————————————————————————————————————————— */

  listPlanGoals(): PlanGoalRow[] {
    return this.db
      .prepare(`SELECT id, type, name, target_amount AS targetAmount, monthly_amount AS monthlyAmount,
                       category, category_ceiling AS categoryCeiling, advice_key AS adviceKey,
                       savings_goal_id AS savingsGoalId, status, start_month AS startMonth,
                       created_at AS createdAt, closed_at AS closedAt
                FROM plan_goals ORDER BY id`)
      .all() as PlanGoalRow[];
  }

  addPlanGoal(goal: Omit<PlanGoalRow, 'id' | 'closedAt'>): number {
    return Number(
      this.db
        .prepare(`INSERT INTO plan_goals
          (type, name, target_amount, monthly_amount, category, category_ceiling, advice_key,
           savings_goal_id, status, start_month, created_at)
          VALUES (@type, @name, @targetAmount, @monthlyAmount, @category, @categoryCeiling, @adviceKey,
                  @savingsGoalId, @status, @startMonth, @createdAt)`)
        .run(goal).lastInsertRowid,
    );
  }

  updatePlanGoal(
    id: number,
    fields: Pick<PlanGoalRow, 'name' | 'targetAmount' | 'monthlyAmount' | 'categoryCeiling' | 'status'> & { closedAt: string | null },
  ): boolean {
    return this.db
      .prepare(`UPDATE plan_goals SET name = @name, target_amount = @targetAmount,
                monthly_amount = @monthlyAmount, category_ceiling = @categoryCeiling,
                status = @status, closed_at = @closedAt WHERE id = @id`)
      .run({ ...fields, id }).changes > 0;
  }

  deletePlanGoal(id: number): boolean {
    return this.db.prepare('DELETE FROM plan_goals WHERE id = ?').run(id).changes > 0;
  }

  addConnection(company: string, nickname: string | null, credentials: Buffer): number {
    const r = this.db
      .prepare('INSERT INTO connections (company, nickname, credentials, created_at) VALUES (?, ?, ?, ?)')
      .run(company, nickname, credentials, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  /** Connection metadata only — credential blobs are never returned here. */
  getConnections(): ConnectionRow[] {
    return this.db
      .prepare(`
        SELECT id, company, nickname, created_at AS createdAt,
               last_sync_at AS lastSyncAt, last_error AS lastError
        FROM connections ORDER BY id
      `)
      .all() as ConnectionRow[];
  }

  getConnectionCredentials(id: number): Buffer | null {
    const row = this.db.prepare('SELECT credentials FROM connections WHERE id = ?').get(id) as
      | { credentials: Buffer }
      | undefined;
    return row?.credentials ?? null;
  }

  replaceConnectionCredentials(id: number, credentials: Buffer): void {
    this.db.prepare('UPDATE connections SET credentials = ? WHERE id = ?').run(credentials, id);
  }

  /** Pass credentials=null to keep the existing blob. */
  updateConnection(id: number, nickname: string | null, credentials: Buffer | null): void {
    if (credentials) {
      this.db.prepare('UPDATE connections SET nickname = ?, credentials = ? WHERE id = ?').run(nickname, credentials, id);
    } else {
      this.db.prepare('UPDATE connections SET nickname = ? WHERE id = ?').run(nickname, id);
    }
  }

  /** Deletes the connection AND all its transactions. Returns false if it did not exist. */
  deleteConnection(id: number): boolean {
    const run = this.db.transaction((cid: number) => {
      this.db.prepare('DELETE FROM transactions WHERE connection_id = ?').run(cid);
      this.db.prepare('DELETE FROM account_snapshots WHERE connection_id = ?').run(cid);
      return this.db.prepare('DELETE FROM connections WHERE id = ?').run(cid).changes > 0;
    });
    return run(id);
  }

  setConnectionSyncResult(id: number, lastSyncAt: string | null, lastError: string | null): void {
    this.db.prepare('UPDATE connections SET last_sync_at = ?, last_error = ? WHERE id = ?').run(lastSyncAt, lastError, id);
  }

  insertSnapshot(connectionId: number, account: string, balance: number, balanceDate: string | null, takenAt: string): void {
    this.db
      .prepare('INSERT INTO account_snapshots (connection_id, account, balance, balance_date, taken_at) VALUES (?, ?, ?, ?, ?)')
      .run(connectionId, account, balance, balanceDate, takenAt);
  }

  /** Latest snapshot per (connection, account). History stays in the table for future phases. */
  getLatestSnapshots(): SnapshotRow[] {
    return this.db
      .prepare(`
        SELECT s.connection_id AS connectionId, s.account, s.balance,
               s.balance_date AS balanceDate, s.taken_at AS takenAt
        FROM account_snapshots s
        JOIN (SELECT connection_id, account, MAX(id) AS mid FROM account_snapshots GROUP BY connection_id, account) m
          ON s.id = m.mid
        ORDER BY s.connection_id, s.account
      `)
      .all() as SnapshotRow[];
  }

  /** Throws on duplicate pattern (UNIQUE) — caller maps to 409. */
  addRule(pattern: string, category: string): number {
    const r = this.db
      .prepare('INSERT INTO category_rules (pattern, category, created_at) VALUES (?, ?, ?)')
      .run(pattern, category, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getRules(): { id: number; pattern: string; category: string }[] {
    return this.db.prepare('SELECT id, pattern, category FROM category_rules ORDER BY id').all() as {
      id: number;
      pattern: string;
      category: string;
    }[];
  }

  deleteRule(id: number): boolean {
    return this.db.prepare('DELETE FROM category_rules WHERE id = ?').run(id).changes > 0;
  }

  getRule(id: number): { id: number; pattern: string; category: string } | null {
    return (this.db.prepare('SELECT id, pattern, category FROM category_rules WHERE id = ?').get(id) ?? null) as
      | { id: number; pattern: string; category: string }
      | null;
  }

  /** Reverts what a rule categorized (rule-sourced rows only) — the undo of applyRuleToExisting. */
  revertRuleApplications(pattern: string, category: string): number {
    return this.db
      .prepare("UPDATE transactions SET category = NULL, category_source = NULL WHERE instr(description, ?) > 0 AND category_source = 'rule' AND category = ?")
      .run(pattern, category).changes;
  }

  /** Batch-set automatic (non-user) categorizations — the repair pass after a rule revert. */
  setResolvedCategories(rows: { key: string; category: string; source: string }[]): void {
    const stmt = this.db.prepare('UPDATE transactions SET category = @category, category_source = @source WHERE key = @key');
    const run = this.db.transaction((rs: typeof rows) => {
      for (const r of rs) stmt.run(r);
    });
    run(rows);
  }

  /** Manual user categorization — never overwritten automatically. */
  setTxnCategory(key: string, category: string): boolean {
    return (
      this.db.prepare("UPDATE transactions SET category = ?, category_source = 'user' WHERE key = ?").run(category, key)
        .changes > 0
    );
  }

  /** Undo of a categorization — the row returns to the review inbox. */
  clearTxnCategory(key: string): boolean {
    return this.db.prepare('UPDATE transactions SET category = NULL, category_source = NULL WHERE key = ?').run(key).changes > 0;
  }

  /** How many rows a rule pattern would touch (same scope as applyRuleToExisting). */
  countRuleMatches(pattern: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE instr(description, ?) > 0 AND (category_source IS NULL OR category_source != 'user')")
      .get(pattern) as { n: number };
    return r.n;
  }

  /** Retroactively applies a rule to every matching row not categorized by the user. */
  applyRuleToExisting(pattern: string, category: string): number {
    return this.db
      .prepare(`
        UPDATE transactions SET category = ?, category_source = 'rule'
        WHERE instr(description, ?) > 0 AND (category_source IS NULL OR category_source != 'user')
      `)
      .run(category, pattern).changes;
  }

  getUncategorizedSinceMonth(month: string): TxnRow[] {
    return this.db
      .prepare(`${FinanceDb.TXN_SELECT} WHERE category IS NULL AND status = 'completed' AND month >= ? ORDER BY date DESC`)
      .all(month) as TxnRow[];
  }

  countUncategorizedSinceMonth(month: string): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM transactions WHERE category IS NULL AND status = 'completed' AND month >= ?")
      .get(month) as { n: number };
    return r.n;
  }

  addAsset(fields: {
    name: string;
    kind: 'asset' | 'liability';
    amount: number;
    liquid?: boolean;
    type?: HoldingType;
    institution?: string | null;
    monthlyPayment?: number | null;
    /** ISO 4217; the route validates support. Omitted = shekels, like every asset before it. */
    currency?: string;
    /** ILS per one unit at write time — frozen into the snapshot. ILS rows always 1. */
    rateIlsPerUnit?: number;
  }): number {
    const now = new Date().toISOString();
    const kind = fields.type ? kindForType(fields.type, fields.kind) : fields.kind;
    const currency = fields.currency ?? 'ILS';
    const rate = currency === 'ILS' ? 1 : fields.rateIlsPerUnit ?? 1;
    const r = this.db
      .prepare(`INSERT INTO assets (name, kind, amount, liquid, type, institution, monthly_payment, currency, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        fields.name, kind, fields.amount, fields.liquid ? 1 : 0,
        fields.type ?? 'other', fields.institution ?? null, fields.monthlyPayment ?? null, currency, now,
      );
    const id = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO asset_snapshots (asset_id, kind, amount, taken_at, currency, rate) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, kind, fields.amount, now, currency, rate);
    return id;
  }

  getAssets(): AssetRow[] {
    const rows = this.db
      .prepare(`SELECT id, name, kind, amount, liquid, type, institution, monthly_payment AS monthlyPayment,
                       currency, updated_at AS updatedAt
                FROM assets ORDER BY id`)
      .all() as (Omit<AssetRow, 'liquid'> & { liquid: number })[];
    return rows.map((r) => ({ ...r, liquid: !!r.liquid }));
  }

  /** Patch-shaped: only provided fields change. Writing `type` re-derives and writes `kind` (A9).
   *  A snapshot point is written ONLY when `amount` actually changes — a rename or a
   *  confirm-with-no-change must not pad the value timeline (A11).
   *  Returns false when `id` does not exist. */
  updateAsset(id: number, fields: {
    name?: string;
    amount?: number;
    liquid?: boolean;
    type?: HoldingType;
    institution?: string | null;
    monthlyPayment?: number | null;
    currency?: string;
    /** ILS per unit at write time, for the snapshot a moved value leaves behind. */
    rateIlsPerUnit?: number;
  }): boolean {
    const run = this.db.transaction(() => {
      const current = this.db.prepare('SELECT kind, amount, currency FROM assets WHERE id = ?').get(id) as
        | { kind: 'asset' | 'liability'; amount: number; currency: string }
        | undefined;
      if (!current) return false;

      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (clause: string, value: unknown) => { sets.push(clause); values.push(value); };
      if (fields.name !== undefined) set('name = ?', fields.name);
      if (fields.amount !== undefined) set('amount = ?', fields.amount);
      if (fields.liquid !== undefined) set('liquid = ?', fields.liquid ? 1 : 0);
      if (fields.type !== undefined) {
        set('type = ?', fields.type);
        // reclassification is a correction of what the row always was, so kind follows type
        set('kind = ?', kindForType(fields.type, current.kind));
      }
      if (fields.institution !== undefined) set('institution = ?', fields.institution);
      if (fields.monthlyPayment !== undefined) set('monthly_payment = ?', fields.monthlyPayment);
      if (fields.currency !== undefined) set('currency = ?', fields.currency);
      const now = new Date().toISOString();
      set('updated_at = ?', now);
      this.db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);

      // a currency change re-denominates the SAME row — that moves its shekel value even when
      // the raw number stayed put, so it earns a timeline point exactly like an amount change
      const moved = (fields.amount !== undefined && Math.round(fields.amount * 100) !== Math.round(current.amount * 100))
        || (fields.currency !== undefined && fields.currency !== current.currency);
      if (moved) {
        const after = this.db.prepare('SELECT kind, amount, currency FROM assets WHERE id = ?').get(id) as
          { kind: string; amount: number; currency: string };
        const rate = after.currency === 'ILS' ? 1 : fields.rateIlsPerUnit ?? 1;
        this.db.prepare('INSERT INTO asset_snapshots (asset_id, kind, amount, taken_at, currency, rate) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, after.kind, after.amount, now, after.currency, rate);
      }
      return true;
    });
    return run();
  }

  /** Runs `fn` as one SQLite transaction, for multi-row writes composed above the db layer:
   *  a rejection part-way through the list must leave nothing written. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** "The user re-read the bank and this is still true." Moves updated_at, writes no snapshot. */
  confirmAsset(id: number): boolean {
    return this.db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id).changes > 0;
  }

  getRecurringOverrides(): { merchant: string; kind: 'income' | 'expense' }[] {
    return this.db.prepare('SELECT merchant, kind FROM recurring_overrides ORDER BY merchant').all() as {
      merchant: string; kind: 'income' | 'expense';
    }[];
  }

  addRecurringOverride(merchant: string, kind: 'income' | 'expense'): void {
    this.db.prepare('INSERT OR IGNORE INTO recurring_overrides (merchant, kind) VALUES (?, ?)').run(merchant, kind);
  }

  deleteRecurringOverride(merchant: string, kind: 'income' | 'expense'): boolean {
    return this.db.prepare('DELETE FROM recurring_overrides WHERE merchant = ? AND kind = ?').run(merchant, kind).changes > 0;
  }

  /** The user's positive classification of a detected recurring stream — מנוי or חיוב קבוע.
   *  Muting (לא מחזורי) still lives in recurring_overrides; this sits on top of the non-muted ones. */
  getRecurringMarks(): { merchant: string; kind: 'income' | 'expense'; mark: 'subscription' | 'fixed' }[] {
    return this.db.prepare('SELECT merchant, kind, mark FROM recurring_marks').all() as {
      merchant: string; kind: 'income' | 'expense'; mark: 'subscription' | 'fixed';
    }[];
  }

  setRecurringMark(merchant: string, kind: 'income' | 'expense', mark: 'subscription' | 'fixed'): void {
    this.db.prepare(
      'INSERT INTO recurring_marks (merchant, kind, mark) VALUES (?, ?, ?) ' +
      'ON CONFLICT(merchant, kind) DO UPDATE SET mark = excluded.mark',
    ).run(merchant, kind, mark);
  }

  deleteRecurringMark(merchant: string, kind: 'income' | 'expense'): void {
    this.db.prepare('DELETE FROM recurring_marks WHERE merchant = ? AND kind = ?').run(merchant, kind);
  }

  getManualRecurring(): ManualRecurringRow[] {
    return this.db.prepare(
      'SELECT id, name, amount, cadence, day_of_month AS dayOfMonth, category, mark, created_at AS createdAt ' +
      'FROM manual_recurring ORDER BY id',
    ).all() as ManualRecurringRow[];
  }

  addManualRecurring(row: {
    name: string; amount: number; cadence: ManualRecurringRow['cadence'];
    dayOfMonth: number | null; category: string | null; mark: 'subscription' | 'fixed'; createdAt: string;
  }): number {
    const info = this.db.prepare(
      'INSERT INTO manual_recurring (name, amount, cadence, day_of_month, category, mark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(row.name, row.amount, row.cadence, row.dayOfMonth, row.category, row.mark, row.createdAt);
    return Number(info.lastInsertRowid);
  }

  deleteManualRecurring(id: number): boolean {
    return this.db.prepare('DELETE FROM manual_recurring WHERE id = ?').run(id).changes > 0;
  }

  /** Per-transaction classification — the metadata the user stamps on an individual charge line.
   *  This is the source of truth; merchant-level recurring behavior is DERIVED from it. */
  getTxnMarks(): { key: string; mark: 'subscription' | 'fixed' | 'habit' | 'dismissed' }[] {
    return this.db.prepare('SELECT txn_key AS key, mark FROM txn_marks').all() as {
      key: string; mark: 'subscription' | 'fixed' | 'habit' | 'dismissed';
    }[];
  }

  setTxnMark(key: string, mark: 'subscription' | 'fixed' | 'habit' | 'dismissed', createdAt: string): void {
    this.db.prepare(
      'INSERT INTO txn_marks (txn_key, mark, created_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(txn_key) DO UPDATE SET mark = excluded.mark',
    ).run(key, mark, createdAt);
  }

  deleteTxnMark(key: string): void {
    this.db.prepare('DELETE FROM txn_marks WHERE txn_key = ?').run(key);
  }

  /** Apply one classification to a whole batch of keys atomically — the "החל על כל החיובים של
   *  הסוחר" convenience. A null mark clears them. */
  setTxnMarksBulk(keys: string[], mark: 'subscription' | 'fixed' | 'habit' | 'dismissed' | null, createdAt: string): void {
    const set = this.db.prepare(
      'INSERT INTO txn_marks (txn_key, mark, created_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(txn_key) DO UPDATE SET mark = excluded.mark',
    );
    const del = this.db.prepare('DELETE FROM txn_marks WHERE txn_key = ?');
    this.db.transaction((ks: string[]) => {
      for (const k of ks) {
        if (mark === null) del.run(k);
        else set.run(k, mark, createdAt);
      }
    })(keys);
  }

  /** The user-anchored monthly cost per merchant (positive magnitude) + the last amount we already
   *  alerted about. Source of truth for "the amount I marked IS the amount" and for price-change
   *  detection. Keyed by the merchant identity (memo-aware merchantKey). */
  getMerchantExpected(): { merchant: string; amount: number; alertedAmount: number | null }[] {
    return this.db.prepare(
      'SELECT merchant_key AS merchant, amount, alerted_amount AS alertedAmount FROM merchant_expected',
    ).all() as { merchant: string; amount: number; alertedAmount: number | null }[];
  }

  /** Set (or move) a merchant's anchor. A fresh anchor clears the alerted marker so a later change
   *  can surface again. `amount` is stored as a positive magnitude. */
  setMerchantExpected(merchant: string, amount: number, sourceTxnKey: string | null, updatedAt: string): void {
    this.db.prepare(
      'INSERT INTO merchant_expected (merchant_key, amount, source_txn_key, alerted_amount, updated_at) ' +
      'VALUES (?, ?, ?, NULL, ?) ' +
      'ON CONFLICT(merchant_key) DO UPDATE SET amount = excluded.amount, source_txn_key = excluded.source_txn_key, ' +
      'alerted_amount = NULL, updated_at = excluded.updated_at',
    ).run(merchant, Math.abs(amount), sourceTxnKey, updatedAt);
  }

  /** Anchor a merchant ONLY if it has none yet — the idempotent backfill for merchants marked before
   *  anchoring existed. Never overwrites a user-set anchor. */
  setMerchantExpectedIfMissing(merchant: string, amount: number, updatedAt: string): void {
    this.db.prepare(
      'INSERT INTO merchant_expected (merchant_key, amount, source_txn_key, alerted_amount, updated_at) ' +
      'VALUES (?, ?, NULL, NULL, ?) ON CONFLICT(merchant_key) DO NOTHING',
    ).run(merchant, Math.abs(amount), updatedAt);
  }

  /** Remember the last deviating amount we surfaced, so "התעלם" (one-off) does not nag again for it. */
  setMerchantAlerted(merchant: string, alertedAmount: number): void {
    this.db.prepare('UPDATE merchant_expected SET alerted_amount = ? WHERE merchant_key = ?')
      .run(Math.abs(alertedAmount), merchant);
  }

  clearMerchantExpected(merchant: string): void {
    this.db.prepare('DELETE FROM merchant_expected WHERE merchant_key = ?').run(merchant);
  }

  /** User-defined issuer-sector mappings — the elastic layer for any future card company. */
  getSectorOverrides(): { sector: string; category: string }[] {
    return this.db.prepare('SELECT sector, category FROM sector_overrides ORDER BY sector').all() as {
      sector: string; category: string;
    }[];
  }

  setSectorOverride(sector: string, category: string): void {
    this.db
      .prepare('INSERT INTO sector_overrides (sector, category) VALUES (?, ?) ON CONFLICT(sector) DO UPDATE SET category = excluded.category')
      .run(sector, category);
  }

  /** User-taught flow classes — the elastic layer over the savings vocabulary, which will never
   *  be complete. No re-stamp twin to applySectorOverride exists and none is needed: exclusion is
   *  computed at read time and never persisted, so an override is retroactive the instant it lands. */
  getFlowOverrides(): { pattern: string; class: FlowClass }[] {
    return this.db.prepare('SELECT pattern, class FROM flow_overrides ORDER BY pattern').all() as {
      pattern: string; class: FlowClass;
    }[];
  }

  setFlowOverride(pattern: string, cls: FlowClass): void {
    this.db
      .prepare('INSERT INTO flow_overrides (pattern, class) VALUES (?, ?) ON CONFLICT(pattern) DO UPDATE SET class = excluded.class')
      .run(pattern, cls);
  }

  deleteFlowOverride(pattern: string): boolean {
    return this.db.prepare('DELETE FROM flow_overrides WHERE pattern = ?').run(pattern).changes > 0;
  }

  /** Re-stamp every machine-categorized row of a sector; user/rule choices are never touched. */
  applySectorOverride(sector: string, category: string): number {
    return this.db
      .prepare(`UPDATE transactions SET category = ?, category_source = 'issuer'
                WHERE TRIM(issuer_category) = ? AND category_source IN ('issuer', 'auto', 'income')`)
      .run(category, sector).changes;
  }

  deleteAsset(id: number): boolean {
    const run = this.db.transaction((aid: number) => {
      this.db.prepare('DELETE FROM asset_snapshots WHERE asset_id = ?').run(aid);
      return this.db.prepare('DELETE FROM assets WHERE id = ?').run(aid).changes > 0;
    });
    return run(id);
  }

  /** Asset value timeline, oldest first — the manual half of the net-worth history.
   *  `rate` is the shekel rate frozen at write time; ILS rows carry 1. */
  getAssetSnapshots(): { assetId: number; kind: 'asset' | 'liability'; amount: number; takenAt: string; currency: string; rate: number }[] {
    return this.db
      .prepare('SELECT asset_id AS assetId, kind, amount, taken_at AS takenAt, currency, rate FROM asset_snapshots ORDER BY taken_at, id')
      .all() as { assetId: number; kind: 'asset' | 'liability'; amount: number; takenAt: string; currency: string; rate: number }[];
  }

  /* ——— the FX cache: ILS per unit, with its honest age ——— */

  getExchangeRates(): { currency: string; rate: number; fetchedAt: string }[] {
    return this.db
      .prepare('SELECT currency, rate, fetched_at AS fetchedAt FROM exchange_rates ORDER BY currency')
      .all() as { currency: string; rate: number; fetchedAt: string }[];
  }

  setExchangeRates(rates: Record<string, number>, fetchedAt: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO exchange_rates (currency, rate, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, fetched_at = excluded.fetched_at
    `);
    const run = this.db.transaction(() => {
      for (const [currency, rate] of Object.entries(rates)) stmt.run(currency, rate, fetchedAt);
    });
    run();
  }

  /** One forecast receipt per (day, horizon) — a re-sync the same day overwrites, honestly:
   *  the audit compares the LAST thing we told the user that day against reality. */
  saveForecastSnapshot(takenOn: string, horizonDays: number, targetDate: string, predictedBalance: number): void {
    this.db
      .prepare(`INSERT INTO forecast_snapshots (taken_on, horizon_days, target_date, predicted_balance)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(taken_on, horizon_days) DO UPDATE SET target_date = excluded.target_date, predicted_balance = excluded.predicted_balance`)
      .run(takenOn, horizonDays, targetDate, predictedBalance);
  }

  listForecastSnapshots(): { takenOn: string; horizonDays: number; targetDate: string; predictedBalance: number }[] {
    return this.db
      .prepare('SELECT taken_on AS takenOn, horizon_days AS horizonDays, target_date AS targetDate, predicted_balance AS predictedBalance FROM forecast_snapshots ORDER BY taken_on DESC, horizon_days')
      .all() as { takenOn: string; horizonDays: number; targetDate: string; predictedBalance: number }[];
  }

  /** Raw issuer sector strings and their frequency — the map-extension worklist. */
  getIssuerSectors(): { sector: string; count: number }[] {
    return this.db
      .prepare("SELECT issuer_category AS sector, COUNT(*) AS count FROM transactions WHERE issuer_category IS NOT NULL AND issuer_category != '' GROUP BY issuer_category ORDER BY count DESC")
      .all() as { sector: string; count: number }[];
  }

  /** Manual (cash) rows are the only user-deletable transactions. */
  deleteManualTxn(key: string): boolean {
    return this.db.prepare("DELETE FROM transactions WHERE key = ? AND company = 'manual'").run(key).changes > 0;
  }

  /** Online snapshot of the live database (WAL-safe) into `destPath`. */
  backupTo(destPath: string): Promise<unknown> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    return this.db.backup(destPath);
  }

  /**
   * Replaces the database from a WAL-safe staged copy. File-backed databases use
   * an atomic rename with rollback; in-memory test databases retain the legacy
   * transactional table-copy implementation.
   */
  async restoreFrom(backupPath: string, options: DatabaseRestoreOptions = {}): Promise<void> {
    if (options.preRestorePath) await this.backupTo(options.preRestorePath);
    inspectDatabaseFile(backupPath);
    if (this.dbPath === ':memory:') {
      this.restoreInPlace(backupPath);
      this.assertHealthy();
      return;
    }

    const suffix = randomUUID();
    const stagingPath = `${this.dbPath}.restore-${suffix}`;
    const rollbackPath = `${this.dbPath}.rollback-${suffix}`;
    const failedReplacementPath = `${this.dbPath}.failed-${suffix}`;
    await copyDatabaseWalSafe(backupPath, stagingPath);

    // Reconcile a legacy backup and validate it before touching the live file.
    try {
      const staged = new FinanceDb(stagingPath);
      staged.checkpoint('TRUNCATE');
      staged.assertHealthy();
      staged.close();
    } catch (err) {
      this.safeRemove(stagingPath);
      this.safeRemoveSidecars(stagingPath);
      throw err;
    }

    this.checkpoint('TRUNCATE');
    this.db.close();
    let liveMoved = false;
    let replacementAccepted = false;
    try {
      this.removeSidecars(this.dbPath);
      this.fileOps.rename(this.dbPath, rollbackPath);
      liveMoved = true;
      this.fileOps.rename(stagingPath, this.dbPath);
      this.reopen();
      this.assertHealthy();
      replacementAccepted = true;
    } catch (originalError) {
      this.closeConnectionBestEffort();

      if (!liveMoved) {
        try {
          this.reopen();
          this.assertHealthy();
        } catch {
          throw new DatabaseRecoveryError('restore failed before the original could be moved', this.dbPath, originalError);
        }
        throw originalError;
      }

      // Never unlink an installed replacement: quarantine it so the original rollback remains untouched.
      if (this.fileOps.exists(this.dbPath)) {
        try {
          this.fileOps.rename(this.dbPath, failedReplacementPath);
        } catch {
          throw new DatabaseRecoveryError('restore replacement could not be quarantined', rollbackPath, originalError);
        }
      }

      let originalRestoredByCopy = false;
      try {
        this.fileOps.rename(rollbackPath, this.dbPath);
      } catch {
        try {
          // A failed rename must not consume the rollback. Copying keeps a second known-good original.
          this.fileOps.copyExclusive(rollbackPath, this.dbPath);
          originalRestoredByCopy = true;
        } catch {
          throw new DatabaseRecoveryError('automatic rollback could not restore the live path', rollbackPath, originalError);
        }
      }

      try {
        this.reopen();
        this.assertHealthy();
      } catch {
        const recoveryPath = originalRestoredByCopy && this.fileOps.exists(rollbackPath) ? rollbackPath : this.dbPath;
        throw new DatabaseRecoveryError('the restored original could not be reopened', recoveryPath, originalError);
      }
      throw originalError;
    } finally {
      this.safeRemove(stagingPath);
      this.safeRemoveSidecars(stagingPath);
      if (replacementAccepted) this.safeRemove(rollbackPath);
    }
  }

  private restoreInPlace(backupPath: string): void {
    this.db.prepare('ATTACH DATABASE ? AS backup').run(backupPath);
    try {
      const tables = (
        this.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      ).map((r) => r.name);
      const backupTables = new Set(
        (this.db.prepare("SELECT name FROM backup.sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
      );
      const run = this.db.transaction(() => {
        for (const t of tables) {
          if (!backupTables.has(t)) continue;
          const mainCols = (this.db.prepare(`PRAGMA main.table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
          const backCols = new Set(
            (this.db.prepare(`PRAGMA backup.table_info("${t}")`).all() as { name: string }[]).map((c) => c.name),
          );
          const cols = mainCols.filter((c) => backCols.has(c));
          if (cols.length === 0) continue;
          const colList = cols.map((c) => `"${c}"`).join(', ');
          this.db.prepare(`DELETE FROM main."${t}"`).run();
          this.db.prepare(`INSERT INTO main."${t}" (${colList}) SELECT ${colList} FROM backup."${t}"`).run();
        }
      });
      run();
    } finally {
      this.db.prepare('DETACH DATABASE backup').run();
    }
  }

  getApplicationId(): number {
    return Number(this.db.pragma('application_id', { simple: true }));
  }

  getSchemaVersion(): number {
    return Number(this.db.pragma('user_version', { simple: true }));
  }

  quickCheck(): string[] {
    return quickCheckConnection(this.db);
  }

  assertHealthy(): void {
    assertConnectionHealthy(this.db);
  }

  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE'): void {
    this.db.pragma(`wal_checkpoint(${mode})`);
  }

  getTableCounts(): Record<string, number> {
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    return Object.fromEntries(
      tables.map(({ name }) => {
        const escaped = name.replace(/"/g, '""');
        const row = this.db.prepare(`SELECT COUNT(*) AS count FROM "${escaped}"`).get() as { count: number };
        return [name, row.count];
      }),
    );
  }

  private reopen(): void {
    const reopened = new FinanceDb(this.dbPath, { fileOps: this.fileOps });
    this.db = reopened.db;
  }

  private removeSidecars(basePath: string): void {
    this.fileOps.remove(`${basePath}-wal`);
    this.fileOps.remove(`${basePath}-shm`);
  }

  private safeRemove(filePath: string): void {
    try {
      this.fileOps.remove(filePath);
    } catch {
      // Generated files are best-effort cleanup; never trade recovery safety for tidiness.
    }
  }

  private safeRemoveSidecars(basePath: string): void {
    this.safeRemove(`${basePath}-wal`);
    this.safeRemove(`${basePath}-shm`);
  }

  private closeConnectionBestEffort(): void {
    try {
      this.db.close();
    } catch {
      // The connection may already be closed because the file swap failed first.
    }
  }

  /** All snapshots (for net-worth history), oldest first. */
  getAllSnapshots(): SnapshotRow[] {
    return this.db
      .prepare(`
        SELECT connection_id AS connectionId, account, balance, balance_date AS balanceDate, taken_at AS takenAt
        FROM account_snapshots ORDER BY taken_at, id
      `)
      .all() as SnapshotRow[];
  }

  /** Wipes everything the scrapers brought — transactions and balance snapshots — but keeps
   *  connections (credentials), categorization rules, manual assets and settings.
   *  One sync afterwards re-pulls the whole window from scratch. */
  /**
   * The deeper wipe: everything a sync produced PLUS every verdict and rule the user layered on
   * top of it. Clearing transactions alone leaves the judgment layer behind, and the next sync
   * re-attaches those old verdicts to the freshly scraped rows — which is why a "delete all data"
   * that only emptied `transactions` felt to the user as though nothing had been deleted.
   *
   * Deliberately survives: connections + their encrypted credentials,
   * hand-typed assets, savings/plan goals, frame history and settings. None of those come back
   * from a sync, so wiping them would destroy work no re-download could restore.
   */
  clearDataAndVerdicts(): { txns: number; snapshots: number; verdicts: number; rules: number } {
    // split into the two words the settings screen uses, so the confirmation can report honestly
    const VERDICT_TABLES = ['txn_marks', 'merchant_expected', 'recurring_marks', 'manual_recurring'];
    const RULE_TABLES = ['category_rules', 'sector_overrides', 'flow_overrides', 'recurring_overrides'];
    const run = this.db.transaction(() => {
      const base = this.clearScrapedDataInner();
      const wipe = (tables: string[]) =>
        tables.reduce((sum, table) => sum + this.db.prepare(`DELETE FROM ${table}`).run().changes, 0);
      return { ...base, verdicts: wipe(VERDICT_TABLES), rules: wipe(RULE_TABLES) };
    });
    return run();
  }

  /** The shared body, callable from inside an outer transaction (better-sqlite3 forbids nesting). */
  private clearScrapedDataInner(): { txns: number; snapshots: number } {
    const txns = this.db.prepare('DELETE FROM transactions').run().changes;
    const snapshots = this.db.prepare('DELETE FROM account_snapshots').run().changes;
    this.db.prepare('UPDATE connections SET last_sync_at = NULL, last_error = NULL').run();
    this.db.prepare("DELETE FROM settings WHERE key = 'lastSyncAt'").run();
    return { txns, snapshots };
  }

  clearScrapedData(): { txns: number; snapshots: number } {
    const run = this.db.transaction(() => this.clearScrapedDataInner());
    return run();
  }

  /** One-time v4 migration: card rows were bucketed by purchase date; re-bucket by charge
   *  date (processed_date) so card months line up with the bank settlements they cancel.
   *  Pure callbacks keep this module free of company/timezone knowledge. */
  rebucketCardMonths(isCard: (company: string) => boolean, monthOf: (iso: string) => string): number {
    const rows = this.db
      .prepare("SELECT key, company, processed_date AS pd, month FROM transactions WHERE processed_date IS NOT NULL AND company IS NOT NULL")
      .all() as { key: string; company: string; pd: string; month: string }[];
    const upd = this.db.prepare('UPDATE transactions SET month = ? WHERE key = ?');
    const run = this.db.transaction(() => {
      let changed = 0;
      for (const r of rows) {
        if (!isCard(r.company)) continue;
        const m = monthOf(r.pd);
        if (m !== r.month) {
          upd.run(m, r.key);
          changed++;
        }
      }
      return changed;
    });
    return run();
  }

  /** Stamps phase-1 rows (company IS NULL) with the migrated leumi connection. */
  backfillLegacyTxns(connectionId: number): void {
    this.db
      .prepare('UPDATE transactions SET company = ?, connection_id = ? WHERE company IS NULL')
      .run('leumi', connectionId);
  }

  close(): void {
    this.db.close();
  }
}

/** One-time boot migration from phase 1: single credentials.enc file → leumi connection row. Idempotent. */
export function migrateLegacy(db: FinanceDb, dataDir: string): void {
  const legacyBlob = readLegacyCredentialsFile(dataDir);
  if (!legacyBlob) return;
  const id = db.addConnection('leumi', 'בנק לאומי', legacyBlob);
  db.backfillLegacyTxns(id);
  const lastSyncAt = db.getSetting('lastSyncAt');
  if (lastSyncAt) db.setConnectionSyncResult(id, lastSyncAt, null);
  db.setSetting('schema_version', '2');
  deleteLegacyCredentialsFile(dataDir);
}
