import { createHash } from 'node:crypto';

/** A transaction as stored in SQLite. amount is the charged amount: positive = income, negative = expense. */
export interface TxnRow {
  key: string;
  account: string;
  date: string; // ISO string as returned by the scraper
  month: string; // 'YYYY-MM' in Asia/Jerusalem local time
  processedDate: string | null;
  amount: number;
  originalAmount: number | null;
  currency: string | null;
  description: string;
  memo: string | null;
  status: 'completed' | 'pending';
  company: string; // CompanyTypes id (e.g. 'leumi', 'isracard')
  connectionId: number;
  type: 'normal' | 'installments';
  installmentNumber: number | null;
  installmentTotal: number | null;
  chargedCurrency: string | null;
  issuerCategory: string | null; // raw category string from the scraper (Max/Cal)
  category: string | null; // our CategoryId; the engine guarantees a category on every stored row
  categorySource: 'issuer' | 'rule' | 'user' | 'income' | 'auto' | null;
}

/** The shape israeli-bank-scrapers returns per transaction (subset we use). */
export interface ScrapedTxn {
  identifier?: string | number | null;
  date: string;
  processedDate?: string | null;
  originalAmount?: number | null;
  originalCurrency?: string | null;
  chargedAmount: number;
  description?: string | null;
  memo?: string | null;
  status: string;
  type?: string;
  installments?: { number: number; total: number } | null;
  chargedCurrency?: string | null;
  category?: string | null;
}

export interface MonthlySummary {
  month: string;
  income: number;
  expenses: number; // positive magnitude
  net: number; // income - expenses
}

/** 'YYYY-MM' of the transaction in Israel local time. The scraper emits ISO strings
 *  that can be UTC-shifted (e.g. 21:00Z for local midnight), so slicing the raw
 *  string would mis-bucket month-boundary transactions. */
export function monthKey(isoDate: string): string {
  // en-CA formats as YYYY-MM-DD
  return new Date(isoDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
}

export function makeTxnKey(
  account: string,
  date: string,
  amount: number,
  description: string,
  identifier?: string | number | null,
): string {
  const raw = [account, date, amount, description, identifier ?? ''].join('|');
  return createHash('sha256').update(raw).digest('hex');
}

/** chargeMonth: bucket by processedDate (the date the money actually moves) instead of the
 *  purchase date. Essential for card companies: a purchase on the 25th is charged next month,
 *  and installments all share the purchase date but debit on their own cycle dates. Without
 *  this, card months never line up with the bank settlements they must cancel out against. */
/** Currencies that are the shekel under different spellings — the scrapers are not consistent. */
const ILS_NAMES = new Set(['ILS', 'NIS', '₪']);

export function mapScrapedTxn(
  company: string,
  connectionId: number,
  account: string,
  t: ScrapedTxn,
  opts?: { chargeMonth?: boolean },
): TxnRow {
  const description = t.description ?? '';
  /**
   * A pending card purchase has not been charged yet, so Max/Cal deliver `chargedAmount: 0` —
   * but the purchase already has a price, and ₪0 on a screen reads as "this cost nothing".
   * The price sits in `originalAmount`, and it substitutes under three guards:
   *   pending only  — for a completed row, chargedAmount is the truth even when it is 0;
   *   nonzero       — a zero original buys nothing;
   *   shekels only  — a foreign-currency original must never slide into an ILS column
   *                   (a $20 shown as ₪20 is a number lying about its unit).
   * The row KEY stays on the raw chargedAmount: when the charge settles, the bank re-delivers
   * it as a fresh completed row and the sync's clear-pending pass drops this one anyway.
   */
  const originalIsIls = t.originalCurrency == null || ILS_NAMES.has(t.originalCurrency);
  const pendingAmount = t.status === 'pending' && t.chargedAmount === 0
    && typeof t.originalAmount === 'number' && Number.isFinite(t.originalAmount)
    && t.originalAmount !== 0 && originalIsIls
    ? t.originalAmount
    : null;
  return {
    key: makeTxnKey(account, t.date, t.chargedAmount, description, t.identifier),
    account,
    date: t.date,
    month: monthKey(opts?.chargeMonth && t.processedDate ? t.processedDate : t.date),
    processedDate: t.processedDate ?? null,
    amount: pendingAmount ?? t.chargedAmount,
    originalAmount: t.originalAmount ?? null,
    currency: t.originalCurrency ?? null,
    description,
    memo: t.memo ?? null,
    status: t.status === 'pending' ? 'pending' : 'completed',
    company,
    connectionId,
    type: t.type === 'installments' ? 'installments' : 'normal',
    installmentNumber: t.installments?.number ?? null,
    installmentTotal: t.installments?.total ?? null,
    chargedCurrency: t.chargedCurrency ?? null,
    issuerCategory: t.category ?? null,
    category: null,
    categorySource: null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The same real-world transaction reached us through two different connections
 *  (e.g. the same card company added twice, or an institution re-added after deletion
 *  under a new connection id). Rows are merged ONLY across connections — two identical-looking
 *  rows inside one connection are genuinely distinct transactions (two coffees, same café, same
 *  day, same price) that the DB keyed apart by scraper identifier; dropping one would silently
 *  undercount. The earliest connection wins. */
export function dedupeAcrossConnections<T extends TxnRow>(rows: T[]): T[] {
  const minConn = new Map<string, number>();
  const contentKey = (r: T) => [r.company, r.account, r.date, r.amount, r.description, r.status].join('|');
  for (const r of rows) {
    const k = contentKey(r);
    const prev = minConn.get(k);
    if (prev === undefined || r.connectionId < prev) minConn.set(k, r.connectionId);
  }
  const kept = rows.filter((r) => minConn.get(contentKey(r)) === r.connectionId);
  return kept.length === rows.length ? rows : kept;
}

export interface CategoryExpense {
  category: string; // CategoryId or 'uncategorized'
  expenses: number; // positive magnitude
}

/** Expenses per category per month over flagged rows. Skips pending, excluded and income rows. */
export function toCategoryBreakdown(rows: (TxnRow & { excluded?: boolean })[]): Record<string, CategoryExpense[]> {
  const byMonth = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.status !== 'completed' || r.excluded || r.amount >= 0) continue;
    const bucket = r.category ?? 'uncategorized';
    const monthMap = byMonth.get(r.month) ?? new Map<string, number>();
    monthMap.set(bucket, (monthMap.get(bucket) ?? 0) + -r.amount);
    byMonth.set(r.month, monthMap);
  }
  const out: Record<string, CategoryExpense[]> = {};
  for (const [month, cats] of byMonth) {
    out[month] = [...cats.entries()]
      .map(([category, expenses]) => ({ category, expenses: round2(expenses) }))
      .sort((a, b) => b.expenses - a.expenses);
  }
  return out;
}

export function toMonthlySummary(rows: (TxnRow & { excluded?: boolean })[]): MonthlySummary[] {
  const byMonth = new Map<string, { income: number; expenses: number }>();
  for (const r of rows) {
    if (r.status !== 'completed' || r.excluded) continue;
    const acc = byMonth.get(r.month) ?? { income: 0, expenses: 0 };
    if (r.amount >= 0) acc.income += r.amount;
    else acc.expenses += -r.amount;
    byMonth.set(r.month, acc);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, { income, expenses }]) => ({
      month,
      income: round2(income),
      expenses: round2(expenses),
      net: round2(income - expenses),
    }));
}
