import { merchantKey, merchantLabel, normalizePattern } from './categories.js';
import { companyKind, settlementCompany, type ExcludeReason, type FlaggedTxn } from './companies.js';

/** Rhythms we can recognize. Bimonthly exists for ארנונה; yearly for insurance/fees —
 *  the classic forecast killers when they were smeared into "daily variable spend". */
export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'yearly';

/** A detected recurring money movement (salary, rent, standing order, subscription, settlement). */
export interface RecurringItem {
  merchant: string; // normalized grouping key
  sampleDescription: string; // most recent raw description
  company: string;
  connectionId: number;
  category: string | null; // category of the most recent occurrence
  amount: number; // median signed amount
  lastAmount: number; // most recent signed amount — stable items forecast with it (price hikes propagate immediately)
  amountStable: boolean; // all occurrences within ±15% of the median
  /** Signed extremes over the recent (≤6) occurrences — the forecast band takes unstable
   *  streams to the edges actually seen lately, not to an invented ±%. */
  amountMin: number;
  amountMax: number;
  cadence: Cadence;
  intervalDays: number; // median gap between occurrences
  monthlyAmount: number; // signed per-month equivalent, for income ratios and metrics
  dayOfMonth: number; // median day of month (Israel local)
  occurrences: number;
  firstDate: string; // local YYYY-MM-DD
  lastDate: string; // local YYYY-MM-DD
  nextDate: string; // projected next occurrence, local YYYY-MM-DD
  kind: 'income' | 'expense';
  /** True when the occurrences are excluded flows (card settlements / internal transfers).
   *  Excluded-flow items are real bank cash movements (forecast cares) but not "spending". */
  excludedFlow: boolean;
  /** Dominant excludeReason across the occurrences, or null. excludedFlow says "not spending";
   *  this says WHICH kind — only 'settlement' streams are card debits the pulse may project. */
  excludeReason: ExcludeReason | null;
  /** Two occurrences only — an emerging pattern shown with a tag, not yet a confirmed habit. */
  provisional: boolean;
  /** Provisional items enter the forecast only when the amounts are identical to the agora. */
  forecastEligible: boolean;
  /** False when the stream looks discontinued: last occurrence older than ~1.5 cadences, or an
   *  installment plan that delivered its final slice. Inactive items are HISTORY — they stay
   *  listed so the user can see/manage them, but no present-tense engine (metrics, plan,
   *  forecast) may count them as a current commitment. */
  active: boolean;
  /** The occurrences are slices of one financed purchase (תשלומים) — debt with a known end,
   *  not an open-ended subscription. */
  installmentPlan: boolean;
  /** Expected date of the final occurrence for finite plans; null = open-ended. */
  endDate: string | null;
  /** For an installment plan: slices already charged (k) and plan length (N), from the latest slice —
   *  the raw material for "נשארו N−k תשלומים" and the ₪ still owed. Absent when not a plan. */
  installmentsPaid?: number | null;
  installmentsTotal?: number | null;
}

