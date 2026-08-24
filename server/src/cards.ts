import { companyKind, companyNameHe, type FlaggedTxn } from './companies.js';

/**
 * The credit-card ledger exposes two facts read directly from the data:
 *
 *   1. what already left the bank inside this window (the settlement rows), and
 *   2. what the card company has ALREADY scheduled to take next — every purchase whose
 *      charge date (`processedDate`) is still in the future.
 *
 * Neither is a forecast. (2) in particular is not an estimate of future spending: it is money
 * already spent, on a date the card company has already fixed.
 *
 * These figures deliberately stay OUT of every total on the screen. Adding the debit to the
 * spending would count the same shopping twice. `countedIn` says exactly where each
 * shekel was already counted, so the claim is checkable rather than asserted.
 */

const round = (n: number): number => Math.round(n * 100) / 100;

function localDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** Part of a scheduled debit, and the flow month that already counted it as spending. */
export interface CardChargeSlice {
  readonly month: string;
  readonly amount: number;
}

/** A debit the card company has already scheduled for purchases already made. */
export interface UpcomingCardCharge {
  /** local day the bank will be debited (YYYY-MM-DD) */
  readonly day: string;
  readonly company: string;
  readonly companyHe: string;
  /** what will leave the bank, refunds already netted */
  readonly amount: number;
  readonly count: number;
  /** where those purchases were already counted — flow months, largest share first */
  readonly countedIn: readonly CardChargeSlice[];
}

export interface CardOutlook {
  /** card debits that already hit the bank inside this flow month */
  readonly settled: {
    readonly amount: number;
    readonly count: number;
    readonly days: readonly string[];
    /** where the purchases behind those debits were counted — the proof, not the promise */
    readonly countedIn: readonly CardChargeSlice[];
  };
  /** every charge date still ahead, nearest first */
  readonly upcoming: readonly UpcomingCardCharge[];
  readonly upcomingTotal: number;
}

/** How many distinct future charge dates to name. Installment plans can schedule debits a
 *  year out; the month screen only needs the ones a person can act on. `upcomingTotal`
 *  always covers everything, named or not. */
const MAX_UPCOMING = 3;

/** Below this a debit is noise (a 5 ₪ PayPal charge that settles on its own date). */
const MIN_CHARGE = 1;

/** month → amount, as a list ordered by share. Amounts below MIN_CHARGE are rounding dust. */
function slices(counted: ReadonlyMap<string, number>): CardChargeSlice[] {
  return [...counted.entries()]
    .map(([month, amount]) => ({ month, amount: round(amount) }))
    .filter((s) => s.amount >= MIN_CHARGE)
    .sort((x, y) => y.amount - x.amount);
}

export function buildCardOutlook(
  rows: readonly FlaggedTxn[],
  month: string,
  todayLocalDay: string,
): CardOutlook {
  /* 1 — what already left the bank inside this window. The settlement row is the bank's own
   *     line ("לאומי ויזה", "מקס איט פיננ-י"); it carries excludeReason 'settlement' precisely
   *     because the details behind it are counted instead. */
  const settlementRows = rows.filter(
    (r) => r.month === month && r.status === 'completed' && r.amount < 0 && r.excludeReason === 'settlement',
  );
  const settledDays = new Set(settlementRows.map((r) => localDay(r.date)));
  // the purchases that debit paid for: card rows the issuer charged on those very days. This
  // provides the audit trail that reconciles the settlement to its underlying purchases.
  const settledCounted = new Map<string, number>();
  for (const r of rows) {
    if (companyKind(r.company) !== 'card' || r.excluded || r.status !== 'completed') continue;
    if (!r.processedDate || !settledDays.has(localDay(r.processedDate))) continue;
    settledCounted.set(r.month, (settledCounted.get(r.month) ?? 0) + -r.amount);
  }
  const settled = {
    amount: round(settlementRows.reduce((s, r) => s + -r.amount, 0)),
    count: settlementRows.length,
    days: [...settledDays].sort(),
    countedIn: slices(settledCounted),
  };

  /* 2 — what the card company will take next. Grouped by (charge day, company): one bank line
   *     per pair, which is exactly how it lands on the statement. */
  interface Bucket {
    day: string;
    company: string;
    net: number;
    count: number;
    counted: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    if (companyKind(r.company) !== 'card') continue;
    // pending rows carry the purchase date as their charge date — the issuer has not scheduled
    // them yet, and guessing on their behalf is exactly what we are not allowed to do
    if (r.status !== 'completed' || !r.processedDate) continue;
    const day = localDay(r.processedDate);
    if (day <= todayLocalDay) continue;
    const k = `${day}|${r.company}`;
    let b = buckets.get(k);
    if (!b) {
      b = { day, company: r.company, net: 0, count: 0, counted: new Map() };
      buckets.set(k, b);
    }
    b.net += r.amount;
    b.count += 1;
    // a row the engine excluded (a settlement, an internal transfer) was never counted as
    // spending, so it may not claim to have been
    if (!r.excluded) b.counted.set(r.month, (b.counted.get(r.month) ?? 0) + -r.amount);
  }

  const upcoming: UpcomingCardCharge[] = [...buckets.values()]
    .filter((b) => -b.net >= MIN_CHARGE)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.company.localeCompare(b.company)))
    .map((b) => ({
      day: b.day,
      company: b.company,
      companyHe: companyNameHe(b.company),
      amount: round(-b.net),
      count: b.count,
      countedIn: slices(b.counted),
    }));

  return {
    settled,
    upcoming: upcoming.slice(0, MAX_UPCOMING),
    upcomingTotal: round(upcoming.reduce((s, u) => s + u.amount, 0)),
  };
}
