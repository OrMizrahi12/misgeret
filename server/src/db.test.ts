import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { decryptCredentials, encryptCredentials } from './credentials.js';
import {
  DATABASE_APPLICATION_ID,
  DATABASE_SCHEMA_VERSION,
  DatabaseRecoveryError,
  FinanceDb,
  copyDatabaseWalSafe,
  migrateLegacy,
  recoverInterruptedDatabase,
} from './db.js';
import { row } from './test-helpers.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'findb-'));
}

describe('FinanceDb transactions', () => {
  test('insertTxns inserts, dedups by key, and round-trips company/connectionId', () => {
    const db = new FinanceDb(':memory:');
    const r = row({ date: '2026-05-01T10:00:00.000Z', amount: 100, company: 'isracard', connectionId: 3 });
    expect(db.insertTxns([r, r])).toBe(1);
    expect(db.insertTxns([r])).toBe(0);
    const stored = db.getTxnsSinceMonth('2026-01');
    expect(stored).toEqual([r]);
  });

  test('getTxnsForMonth returns only that month', () => {
    const db = new FinanceDb(':memory:');
    db.insertTxns([
      row({ date: '2026-05-10T10:00:00.000Z', amount: 1, description: 'may' }),
      row({ date: '2026-04-10T10:00:00.000Z', amount: 2, description: 'april' }),
    ]);
    const may = db.getTxnsForMonth('2026-05');
    expect(may).toHaveLength(1);
    expect(may[0].description).toBe('may');
  });

  test('settings round-trip', () => {
    const db = new FinanceDb(':memory:');
    expect(db.getSetting('months')).toBeNull();
    db.setSetting('months', '6');
    expect(db.getSetting('months')).toBe('6');
  });

  test('insertTxnsForSync reconciles pending rows instead of freezing/ghosting them', () => {
    const db = new FinanceDb(':memory:');
    const pending = row({ date: '2026-06-25T10:00:00.000Z', amount: -200, description: 'עסקה ממתינה', status: 'pending', connectionId: 3 });
    expect(db.insertTxnsForSync(3, [pending])).toBe(1);

    // (a) settled under the SAME key: the row must flip to completed, not stay pending forever
    const settledSameKey = { ...pending, status: 'completed' as const };
    expect(db.insertTxnsForSync(3, [settledSameKey])).toBe(0); // not news — it was already shown as pending
    expect(db.getTxnsSinceMonth('2026-01').map((t) => t.status)).toEqual(['completed']);

    // (b) settled under a NEW key (date shifted on settlement): no pending ghost may remain
    const pending2 = row({ date: '2026-07-01T10:00:00.000Z', amount: -300, description: 'הו"ק', status: 'pending', connectionId: 3 });
    db.insertTxnsForSync(3, [settledSameKey, pending2]);
    const settledNewKey = row({ date: '2026-07-03T10:00:00.000Z', amount: -300, description: 'הו"ק', status: 'completed', connectionId: 3 });
    db.insertTxnsForSync(3, [settledSameKey, settledNewKey]);
    const all = db.getTxnsSinceMonth('2026-01');
    expect(all.filter((t) => t.status === 'pending')).toHaveLength(0);
    expect(all).toHaveLength(2);

    // (c) other connections' pending rows are untouched
    const otherPending = row({ date: '2026-07-05T10:00:00.000Z', amount: -50, description: 'אחר', status: 'pending', connectionId: 9 });
    db.insertTxns([otherPending]);
    db.insertTxnsForSync(3, [settledSameKey]);
    expect(db.getTxnsSinceMonth('2026-01').filter((t) => t.status === 'pending')).toHaveLength(1);
  });

  test('rebucketCardMonths moves card rows to their charge month, leaves banks alone', () => {
    const db = new FinanceDb(':memory:');
    db.insertTxns([
      row({
        date: '2026-05-28T10:00:00.000Z', processedDate: '2026-06-02T10:00:00.000Z',
        amount: -250, description: 'קניה', company: 'isracard',
      }),
      row({
        date: '2026-05-28T10:00:00.000Z', processedDate: '2026-06-02T10:00:00.000Z',
        amount: -99, description: 'העברה', company: 'leumi',
      }),
    ]);
    const monthOf = (iso: string) => iso.slice(0, 7);
    const changed = db.rebucketCardMonths((c) => c === 'isracard', monthOf);
    expect(changed).toBe(1);
    expect(db.getTxnsForMonth('2026-06').map((t) => t.description)).toEqual(['קניה']);
    expect(db.getTxnsForMonth('2026-05').map((t) => t.description)).toEqual(['העברה']);
    // idempotent
    expect(db.rebucketCardMonths((c) => c === 'isracard', monthOf)).toBe(0);
  });
});

