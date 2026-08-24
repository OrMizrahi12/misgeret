import { merchantKey, merchantLabel, normalizePattern } from './categories.js';
import { settlementCompany, type FlaggedTxn } from './companies.js';
import type { ManualRecurringRow } from './db.js';
import {
  addDays, addMonthsClamped, CADENCE_MONTHS, CADENCE_NAME_HE, type Cadence, type RecurringItem,
} from './recurring.js';

const CADENCE_INTERVAL_DAYS: Record<Cadence, number> = {
  weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60, yearly: 365,
};

export type TxnMarkValue = 'subscription' | 'fixed' | 'habit' | 'dismissed';
/** subscription/fixed are the two recurring COMMITMENT classes; habit is a confirmed behavioural
 *  rhythm (never committed money); dismissed silences a false positive. */
export type MerchantMark = 'subscription' | 'fixed' | 'habit' | 'dismissed';

function round2(n: number): number { return Math.round(n * 100) / 100; }
function localDate(iso: string): string { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); }
function daysBetween(a: string, b: string): number { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000); }
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The next upcoming occurrence, strictly in the future of `today`. */
export function nextOccurrence(today: string, cadence: Cadence, dayOfMonth: number | null): string {
  const months = CADENCE_MONTHS[cadence];
  if (months > 0) {
    const day = dayOfMonth ?? 1;
    let d = addMonthsClamped(today, 0, day);
    let guard = 0;
    while (d <= today && guard++ < 24) d = addMonthsClamped(d, months, day);
    return d;
  }
  return addDays(today, CADENCE_INTERVAL_DAYS[cadence]);
}

/** A hand-typed recurring charge, cast into the detector's shape (see the module's original note):
 *  `company: 'manual'` keeps it out of the calibrated daily balance curve but in the monthly plan. */
export function manualToRecurringItem(row: ManualRecurringRow, today: string): RecurringItem {
  const months = CADENCE_MONTHS[row.cadence];
  const intervalDays = CADENCE_INTERVAL_DAYS[row.cadence];
  const signed = -Math.abs(row.amount);
  const monthly = months > 0 ? signed / months : signed * (30 / intervalDays);
  const day = row.dayOfMonth ?? 1;
  return {
    merchant: normalizePattern(row.name), sampleDescription: row.name, company: 'manual', connectionId: -1,
    category: row.category, amount: round2(signed), lastAmount: round2(signed), amountStable: true,
    amountMin: round2(signed), amountMax: round2(signed), cadence: row.cadence, intervalDays,
    monthlyAmount: round2(monthly), dayOfMonth: day, occurrences: 0, firstDate: today, lastDate: today,
    nextDate: nextOccurrence(today, row.cadence, row.dayOfMonth), kind: 'expense', excludedFlow: false,
    excludeReason: null, provisional: false, forecastEligible: true, active: true, installmentPlan: false, endDate: null,
  };
}

/** The rhythm implied by the gaps between a merchant's charges — the detector could not confirm it
 *  (too few, too irregular), but once the user vouches for the merchant we still project a cadence.
 *  Also the cadence of a frequency-detected habit (patterns.ts), where irregularity is the point. */
export function cadenceFromGaps(sortedDates: string[]): Cadence {
  if (sortedDates.length < 2) return 'monthly';
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) gaps.push(daysBetween(sortedDates[i - 1], sortedDates[i]));
  const g = median(gaps);
  if (g <= 10) return 'weekly';
  if (g <= 20) return 'biweekly';
  if (g <= 45) return 'monthly';
  if (g <= 90) return 'bimonthly';
  return 'yearly';
}

/** How evenly spaced a merchant's charges are: 1 = metronomic (a genuine subscription cadence),
 *  0 = erratic. The coefficient of variation of the gaps, inverted and clamped. Variance needs
 *  ≥3 charges; a single gap (2 charges) is honestly unknown, so it scores a neutral 0.5, and a
 *  lone charge has no rhythm at all (0). This is the "קצב" axis of the frequency heat map. */
export function regularityScore(sortedDates: string[]): number {
  if (sortedDates.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) gaps.push(daysBetween(sortedDates[i - 1], sortedDates[i]));
  if (gaps.length === 1) return 0.5;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return 0;
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, Math.min(1, 1 - cv));
}