function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `months` ahead of `date`, landing on `day` (clamped to the target month's length).
 *  This is how month-anchored flows project — a salary on the 1st stays on the 1st,
 *  instead of drifting backwards with fixed +30-day hops. */
export function addMonthsClamped(date: string, months: number, day: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(day, daysInMonth);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

/** Gap bands per cadence. months > 0 → the flow is month-anchored (projected by day-of-month);
 *  months = 0 → day-interval anchored. */
const CADENCE_BANDS: { id: Cadence; min: number; max: number; months: number }[] = [
  { id: 'weekly', min: 6, max: 8, months: 0 },
  { id: 'biweekly', min: 12, max: 16, months: 0 },
  { id: 'monthly', min: 25, max: 35, months: 1 },
  { id: 'bimonthly', min: 55, max: 65, months: 2 },
  { id: 'yearly', min: 330, max: 400, months: 12 },
];

export const CADENCE_MONTHS: Record<Cadence, number> = {
  weekly: 0, biweekly: 0, monthly: 1, bimonthly: 2, yearly: 12,
};

export const CADENCE_NAME_HE: Record<Cadence, string> = {
  weekly: 'שבועי', biweekly: 'דו-שבועי', monthly: 'חודשי', bimonthly: 'דו-חודשי', yearly: 'שנתי',
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A reason wins only with a strict majority of the occurrences, mirroring excludedFlow. */
function dominantReason(rows: FlaggedTxn[]): ExcludeReason | null {
  const counts = new Map<ExcludeReason, number>();
  for (const r of rows) if (r.excludeReason) counts.set(r.excludeReason, (counts.get(r.excludeReason) ?? 0) + 1);
  let best: ExcludeReason | null = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) { best = k; n = v; }
  return n > rows.length / 2 ? best : null;
}

export interface DetectOptions {
  /** Local YYYY-MM-DD. When given, a stream whose last occurrence is older than ~1.5 cadences
   *  is treated as discontinued: still listed, but never projected into the forecast.
   *  Without it a cancelled subscription (or a lost client) would drain/inflate the
   *  projected balance forever. */
  today?: string;
}

/** A card purchase that was reversed within days (same merchant, exact opposite amount).
 *  Neither side is a rhythm — and the credit side is certainly not income. */
function refundPairRows(rows: FlaggedTxn[]): Set<FlaggedTxn> {
  const paired = new Set<FlaggedTxn>();
  const byMerchant = new Map<string, FlaggedTxn[]>();
  for (const r of rows) {
    if (companyKind(r.company) !== 'card' || r.status !== 'completed' || r.amount === 0) continue;
    const m = normalizePattern(r.description);
    const g = byMerchant.get(m) ?? [];
    g.push(r);
    byMerchant.set(m, g);
  }
  for (const g of byMerchant.values()) {
    const credits = g.filter((r) => r.amount > 0);
    const debits = g.filter((r) => r.amount < 0);
    for (const credit of credits) {
      const match = debits.find(
        (d) => !paired.has(d) && Math.abs(d.amount + credit.amount) < 0.005 &&
          Math.abs(daysBetween(localDate(d.date), localDate(credit.date))) <= 7,
      );
      if (match) {
        paired.add(credit);
        paired.add(match);
      }
    }
  }
  return paired;
}

/** Month-anchored fallback for streams the gap test cannot see: merchants that hit the account
 *  several times a month around one primary date. The two big real-world cases are salaries with
 *  occasional extra payments (bonus, per-diem) and card settlements split into multiple debits —
 *  per-occurrence gaps look chaotic, but the PER-MONTH TOTAL is a steady monthly rhythm. */
function monthlyStreamItem(key: string, sorted: FlaggedTxn[], dates: string[]): RecurringItem | null {
  if (sorted.length < 3) return null;
  const byMonth = new Map<string, { total: number; primary: FlaggedTxn; primaryDay: number }>();
  for (let i = 0; i < sorted.length; i++) {
    const m = dates[i].slice(0, 7);
    const day = Number(dates[i].slice(8, 10));
    const b = byMonth.get(m);
    if (!b) byMonth.set(m, { total: sorted[i].amount, primary: sorted[i], primaryDay: day });
    else {
      b.total += sorted[i].amount;
      if (Math.abs(sorted[i].amount) > Math.abs(b.primary.amount)) {
        b.primary = sorted[i];
        b.primaryDay = day;
      }
    }
  }
  if (byMonth.size < 3) return null;
  const monthKeys = [...byMonth.keys()].sort();
  const idx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  const span = idx(monthKeys[monthKeys.length - 1]) - idx(monthKeys[0]) + 1;
  if (byMonth.size < Math.ceil((span * 2) / 3)) return null;
  // the primary hit must keep a steady day of month — that is what separates a salary/settlement
  // from a supermarket someone happens to visit every month on random days
  const primaryDays = [...byMonth.values()].map((b) => b.primaryDay);
  const medDay = median(primaryDays);
  const nearDay = primaryDays.filter((d) => Math.abs(d - medDay) <= 3).length;
  if (nearDay < Math.ceil((primaryDays.length * 3) / 4)) return null;

  const totals = [...byMonth.values()].map((b) => round2(b.total));
  const med = median(totals);
  if (med === 0) return null;
  const stable = totals.every((a) => Math.abs(a - med) <= Math.abs(med) * 0.15);
  const recentTotals = totals.slice(-6);
  const last = sorted[sorted.length - 1];
  const excludedCount = sorted.filter((r) => r.excluded).length;
  const dayOfMonth = Math.round(medDay);
  const inst = installmentInfo(sorted, dayOfMonth);
  return {
    merchant: key.slice(0, -2),
    sampleDescription: merchantLabel(last.description, last.memo),
    company: last.company,
    connectionId: last.connectionId,
    category: last.category,
    amount: round2(med),
    lastAmount: round2(totals[totals.length - 1]),
    amountStable: stable,
    amountMin: round2(Math.min(...recentTotals)),
    amountMax: round2(Math.max(...recentTotals)),
    cadence: 'monthly',
    intervalDays: 30,
    monthlyAmount: round2(med),
    dayOfMonth,
    occurrences: sorted.length,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    nextDate: addMonthsClamped(dates[dates.length - 1], 1, dayOfMonth),
    kind: med > 0 ? 'income' : 'expense',
    excludedFlow: excludedCount > sorted.length / 2,
    excludeReason: dominantReason(sorted),
    provisional: false,
    forecastEligible: true,
    active: true,
    installmentPlan: inst.plan,
    endDate: inst.endDate,
    installmentsPaid: inst.paid,
    installmentsTotal: inst.total,
  };
}

/** Installment purchases (תשלומים) are finite by construction — the rows literally say
 *  "slice k of n". A finished plan must die the day its last slice lands, not linger
 *  through the recency grace period looking like a live subscription. */
function installmentInfo(sorted: FlaggedTxn[], dayOfMonth: number): { plan: boolean; endDate: string | null; paid: number | null; total: number | null } {
  const slices = sorted.filter(
    (r) => r.type === 'installments' && r.installmentNumber !== null && r.installmentTotal !== null,
  );
  if (slices.length <= sorted.length / 2) return { plan: false, endDate: null, paid: null, total: null };
  const latest = slices[slices.length - 1];
  const paid = latest.installmentNumber ?? null;
  const total = latest.installmentTotal ?? null;
  const remaining = Math.max(0, (total ?? 0) - (paid ?? 0));
  const lastSliceDate = localDate(latest.date);
  return {
    plan: true,
    endDate: remaining === 0 ? lastSliceDate : addMonthsClamped(lastSliceDate, remaining, dayOfMonth),
    paid,
    total,
  };
}

/** True while the stream is still alive: the last occurrence is at most ~1.5 cadences old
 *  and a finite plan has slices left to deliver. */
function isActive(item: RecurringItem, today: string | undefined): boolean {
  if (item.endDate !== null && item.nextDate > item.endDate) return false; // final slice delivered
  if (!today) return true;
  const months = CADENCE_MONTHS[item.cadence];
  const graceDays = months > 0 ? months * 45 : Math.max(10, Math.round(item.intervalDays * 1.5));
  return addDays(item.lastDate, graceDays) >= today;
}

/** Stamps liveness once, in one place — every detection path must exit through here. */
function finalize(item: RecurringItem, today: string | undefined): RecurringItem {
  item.active = isActive(item, today);
  item.forecastEligible = item.forecastEligible && item.active;
  return item;
}

/** Detects recurring transactions by normalized merchant across five cadences.
 *  Confirmed: ≥3 occurrences with ≥⅔ of the gaps inside one cadence band
 *  (yearly: ≥2 occurrences with a stable amount — three years of data is a luxury).
 *  Emerging ('provisional'): exactly 2 occurrences a monthly gap apart — shown with a tag,
 *  and trusted by the forecast only when the two amounts are identical.
 *  Merchants that fail the gap test fall back to per-month-total detection (salaries with
 *  extra payments, settlements split into several debits). */
export function detectRecurring(rows: FlaggedTxn[], options: DetectOptions = {}): RecurringItem[] {
  const refunds = refundPairRows(rows);
  const groups = new Map<string, FlaggedTxn[]>();
  for (const r of rows) {
    if (r.status !== 'completed' || r.amount === 0) continue;
    // next-cycle card rows are delivered in advance — they have not happened yet, and counting
    // them shifts lastDate/nextDate a full cadence forward, skipping the genuine next occurrence
    if (r.excludeReason === 'future') continue;
    if (refunds.has(r)) continue;
    const merchant = merchantKey(r.description, r.memo);
    if (merchant.length < 2) continue;
    // income and expense streams of the same merchant are separate rhythms
    const key = `${merchant}|${r.amount > 0 ? '+' : '-'}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }

  const items: RecurringItem[] = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    const dates = sorted.map((r) => localDate(r.date));

    // bank-side card settlements are monthly BY NATURE — Israeli cards debit per monthly cycle,
    // sometimes split into several debits (an interest-free split, a second physical card). Gap
    // analysis over the split debits reads as weekly/noise; the month total is the real rhythm.
    const isSettlementStream =
      companyKind(sorted[0].company) === 'bank' && settlementCompany(sorted[0].description) !== null;
    if (isSettlementStream) {
      const stream = monthlyStreamItem(key, sorted, dates);
      if (stream) {
        items.push(finalize(stream, options.today));
        continue;
      }
      // not enough settled months yet — let the ordinary gap path try (2-month provisional)
    }

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));

    // best-fitting cadence: the band holding the most gaps, requiring a ⅔ majority
    let best: { band: (typeof CADENCE_BANDS)[number]; matching: number[] } | null = null;
    for (const band of CADENCE_BANDS) {
      const matching = gaps.filter((d) => d >= band.min && d <= band.max);
      if (matching.length === 0 || matching.length < Math.ceil((gaps.length * 2) / 3)) continue;
      if (!best || matching.length > best.matching.length) best = { band, matching };
    }
    if (!best) {
      const fallback = monthlyStreamItem(key, sorted, dates);
      if (fallback) items.push(finalize(fallback, options.today));
      continue;
    }

    const amounts = sorted.map((r) => r.amount);
    const med = median(amounts);
    if (med === 0) continue;
    const stable = amounts.every((a) => Math.abs(a - med) <= Math.abs(med) * 0.15);
    const recentAmounts = amounts.slice(-6);

    // confidence tiers: 2 occurrences make an emerging monthly pattern (a new subscription
    // should surface after two charges, not three months in); a week apart happens by chance,
    // so other short cadences still demand 3. Yearly is confirmed at 2 — but only stable.
    const provisional = sorted.length === 2 && best.band.id === 'monthly';
    if (sorted.length === 2 && best.band.id !== 'monthly' && best.band.id !== 'yearly') continue;
    if (best.band.id === 'yearly' && !stable) continue;

    const last = sorted[sorted.length - 1];
    const excludedCount = sorted.filter((r) => r.excluded).length;
    const intervalDays = Math.round(median(best.matching));
    const dayOfMonth = Math.round(median(dates.map((d) => Number(d.slice(8, 10)))));
    const months = best.band.months;
    const amountsIdentical = amounts.every((a) => Math.abs(a - amounts[0]) < 0.005);
    const inst = installmentInfo(sorted, dayOfMonth);

    const item: RecurringItem = {
      merchant: key.slice(0, -2),
      sampleDescription: merchantLabel(last.description, last.memo),
      company: last.company,
      connectionId: last.connectionId,
      category: last.category,
      amount: round2(med),
      lastAmount: round2(last.amount),
      amountStable: stable,
      amountMin: round2(Math.min(...recentAmounts)),
      amountMax: round2(Math.max(...recentAmounts)),
      cadence: best.band.id,
      intervalDays,
      monthlyAmount: round2(months > 0 ? med / months : med * (30 / intervalDays)),
      dayOfMonth,
      occurrences: sorted.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      nextDate: months > 0
        ? addMonthsClamped(dates[dates.length - 1], months, dayOfMonth)
        : addDays(dates[dates.length - 1], intervalDays),
      kind: med > 0 ? 'income' : 'expense',
      excludedFlow: excludedCount > sorted.length / 2,
      excludeReason: dominantReason(sorted),
      provisional,
      forecastEligible: !provisional || amountsIdentical,
      active: true,
      installmentPlan: inst.plan,
      endDate: inst.endDate,
      installmentsPaid: inst.paid,
      installmentsTotal: inst.total,
    };
    items.push(finalize(item, options.today));
  }
  return items.sort((a, b) => Math.abs(b.monthlyAmount) - Math.abs(a.monthlyAmount));
}

/** Bank-side recurring cash flows for balance forecasting:
 *  includes settlement debits (real cash-out) but not internal transfers (net zero across own banks). */
export function bankCashFlows(items: RecurringItem[], rows: FlaggedTxn[]): RecurringItem[] {
  const transferMerchants = new Set(
    rows.filter((r) => r.excludeReason === 'transfer').map((r) => merchantKey(r.description, r.memo)),
  );
  return items.filter((i) => companyKind(i.company) === 'bank' && !transferMerchants.has(i.merchant));
}
