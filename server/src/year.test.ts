import { describe, expect, test } from 'vitest';
import type { FlaggedTxn } from './companies.js';
import { computeCategoryHistory, computeYear } from './year.js';

let seq = 0;
function txn(over: Partial<FlaggedTxn> & { month: string; amount: number }): FlaggedTxn {
  seq += 1;
  return {
    key: `t${seq}`,
    account: '123',
    date: `${over.month}-10T12:00:00.000Z`,
    processedDate: null,
    originalAmount: null,
    currency: 'ILS',
    description: over.amount >= 0 ? 'משכורת' : 'קנייה',
    memo: null,
    status: 'completed',
    company: 'leumi',
    connectionId: 1,
    type: 'normal',
    installmentNumber: null,
    installmentTotal: null,
    chargedCurrency: null,
    issuerCategory: null,
    category: over.amount >= 0 ? null : 'food',
    categorySource: null,
    excluded: false,
    ...over,
  } as FlaggedTxn;
}

describe('computeYear', () => {
  test('12 month slots; totals over data months; partial marks the running month', () => {
    const rows = [
      txn({ month: '2026-01', amount: 10000 }),
      txn({ month: '2026-01', amount: -4000 }),
      txn({ month: '2026-02', amount: 10000 }),
      txn({ month: '2026-02', amount: -3500 }),
      txn({ month: '2026-07', amount: -200 }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.months).toHaveLength(12);
    expect(y.months[0]).toMatchObject({ month: '2026-01', income: 10000, expenses: 4000, net: 6000, hasData: true, partial: false });
    expect(y.months[2]).toMatchObject({ month: '2026-03', hasData: false });
    expect(y.months[6]).toMatchObject({ month: '2026-07', partial: true, hasData: true });
    expect(y.monthsWithData).toBe(3);
    expect(y.totals).toEqual({ income: 20000, expenses: 7700, net: 12300 });
  });

  test('pending and excluded rows never count', () => {
    const rows = [
      txn({ month: '2026-03', amount: -500 }),
      txn({ month: '2026-03', amount: -900, status: 'pending' }),
      txn({ month: '2026-03', amount: -700, excluded: true }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.totals.expenses).toBe(500);
  });

  test('honest YoY: both years summed over the SAME month numbers only', () => {
    const rows = [
      // 2026: Jan + Feb + Mar
      txn({ month: '2026-01', amount: 10000 }), txn({ month: '2026-01', amount: -4000 }),
      txn({ month: '2026-02', amount: 10000 }), txn({ month: '2026-02', amount: -5000 }),
      txn({ month: '2026-03', amount: 10000 }), txn({ month: '2026-03', amount: -6000 }),
      // 2025: Jan + Feb + Dec — March missing, December outside the shared set
      txn({ month: '2025-01', amount: 9000 }), txn({ month: '2025-01', amount: -4400 }),
      txn({ month: '2025-02', amount: 9000 }), txn({ month: '2025-02', amount: -4600 }),
      txn({ month: '2025-12', amount: 9000 }), txn({ month: '2025-12', amount: -9000 }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.sameMonths).not.toBeNull();
    expect(y.sameMonths!.count).toBe(2); // Jan+Feb only
    expect(y.sameMonths!.prevYear).toBe('2025');
    expect(y.sameMonths!.prev).toEqual({ income: 18000, expenses: 9000, net: 9000 });
    expect(y.sameMonths!.current).toEqual({ income: 20000, expenses: 9000, net: 11000 });
  });

  test('no previous-year data — no fabricated comparison', () => {
    const y = computeYear([txn({ month: '2026-01', amount: -100 })], '2026', '2026-07');
    expect(y.sameMonths).toBeNull();
  });

  test('categories: yearly totals desc, monthly slots, delta over shared months, tiny base → null', () => {
    const rows = [
      txn({ month: '2026-01', amount: -1000, category: 'food' }),
      txn({ month: '2026-04', amount: -500, category: 'food' }),
      txn({ month: '2026-01', amount: -2000, category: 'housing' }),
      txn({ month: '2026-01', amount: -80, category: 'fun' }),
      // prev year, January (the shared month): food 750 → +33%; fun 50 → base too small
      txn({ month: '2025-01', amount: -750, category: 'food' }),
      txn({ month: '2025-01', amount: -50, category: 'fun' }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.byCategory[0]).toMatchObject({ category: 'housing', total: 2000 });
    const food = y.byCategory.find((c) => c.category === 'food')!;
    expect(food.total).toBe(1500);
    expect(food.byMonth[0]).toBe(1000);
    expect(food.byMonth[3]).toBe(500);
    // shared month = January only: 1000 vs 750 → +33%
    expect(food.deltaPct).toBe(33);
    expect(y.byCategory.find((c) => c.category === 'fun')!.deltaPct).toBeNull();
  });

  test('a financed purchase competes as ONE purchase: installment slices re-assembled', () => {
    const rows = [
      txn({ month: '2026-02', amount: -500, type: 'installments', description: 'מחשב נייד' }),
      txn({ month: '2026-03', amount: -500, type: 'installments', description: 'מחשב נייד' }),
      txn({ month: '2026-04', amount: -500, type: 'installments', description: 'מחשב נייד' }),
      txn({ month: '2026-05', amount: -1200, description: 'תיקון רכב' }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.biggest[0]).toMatchObject({ description: 'מחשב נייד', amount: 1500, installments: 3 });
    expect(y.biggest[1]).toMatchObject({ description: 'תיקון רכב', amount: 1200, installments: 1 });
  });

  test('fees named; years listed newest first', () => {
    const rows = [
      txn({ month: '2026-01', amount: -35, category: 'fees' }),
      txn({ month: '2026-06', amount: -42, category: 'fees' }),
      txn({ month: '2025-03', amount: -10 }),
      txn({ month: '2024-11', amount: -10 }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.fees).toBe(77);
    expect(y.years).toEqual(['2026', '2025', '2024']);
  });
});

describe('computeCategoryHistory', () => {
  const noMarks: { key: string; mark: 'subscription' | 'fixed' | 'habit' | 'dismissed' }[] = [];

  test('one bar per month, gaps zero-filled — a month with no spending is information', () => {
    const rows = [
      txn({ month: '2026-01', amount: -300, category: 'leisure', description: 'קולנוע' }),
      txn({ month: '2026-04', amount: -500, category: 'leisure', description: 'קולנוע' }),
    ];
    const h = computeCategoryHistory(rows, 'leisure', noMarks)!;
    expect(h.charges.map((c) => c.month)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(h.charges.map((c) => c.amount)).toEqual([300, 0, 0, 500]);
    expect(h.count).toBe(4);      // months plotted
    expect(h.chargeCount).toBe(2); // charges behind them
    expect(h.totalAmount).toBe(800);
  });

  test('the year boundary is not a boundary here — a category is read over all stored months', () => {
    const rows = [
      txn({ month: '2025-11', amount: -100, category: 'leisure' }),
      txn({ month: '2026-01', amount: -100, category: 'leisure' }),
    ];
    const h = computeCategoryHistory(rows, 'leisure', noMarks)!;
    expect(h.firstMonth).toBe('2025-11');
    expect(h.lastMonth).toBe('2026-01');
    expect(h.charges).toHaveLength(3);
  });

  test('typical is the median MONTH, and a spike does not move it', () => {
    const rows = [
      txn({ month: '2026-01', amount: -1000, category: 'food' }),
      txn({ month: '2026-02', amount: -1100, category: 'food' }),
      txn({ month: '2026-03', amount: -9000, category: 'food' }),
    ];
    const h = computeCategoryHistory(rows, 'food', noMarks)!;
    expect(h.typicalAmount).toBe(1100);
    expect(h.maxAmount).toBe(9000);
    expect(h.varied).toBe(true);
  });

  test('excluded and income rows never enter — the popup counts exactly what the card counts', () => {
    const rows = [
      txn({ month: '2026-01', amount: -400, category: 'food' }),
      txn({ month: '2026-01', amount: -900, category: 'food', excluded: true }),
      txn({ month: '2026-01', amount: 5000, category: 'food' }),
    ];
    const h = computeCategoryHistory(rows, 'food', noMarks)!;
    expect(h.totalAmount).toBe(400);
    expect(h.chargeCount).toBe(1);
  });

  test('merchants ranked, and one the merchant popup cannot read is not offered a door', () => {
    const rows = [
      txn({ month: '2026-01', amount: -800, category: 'food', description: 'שופרסל' }),
      txn({ month: '2026-02', amount: -900, category: 'food', description: 'שופרסל' }),
      txn({ month: '2026-02', amount: -200, category: 'food', description: 'פיצה', excludeReason: 'future' }),
    ];
    const h = computeCategoryHistory(rows, 'food', noMarks)!;
    expect(h.topMerchants[0]).toMatchObject({ name: 'שופרסל', total: 1700, count: 2, drillable: true });
    expect(h.topMerchants[1]).toMatchObject({ name: 'פיצה', drillable: false });
  });

  test('an empty category is null, not an empty chart', () => {
    expect(computeCategoryHistory([txn({ month: '2026-01', amount: -100, category: 'food' })], 'health', noMarks)).toBeNull();
  });
});

describe('computeYear — the merchants of the year', () => {
  test('ranked by money, keyed the way the merchant popup expects, painted by category', () => {
    const rows = [
      txn({ month: '2026-01', amount: -800, category: 'groceries', description: 'שופרסל' }),
      txn({ month: '2026-03', amount: -900, category: 'groceries', description: 'שופרסל' }),
      txn({ month: '2026-02', amount: -1200, category: 'housing', description: 'שכר דירה' }),
      txn({ month: '2026-02', amount: 5000 }), // income never ranks
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.topMerchants[0]).toMatchObject({ name: 'שופרסל', total: 1700, count: 2, category: 'groceries', drillable: true });
    expect(y.topMerchants[1]).toMatchObject({ name: 'שכר דירה', total: 1200, count: 1, category: 'housing' });
    // the ranking is by total, so the two-charge merchant sorts above the one-charge one
    expect(y.topMerchants.map((m) => m.total)).toEqual([1700, 1200]);
    expect(y.topMerchants.every((m) => m.merchant.length > 0)).toBe(true);
  });

  test('the colour follows the LATEST charge — a re-categorised merchant is not painted by its past', () => {
    const rows = [
      txn({ month: '2026-01', amount: -100, category: 'other', description: 'עסק' }),
      txn({ month: '2026-05', amount: -100, category: 'health', description: 'עסק' }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.topMerchants[0].category).toBe('health');
  });

  test('a merchant with no readable charge gets no door', () => {
    const rows = [txn({ month: '2026-01', amount: -300, category: 'other', description: 'חיוב עתידי', excludeReason: 'future' })];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.topMerchants[0]).toMatchObject({ total: 300, drillable: false });
  });

  test('only the selected year ranks — last year is a different card', () => {
    const rows = [
      txn({ month: '2025-04', amount: -9000, category: 'other', description: 'ישן' }),
      txn({ month: '2026-04', amount: -300, category: 'other', description: 'חדש' }),
    ];
    const y = computeYear(rows, '2026', '2026-07');
    expect(y.topMerchants).toHaveLength(1);
    expect(y.topMerchants[0].name).toBe('חדש');
  });
});
