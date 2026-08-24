import { describe, expect, test } from 'vitest';
import { flowMonthOf } from './flow.js';
import { computeOverview, type OverviewInputs } from './overview.js';

function summary(month: string, income: number, expenses: number, byCategory: { category: string; expenses: number }[] = []) {
  return { month, income, expenses, net: income - expenses, byCategory };
}

function baseInputs(over: Partial<OverviewInputs> = {}): OverviewInputs {
  return {
    monthsRequested: 6,
    currentMonth: '2026-07',
    anchorDay: 1,
    monthOf: (iso) => flowMonthOf(iso, 1),
    summaries: [
      summary('2026-07', 5000, 3000), // partial, must stay OUT of every aggregate
      summary('2026-06', 10000, 8000),
      summary('2026-05', 10000, 9000),
      summary('2026-04', 10000, 12000), // red month
      summary('2026-03', 10000, 7000),
    ],
    daily: [],
    fixedByMonth: {},
    overdraftLimit: 0,
    ...over,
  };
}

describe('computeOverview', () => {
  test('the partial month rides in the series but never enters an aggregate', () => {
    const res = computeOverview(baseInputs());
    expect(res.series[res.series.length - 1]).toMatchObject({ month: '2026-07', partial: true });
    expect(res.completeMonths).toBe(4); // window clipped to where data begins
    // avg net over complete months only: (2000+1000-2000+3000)/4 = 1000 — the partial +2000 must not move it
    expect(res.verdict.avgNet).toBe(1000);
    expect(res.kpis.avgIncome.value).toBe(10000);
  });

  test('green months, streak, best and worst read from the complete window', () => {
    const res = computeOverview(baseInputs());
    expect(res.streaks.greenMonths).toBe(3);
    expect(res.streaks.currentPlusStreak).toBe(2); // 2026-05, 2026-06
    expect(res.streaks.best).toMatchObject({ month: '2026-03', net: 3000 });
    expect(res.streaks.worst).toMatchObject({ month: '2026-04', net: -2000 });
  });

  test('minus profile counts days, estimates interest, and tracks the clean run', () => {
    const res = computeOverview(baseInputs({
      overdraftLimit: 5000,
      daily: [
        { date: '2026-05-10', balance: 1000 },
        { date: '2026-05-11', balance: -1000 },
        { date: '2026-05-12', balance: -3650 }, // deepest
        { date: '2026-05-13', balance: 2000 },
        { date: '2026-06-10', balance: 4000 },
      ],
    }));
    expect(res.minus.covered).toBe(true);
    expect(res.minus.totalDays).toBe(2);
    expect(res.minus.maxDepth).toMatchObject({ month: '2026-05', amount: -3650 });
    // interest at 12.7%: (1000 + 3650) × 0.127/365 = 4650×0.000347… ≈ 1.62
    expect(res.minus.interestCost).toBeCloseTo(1.62, 1);
    expect(res.minus.worstUtilization).toBeCloseTo(0.73, 2);
    // last minus 2026-05-12, last day 2026-06-10 → 29 clean days
    expect(res.minus.cleanDays).toBe(29);
    expect(res.minus.neverMinus).toBe(false);
  });

  test('a spotless account reports neverMinus and zero cost', () => {
    const res = computeOverview(baseInputs({
      daily: [{ date: '2026-06-01', balance: 500 }, { date: '2026-06-02', balance: 700 }],
    }));
    expect(res.minus.neverMinus).toBe(true);
    expect(res.minus.interestCost).toBe(0);
    expect(res.minus.cleanDays).toBeNull();
  });

  test('an empty world returns an honest empty payload', () => {
    const res = computeOverview(baseInputs({ summaries: [] }));
    expect(res.completeMonths).toBe(0);
    expect(res.series).toHaveLength(1); // just the empty partial month
    expect(res.kpis.avgIncome.value).toBeNull();
    expect(res.minus.covered).toBe(false);
  });

});
