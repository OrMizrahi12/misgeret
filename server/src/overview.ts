import type { DayBalance } from './balance-history.js';
import { monthsBack } from './flow.js';
import type { CategoryExpense, MonthlySummary } from './txns.js';

type SummaryWithCategories = MonthlySummary & { byCategory: CategoryExpense[] };

/**
 * "איך אני בכללי?" — the longitudinal conduct view (spec: docs/2026-07-16-overview-tab-spec.md).
 *
 * Everything here is a per-month series plus window aggregates, and the one hard rule the
 * research kept shouting: THE PARTIAL CURRENT MONTH NEVER ENTERS AN AVERAGE. It rides along
 * in the series marked `partial` so charts can draw it faded, and stops there.
 *
 * The three quantities of a behavior view: direction (deltas vs the previous equal window),
 * consistency (green-month share, streaks), and the series themselves.
 */

/** Bank of Israel average household overdraft rate, Nov 2024 — the default the UI names. */
export const DEFAULT_OVERDRAFT_ANNUAL_RATE = 0.127;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface OverviewMonthRow {
  month: string;
  income: number;
  expenses: number;
  net: number;
  /** net/income, null when the month saw no income. */
  savingsRate: number | null;
  /** null = the daily balance series does not cover this month. */
  minusDays: number | null;
  /** The most negative EOD balance of the month; null when never negative or not covered. */
  minDepth: number | null;
  /** Composition of the month's expenses + envelope savings. */
  fixed: number;
  variable: number;
  partial: boolean;
}

export interface OverviewKpi {
  value: number | null;
  /** vs the previous equal-length window; null when there is no previous data. */
  delta: number | null;
}

export interface OverviewResponse {
  monthsRequested: number;
  anchorDay: number;
  /** Oldest → newest, complete months first, then the running month marked partial. */
  series: OverviewMonthRow[];
  /** How many COMPLETE months actually back the aggregates. */
  completeMonths: number;
  verdict: { avgNet: number; prevAvgNet: number | null };
  kpis: {
    avgIncome: OverviewKpi;
    avgExpenses: OverviewKpi;
    avgNet: OverviewKpi;
    /** 0..1; delta in rate points. */
    savingsRate: OverviewKpi;
  };
  streaks: {
    greenMonths: number;
    currentPlusStreak: number;
    best: { month: string; net: number } | null;
    worst: { month: string; net: number } | null;
  };
  minus: {
    /** false = no daily balance data inside the window; the whole section stays silent. */
    covered: boolean;
    totalDays: number;
    monthsClean: number;
    monthsCovered: number;
    /** Estimated interest paid on negative days across the window, at `rate`. */
    interestCost: number;
    rate: number;
    maxDepth: { month: string; amount: number } | null;
    /** |maxDepth| / overdraft limit, 0..∞, null when no limit is set or never negative. */
    worstUtilization: number | null;
    /** Days since the last negative EOD over ALL held history; null = never negative. */
    cleanDays: number | null;
    neverMinus: boolean;
  };
}

export interface OverviewInputs {
  monthsRequested: number;
  /** The running (partial) flow month. */
  currentMonth: string;
  anchorDay: number;
  /** The salary-aware calendar's bucketing — the same one that produced `summaries`. */
  monthOf: (iso: string) => string;
  /** Over ALL held data, any order, byCategory populated. */
  summaries: SummaryWithCategories[];
  /** Full daily EOD series, oldest→newest (may be empty). */
  daily: DayBalance[];
  /** Flow month → net envelope deposits that month. */
  /** Flow month → magnitude of expenses on recurring (fixed) merchants. */
  fixedByMonth: Record<string, number>;
  overdraftLimit: number;
  annualOverdraftRate?: number;
}

