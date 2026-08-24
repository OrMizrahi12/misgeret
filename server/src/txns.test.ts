import { describe, expect, test } from 'vitest';
import { row } from './test-helpers.js';
import {
  dedupeAcrossConnections, makeTxnKey, mapScrapedTxn, monthKey, toCategoryBreakdown, toMonthlySummary,
} from './txns.js';

describe('mapScrapedTxn — charge-month bucketing', () => {
  const scraped = {
    date: '2026-05-28T10:00:00.000Z', // purchased end of May
    processedDate: '2026-06-02T10:00:00.000Z', // charged in June's cycle
    chargedAmount: -250,
    description: 'קניה',
    status: 'completed',
  };

  test('card txns bucket by the charge date, banks by the transaction date', () => {
    expect(mapScrapedTxn('isracard', 1, 'card-1', scraped, { chargeMonth: true }).month).toBe('2026-06');
    expect(mapScrapedTxn('leumi', 1, 'acc', scraped).month).toBe('2026-05');
  });

  test('falls back to the purchase date when processedDate is missing', () => {
    const pending = { ...scraped, processedDate: null, status: 'pending' };
    expect(mapScrapedTxn('isracard', 1, 'card-1', pending, { chargeMonth: true }).month).toBe('2026-05');
  });

  test('the dedup key ignores the bucketing so history stays stable', () => {
    const a = mapScrapedTxn('isracard', 1, 'card-1', scraped, { chargeMonth: true });
    const b = mapScrapedTxn('isracard', 1, 'card-1', scraped);
    expect(a.key).toBe(b.key);
  });
});

describe('dedupeAcrossConnections', () => {
  test('collapses the same real-world txn reached via two connections, earliest connection wins', () => {
    const a = row({ date: '2026-05-10T10:00:00.000Z', amount: -80, description: 'קפה', company: 'max', connectionId: 2 });
    const b = { ...a, connectionId: 5, key: 'other-key' };
    const out = dedupeAcrossConnections([b, a]);
    expect(out).toHaveLength(1);
    expect(out[0].connectionId).toBe(2);
  });

  test('keeps genuinely different rows', () => {
    const a = row({ date: '2026-05-10T10:00:00.000Z', amount: -80, description: 'קפה', company: 'max', connectionId: 2 });
    const diffAmount = { ...a, amount: -81, connectionId: 5 };
    const diffCompany = { ...a, company: 'visaCal', connectionId: 5 };
    expect(dedupeAcrossConnections([a, diffAmount, diffCompany])).toHaveLength(3);
  });

  test('two identical-looking rows in the SAME connection are two real transactions — both kept', () => {
    // two coffees, same café, same day, same price: the DB keyed them apart by scraper identifier
    const a = row({ date: '2026-05-10T10:00:00.000Z', amount: -12.9, description: 'קפה', company: 'max', connectionId: 2 });
    const b = { ...a, key: 'distinct-identifier-key' };
    expect(dedupeAcrossConnections([a, b])).toHaveLength(2);
  });

  test('cross-connection merge keeps ALL rows of the earliest connection, not one per content key', () => {
    const a1 = row({ date: '2026-05-10T10:00:00.000Z', amount: -12.9, description: 'קפה', company: 'max', connectionId: 2 });
    const a2 = { ...a1, key: 'a2' };
    const dup1 = { ...a1, key: 'b1', connectionId: 5 };
    const dup2 = { ...a1, key: 'b2', connectionId: 5 };
    const out = dedupeAcrossConnections([dup1, a1, dup2, a2]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.connectionId === 2)).toBe(true);
  });
});

describe('monthKey', () => {
  test('buckets by Asia/Jerusalem local time, not UTC', () => {
    expect(monthKey('2026-04-30T21:30:00.000Z')).toBe('2026-05');
    expect(monthKey('2026-05-15T10:00:00.000Z')).toBe('2026-05');
  });
});

