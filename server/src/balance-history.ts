import type { TxnRow } from './txns.js';

export interface DayBalance {
  date: string; // local YYYY-MM-DD
  balance: number;
}

export interface BalanceStats {
  series: DayBalance[];
  minByMonth: { month: string; min: number }[]; // oldest first
  daysBelowZeroByMonth: { month: string; days: number }[];
  /** Linear-regression slope of the monthly minimum (₪ per month); negative = deteriorating trough. */
  troughSlope: number | null; // null when under 3 months
}

function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

function prevDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Reconstructs the end-of-day balance series backwards from a known latest balance:
 *  balance(end of day d−1) = balance(end of day d) − Σ txns on day d.
 *  Rows must be the completed transactions of the SAME scope the balance measures. */
export function reconstructDailyBalances(
  latestBalance: number,
  latestDate: string, // local YYYY-MM-DD the balance was observed
  rows: TxnRow[],
  fromDate: string, // local YYYY-MM-DD, inclusive
): DayBalance[] {
  const sumByDay = new Map<string, number>();
  for (const r of rows) {
    if (r.status !== 'completed') continue;
    const d = localDate(r.date);
    if (d > latestDate || d < fromDate) continue;
    sumByDay.set(d, (sumByDay.get(d) ?? 0) + r.amount);
  }
  const series: DayBalance[] = [];
  let day = latestDate;
  let bal = latestBalance;
  while (day >= fromDate) {
    series.push({ date: day, balance: round2(bal) });
    bal -= sumByDay.get(day) ?? 0;
    day = prevDay(day);
  }
  return series.reverse();
}

export function balanceStats(series: DayBalance[]): BalanceStats {
  const byMonth = new Map<string, DayBalance[]>();
  for (const d of series) {
    const m = d.date.slice(0, 7);
    const g = byMonth.get(m) ?? [];
    g.push(d);
    byMonth.set(m, g);
  }
  const months = [...byMonth.keys()].sort();
  const minByMonth = months.map((m) => ({
    month: m,
    min: Math.min(...byMonth.get(m)!.map((d) => d.balance)),
  }));
  const daysBelowZeroByMonth = months.map((m) => ({
    month: m,
    days: byMonth.get(m)!.filter((d) => d.balance < 0).length,
  }));

  let troughSlope: number | null = null;
  if (minByMonth.length >= 3) {
    const n = minByMonth.length;
    const xs = minByMonth.map((_, i) => i);
    const ys = minByMonth.map((p) => p.min);
    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    troughSlope = den === 0 ? 0 : round2(num / den);
  }
  return { series, minByMonth, daysBelowZeroByMonth, troughSlope };
}
