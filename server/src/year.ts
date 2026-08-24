/**
 * שכבת השנה — the annual statement.
 *
 * The app already answers "how is the month" and "how am I in general"; this module answers
 * the December question — "כמה עלתה לנו השנה?" — over the 12 flow months of a calendar year.
 *
 * Honesty rule for year-over-year: a year in progress is never compared against a full
 * previous year. Every comparison — totals and categories alike — runs over the SAME month
 * numbers that hold data in BOTH years, and says how many months that is.
 */

import type { FlaggedTxn } from './companies.js';
import { merchantKey, merchantLabel, normalizePattern } from './categories.js';
import { deriveMerchantMarks, isClassifiableExpense, type TxnMarkValue } from './subscriptions.js';

export interface YearMonthRow {
  month: string; // 'YYYY-MM'
  income: number;
  expenses: number; // positive magnitude
  net: number;
  hasData: boolean;
  /** The running flow month — its figures are real but the month is not finished. */
  partial: boolean;
}

export interface YearCategoryRow {
  category: string;
  /** Full-year total (positive magnitude). */
  total: number;
  /** 12 slots, January..December of the flow year. */
  byMonth: number[];
  /** Δ% vs the previous year over the shared months, or null when there is no honest base. */
  deltaPct: number | null;
}

export interface YearBigExpense {
  key: string;
  date: string;
  description: string;
  amount: number; // positive magnitude
  category: string | null;
  /** >1 when this is a financed purchase aggregated from its installment charges this year. */
  installments: number;
}

export interface YearReport {
  year: string;
  months: YearMonthRow[];
  totals: { income: number; expenses: number; net: number };
  monthsWithData: number;
  /** The honest YoY frame: both years summed over the same month numbers. null = no overlap. */
  sameMonths: {
    count: number;
    prevYear: string;
    prev: { income: number; expenses: number; net: number };
    current: { income: number; expenses: number; net: number };
  } | null;
  byCategory: YearCategoryRow[];
  topMerchants: RankedMerchant[];
  biggest: YearBigExpense[];
  fees: number;
  /** Every year that holds completed data, newest first — the picker. */
  years: string[];
}

/** One plotted point of a category's history — a whole calendar month, shaped like the merchant
 *  popup's charge so the very same chart component draws both. `date` is the month's first day. */
export interface CategoryMonthPoint {
  date: string;   // YYYY-MM-01
  month: string;  // YYYY-MM
  amount: number; // positive magnitude
}

/** The full spending history of ONE category — the raw material for the "היסטוריית התשלומים" popup.
 *  Over ALL stored months, not the selected year: the question is how this category behaves over
 *  time, and a single year is too short a window to answer it. */
export interface CategoryHistory {
  category: string;
  /** Oldest → newest, ZERO-FILLED across the gaps: a month with no spending is information. */
  charges: CategoryMonthPoint[];
  count: number;       // months plotted — the chart's readout counts months, not charges
  chargeCount: number; // the individual charges behind them
  typicalAmount: number; // the median month
  minAmount: number;
  maxAmount: number;
  totalAmount: number;
  varied: boolean;
  firstMonth: string;
  lastMonth: string;
  topMerchants: RankedMerchant[];
}

/**
 * Expense rows → the merchants behind them, biggest first.
 *
 * Keyed by `merchantKey`, the SAME identity the merchant history popup takes — a ranking whose key
 * the popup cannot resolve is a list of doors that open onto 404.
 */