/** True for a transaction that is genuine, flow-counted spending — an expense charge, not a card
 *  settlement, transfer, or any excluded flow. The STRICT notion (what already counts in the month). */
export function isExpenseCharge(r: FlaggedTxn): boolean {
  return r.status === 'completed' && r.amount < 0 && !r.excluded && settlementCompany(r.description) === null;
}

/** True for an outflow the user may CLASSIFY in the tab — genuine money that ALREADY left the account,
 *  INCLUDING what the engine set aside from the flow (a bank transfer for rent, a standing order it
 *  read as internal, a savings move). The tab exists to align expectations, so these must be visible
 *  and markable. Withheld: the true card double-counts (`settlement`, `partial` — the same spending the
 *  card rows already carry, so classifying it would count it twice) and `future` (a not-yet-charged
 *  next-cycle row — a prediction, not history, and already carried by the forecast). */
export function isClassifiableExpense(r: FlaggedTxn): boolean {
  return r.status === 'completed' && r.amount < 0 && settlementCompany(r.description) === null
    && r.excludeReason !== 'settlement' && r.excludeReason !== 'partial' && r.excludeReason !== 'future';
}

/** The Hebrew note for a charge the engine kept OUT of the flow — shown so the user understands why
 *  a real commitment (rent-by-transfer) wasn't counted, and can promote it. null = counted normally. */
export function excludeReasonHe(r: FlaggedTxn): string | null {
  if (!r.excluded) return null;
  switch (r.excludeReason) {
    case 'transfer': return 'העברה';
    case 'savings': return 'חיסכון';
    case 'manual': return 'סומן כפנימי';
    case 'future': return 'טרם נגבה';
    default: return 'לא נספר בתזרים';
  }
}

/** The user's per-transaction marks, aggregated up to a per-merchant verdict. The dominant mark wins;
 *  ties break subscription > fixed > habit > dismissed (the more actionable signal). */
export function deriveMerchantMarks(
  txnMarks: { key: string; mark: TxnMarkValue }[],
  rows: FlaggedTxn[],
): Map<string, MerchantMark> {
  const markByKey = new Map(txnMarks.map((m) => [m.key, m.mark]));
  const counts = new Map<string, { subscription: number; fixed: number; habit: number; dismissed: number }>();
  for (const r of rows) {
    const mk = markByKey.get(r.key);
    if (!mk) continue;
    const merchant = merchantKey(r.description, r.memo);
    if (merchant.length < 2) continue;
    const c = counts.get(merchant) ?? { subscription: 0, fixed: 0, habit: 0, dismissed: 0 };
    c[mk] += 1;
    counts.set(merchant, c);
  }
  const result = new Map<string, MerchantMark>();
  for (const [merchant, c] of counts) {
    const ordered: [MerchantMark, number][] = [
      ['subscription', c.subscription], ['fixed', c.fixed], ['habit', c.habit], ['dismissed', c.dismissed],
    ];
    ordered.sort((a, b) => b[1] - a[1]);
    if (ordered[0][1] > 0) result.set(merchant, ordered[0][0]);
  }
  return result;
}

/** Synthesize a forecastable recurring item from a merchant's own transactions — used when the user
 *  vouched for a merchant the detector never confirmed. Amount = median charge, cadence from gaps. */