describe('FinanceDb connections', () => {
  test('add/list/credentials/delete lifecycle', () => {
    const db = new FinanceDb(':memory:');
    const blob = encryptCredentials({ username: 'u', password: 'p' });
    const id = db.addConnection('leumi', 'העו"ש שלי', blob);

    const conns = db.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ id, company: 'leumi', nickname: 'העו"ש שלי', lastSyncAt: null, lastError: null });
    expect('credentials' in conns[0]).toBe(false);

    expect(decryptCredentials(db.getConnectionCredentials(id)!)).toEqual({ username: 'u', password: 'p' });

    db.insertTxns([row({ date: '2026-05-01T10:00:00.000Z', amount: -5, connectionId: id })]);
    expect(db.deleteConnection(id)).toBe(true);
    expect(db.getConnections()).toHaveLength(0);
    expect(db.getTxnsSinceMonth('2026-01')).toHaveLength(0); // its txns are gone
    expect(db.deleteConnection(id)).toBe(false);
  });

  test('updateConnection replaces nickname and optionally credentials', () => {
    const db = new FinanceDb(':memory:');
    const id = db.addConnection('isracard', null, encryptCredentials({ id: '1', card6Digits: '123456', password: 'a' }));

    db.updateConnection(id, 'כרטיס עיקרי', null); // nickname only
    expect(db.getConnections()[0].nickname).toBe('כרטיס עיקרי');
    expect(decryptCredentials(db.getConnectionCredentials(id)!).password).toBe('a');

    db.updateConnection(id, 'כרטיס עיקרי', encryptCredentials({ id: '1', card6Digits: '123456', password: 'b' }));
    expect(decryptCredentials(db.getConnectionCredentials(id)!).password).toBe('b');
  });

  test('setConnectionSyncResult updates status fields', () => {
    const db = new FinanceDb(':memory:');
    const id = db.addConnection('leumi', null, encryptCredentials({ username: 'u', password: 'p' }));
    db.setConnectionSyncResult(id, '2026-07-13T10:00:00.000Z', null);
    expect(db.getConnections()[0]).toMatchObject({ lastSyncAt: '2026-07-13T10:00:00.000Z', lastError: null });
    db.setConnectionSyncResult(id, '2026-07-13T10:00:00.000Z', 'INVALID_PASSWORD');
    expect(db.getConnections()[0].lastError).toBe('INVALID_PASSWORD');
  });
});