function rankMerchants(
  rows: FlaggedTxn[],
  txnMarks: { key: string; mark: TxnMarkValue }[],
  allRows: FlaggedTxn[],
  limit: number,
): RankedMerchant[] {
  const marks = deriveMerchantMarks(txnMarks, allRows);
  const agg = new Map<string, { name: string; total: number; count: number; category: string | null; last: string; drillable: boolean }>();
  for (const r of rows) {
    const key = merchantKey(r.description, r.memo);
    const acc = agg.get(key) ?? { name: merchantLabel(r.description, r.memo), total: 0, count: 0, category: null, last: '', drillable: false };
    acc.total += -r.amount;
    acc.count += 1;
    if (r.date >= acc.last) { acc.last = r.date; acc.category = r.category ?? null; }
    if (isClassifiableExpense(r)) acc.drillable = true;
    agg.set(key, acc);
  }
  return [...agg.entries()]
    .map(([merchant, a]) => ({
      merchant,
      name: a.name,
      total: round2(a.total),
      count: a.count,
      category: a.category,
      mark: marks.get(merchant) ?? null,
      drillable: a.drillable,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

export interface RankedMerchant {
  merchant: string; // the normalized key — what /merchant-history expects
  name: string;
  total: number;
  count: number;
  /** The category of its most recent charge — what paints the bar. */
  category: string | null;
  mark: TxnMarkValue | null;
  /** The merchant popup reads only classifiable charges; without one it would 404, so the
   *  drill-through button is offered only where it can actually land. */
  drillable: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 'YYYY-MM' + 1, without touching Date — a month string is a calendar fact, not an instant. */
function nextMonth(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * One category's month-by-month spending across every stored month.
 *
 * Counted with `countable` — exactly the filter the year card's category totals use. The popup
 * explains a number on that card, so any other filter here would make the bars disagree with the
 * row that opened them.
 */
export function computeCategoryHistory(
  rows: FlaggedTxn[],
  category: string,
  txnMarks: { key: string; mark: TxnMarkValue }[],
): CategoryHistory | null {
  const all = countable(rows).filter((r) => r.amount < 0 && (r.category ?? 'other') === category);
  if (all.length === 0) return null;

  const byMonth = new Map<string, number>();
  for (const r of all) byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + -r.amount);
  const keys = [...byMonth.keys()].sort();
  const firstMonth = keys[0];
  const lastMonth = keys[keys.length - 1];

  const charges: CategoryMonthPoint[] = [];
  for (let m = firstMonth; m <= lastMonth; m = nextMonth(m)) {
    charges.push({ date: `${m}-01`, month: m, amount: round2(byMonth.get(m) ?? 0) });
  }
  const mags = charges.map((c) => c.amount);
  const typical = round2(median(mags));
  const minAmount = round2(Math.min(...mags));
  const maxAmount = round2(Math.max(...mags));

  return {
    category,
    charges,
    count: charges.length,
    chargeCount: all.length,
    typicalAmount: typical,
    minAmount,
    maxAmount,
    totalAmount: round2(mags.reduce((a, b) => a + b, 0)),
    // a month-to-month swing worth naming, on the same rule the merchant popup uses
    varied: maxAmount - minAmount > Math.max(10, typical * 0.1),
    firstMonth,
    lastMonth,
    topMerchants: rankMerchants(all, txnMarks, rows, 8),
  };
}

const MONTH_KEYS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** Completed, non-excluded rows only — the same filter every summary in the app applies. */
function countable(rows: FlaggedTxn[]): FlaggedTxn[] {
  return rows.filter((r) => r.status === 'completed' && !r.excluded);
}

export function computeYear(
  rows: FlaggedTxn[],
  year: string,
  currentMonth: string,
  txnMarks: { key: string; mark: TxnMarkValue }[] = [],
): YearReport {
  const all = countable(rows);
  const years = [...new Set(all.map((r) => r.month.slice(0, 4)))].sort().reverse();

  const inYear = all.filter((r) => r.month.slice(0, 4) === year);
  const prevYear = String(Number(year) - 1);
  const inPrev = all.filter((r) => r.month.slice(0, 4) === prevYear);

  // ── the 12 months ──────────────────────────────────────────────────────────────────────
  const monthAgg = new Map<string, { income: number; expenses: number }>();
  for (const r of inYear) {
    const acc = monthAgg.get(r.month) ?? { income: 0, expenses: 0 };
    if (r.amount >= 0) acc.income += r.amount;
    else acc.expenses += -r.amount;
    monthAgg.set(r.month, acc);
  }
  const months: YearMonthRow[] = MONTH_KEYS.map((mm) => {
    const m = `${year}-${mm}`;
    const a = monthAgg.get(m);
    return {
      month: m,
      income: round2(a?.income ?? 0),
      expenses: round2(a?.expenses ?? 0),
      net: round2((a?.income ?? 0) - (a?.expenses ?? 0)),
      hasData: !!a,
      partial: m === currentMonth,
    };
  });
  const withData = months.filter((m) => m.hasData);
  const totals = {
    income: round2(withData.reduce((s, m) => s + m.income, 0)),
    expenses: round2(withData.reduce((s, m) => s + m.expenses, 0)),
    net: round2(withData.reduce((s, m) => s + m.net, 0)),
  };

  // ── the honest YoY frame: same month numbers in both years ─────────────────────────────
  const prevMonthsWithData = new Set(inPrev.map((r) => r.month.slice(5)));
  const shared = MONTH_KEYS.filter((mm) => monthAgg.has(`${year}-${mm}`) && prevMonthsWithData.has(mm));
  let sameMonths: YearReport['sameMonths'] = null;
  if (shared.length > 0) {
    const sumOver = (list: FlaggedTxn[], y: string) => {
      const set = new Set(shared.map((mm) => `${y}-${mm}`));
      const picked = list.filter((r) => set.has(r.month));
      const income = round2(picked.filter((r) => r.amount >= 0).reduce((s, r) => s + r.amount, 0));
      const expenses = round2(picked.filter((r) => r.amount < 0).reduce((s, r) => s + -r.amount, 0));
      return { income, expenses, net: round2(income - expenses) };
    };
    sameMonths = {
      count: shared.length,
      prevYear,
      prev: sumOver(inPrev, prevYear),
      current: sumOver(inYear, year),
    };
  }

  // ── categories: full-year totals + monthly shape + honest delta ────────────────────────
  const catAgg = new Map<string, { total: number; byMonth: number[]; sharedTotal: number }>();
  const sharedSet = new Set(shared.map((mm) => `${year}-${mm}`));
  for (const r of inYear) {
    if (r.amount >= 0) continue;
    const cat = r.category ?? 'other';
    const acc = catAgg.get(cat) ?? { total: 0, byMonth: Array(12).fill(0), sharedTotal: 0 };
    const idx = Number(r.month.slice(5)) - 1;
    acc.total += -r.amount;
    acc.byMonth[idx] += -r.amount;
    if (sharedSet.has(r.month)) acc.sharedTotal += -r.amount;
    catAgg.set(cat, acc);
  }
  const prevCatShared = new Map<string, number>();
  if (shared.length > 0) {
    const prevSharedSet = new Set(shared.map((mm) => `${prevYear}-${mm}`));
    for (const r of inPrev) {
      if (r.amount >= 0 || !prevSharedSet.has(r.month)) continue;
      const cat = r.category ?? 'other';
      prevCatShared.set(cat, (prevCatShared.get(cat) ?? 0) + -r.amount);
    }
  }
  const byCategory: YearCategoryRow[] = [...catAgg.entries()]
    .map(([category, a]) => {
      const prev = prevCatShared.get(category) ?? 0;
      // an honest percentage needs a real base — tiny prev totals produce clown numbers
      const deltaPct = shared.length > 0 && prev >= 100
        ? Math.round(((a.sharedTotal - prev) / prev) * 100)
        : null;
      return { category, total: round2(a.total), byMonth: a.byMonth.map(round2), deltaPct };
    })
    .sort((a, b) => b.total - a.total);

  // ── merchants of the year ──────────────────────────────────────────────────────────────
  const topMerchants = rankMerchants(inYear.filter((r) => r.amount < 0), txnMarks, rows, 8);

  // ── the big expenses: single charges as-is; a financed purchase re-assembled from its
  //    installment slices, so it competes as the purchase it was, not as twelve small rows ──
  const singles: YearBigExpense[] = [];
  const plans = new Map<string, { key: string; date: string; description: string; amount: number; category: string | null; installments: number }>();
  for (const r of inYear) {
    if (r.amount >= 0) continue;
    if (r.type === 'installments') {
      const k = normalizePattern(r.description) || r.description;
      const acc = plans.get(k);
      if (acc) {
        acc.amount += -r.amount;
        acc.installments += 1;
        if (r.date < acc.date) acc.date = r.date;
      } else {
        plans.set(k, { key: r.key, date: r.date, description: r.description, amount: -r.amount, category: r.category ?? null, installments: 1 });
      }
    } else {
      singles.push({ key: r.key, date: r.date, description: r.description, amount: -r.amount, category: r.category ?? null, installments: 1 });
    }
  }
  const biggest = [...singles, ...[...plans.values()].map((p) => ({ ...p, amount: p.amount }))]
    .map((e) => ({ ...e, amount: round2(e.amount) }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  const fees = round2(inYear.filter((r) => r.category === 'fees' && r.amount < 0).reduce((s, r) => s + -r.amount, 0));

  return {
    year,
    months,
    totals,
    monthsWithData: withData.length,
    sameMonths,
    byCategory,
    topMerchants,
    biggest,
    fees,
    years,
  };
}