function merchantToRecurringItem(merchant: string, txns: FlaggedTxn[], today: string): RecurringItem | null {
  if (txns.length === 0) return null;
  const sorted = [...txns].sort((a, b) => a.date.localeCompare(b.date));
  const dates = sorted.map((r) => localDate(r.date));
  const amounts = sorted.map((r) => r.amount);
  const med = median(amounts);
  if (med === 0) return null;
  const cadence = cadenceFromGaps(dates);
  const months = CADENCE_MONTHS[cadence];
  const intervalDays = CADENCE_INTERVAL_DAYS[cadence];
  const dayOfMonth = Math.round(median(dates.map((d) => Number(d.slice(8, 10)))));
  const last = sorted[sorted.length - 1];
  const monthly = months > 0 ? med / months : med * (30 / intervalDays);
  // A user's verdict promotes the merchant — it does NOT exempt it from being dead. The same
  // staleness law as the detector's isActive: a promoted merchant whose charges stopped must
  // never keep feeding the plan and the forecast (the שחר רוזן zombie, promoted-path variant).
  const lastDate = dates[dates.length - 1];
  const graceDays = months > 0 ? months * 45 : Math.max(10, Math.round(intervalDays * 1.5));
  const active = addDays(lastDate, graceDays) >= today;
  return {
    merchant, sampleDescription: last.description, company: last.company, connectionId: last.connectionId,
    category: last.category, amount: round2(med), lastAmount: round2(last.amount), amountStable: true,
    amountMin: round2(Math.min(...amounts)), amountMax: round2(Math.max(...amounts)), cadence, intervalDays,
    monthlyAmount: round2(monthly), dayOfMonth, occurrences: sorted.length, firstDate: dates[0],
    lastDate,
    nextDate: months > 0 ? nextOccurrence(today, cadence, dayOfMonth) : addDays(lastDate, intervalDays),
    kind: 'expense', excludedFlow: false, excludeReason: null, provisional: false, forecastEligible: active,
    active, installmentPlan: false, endDate: null,
  };
}

/** Recurring items the user PROMOTED by hand — merchants marked subscription/fixed that the detector
 *  never surfaced. `company: 'manual'` keeps them out of the calibrated balance curve (they still feed
 *  the plan + the expected-charges list). Merchants the detector already found are skipped here. */
export function promotedRecurringItems(
  merchantMark: Map<string, MerchantMark>,
  rows: FlaggedTxn[],
  detectedExpenseMerchants: Set<string>,
  today: string,
): RecurringItem[] {
  const items: RecurringItem[] = [];
  const expenseRows = rows.filter(isClassifiableExpense);
  for (const [merchant, mark] of merchantMark) {
    // only commitment verdicts promote a merchant into the plan — a habit is behaviour, not a bill
    if (mark === 'dismissed' || mark === 'habit' || detectedExpenseMerchants.has(merchant)) continue;
    const txns = expenseRows.filter((r) => merchantKey(r.description, r.memo) === merchant);
    const item = merchantToRecurringItem(merchant, txns, today);
    if (item) items.push({ ...item, company: 'manual' });
  }
  return items;
}

/** Normalized merchants whose per-transaction verdict is 'subscription' (plus manual subscriptions) —
 *  the set that stamps the "מנוי" tag across the app. */
export function subscriptionMerchants(
  merchantMark: Map<string, MerchantMark>,
  manualRows: ManualRecurringRow[],
): Set<string> {
  const set = new Set<string>();
  for (const [merchant, mark] of merchantMark) if (mark === 'subscription') set.add(merchant);
  for (const r of manualRows) if (r.mark === 'subscription') set.add(normalizePattern(r.name));
  return set;
}

/* ——— the full expense-detail surface ——— */

export interface ExpenseTxn {
  key: string;
  date: string;
  description: string;
  memo: string | null;         // the bank's note — carries the payee for a generic transfer
  merchant: string;
  category: string | null;
  amount: number; // signed (expense negative)
  company: string;
  mark: TxnMarkValue | null;   // this transaction's own classification
  detected: boolean;           // the detector already reads this merchant as recurring
  excluded: boolean;           // the engine kept this out of the flow (transfer/savings/internal)
  excludeReasonHe: string | null; // why, in Hebrew — null when it counts normally
}

/** One merchant, rolled up from all its charges in the window — the unit the "לפי תדירות" view
 *  shows and sorts. `count` and `regularity` are the two heat axes; the client blends them into
 *  the weighted score and colors the row. `txns` carries every underlying charge so the group can
 *  expand to the individual data-points (and stay per-transaction under the hood). */
export interface ExpenseMerchant {
  merchant: string;          // normalized key — what apply-merchant matches on
  name: string;              // display description (the most recent charge)
  category: string | null;
  count: number;             // how many charges in the window
  typicalAmount: number;     // signed (negative) — median charge
  totalAmount: number;       // signed (negative) — sum over the window
  monthlyAmount: number;     // positive magnitude — monthly-equivalent
  cadence: Cadence;
  cadenceHe: string;
  regularity: number;        // 0..1 — how even the gaps are
  firstDate: string;
  lastDate: string;
  detected: boolean;         // the detector already reads this merchant as recurring
  mark: TxnMarkValue | null; // merchant verdict (dominant), null = unclassified
  excluded: boolean;         // the engine keeps this merchant's charges out of the flow
  excludeReasonHe: string | null; // why (העברה / חיסכון / …), null when counted normally
  txns: ExpenseTxn[];        // the merchant's charges, newest first
}