describe('migration', () => {
  test('stamps the numbered application schema and passes quick_check', () => {
    const db = new FinanceDb(':memory:');
    expect(db.getApplicationId()).toBe(DATABASE_APPLICATION_ID);
    expect(db.getSchemaVersion()).toBe(DATABASE_SCHEMA_VERSION);
    expect(db.quickCheck()).toEqual(['ok']);
    db.close();
  });

  test('rejects a database owned by another application', () => {
    const dir = tempDir();
    const p = path.join(dir, 'foreign.db');
    const raw = new Database(p);
    raw.pragma('application_id = 42');
    raw.close();
    expect(() => new FinanceDb(p)).toThrow('another application');
  });

  test('rejects an unrelated application_id=0 SQLite file without stamping or mutating it', async () => {
    const dir = tempDir();
    const p = path.join(dir, 'unrelated.db');
    const copyPath = path.join(dir, 'copy.db');
    const raw = new Database(p);
    raw.exec("CREATE TABLE customers (id INTEGER PRIMARY KEY, sentinel TEXT); INSERT INTO customers (sentinel) VALUES ('ORIGINAL')");
    raw.close();

    expect(() => new FinanceDb(p)).toThrow('not a recognized Misgeret database');
    await expect(copyDatabaseWalSafe(p, copyPath)).rejects.toThrow('not a recognized Misgeret database');
    const untouched = new Database(p, { readonly: true });
    expect(untouched.pragma('application_id', { simple: true })).toBe(0);
    expect((untouched.prepare('SELECT sentinel FROM customers').get() as { sentinel: string }).sentinel).toBe('ORIGINAL');
    untouched.close();
  });

  test('rejects a near-match database with familiar table names but the wrong historical schema', async () => {
    const dir = tempDir();
    const p = path.join(dir, 'near-match.db');
    const copyPath = path.join(dir, 'copy.db');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE transactions (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, date TEXT NOT NULL, month TEXT NOT NULL,
        amount REAL NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('sentinel', 'ORIGINAL');
    `);
    raw.close();

    expect(() => new FinanceDb(p)).toThrow('not a recognized Misgeret database');
    await expect(copyDatabaseWalSafe(p, copyPath)).rejects.toThrow('not a recognized Misgeret database');
    const untouched = new Database(p, { readonly: true });
    expect(untouched.pragma('application_id', { simple: true })).toBe(0);
    expect((untouched.prepare("SELECT value FROM settings WHERE key = 'sentinel'").get() as { value: string }).value)
      .toBe('ORIGINAL');
    untouched.close();
  });

  test('rejects an existing empty SQLite file as an import source while allowing a genuinely new database', async () => {
    const dir = tempDir();
    const emptyPath = path.join(dir, 'empty.db');
    const copyPath = path.join(dir, 'copy.db');
    new Database(emptyPath).close();

    expect(() => new FinanceDb(emptyPath)).toThrow('not a recognized Misgeret database');
    await expect(copyDatabaseWalSafe(emptyPath, copyPath)).rejects.toThrow('not a recognized Misgeret database');

    const newPath = path.join(dir, 'new.db');
    const created = new FinanceDb(newPath);
    expect(created.getApplicationId()).toBe(DATABASE_APPLICATION_ID);
    created.close();
  });

  test('accepts a transactions-only phase-one database and reconciles its missing tables', () => {
    const dir = tempDir();
    const p = path.join(dir, 'phase-one.db');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE transactions (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, date TEXT NOT NULL, month TEXT NOT NULL,
        processed_date TEXT, amount REAL NOT NULL, original_amount REAL, currency TEXT,
        description TEXT NOT NULL, memo TEXT, status TEXT NOT NULL
      );
    `);
    raw.close();

    const reconciled = new FinanceDb(p);
    reconciled.setSetting('sentinel', 'PRESERVED');
    expect(reconciled.getSetting('sentinel')).toBe('PRESERVED');
    expect(reconciled.getApplicationId()).toBe(DATABASE_APPLICATION_ID);
    reconciled.close();
  });

  test('startup crash-gap recovery copies a retained rollback when the live DB is missing', () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'finance.db');
    const rollbackPath = `${livePath}.rollback-crash-test`;
    const live = new FinanceDb(livePath);
    live.setSetting('sentinel', 'ORIGINAL');
    live.close();
    fs.renameSync(livePath, rollbackPath);

    expect(recoverInterruptedDatabase(livePath)).toEqual({ recovered: true, rollbackPath });
    expect(fs.existsSync(rollbackPath)).toBe(true);
    const recovered = new FinanceDb(livePath);
    expect(recovered.getSetting('sentinel')).toBe('ORIGINAL');
    recovered.close();
  });

  test('startup recovery quarantines a corrupt live file and restores a retained valid rollback', () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'finance.db');
    const rollbackPath = `${livePath}.rollback-crash-test`;
    const rollback = new FinanceDb(rollbackPath);
    rollback.setSetting('sentinel', 'ORIGINAL');
    rollback.close();
    fs.writeFileSync(livePath, 'broken replacement');

    expect(recoverInterruptedDatabase(livePath)).toEqual({ recovered: true, rollbackPath });
    expect(fs.existsSync(rollbackPath)).toBe(true);
    const recovered = new FinanceDb(livePath);
    expect(recovered.getSetting('sentinel')).toBe('ORIGINAL');
    recovered.close();
    const quarantined = fs.readdirSync(dir).find((name) => name.startsWith('finance.db.failed-recovery-'));
    expect(quarantined).toBeDefined();
    expect(fs.readFileSync(path.join(dir, quarantined!), 'utf8')).toBe('broken replacement');
  });

  test('online copy includes committed rows still represented by WAL', async () => {
    const dir = tempDir();
    const sourcePath = path.join(dir, 'source.db');
    const copyPath = path.join(dir, 'copy.db');
    const source = new FinanceDb(sourcePath);
    source.setSetting('wal-value', 'present');
    await copyDatabaseWalSafe(sourcePath, copyPath);
    const copied = new FinanceDb(copyPath);
    expect(copied.getSetting('wal-value')).toBe('present');
    copied.close();
    source.close();
  });

  test('file restore atomically replaces data and keeps a pre-restore snapshot', async () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'live.db');
    const backupPath = path.join(dir, 'backup.db');
    const preRestorePath = path.join(dir, 'pre-restore.db');
    const live = new FinanceDb(livePath);
    live.setSetting('marker', 'old');
    const backup = new FinanceDb(backupPath);
    backup.setSetting('marker', 'new');
    backup.close();

    await live.restoreFrom(backupPath, { preRestorePath });
    expect(live.getSetting('marker')).toBe('new');
    const before = new FinanceDb(preRestorePath);
    expect(before.getSetting('marker')).toBe('old');
    before.close();
    live.close();
  });

  test('restore leaves ORIGINAL live when moving live to rollback fails', async () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'live.db');
    const backupPath = path.join(dir, 'backup.db');
    const seed = new FinanceDb(livePath);
    seed.setSetting('sentinel', 'ORIGINAL');
    seed.close();
    const backup = new FinanceDb(backupPath);
    backup.setSetting('sentinel', 'REPLACEMENT');
    backup.close();

    const live = new FinanceDb(livePath, {
      fileOps: {
        rename: (source, destination) => {
          if (source === livePath && destination.includes('.rollback-')) throw new Error('injected live rename failure');
          fs.renameSync(source, destination);
        },
      },
    });
    await expect(live.restoreFrom(backupPath)).rejects.toThrow('injected live rename failure');
    expect(live.getSetting('sentinel')).toBe('ORIGINAL');
    live.close();

    const reopened = new FinanceDb(livePath);
    expect(reopened.getSetting('sentinel')).toBe('ORIGINAL');
    reopened.close();
  });

  test('failed rollback rename copies ORIGINAL back and preserves the rollback file', async () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'live.db');
    const backupPath = path.join(dir, 'backup.db');
    const seed = new FinanceDb(livePath);
    seed.setSetting('sentinel', 'ORIGINAL');
    seed.close();
    const backup = new FinanceDb(backupPath);
    backup.setSetting('sentinel', 'REPLACEMENT');
    backup.close();

    const live = new FinanceDb(livePath, {
      fileOps: {
        rename: (source, destination) => {
          if (source.includes('.restore-') && destination === livePath) throw new Error('injected install failure');
          if (source.includes('.rollback-') && destination === livePath) throw new Error('injected rollback rename failure');
          fs.renameSync(source, destination);
        },
      },
    });
    await expect(live.restoreFrom(backupPath)).rejects.toThrow('injected install failure');
    expect(live.getSetting('sentinel')).toBe('ORIGINAL');

    const rollbackName = fs.readdirSync(dir).find((name) => name.startsWith('live.db.rollback-'));
    expect(rollbackName).toBeDefined();
    const rollback = new FinanceDb(path.join(dir, rollbackName!));
    expect(rollback.getSetting('sentinel')).toBe('ORIGINAL');
    rollback.close();
    live.close();
  });

  test('if rename and copy recovery both fail, the only ORIGINAL rollback is never deleted', async () => {
    const dir = tempDir();
    const livePath = path.join(dir, 'live.db');
    const backupPath = path.join(dir, 'backup.db');
    const seed = new FinanceDb(livePath);
    seed.setSetting('sentinel', 'ORIGINAL');
    seed.close();
    const backup = new FinanceDb(backupPath);
    backup.setSetting('sentinel', 'REPLACEMENT');
    backup.close();
    const live = new FinanceDb(livePath, {
      fileOps: {
        rename: (source, destination) => {
          if (source.includes('.restore-') && destination === livePath) throw new Error('injected install failure');
          if (source.includes('.rollback-') && destination === livePath) throw new Error('injected rollback rename failure');
          fs.renameSync(source, destination);
        },
        copyExclusive: () => {
          throw new Error('injected rollback copy failure');
        },
      },
    });

    let failure: unknown;
    try {
      await live.restoreFrom(backupPath);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(DatabaseRecoveryError);
    const recoveryPath = (failure as DatabaseRecoveryError).recoveryPath;
    expect(recoveryPath).toContain('.rollback-');
    expect(fs.existsSync(recoveryPath)).toBe(true);
    const original = new FinanceDb(recoveryPath);
    expect(original.getSetting('sentinel')).toBe('ORIGINAL');
    original.close();
  });

  test('partial-schema reconciliation rolls back every DDL change on an injected failure', () => {
    const dir = tempDir();
    const p = path.join(dir, 'partial.db');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE transactions (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, date TEXT NOT NULL, month TEXT NOT NULL,
        processed_date TEXT, amount REAL NOT NULL, original_amount REAL, currency TEXT,
        description TEXT NOT NULL, memo TEXT, status TEXT NOT NULL, category TEXT
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('sentinel', 'ORIGINAL');
    `);
    raw.close();

    expect(
      () => new FinanceDb(p, {
        migrationFault: (stage) => {
          if (stage === 'after-columns') throw new Error('injected schema failure');
        },
      }),
    ).toThrow('injected schema failure');

    const untouched = new Database(p);
    const columns = (untouched.pragma('table_info(transactions)') as { name: string }[]).map((column) => column.name);
    expect(columns).toContain('category');
    expect(columns).not.toContain('company');
    expect(columns).not.toContain('type');
    expect((untouched.prepare("SELECT value FROM settings WHERE key = 'sentinel'").get() as { value: string }).value)
      .toBe('ORIGINAL');
    expect(untouched.prepare("SELECT name FROM sqlite_master WHERE name = 'connections'").get()).toBeUndefined();
    expect(untouched.pragma('application_id', { simple: true })).toBe(0);
    expect(untouched.pragma('user_version', { simple: true })).toBe(0);
    untouched.close();

    const repaired = new FinanceDb(p);
    const repairedColumns = new Database(p, { readonly: true });
    const names = (repairedColumns.pragma('table_info(transactions)') as { name: string }[]).map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(['company', 'connection_id', 'type', 'category_source']));
    expect(repaired.getSetting('sentinel')).toBe('ORIGINAL');
    repairedColumns.close();
    repaired.close();
  });

  test('v1 schema (no company columns) is upgraded on open', () => {
    const dir = tempDir();
    const p = path.join(dir, 'finance.db');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE transactions (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, date TEXT NOT NULL, month TEXT NOT NULL,
        processed_date TEXT, amount REAL NOT NULL, original_amount REAL, currency TEXT,
        description TEXT NOT NULL, memo TEXT, status TEXT NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    raw.close();

    const db = new FinanceDb(p); // must not throw
    db.insertTxns([row({ date: '2026-06-01T10:00:00.000Z', amount: -10 })]);
    expect(db.getTxnsSinceMonth('2026-01')[0].company).toBe('leumi');
    db.close();
  });

  test('migrateLegacy converts credentials.enc into a leumi connection and backfills txns', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'credentials.enc'), encryptCredentials({ username: 'u', password: 'p' }));

    const p = path.join(dir, 'finance.db');
    let db = new FinanceDb(p);
    db.insertTxns([row({ date: '2026-06-01T10:00:00.000Z', amount: -10 })]);
    db.setSetting('lastSyncAt', '2026-07-13T08:00:00.000Z');
    db.close();

    // simulate phase-1 rows: null out the new columns
    const raw = new Database(p);
    raw.exec('UPDATE transactions SET company = NULL, connection_id = NULL');
    raw.close();

    db = new FinanceDb(p);
    migrateLegacy(db, dir);

    const conns = db.getConnections();
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ company: 'leumi', nickname: 'בנק לאומי', lastSyncAt: '2026-07-13T08:00:00.000Z' });
    expect(decryptCredentials(db.getConnectionCredentials(conns[0].id)!)).toEqual({ username: 'u', password: 'p' });

    const txns = db.getTxnsSinceMonth('2026-01');
    expect(txns[0].company).toBe('leumi');
    expect(txns[0].connectionId).toBe(conns[0].id);

    expect(fs.existsSync(path.join(dir, 'credentials.enc'))).toBe(false);

    migrateLegacy(db, dir); // idempotent — file is gone, nothing changes
    expect(db.getConnections()).toHaveLength(1);
    db.close();
  });
});

describe('flow_overrides', () => {
  test('set is an upsert, list is ordered, delete reports whether anything went', () => {
    const db = new FinanceDb(':memory:');
    expect(db.getFlowOverrides()).toEqual([]);
    db.setFlowOverride('חידוש פיקדון פק ם', 'internal');
    db.setFlowOverride('אבג', 'flow');
    db.setFlowOverride('חידוש פיקדון פק ם', 'flow'); // the user changes their mind, not a duplicate
    expect(db.getFlowOverrides()).toEqual([
      { pattern: 'אבג', class: 'flow' },
      { pattern: 'חידוש פיקדון פק ם', class: 'flow' },
    ]);
    expect(db.deleteFlowOverride('אבג')).toBe(true);
    expect(db.deleteFlowOverride('אבג')).toBe(false);
    db.close();
  });

  test('the class is constrained in the schema — a bad class is a money bug, not a typo', () => {
    const db = new FinanceDb(':memory:');
    expect(() => db.setFlowOverride('משהו', 'income' as never)).toThrow();
    db.close();
  });

  test('a database from before this feature opens fine and gains the table', () => {
    const dir = tempDir();
    const p = path.join(dir, 'older.db');
    const older = new FinanceDb(p);
    older.insertTxns([row({ date: '2026-05-18T10:00:00.000Z', amount: -180, description: 'רהיטי הארץ' })]);
    older.close();
    // simulate a backup restored from a build that never knew about flow_overrides
    const raw = new Database(p);
    raw.exec('DROP TABLE flow_overrides');
    raw.close();

    const reopened = new FinanceDb(p);
    expect(reopened.getFlowOverrides()).toEqual([]);
    expect(reopened.getTxnsForMonth('2026-05')).toHaveLength(1);
    reopened.close();
  });
});

describe('schema v3', () => {
  test('round-trips the new txn fields', () => {
    const db = new FinanceDb(':memory:');
    db.insertTxns([
      row({
        date: '2026-05-18T10:00:00.000Z',
        amount: -180,
        description: 'רהיטי הארץ',
        type: 'installments',
        installmentNumber: 2,
        installmentTotal: 6,
        chargedCurrency: 'ILS',
        issuerCategory: 'ריהוט',
        category: 'shopping',
        categorySource: 'user',
      }),
    ]);
    const [t] = db.getTxnsForMonth('2026-05');
    expect(t.type).toBe('installments');
    expect(t.installmentNumber).toBe(2);
    expect(t.installmentTotal).toBe(6);
    expect(t.chargedCurrency).toBe('ILS');
    expect(t.issuerCategory).toBe('ריהוט');
    expect(t.category).toBe('shopping');
    expect(t.categorySource).toBe('user');
    db.close();
  });

  test('upgrades a v2 database in place (old rows readable, type defaults to normal)', () => {
    const dir = tempDir();
    const p = path.join(dir, 'finance.db');
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE transactions (
        key TEXT PRIMARY KEY, account TEXT NOT NULL, date TEXT NOT NULL, month TEXT NOT NULL,
        processed_date TEXT, amount REAL NOT NULL, original_amount REAL, currency TEXT,
        description TEXT NOT NULL, memo TEXT, status TEXT NOT NULL, company TEXT, connection_id INTEGER
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO transactions (key, account, date, month, amount, description, status, company, connection_id)
      VALUES ('k1', 'a', '2026-05-01T10:00:00.000Z', '2026-05', -50, 'ישן', 'completed', 'leumi', 1);
    `);
    raw.close();
    const db = new FinanceDb(p);
    const [t] = db.getTxnsForMonth('2026-05');
    expect(t.type).toBe('normal');
    expect(t.category).toBeNull();
    db.close();
  });

  test('account snapshots: latest per (connection, account); deleted with connection', () => {
    const db = new FinanceDb(':memory:');
    const id = db.addConnection('leumi', null, Buffer.from('x'));
    db.insertSnapshot(id, 'acc-1', 100, null, '2026-07-01T00:00:00.000Z');
    db.insertSnapshot(id, 'acc-1', 250, '2026-07-10', '2026-07-10T00:00:00.000Z');
    db.insertSnapshot(id, 'acc-2', 999, null, '2026-07-10T00:00:00.000Z');
    const latest = db.getLatestSnapshots();
    expect(latest).toHaveLength(2);
    expect(latest.find((s) => s.account === 'acc-1')?.balance).toBe(250);
    db.deleteConnection(id);
    expect(db.getLatestSnapshots()).toHaveLength(0);
    db.close();
  });

  test('category rules: add, list, unique pattern, delete', () => {
    const db = new FinanceDb(':memory:');
    const id = db.addRule('שופרסל', 'groceries');
    expect(db.getRules()).toEqual([{ id, pattern: 'שופרסל', category: 'groceries' }]);
    expect(() => db.addRule('שופרסל', 'shopping')).toThrow();
    expect(db.deleteRule(id)).toBe(true);
    expect(db.deleteRule(id)).toBe(false);
    db.close();
  });

  test('setTxnCategory marks user source; applyRuleToExisting skips user rows', () => {
    const db = new FinanceDb(':memory:');
    db.insertTxns([
      row({ date: '2026-05-01T10:00:00.000Z', amount: -50, description: 'שופרסל דיל' }),
      row({ date: '2026-05-02T10:00:00.000Z', amount: -60, description: 'שופרסל חולון' }),
    ]);
    const [a, b] = db.getTxnsForMonth('2026-05').sort((x, y) => x.date.localeCompare(y.date));
    expect(db.setTxnCategory(a.key, 'shopping')).toBe(true);
    expect(db.setTxnCategory('no-such-key', 'shopping')).toBe(false);
    db.applyRuleToExisting('שופרסל', 'groceries');
    const after = db.getTxnsForMonth('2026-05');
    expect(after.find((t) => t.key === a.key)?.category).toBe('shopping'); // user kept
    expect(after.find((t) => t.key === a.key)?.categorySource).toBe('user');
    expect(after.find((t) => t.key === b.key)?.category).toBe('groceries');
    expect(after.find((t) => t.key === b.key)?.categorySource).toBe('rule');
    db.close();
  });

  test('uncategorized queries respect month window and completed status', () => {
    const db = new FinanceDb(':memory:');
    db.insertTxns([
      row({ date: '2026-05-01T10:00:00.000Z', amount: -50, description: 'לא מזוהה' }),
      row({ date: '2026-05-02T10:00:00.000Z', amount: -60, description: 'ממתין', status: 'pending' }),
      row({ date: '2026-01-01T10:00:00.000Z', amount: -70, description: 'ישן' }),
      row({ date: '2026-05-03T10:00:00.000Z', amount: -80, description: 'מסווג', category: 'other', categorySource: 'user' }),
    ]);
    expect(db.getUncategorizedSinceMonth('2026-04').map((t) => t.description)).toEqual(['לא מזוהה']);
    expect(db.countUncategorizedSinceMonth('2026-04')).toBe(1);
    expect(db.countUncategorizedSinceMonth('2026-01')).toBe(2);
    db.close();
  });
});