export function computeOverview(inputs: OverviewInputs): OverviewResponse {
  const {
    monthsRequested, currentMonth, anchorDay, monthOf, summaries, daily,
    fixedByMonth, overdraftLimit,
  } = inputs;
  const rate = inputs.annualOverdraftRate ?? DEFAULT_OVERDRAFT_ANNUAL_RATE;

  const byMonth = new Map(summaries.map((s) => [s.month, s]));
  const dataMonths = summaries.map((s) => s.month).filter((m) => m < currentMonth).sort();
  const earliest = dataMonths[0] ?? null;

  // the window: the last N COMPLETE months, clipped to where data actually begins
  const windowMonths: string[] = [];
  if (earliest) {
    for (let n = monthsRequested; n >= 1; n--) {
      const m = monthsBack(currentMonth, n);
      if (m >= earliest) windowMonths.push(m);
    }
  }

  // daily balances grouped by flow month, once
  const minusByMonth = new Map<string, { days: number; covered: boolean; minDepth: number | null; interest: number }>();
  for (const d of daily) {
    const m = monthOf(d.date);
    const acc = minusByMonth.get(m) ?? { days: 0, covered: true, minDepth: null, interest: 0 };
    if (d.balance < 0) {
      acc.days += 1;
      acc.interest += -d.balance * (rate / 365);
      acc.minDepth = acc.minDepth === null ? d.balance : Math.min(acc.minDepth, d.balance);
    }
    minusByMonth.set(m, acc);
  }

  const rowFor = (m: string, partial: boolean): OverviewMonthRow => {
    const s = byMonth.get(m);
    const income = round2(s?.income ?? 0);
    const expenses = round2(s?.expenses ?? 0);
    const net = round2(s?.net ?? 0);
    const minus = minusByMonth.get(m);
    const fixed = Math.min(round2(fixedByMonth[m] ?? 0), expenses);
    return {
      month: m,
      income,
      expenses,
      net,
      savingsRate: income >= 1 ? round2(net / income) : null,
      minusDays: minus ? minus.days : null,
      minDepth: minus?.minDepth ?? null,
      fixed,
      variable: round2(Math.max(0, expenses - fixed)),
      partial,
    };
  };

  const complete = windowMonths.map((m) => rowFor(m, false));
  const series = [...complete, rowFor(currentMonth, true)];

  // ── aggregates over complete months only ────────────────────────────────────────────
  const K = complete.length;
  const sum = (f: (r: OverviewMonthRow) => number) => complete.reduce((s, r) => s + f(r), 0);
  const avg = (f: (r: OverviewMonthRow) => number) => (K > 0 ? round2(sum(f) / K) : 0);
  const totalIncome = sum((r) => r.income);
  const savingsRate = totalIncome >= 1 ? round2(sum((r) => r.net) / totalIncome) : null;

  // the previous equal-length window, for deltas — only months that actually have data
  const prevMonths: string[] = [];
  if (earliest && windowMonths.length > 0) {
    for (let n = 1; n <= K; n++) {
      const m = monthsBack(windowMonths[0], n);
      if (m >= earliest) prevMonths.push(m);
    }
  }
  const prev = prevMonths.map((m) => rowFor(m, false));
  const P = prev.length;
  const prevAvg = (f: (r: OverviewMonthRow) => number) =>
    P >= 2 ? round2(prev.reduce((s, r) => s + f(r), 0) / P) : null;
  const prevTotalIncome = prev.reduce((s, r) => s + r.income, 0);
  const prevSavingsRate = P >= 2 && prevTotalIncome >= 1
    ? round2(prev.reduce((s, r) => s + r.net, 0) / prevTotalIncome)
    : null;

  const kpi = (value: number | null, prevValue: number | null): OverviewKpi => ({
    value,
    delta: value !== null && prevValue !== null ? round2(value - prevValue) : null,
  });

  // ── consistency ─────────────────────────────────────────────────────────────────────
  let currentPlusStreak = 0;
  for (let i = complete.length - 1; i >= 0 && complete[i].net > 0; i--) currentPlusStreak++;
  const nonEmpty = complete.filter((r) => r.income >= 1 || r.expenses >= 1);
  const best = nonEmpty.length > 0 ? nonEmpty.reduce((a, b) => (b.net > a.net ? b : a)) : null;
  const worst = nonEmpty.length > 0 ? nonEmpty.reduce((a, b) => (b.net < a.net ? b : a)) : null;

  // ── the minus profile ───────────────────────────────────────────────────────────────
  const coveredRows = complete.filter((r) => r.minusDays !== null);
  const totalMinusDays = coveredRows.reduce((s, r) => s + (r.minusDays ?? 0), 0);
  const interestCost = round2(windowMonths.reduce((s, m) => s + (minusByMonth.get(m)?.interest ?? 0), 0));
  let maxDepth: { month: string; amount: number } | null = null;
  for (const r of coveredRows) {
    if (r.minDepth !== null && (maxDepth === null || r.minDepth < maxDepth.amount)) {
      maxDepth = { month: r.month, amount: r.minDepth };
    }
  }
  let lastMinusDate: string | null = null;
  for (const d of daily) if (d.balance < 0) lastMinusDate = d.date;
  const lastDay = daily.length > 0 ? daily[daily.length - 1].date : null;
  const cleanDays = lastMinusDate && lastDay
    ? Math.max(0, Math.round((Date.parse(lastDay) - Date.parse(lastMinusDate)) / 86_400_000))
    : null;

  // The response deliberately omits unused lifestyle-creep and observation pipelines.

  return {
    monthsRequested,
    anchorDay,
    series,
    completeMonths: K,
    verdict: { avgNet: avg((r) => r.net), prevAvgNet: prevAvg((r) => r.net) },
    kpis: {
      avgIncome: kpi(K > 0 ? avg((r) => r.income) : null, prevAvg((r) => r.income)),
      avgExpenses: kpi(K > 0 ? avg((r) => r.expenses) : null, prevAvg((r) => r.expenses)),
      avgNet: kpi(K > 0 ? avg((r) => r.net) : null, prevAvg((r) => r.net)),
      savingsRate: kpi(savingsRate, prevSavingsRate),
    },
    streaks: {
      greenMonths: complete.filter((r) => r.net > 0).length,
      currentPlusStreak,
      best: best ? { month: best.month, net: best.net } : null,
      worst: worst ? { month: worst.month, net: worst.net } : null,
    },
    minus: {
      covered: coveredRows.length > 0,
      totalDays: totalMinusDays,
      monthsClean: coveredRows.filter((r) => r.minusDays === 0).length,
      monthsCovered: coveredRows.length,
      interestCost,
      rate,
      maxDepth,
      worstUtilization: maxDepth && overdraftLimit > 0 ? round2(-maxDepth.amount / overdraftLimit) : null,
      cleanDays,
      neverMinus: daily.length > 0 && lastMinusDate === null,
    },
  };
}