export interface ManualSub {
  id: number;
  name: string;
  amount: number;      // signed (negative)
  monthlyAmount: number;
  cadence: Cadence;
  cadenceHe: string;
  dayOfMonth: number | null;
  category: string | null;
  mark: 'subscription' | 'fixed';
}

export interface ExpenseDetailView {
  txns: ExpenseTxn[];
  merchants: ExpenseMerchant[];
  manual: ManualSub[];
  summary: {
    subscriptionCount: number;   // distinct merchants (+ manual) classified as subscription
    subscriptionMonthly: number; // positive magnitude
    fixedCount: number;
    fixedMonthly: number;
    unclassifiedCount: number;   // expense transactions with no mark
    totalTxns: number;
  };
}

/** The per-merchant monthly-equivalent (positive magnitude): the detector's figure when it has one,
 *  otherwise synthesized from the merchant's own transactions. */
function merchantMonthly(merchant: string, rows: FlaggedTxn[], detected: RecurringItem[], today: string): number {
  const det = detected.find((d) => d.merchant === merchant && d.kind === 'expense');
  if (det) return Math.abs(det.monthlyAmount);
  const txns = rows.filter((r) => isClassifiableExpense(r) && merchantKey(r.description, r.memo) === merchant);
  const item = merchantToRecurringItem(merchant, txns, today);
  return item ? Math.abs(item.monthlyAmount) : 0;
}

