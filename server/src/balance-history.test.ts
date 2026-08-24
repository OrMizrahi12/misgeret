import { describe, expect, test } from 'vitest';
import { balanceStats, reconstructDailyBalances } from './balance-history.js';
import { row } from './test-helpers.js';

describe('reconstructDailyBalances', () => {
  test('walks backwards from the latest balance', () => {
    const rows = [
      row({ date: '2026-07-01T10:00:00.000Z', amount: 1000, description: 'in' }),
      row({ date: '2026-07-03T10:00:00.000Z', amount: -400, description: 'out' }),
    ];
    const series = reconstructDailyBalances(600, '2026-07-04', rows, '2026-06-30');
    // end of 07-04: 600; 07-03: 600 (txn -400 happened on 03 → end of 02 = 1000)
    const by = Object.fromEntries(series.map((d) => [d.date, d.balance]));
    expect(by['2026-07-04']).toBe(600);
    expect(by['2026-07-03']).toBe(600);
    expect(by['2026-07-02']).toBe(1000);
    expect(by['2026-07-01']).toBe(1000);
    expect(by['2026-06-30']).toBe(0); // before the +1000 on 07-01
    expect(series[0].date).toBe('2026-06-30');
  });

  test('ignores pending rows', () => {
    const rows = [row({ date: '2026-07-02T10:00:00.000Z', amount: -999, description: 'p', status: 'pending' })];
    const series = reconstructDailyBalances(100, '2026-07-03', rows, '2026-07-01');
    expect(series.every((d) => d.balance === 100)).toBe(true);
  });
});

describe('balanceStats', () => {
  test('monthly minima, days below zero, and a negative trough slope', () => {
    const series = [
      { date: '2026-05-10', balance: 500 },
      { date: '2026-05-20', balance: 300 },
      { date: '2026-06-10', balance: 200 },
      { date: '2026-06-20', balance: -50 },
      { date: '2026-07-10', balance: -300 },
      { date: '2026-07-20', balance: 100 },
    ];
    const stats = balanceStats(series);
    expect(stats.minByMonth).toEqual([
      { month: '2026-05', min: 300 },
      { month: '2026-06', min: -50 },
      { month: '2026-07', min: -300 },
    ]);
    expect(stats.daysBelowZeroByMonth.map((d) => d.days)).toEqual([0, 1, 1]);
    expect(stats.troughSlope).toBeLessThan(0);
  });

  test('slope is null under 3 months', () => {
    expect(balanceStats([{ date: '2026-07-01', balance: 1 }]).troughSlope).toBeNull();
  });
});
