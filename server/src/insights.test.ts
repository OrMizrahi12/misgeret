import { describe, expect, test } from 'vitest';
import type { FlaggedTxn } from './companies.js';
import { monthInsights, topMerchants } from './insights.js';
import { row } from './test-helpers.js';

function flag(t: ReturnType<typeof row>): FlaggedTxn {
  return { ...t, excluded: false };
}

describe('duplicate-charge insight', () => {
  test('same merchant, same exact amount, within 48 hours → flagged once', () => {
    const rows: FlaggedTxn[] = [
      flag(row({ date: '2026-07-03T10:00:00.000Z', amount: -450, description: 'הוט מובייל' })),
      flag(row({ date: '2026-07-04T09:00:00.000Z', amount: -450, description: 'הוט מובייל' })),
    ];
    const dups = monthInsights('2026-07', rows, []).filter((i) => i.type === 'duplicate-charge');
    expect(dups).toHaveLength(1);
    expect(dups[0].textHe).toContain('חיוב כפול');
    expect(dups[0].amount).toBe(450);
    // refs point at BOTH suspect rows — the unified table tags each one in place
    expect(dups[0].refs).toEqual([rows[0].key, rows[1].key]);
  });

  test('small amounts, differing amounts, installments and far-apart charges stay silent', () => {
    const rows: FlaggedTxn[] = [
      // routine coffee — under the 100 ₪ floor
      flag(row({ date: '2026-07-03T10:00:00.000Z', amount: -12.9, description: 'קפה טוב' })),
      flag(row({ date: '2026-07-04T10:00:00.000Z', amount: -12.9, description: 'קפה טוב' })),
      // similar but not identical amounts
      flag(row({ date: '2026-07-05T10:00:00.000Z', amount: -300, description: 'חנות בגדים' })),
      flag(row({ date: '2026-07-06T10:00:00.000Z', amount: -320, description: 'חנות בגדים' })),
      // installments legitimately repeat the same amount
      flag(row({ date: '2026-07-01T10:00:00.000Z', amount: -500, description: 'ריהוט', type: 'installments', installmentNumber: 1, installmentTotal: 3 })),
      flag(row({ date: '2026-07-02T10:00:00.000Z', amount: -500, description: 'ריהוט', type: 'installments', installmentNumber: 2, installmentTotal: 3 })),
      // nine days apart — not a double swipe
      flag(row({ date: '2026-07-01T10:00:00.000Z', amount: -800, description: 'טיסה' })),
      flag(row({ date: '2026-07-10T10:00:00.000Z', amount: -800, description: 'טיסה' })),
    ];
    expect(monthInsights('2026-07', rows, []).filter((i) => i.type === 'duplicate-charge')).toHaveLength(0);
  });
});

describe('topMerchants', () => {
  test('aggregates expenses by merchant and carries the row keys for in-table tagging', () => {
    const rows: FlaggedTxn[] = [
      flag(row({ date: '2026-07-03T10:00:00.000Z', amount: -200, description: 'שופרסל 123' })),
      flag(row({ date: '2026-07-11T10:00:00.000Z', amount: -300, description: 'שופרסל 456' })),
      flag(row({ date: '2026-07-05T10:00:00.000Z', amount: -50, description: 'קפה טוב' })),
      flag(row({ date: '2026-07-10T10:00:00.000Z', amount: 8000, description: 'משכורת' })), // income never ranks
    ];
    const top = topMerchants('2026-07', rows);
    expect(top[0].total).toBe(500);
    expect(top[0].count).toBe(2);
    expect(top[0].refs).toEqual([rows[0].key, rows[1].key]);
    expect(top).toHaveLength(2);
  });
});