export function buildExpenseDetail(input: {
  rows: FlaggedTxn[];
  detected: RecurringItem[];
  txnMarks: { key: string; mark: TxnMarkValue }[];
  manual: ManualRecurringRow[];
  today: string;
  /** merchant → user-anchored monthly cost (positive magnitude). When present it OVERRIDES the
   *  statistical estimate — "the amount I marked IS the amount". */
  expected?: Map<string, number>;
}): ExpenseDetailView {
  const { rows, detected, txnMarks, manual, today, expected } = input;
  const markByKey = new Map(txnMarks.map((m) => [m.key, m.mark]));
  const detectedMerchants = new Set(detected.filter((d) => d.kind === 'expense').map((d) => d.merchant));
  const merchantMark = deriveMerchantMarks(txnMarks, rows);

  // the monthly figure for a merchant: the user's anchor when they set one (converted to a monthly
  // basis by the merchant's cadence), otherwise the detector's / median-synthesized estimate.
  const monthlyForMerchant = (merchant: string, cadence: Cadence): number => {
    const anchor = expected?.get(merchant);
    if (anchor !== undefined) {
      const months = CADENCE_MONTHS[cadence];
      return months > 0 ? anchor / months : anchor;
    }
    return merchantMonthly(merchant, rows, detected, today);
  };

  const txns: ExpenseTxn[] = rows
    .filter(isClassifiableExpense)
    .map((r) => {
      const merchant = merchantKey(r.description, r.memo);
      return {
        key: r.key, date: r.date, description: r.description, memo: r.memo ?? null, merchant,
        category: r.category, amount: r.amount, company: r.company,
        mark: markByKey.get(r.key) ?? null, detected: detectedMerchants.has(merchant),
        excluded: r.excluded === true, excludeReasonHe: excludeReasonHe(r),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // roll the charges up to merchants — the unit the "לפי תדירות" view shows. Grouping preserves
  // the newest-first order above, so each group's txns are already newest-first.
  const byMerchant = new Map<string, ExpenseTxn[]>();
  for (const t of txns) {
    const g = byMerchant.get(t.merchant);
    if (g) g.push(t); else byMerchant.set(t.merchant, [t]);
  }
  const merchants: ExpenseMerchant[] = [];
  for (const [merchant, group] of byMerchant) {
    const asc = group.map((t) => localDate(t.date)).sort();
    const amounts = group.map((t) => t.amount);
    const cadence = cadenceFromGaps(asc);
    const excludedTxns = group.filter((t) => t.excluded);
    merchants.push({
      merchant,
      name: merchantLabel(group[0].description, group[0].memo),
      category: group[0].category,
      count: group.length,
      typicalAmount: round2(median(amounts)),
      totalAmount: round2(amounts.reduce((a, b) => a + b, 0)),
      monthlyAmount: Math.round(monthlyForMerchant(merchant, cadence)),
      cadence,
      cadenceHe: CADENCE_NAME_HE[cadence],
      regularity: Math.round(regularityScore(asc) * 100) / 100,
      firstDate: group[group.length - 1].date,
      lastDate: group[0].date,
      detected: detectedMerchants.has(merchant),
      mark: merchantMark.get(merchant) ?? null,
      excluded: excludedTxns.length > group.length / 2,
      excludeReasonHe: excludedTxns[0]?.excludeReasonHe ?? null,
      txns: group,
    });
  }
  merchants.sort((a, b) => b.count - a.count); // a stable default; the client re-sorts by the chosen metric

  // merchant-level summary (distinct merchants, not transactions) — sums the SAME anchor-adjusted
  // monthly figures the merchants carry, so the totals reconcile with the donut slices exactly.
  let subscriptionMonthly = 0; let subscriptionCount = 0;
  let fixedMonthly = 0; let fixedCount = 0;
  for (const m of merchants) {
    if (m.mark === 'subscription') { subscriptionCount += 1; subscriptionMonthly += m.monthlyAmount; }
    else if (m.mark === 'fixed') { fixedCount += 1; fixedMonthly += m.monthlyAmount; }
  }

  const manualSubs: ManualSub[] = manual.map((row) => {
    const item = manualToRecurringItem(row, today);
    return {
      id: row.id, name: row.name, amount: item.amount, monthlyAmount: item.monthlyAmount,
      cadence: row.cadence, cadenceHe: CADENCE_NAME_HE[row.cadence], dayOfMonth: row.dayOfMonth,
      category: row.category, mark: row.mark,
    };
  });
  for (const m of manualSubs) {
    if (m.mark === 'subscription') { subscriptionCount += 1; subscriptionMonthly += Math.abs(m.monthlyAmount); }
    else { fixedCount += 1; fixedMonthly += Math.abs(m.monthlyAmount); }
  }

  return {
    txns,
    merchants,
    manual: manualSubs,
    summary: {
      subscriptionCount,
      subscriptionMonthly: Math.round(subscriptionMonthly),
      fixedCount,
      fixedMonthly: Math.round(fixedMonthly),
      unclassifiedCount: txns.filter((t) => t.mark === null).length,
      totalTxns: txns.length,
    },
  };
}

/** One past charge of a merchant — the atom the history popup plots. */
export interface MerchantCharge {
  date: string;    // local YYYY-MM-DD
  month: string;   // YYYY-MM
  amount: number;  // positive magnitude
}

/** The full charge history of ONE merchant, plus the pattern read from it — the raw material for the
 *  "היסטוריה ודפוס" popup. Deliberately over ALL stored months (not the 12-month analysis window):
 *  a pattern is only as honest as its depth, and price drift shows up only over the long run. */
export interface MerchantChargeHistory {
  merchant: string;
  name: string;
  category: string | null;
  count: number;
  charges: MerchantCharge[]; // oldest → newest (chart reads left→right in time)
  typicalAmount: number;     // median magnitude, positive
  minAmount: number;
  maxAmount: number;
  totalAmount: number;       // positive sum
  firstDate: string;
  lastDate: string;
  cadence: Cadence;
  cadenceHe: string;
  regularity: number;        // 0..1 — how metronomic the gaps are
  dayOfMonth: number | null; // the median day-of-month it lands on
  mark: TxnMarkValue | null; // the merchant's current verdict (dominant)
  varied: boolean;           // amounts drift beyond an FX/rounding wiggle → a variable-price charge
}

/** Roll ALL of a merchant's genuine charges (across every stored month) into a history + pattern.
 *  Returns null when the merchant has no classifiable charge on record. */
export function merchantHistory(input: {
  rows: FlaggedTxn[];
  merchant: string;
  txnMarks: { key: string; mark: TxnMarkValue }[];
}): MerchantChargeHistory | null {
  const { rows, merchant, txnMarks } = input;
  const group = rows
    .filter((r) => isClassifiableExpense(r) && merchantKey(r.description, r.memo) === merchant)
    .sort((a, b) => localDate(a.date).localeCompare(localDate(b.date))); // oldest → newest
  if (group.length === 0) return null;

  const charges: MerchantCharge[] = group.map((r) => {
    const d = localDate(r.date);
    return { date: d, month: d.slice(0, 7), amount: round2(Math.abs(r.amount)) };
  });
  const mags = charges.map((c) => c.amount);
  const dates = charges.map((c) => c.date);
  const days = dates.map((d) => Number(d.slice(8, 10)));
  const typical = round2(median(mags));
  const minAmount = round2(Math.min(...mags));
  const maxAmount = round2(Math.max(...mags));
  const newest = group[group.length - 1];

  return {
    merchant,
    name: merchantLabel(newest.description, newest.memo),
    category: newest.category,
    count: group.length,
    charges,
    typicalAmount: typical,
    minAmount,
    maxAmount,
    totalAmount: round2(mags.reduce((a, b) => a + b, 0)),
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    cadence: cadenceFromGaps(dates),
    cadenceHe: CADENCE_NAME_HE[cadenceFromGaps(dates)],
    regularity: Math.round(regularityScore(dates) * 100) / 100,
    dayOfMonth: days.length ? Math.round(median(days)) : null,
    mark: deriveMerchantMarks(txnMarks, rows).get(merchant) ?? null,
    // a real price change, not FX/rounding noise: spread beyond both 10% of typical and ₪10
    varied: maxAmount - minAmount > Math.max(10, typical * 0.1),
  };
}

/* ——— subscription price tracking: "the amount I marked IS the amount", and a nudge when it changes ——— */

export interface ExpectedRow { merchant: string; amount: number; alertedAmount: number | null }

/** One merchant's charges → magnitude total per calendar month. `excludeFrom` (a YYYY-MM) drops that
 *  month and everything after it — used to ignore the still-running, half-charged current month. */
function monthlyTotals(txns: FlaggedTxn[], excludeFrom: string | null): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const t of txns) {
    const m = t.date.slice(0, 7);
    if (excludeFrom && m >= excludeFrom) continue;
    byMonth.set(m, (byMonth.get(m) ?? 0) + Math.abs(t.amount));
  }
  return byMonth;
}

/** The marked (subscription/fixed) classifiable-expense charges, grouped by merchant identity.
 *  Shared by the backfill and the price-change detector so they see one consistent grouping. */
function markedMerchantCharges(rows: FlaggedTxn[], merchantMark: Map<string, MerchantMark>): Map<string, FlaggedTxn[]> {
  const byMerchant = new Map<string, FlaggedTxn[]>();
  for (const r of rows) {
    if (!isClassifiableExpense(r)) continue;
    const mk = merchantKey(r.description, r.memo);
    const mark = merchantMark.get(mk);
    if (mark !== 'subscription' && mark !== 'fixed') continue;
    const g = byMerchant.get(mk);
    if (g) g.push(r); else byMerchant.set(mk, [r]);
  }
  return byMerchant;
}

/** Anchors to CREATE for merchants that were marked before anchoring existed: the most recent SETTLED
 *  month's total (a whole month's real cost, so a two-charge upgrade month reads as one figure).
 *  Idempotent — skips any merchant that already has an anchor. */
export function anchorsToBackfill(
  rows: FlaggedTxn[],
  merchantMark: Map<string, MerchantMark>,
  existing: Set<string>,
  today: string,
): { merchant: string; amount: number }[] {
  const currentMonth = today.slice(0, 7);
  const out: { merchant: string; amount: number }[] = [];
  for (const [merchant, txns] of markedMerchantCharges(rows, merchantMark)) {
    if (existing.has(merchant)) continue;
    // prefer the latest settled month; fall back to the latest month at all (a brand-new sub with
    // only the current month) so a just-marked merchant still gets a sensible anchor.
    let byMonth = monthlyTotals(txns, currentMonth);
    if (byMonth.size === 0) byMonth = monthlyTotals(txns, null);
    if (byMonth.size === 0) continue;
    const latestMonth = [...byMonth.keys()].sort().at(-1)!;
    out.push({ merchant, amount: Math.round(byMonth.get(latestMonth)!) });
  }
  return out;
}

export interface PriceChange {
  merchant: string;
  name: string;
  expected: number; // the user's anchor (magnitude)
  latest: number;   // the latest settled month's total (magnitude)
  month: string;    // YYYY-MM of that month
}

/** Subscriptions whose latest SETTLED month deviates from the user's anchor by a MEANINGFUL amount
 *  (≥15% AND ≥₪15 — a tier change fires, an FX/rounding wiggle stays quiet), excluding an amount the
 *  user already dismissed. Per calendar month, so a two-charge upgrade month that still totals the
 *  anchor does NOT false-alarm. One row per merchant — the "pop a message when it changed" half. */
export function subscriptionPriceChanges(input: {
  rows: FlaggedTxn[];
  merchantMark: Map<string, MerchantMark>;
  expected: ExpectedRow[];
  today: string;
}): PriceChange[] {
  const { rows, merchantMark, expected, today } = input;
  const currentMonth = today.slice(0, 7);
  const anchorOf = new Map(expected.map((e) => [e.merchant, e]));
  const out: PriceChange[] = [];
  for (const [merchant, txns] of markedMerchantCharges(rows, merchantMark)) {
    const anchor = anchorOf.get(merchant);
    if (!anchor) continue;
    const byMonth = monthlyTotals(txns, currentMonth);
    if (byMonth.size === 0) continue;
    const latestMonth = [...byMonth.keys()].sort().at(-1)!;
    const latest = Math.round(byMonth.get(latestMonth)!);
    const tol = Math.max(anchor.amount * 0.15, 15);
    if (Math.abs(latest - anchor.amount) <= tol) continue;
    if (anchor.alertedAmount !== null && Math.abs(latest - anchor.alertedAmount) <= 1) continue;
    const newest = [...txns].sort((a, b) => b.date.localeCompare(a.date))[0];
    out.push({ merchant, name: merchantLabel(newest.description, newest.memo), expected: Math.round(anchor.amount), latest, month: latestMonth });
  }
  return out;
}

/* ——— open installment plans (תשלומים): finite debt with a known end, surfaced for cash-flow ——— */

export interface InstallmentPlan {
  merchant: string;
  name: string;              // display name (latest description)
  category: string | null;
  paid: number;              // slices already charged (k)
  total: number;             // plan length (N)
  remaining: number;         // slices left (N − k)
  sliceAmount: number;       // positive magnitude of one monthly slice
  remainingAmount: number;   // positive magnitude still owed = remaining × slice
  nextDate: string;          // next slice, local YYYY-MM-DD
  endDate: string | null;    // the month the final slice lands — when this frees up
}

/** The user's OPEN installment plans — financed purchases (תשלומים) with slices left to pay. Sourced
 *  from the detected recurring set, which ALREADY models installment plans + end dates: this surfaces
 *  the "how many / how much is left, and when does it free up" the engine already computes, no new
 *  detection. Sorted by soonest to finish (the next relief), then by size. */
export function activeInstallmentPlans(recurring: RecurringItem[]): InstallmentPlan[] {
  const out: InstallmentPlan[] = [];
  for (const i of recurring) {
    if (!i.installmentPlan || !i.active || i.kind !== 'expense') continue;
    const total = i.installmentsTotal ?? 0;
    const paid = i.installmentsPaid ?? 0;
    const remaining = Math.max(0, total - paid);
    if (remaining <= 0 || total <= 0) continue; // a finished plan is not "open"
    const slice = Math.abs(i.amount);
    out.push({
      merchant: i.merchant,
      name: i.sampleDescription,
      category: i.category,
      paid, total, remaining,
      sliceAmount: Math.round(slice),
      remainingAmount: Math.round(slice * remaining),
      nextDate: i.nextDate,
      endDate: i.endDate,
    });
  }
  out.sort((a, b) => (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999') || b.remainingAmount - a.remainingAmount);
  return out;
}
