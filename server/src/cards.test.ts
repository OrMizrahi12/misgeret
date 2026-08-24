import { describe, expect, it } from 'vitest';
import { buildCardOutlook } from './cards.js';
import type { FlaggedTxn } from './companies.js';

/** A row shaped like the scrapers deliver: ISO instants, Israel-local days. */
function txn(p: Partial<FlaggedTxn> & { date: string; amount: number }): FlaggedTxn {
  return {
    key: `${p.company ?? 'max'}|${p.date}|${p.amount}|${p.description ?? 'x'}`,
    account: 'acc',
    month: p.month ?? p.date.slice(0, 7),
    processedDate: null,
    originalAmount: null,
    currency: 'ILS',
    description: 'עסקה',
    memo: null,
    status: 'completed',
    company: 'max',
    connectionId: 2,
    type: 'normal',
    installmentNumber: null,
    installmentTotal: null,
    chargedCurrency: null,
    issuerCategory: null,
    category: 'other',
    categorySource: 'auto',
    excluded: false,
    ...p,
  } as FlaggedTxn;
}

const TODAY = '2026-07-27';

describe('buildCardOutlook — the settled side', () => {
  it('sums the bank settlement rows of the flow month, and only those', () => {
    const rows = [
      txn({ date: '2026-07-10', amount: -6429.24, company: 'leumi', month: '2026-07', description: 'לאומי ויזה', excluded: true, excludeReason: 'settlement' }),
      txn({ date: '2026-07-10', amount: -2467.6, company: 'leumi', month: '2026-07', description: 'מקס איט פיננ-י', excluded: true, excludeReason: 'settlement' }),
      // June's settlement — a different window, must not leak in
      txn({ date: '2026-06-10', amount: -5000, company: 'leumi', month: '2026-06', description: 'לאומי ויזה', excluded: true, excludeReason: 'settlement' }),
      // an ordinary bank expense in July is not a settlement
      txn({ date: '2026-07-11', amount: -3500, company: 'leumi', month: '2026-07', description: 'שכר דירה' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.settled.amount).toBe(8896.84);
    expect(out.settled.count).toBe(2);
    expect(out.settled.days).toEqual(['2026-07-10']);
  });

  it('names the flow months that already counted the purchases behind the debit', () => {
    const rows = [
      txn({ date: '2026-07-10', amount: -8896.84, company: 'leumi', month: '2026-07', description: 'לאומי ויזה', excluded: true, excludeReason: 'settlement' }),
      // the details: purchases charged on the 10th, counted in June under the purchase lens
      txn({ date: '2026-06-15', processedDate: '2026-07-10', amount: -5000, month: '2026-06' }),
      txn({ date: '2026-06-20', processedDate: '2026-07-10', amount: -3896.84, month: '2026-06' }),
      // a purchase charged on a different day belongs to a different debit
      txn({ date: '2026-07-14', processedDate: '2026-08-10', amount: -300, month: '2026-07' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.settled.countedIn).toEqual([{ month: '2026-06', amount: 8896.84 }]);
  });

  it('never lets an excluded card row claim it was counted as spending', () => {
    const rows = [
      txn({ date: '2026-07-10', amount: -500, company: 'leumi', month: '2026-07', description: 'לאומי ויזה', excluded: true, excludeReason: 'settlement' }),
      txn({ date: '2026-06-15', processedDate: '2026-07-10', amount: -500, month: '2026-06', excluded: true, excludeReason: 'transfer' }),
    ];
    expect(buildCardOutlook(rows, '2026-07', TODAY).settled.countedIn).toEqual([]);
  });
});

describe('buildCardOutlook — the scheduled side', () => {
  it('groups future charge dates into one debit per (day, company)', () => {
    const rows = [
      txn({ date: '2026-07-11', processedDate: '2026-08-10', amount: -121.4, month: '2026-07' }),
      txn({ date: '2026-07-13', processedDate: '2026-08-10', amount: -1320.48, month: '2026-07' }),
      txn({ date: '2026-07-26', processedDate: '2026-08-10', amount: -666, month: '2026-07', type: 'installments' }),
      // a June purchase that only gets charged next month rides the same debit
      txn({ date: '2026-06-30', processedDate: '2026-08-10', amount: -26, month: '2026-06' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.upcoming).toHaveLength(1);
    expect(out.upcoming[0]!.day).toBe('2026-08-10');
    expect(out.upcoming[0]!.amount).toBe(2133.88);
    expect(out.upcoming[0]!.count).toBe(4);
    expect(out.upcoming[0]!.countedIn).toEqual([
      { month: '2026-07', amount: 2107.88 },
      { month: '2026-06', amount: 26 },
    ]);
    expect(out.upcomingTotal).toBe(2133.88);
  });

  it('nets refunds into the debit that carries them', () => {
    const rows = [
      txn({ date: '2026-07-11', processedDate: '2026-08-10', amount: -500, month: '2026-07' }),
      txn({ date: '2026-07-12', processedDate: '2026-08-10', amount: 120, month: '2026-07' }),
    ];
    expect(buildCardOutlook(rows, '2026-07', TODAY).upcoming[0]!.amount).toBe(380);
  });

  it('is a schedule, not a forecast: charges on or before today are never "upcoming"', () => {
    const rows = [
      txn({ date: '2026-06-15', processedDate: '2026-07-10', amount: -900, month: '2026-06' }),
      txn({ date: '2026-07-20', processedDate: '2026-07-27', amount: -400, month: '2026-07' }),
      txn({ date: '2026-07-21', processedDate: '2026-07-28', amount: -700, month: '2026-07' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.upcoming.map((u) => u.day)).toEqual(['2026-07-28']);
    expect(out.upcomingTotal).toBe(700);
  });

  it('ignores pending rows — the issuer has not scheduled them yet', () => {
    const rows = [
      txn({ date: '2026-07-25', processedDate: '2026-08-10', amount: -64.8, month: '2026-07', status: 'pending' }),
      txn({ date: '2026-07-25', processedDate: '2026-08-10', amount: -600, month: '2026-07' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.upcoming[0]!.amount).toBe(600);
    expect(out.upcoming[0]!.count).toBe(1);
  });

  it('leaves bank rows out of the schedule entirely', () => {
    const rows = [
      txn({ date: '2026-07-20', processedDate: '2026-08-01', amount: -900, company: 'leumi', month: '2026-07' }),
    ];
    expect(buildCardOutlook(rows, '2026-07', TODAY).upcoming).toEqual([]);
  });

  it('names at most three charge dates but totals every one of them', () => {
    const rows = ['2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10'].map((pd, i) =>
      txn({ date: '2026-07-11', processedDate: pd, amount: -(100 + i), month: '2026-07', description: `t${i}` }));
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.upcoming.map((u) => u.day)).toEqual(['2026-08-10', '2026-09-10', '2026-10-10']);
    expect(out.upcomingTotal).toBe(406); // 100 + 101 + 102 + 103 — the fourth still counts
  });

  it('separates two issuers charging on the same day', () => {
    const rows = [
      txn({ date: '2026-07-11', processedDate: '2026-08-10', amount: -500, month: '2026-07', company: 'max' }),
      txn({ date: '2026-07-11', processedDate: '2026-08-10', amount: -300, month: '2026-07', company: 'isracard' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.upcoming).toHaveLength(2);
    expect(out.upcomingTotal).toBe(800);
  });
});

describe('buildCardOutlook — the law it exists to keep', () => {
  /** A paid settlement and the next scheduled one stay separate from purchase-date spending. */
  it('keeps the paid debit and the scheduled one on opposite sides of today', () => {
    const rows = [
      txn({ date: '2026-07-10', amount: -8896.84, company: 'leumi', month: '2026-07', description: 'לאומי ויזה', excluded: true, excludeReason: 'settlement' }),
      txn({ date: '2026-06-15', processedDate: '2026-07-10', amount: -8896.84, month: '2026-06' }),
      txn({ date: '2026-07-13', processedDate: '2026-08-10', amount: -3182.15, month: '2026-07' }),
    ];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.settled.amount).toBe(8896.84);
    expect(out.settled.countedIn).toEqual([{ month: '2026-06', amount: 8896.84 }]);
    expect(out.upcomingTotal).toBe(3182.15);
    expect(out.upcoming[0]!.countedIn).toEqual([{ month: '2026-07', amount: 3182.15 }]);
    // the two never overlap: no purchase is on both sides
    expect(out.settled.amount + out.upcomingTotal).toBe(12078.99);
  });

  it('returns empty ledgers for a month with no cards at all', () => {
    const rows = [txn({ date: '2026-07-11', amount: -3500, company: 'leumi', month: '2026-07' })];
    const out = buildCardOutlook(rows, '2026-07', TODAY);
    expect(out.settled.amount).toBe(0);
    expect(out.settled.count).toBe(0);
    expect(out.upcoming).toEqual([]);
    expect(out.upcomingTotal).toBe(0);
  });
});