describe('makeTxnKey', () => {
  test('is deterministic for identical input', () => {
    expect(makeTxnKey('a', '2026-01-01', -5, 'x', 7)).toBe(makeTxnKey('a', '2026-01-01', -5, 'x', 7));
  });
  test('differs when any field differs', () => {
    const base = makeTxnKey('a', '2026-01-01', -5, 'x', null);
    expect(makeTxnKey('b', '2026-01-01', -5, 'x', null)).not.toBe(base);
    expect(makeTxnKey('a', '2026-01-02', -5, 'x', null)).not.toBe(base);
    expect(makeTxnKey('a', '2026-01-01', -6, 'x', null)).not.toBe(base);
    expect(makeTxnKey('a', '2026-01-01', -5, 'y', null)).not.toBe(base);
    expect(makeTxnKey('a', '2026-01-01', -5, 'x', 3)).not.toBe(base);
  });
});

describe('mapScrapedTxn', () => {
  test('maps scraper fields to TxnRow with company and connection', () => {
    const mapped = mapScrapedTxn('isracard', 7, '12-345', {
      identifier: 42,
      date: '2026-05-15T10:00:00.000Z',
      processedDate: '2026-05-16T10:00:00.000Z',
      originalAmount: -120.5,
      originalCurrency: 'ILS',
      chargedAmount: -120.5,
      description: 'סופרמרקט',
      memo: null,
      status: 'completed',
    });
    expect(mapped).toEqual({
      key: makeTxnKey('12-345', '2026-05-15T10:00:00.000Z', -120.5, 'סופרמרקט', 42),
      account: '12-345',
      date: '2026-05-15T10:00:00.000Z',
      month: '2026-05',
      processedDate: '2026-05-16T10:00:00.000Z',
      amount: -120.5,
      originalAmount: -120.5,
      currency: 'ILS',
      description: 'סופרמרקט',
      memo: null,
      status: 'completed',
      company: 'isracard',
      connectionId: 7,
      type: 'normal',
      installmentNumber: null,
      installmentTotal: null,
      chargedCurrency: null,
      issuerCategory: null,
      category: null,
      categorySource: null,
    });
  });

  test('maps installments, charged currency and issuer category when present', () => {
    const mapped = mapScrapedTxn('max', 3, 'card-1', {
      date: '2026-05-18T10:00:00.000Z',
      chargedAmount: -180,
      description: 'רהיטי הארץ',
      status: 'completed',
      type: 'installments',
      installments: { number: 2, total: 6 },
      chargedCurrency: 'ILS',
      category: 'ריהוט',
    });
    expect(mapped.type).toBe('installments');
    expect(mapped.installmentNumber).toBe(2);
    expect(mapped.installmentTotal).toBe(6);
    expect(mapped.chargedCurrency).toBe('ILS');
    expect(mapped.issuerCategory).toBe('ריהוט');
    expect(mapped.category).toBeNull();
    expect(mapped.categorySource).toBeNull();
  });
});

describe('mapScrapedTxn — the pending price', () => {
  /** Exactly what Max delivers for a purchase awaiting its charge: the price is already known
   *  (originalAmount), but nothing was charged yet (chargedAmount 0). */
  const maxPending = {
    identifier: 9,
    date: '2026-07-20T10:00:00.000Z',
    processedDate: null,
    originalAmount: -89.9,
    originalCurrency: 'ILS',
    chargedAmount: 0,
    description: 'וולט',
    status: 'pending',
  };

  test('a pending purchase shows its real price, not the ₪0 the card has charged so far', () => {
    const mapped = mapScrapedTxn('max', 3, 'card-1', maxPending);
    expect(mapped.amount).toBe(-89.9);
    expect(mapped.status).toBe('pending');
    expect(mapped.originalAmount).toBe(-89.9);
  });

  test('the key stays on the raw charged amount — the settled form re-keys and the sync clears the pending', () => {
    const mapped = mapScrapedTxn('max', 3, 'card-1', maxPending);
    expect(mapped.key).toBe(makeTxnKey('card-1', maxPending.date, 0, 'וולט', 9));
  });

  test('a foreign-currency original never slides into the shekel column', () => {
    // a $25 pending shown as ₪25 would be a number lying about its unit — worse than the zero
    const usd = { ...maxPending, originalAmount: -25, originalCurrency: 'USD' };
    expect(mapScrapedTxn('max', 3, 'card-1', usd).amount).toBe(0);
  });

  test('the shekel spellings the scrapers actually emit all count as shekels', () => {
    for (const cur of ['ILS', 'NIS', '₪', null, undefined]) {
      const t = { ...maxPending, originalCurrency: cur as string | null | undefined };
      expect(mapScrapedTxn('max', 3, 'card-1', t).amount).toBe(-89.9);
    }
  });

  test('a completed row never substitutes — chargedAmount is the truth even at zero', () => {
    const completed = { ...maxPending, status: 'completed' };
    expect(mapScrapedTxn('max', 3, 'card-1', completed).amount).toBe(0);
  });

  test('a pending that already carries a charged amount keeps it', () => {
    const bankPending = { ...maxPending, chargedAmount: -200, originalAmount: -200 };
    expect(mapScrapedTxn('leumi', 1, 'acc', bankPending).amount).toBe(-200);
  });

  test('a zero or missing original buys nothing — the amount stays 0', () => {
    expect(mapScrapedTxn('max', 3, 'card-1', { ...maxPending, originalAmount: 0 }).amount).toBe(0);
    expect(mapScrapedTxn('max', 3, 'card-1', { ...maxPending, originalAmount: null }).amount).toBe(0);
  });
});

