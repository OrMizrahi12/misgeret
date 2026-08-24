import { describe, expect, test } from 'vitest';
import { buildExpectation, type ExpectationInput } from './expectation.js';

const MONTHS = ['2026-06', '2026-05', '2026-04'];

function input(over: Partial<ExpectationInput> = {}): ExpectationInput {
  return {
    variableSpentByCategory: {},
    variableHistory: {},
    completeMonths: MONTHS,
    fixedSpentByMerchant: {},
    fixedMonthlyByMerchant: {},
    ...over,
  };
}

const rowFor = (view: ReturnType<typeof buildExpectation>, key: string) => view.rows.find((r) => r.key === key);

describe('buildExpectation — a bucket costs max(what already went out, what typically does)', () => {
  test('a habit below its typical size is expected to fill up', () => {
    const view = buildExpectation(input({
      variableSpentByCategory: { groceries: 1200 },
      variableHistory: {
        '2026-06': { groceries: 2000 }, '2026-05': { groceries: 2200 }, '2026-04': { groceries: 1800 },
      },
    }));
    expect(rowFor(view, 'groceries')).toMatchObject({ spent: 1200, typical: 2000, expected: 2000, ahead: 800 });
  });

  test('a habit that already overshot IS the expectation — the month has spoken', () => {
    const view = buildExpectation(input({
      variableSpentByCategory: { groceries: 3000 },
      variableHistory: {
        '2026-06': { groceries: 2000 }, '2026-05': { groceries: 2200 }, '2026-04': { groceries: 1800 },
      },
    }));
    expect(rowFor(view, 'groceries')).toMatchObject({ spent: 3000, expected: 3000, ahead: 0 });
  });

  test('a lumpy category reserves NOTHING — a sofa is not a rhythm', () => {
    // spent in only two of the three months: big, real, and not a monthly commitment
    const view = buildExpectation(input({
      variableSpentByCategory: { shopping: 400 },
      variableHistory: {
        '2026-06': { shopping: 5000 }, '2026-05': { shopping: 0 }, '2026-04': { shopping: 3000 },
      },
    }));
    expect(rowFor(view, 'shopping')).toMatchObject({ typical: 0, expected: 400, ahead: 0 });
  });

  test('a fixed charge whose day passed without arriving is still expected', () => {
    // RiseUp keeps their 1,040 ₪ of the 12.7 inside the month's expectation on the 26.7 —
    // dropping it is how a plan quietly promises money that is already committed
    const view = buildExpectation(input({
      fixedSpentByMerchant: {},
      fixedMonthlyByMerchant: { 'שכר דירה': 3500 },
    }));
    expect(rowFor(view, 'שכר דירה')).toMatchObject({ spent: 0, expected: 3500, ahead: 3500 });
    expect(view.fixed).toMatchObject({ spent: 0, expected: 3500, ahead: 3500 });
  });

  test('the median is the typical — one holiday month never becomes the new normal', () => {
    const view = buildExpectation(input({
      variableSpentByCategory: { restaurants: 0 },
      variableHistory: {
        '2026-06': { restaurants: 600 }, '2026-05': { restaurants: 3000 }, '2026-04': { restaurants: 700 },
      },
    }));
    expect(rowFor(view, 'restaurants')!.typical).toBe(700); // mean would be 1,433
  });

  test('only the three most recent complete months vote', () => {
    const view = buildExpectation(input({
      completeMonths: ['2026-06', '2026-05', '2026-04', '2026-03'],
      variableSpentByCategory: {},
      variableHistory: {
        '2026-06': { transport: 800 }, '2026-05': { transport: 800 }, '2026-04': { transport: 800 },
        '2026-03': { transport: 9000 }, // older than the basis — must not lift anything
      },
    }));
    expect(rowFor(view, 'transport')!.typical).toBe(800);
  });

  test('noise below the floor is dropped rather than cluttering the breakdown', () => {
    const view = buildExpectation(input({
      variableSpentByCategory: {},
      variableHistory: { '2026-06': { fees: 12 }, '2026-05': { fees: 11 }, '2026-04': { fees: 13 } },
    }));
    expect(rowFor(view, 'fees')).toBeUndefined();
  });

  test('a fresh install predicts nothing and invents nothing', () => {
    const view = buildExpectation(input({ variableSpentByCategory: { groceries: 700 }, completeMonths: [] }));
    expect(view).toMatchObject({ expectedTotal: 700, spentTotal: 700, aheadTotal: 0 });
  });

  test('the totals reconcile: expected = spent + ahead, fixed + variable = all', () => {
    const view = buildExpectation(input({
      variableSpentByCategory: { groceries: 1200, restaurants: 100 },
      variableHistory: {
        '2026-06': { groceries: 2000, restaurants: 500 },
        '2026-05': { groceries: 2200, restaurants: 500 },
        '2026-04': { groceries: 1800, restaurants: 500 },
      },
      fixedSpentByMerchant: { 'חשמל': 300 },
      fixedMonthlyByMerchant: { 'חשמל': 280, 'שכר דירה': 3500 },
    }));
    expect(view.expectedTotal).toBeCloseTo(view.spentTotal + view.aheadTotal, 2);
    expect(view.expectedTotal).toBeCloseTo(view.fixed.expected + view.variable.expected, 2);
    expect(view.fixed.expected).toBeCloseTo(3800, 2); // rent 3,500 + electricity at its ACTUAL 300
    expect(view.variable.expected).toBeCloseTo(2500, 2); // groceries 2,000 + restaurants 500
    expect(view.rows[0].key).toBe('שכר דירה'); // biggest first
  });
});