describe('assets type-CHECK taxonomy widening', () => {
  test('a database with the four-type CHECK is rebuilt once and accepts the current types', () => {
    const dir = tempDir();
    const file = path.join(dir, 'finance.db');
    // a fresh database, with one asset the old world knew
    let db = new FinanceDb(file);
    const depositId = db.addAsset({ name: 'פיקדון ותיק', kind: 'asset', amount: 12_345.67, type: 'deposit', liquid: true });
    db.close();

    // regress the file to the 2.8-era schema: the four-type CHECK baked into the column
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE assets_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('asset', 'liability')),
        amount REAL NOT NULL,
        updated_at TEXT NOT NULL,
        liquid INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('deposit','loan','securities','other')),
        institution TEXT,
        monthly_payment REAL,
        currency TEXT NOT NULL DEFAULT 'ILS'
      );
      INSERT INTO assets_legacy (id, name, kind, amount, updated_at, liquid, type, institution, monthly_payment, currency)
        SELECT id, name, kind, amount, updated_at, liquid, type, institution, monthly_payment, currency FROM assets;
      DROP TABLE assets;
      ALTER TABLE assets_legacy RENAME TO assets;
    `);
    // the legacy CHECK really does refuse the new taxonomy — the migration is not decorative
    expect(() => raw.prepare("INSERT INTO assets (name, kind, amount, updated_at, type) VALUES ('דירה', 'asset', 1, '2026-01-01', 'realEstate')").run()).toThrow();
    raw.close();

    // reopening runs reconcileSchema → the rebuild — old rows and ids intact, new types legal
    db = new FinanceDb(file);
    const flatId = db.addAsset({ name: 'דירה בחולון', kind: 'asset', amount: 1_850_000, type: 'realEstate' });
    const mortgageId = db.addAsset({ name: 'משכנתא', kind: 'liability', amount: 920_000, type: 'mortgage', monthlyPayment: 4_600 });
    const assets = db.getAssets();
    expect(assets.find((a) => a.id === depositId)).toMatchObject({ name: 'פיקדון ותיק', type: 'deposit', amount: 12_345.67, liquid: true });
    expect(assets.find((a) => a.id === flatId)).toMatchObject({ type: 'realEstate', kind: 'asset' });
    // kind derives from type: a mortgage is a liability no matter what the caller claims
    expect(assets.find((a) => a.id === mortgageId)).toMatchObject({ type: 'mortgage', kind: 'liability', monthlyPayment: 4_600 });
    db.close();
  });
});