describe('toMonthlySummary', () => {
  test('splits income and expenses, net = income - expenses', () => {
    const rows = [
      row({ date: '2026-05-01T10:00:00.000Z', amount: 10000, description: 'משכורת' }),
      row({ date: '2026-05-03T10:00:00.000Z', amount: -4000, description: 'שכירות' }),
    ];
    expect(toMonthlySummary(rows)).toEqual([
      { month: '2026-05', income: 10000, expenses: 4000, net: 6000 },
    ]);
  });

  test('excludes pending transactions', () => {
    const rows = [
      row({ date: '2026-05-01T10:00:00.000Z', amount: 1000 }),
      row({ date: '2026-05-02T10:00:00.000Z', amount: -999, status: 'pending', description: 'ממתין' }),
    ];
    expect(toMonthlySummary(rows)).toEqual([
      { month: '2026-05', income: 1000, expenses: 0, net: 1000 },
    ]);
  });

  test('skips rows flagged as excluded (card settlements)', () => {
    const rows = [
      row({ date: '2026-05-01T10:00:00.000Z', amount: 1000 }),
      { ...row({ date: '2026-05-02T10:00:00.000Z', amount: -500, description: 'ישראכרט' }), excluded: true },
    ];
    expect(toMonthlySummary(rows)).toEqual([
      { month: '2026-05', income: 1000, expenses: 0, net: 1000 },
    ]);
  });

  test('sorts months newest first', () => {
    const rows = [
      row({ date: '2026-03-10T10:00:00.000Z', amount: 1 }),
      row({ date: '2026-05-10T10:00:00.000Z', amount: 2 }),
      row({ date: '2026-04-10T10:00:00.000Z', amount: 3 }),
    ];
    expect(toMonthlySummary(rows).map((m) => m.month)).toEqual(['2026-05', '2026-04', '2026-03']);
  });

  test('rounds sums to 2 decimals', () => {
    const rows = [
      row({ date: '2026-05-01T10:00:00.000Z', amount: 0.1 }),
      row({ date: '2026-05-02T10:00:00.000Z', amount: 0.2, description: 'other' }),
    ];
    expect(toMonthlySummary(rows)[0].income).toBe(0.3);
  });
});

describe('toCategoryBreakdown', () => {
  test('sums expenses per category per month, uncategorized bucketed, excluded/pending/income skipped', () => {
    const rows = [
      { ...row({ date: '2026-05-01T10:00:00.000Z', amount: -100, description: 'a', category: 'groceries' }), excluded: false },
      { ...row({ date: '2026-05-02T10:00:00.000Z', amount: -50, description: 'b', category: 'groceries' }), excluded: false },
      { ...row({ date: '2026-05-03T10:00:00.000Z', amount: -30, description: 'c' }), excluded: false },
      { ...row({ date: '2026-05-04T10:00:00.000Z', amount: -999, description: 'd', category: 'other' }), excluded: true },
      { ...row({ date: '2026-05-05T10:00:00.000Z', amount: -20, description: 'e', status: 'pending' as const }), excluded: false },
      { ...row({ date: '2026-05-06T10:00:00.000Z', amount: 500, description: 'income', category: 'income' }), excluded: false },
    ];
    expect(toCategoryBreakdown(rows)).toEqual({
      '2026-05': [
        { category: 'groceries', expenses: 150 },
        { category: 'uncategorized', expenses: 30 },
      ],
    });
  });
});
