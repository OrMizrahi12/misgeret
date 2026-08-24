import { describe, expect, test } from 'vitest';
import { buildAdvice, type AdviceInput } from './advice.js';
import type { DayBalance } from './balance-history.js';
import { flowMonthOf } from './flow.js';
import type { FlaggedTxn } from './companies.js';
import type { SpendingPattern } from './patterns.js';
import type { RecurringItem } from './recurring.js';
import type { InstallmentPlan } from './subscriptions.js';
import { row } from './test-helpers.js';
import type { MonthlySummary } from './txns.js';

/* ——— fixtures ——————————————————————————————————————————————————————————————————————— */

const flag = (t: ReturnType<typeof row>): FlaggedTxn => ({ ...t, excluded: false });

const summary = (month: string, income: number, expenses: number): MonthlySummary =>
  ({ month, income, expenses, net: income - expenses });

function pattern(over: Partial<SpendingPattern> & { merchant: string }): SpendingPattern {
  return {
    name: over.merchant,
    category: 'leisure',
    cadence: 'monthly',
    cadenceHe: 'חודשי',
    intervalDays: 30,
    regularity: 0.95,
    occurrences: 8,
    firstDate: '2025-11-01',
    lastDate: '2026-06-01',
    nextDate: '2026-07-01',
    active: true,
    installmentPlan: false,
    endDate: null,
    typicalAmount: 50,
    minAmount: 50,
    maxAmount: 50,
    amountStable: true,
    monthlyAmount: 50,
    totalToDate: 400,
    recent: [50, 50, 50],
    dayOfMonth: 1,
    dayOfWeek: null,
    suggestedNature: 'subscription',
    nature: 'subscription',
    confidence: 0.9,
    userMarked: true,
    dismissed: false,
    isCommitment: true,
    countsAsCommitted: true,
    countsAsHabit: false,
    source: 'detected',
    installmentsPaid: null,
    installmentsTotal: null,
    ...over,
  };
}

function recurringItem(over: Partial<RecurringItem> & { merchant: string }): RecurringItem {
  return {
    sampleDescription: over.merchant,
    company: 'leumi',
    connectionId: 1,
    category: null,
    amount: -100,
    lastAmount: -100,
    amountStable: true,
    amountMin: -100,
    amountMax: -100,
    cadence: 'monthly',
    intervalDays: 30,
    monthlyAmount: -100,
    dayOfMonth: 10,
    occurrences: 6,
    firstDate: '2026-01-10',
    lastDate: '2026-06-10',
    nextDate: '2026-07-10',
    kind: 'expense',
    excludedFlow: false,
    excludeReason: null,
    provisional: false,
    forecastEligible: true,
    active: true,
    installmentPlan: false,
    endDate: null,
    ...over,
  };
}

function plan(over: Partial<InstallmentPlan> & { merchant: string }): InstallmentPlan {
  return {
    name: over.merchant,
    category: 'shopping',
    paid: 9,
    total: 12,
    remaining: 3,
    sliceAmount: 500,
    remainingAmount: 1500,
    nextDate: '2026-08-05',
    endDate: '2026-10-05',
    ...over,
  };
}

const MONTHS = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

/** A household with nothing wrong: 20,000 in, 15,000 out, a real cushion, no minus. */
function baseInput(over: Partial<AdviceInput> = {}): AdviceInput {
  const rows: FlaggedTxn[] = [];
  for (const m of MONTHS) {
    rows.push(flag(row({ date: `${m}-05T10:00:00.000Z`, amount: -4000, description: 'שופרסל', category: 'groceries' })));
    rows.push(flag(row({ date: `${m}-08T10:00:00.000Z`, amount: -1200, description: 'דלק', category: 'transport' })));
    rows.push(flag(row({ date: `${m}-12T10:00:00.000Z`, amount: -800, description: 'חשמל', category: 'bills' })));
  }
  return {
    today: '2026-07-15',
    currentMonth: '2026-07',
    summaries: [...MONTHS.map((m) => summary(m, 20000, 15000)), summary('2026-07', 9000, 7000)],
    rows,
    recurring: [],
    patterns: [],
    installments: [],
    daily: [],
    monthOf: (iso) => flowMonthOf(iso, 1),
    liquidTotal: 60000,
    ...over,
  };
}

const kinds = (input: AdviceInput) => buildAdvice(input).items.map((a) => a.kind);

/* ——— the queue itself ——————————————————————————————————————————————————————————————— */

describe('buildAdvice — the queue', () => {
  test('a household with nothing wrong gets no advice; silence is still a feature', () => {
    expect(buildAdvice(baseInput()).items).toEqual([]);
  });

  test('a dismissed key never comes back', () => {
    const input = baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', category: 'leisure', typicalAmount: 40, recent: [40, 40, 56], monthlyAmount: 40 })],
    });
    expect(kinds(input)).toContain('price-hike');
    expect(kinds({ ...input, suppressed: new Set(['hike|נטפליקס|56']) })).not.toContain('price-hike');
  });

  test('the cap holds, and totalFound still reports everything the rules found', () => {
    const input = baseInput({
      patterns: [
        pattern({ merchant: 'נטפליקס', category: 'leisure', typicalAmount: 40, recent: [40, 40, 56], monthlyAmount: 40 }),
        pattern({ merchant: 'דיסני', category: 'leisure', monthlyAmount: 30, typicalAmount: 30, recent: [30, 30, 30] }),
        pattern({ merchant: 'חדר כושר', category: 'shopping', monthlyAmount: 200, typicalAmount: 200, recent: [200, 200, 260] }),
      ],
      limit: 2,
    });
    const view = buildAdvice(input);
    expect(view.items).toHaveLength(2);
    expect(view.totalFound).toBeGreaterThan(2);
  });

  test('the cushion and the minus outrank money on the table', () => {
    const daily: DayBalance[] = MONTHS.flatMap((m) =>
      Array.from({ length: 28 }, (_, i) => ({ date: `${m}-${String(i + 1).padStart(2, '0')}`, balance: -9000 })),
    );
    const input = baseInput({
      liquidTotal: 1000,
      daily,
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 40, 56], monthlyAmount: 40 })],
    });
    const order = kinds(input);
    expect(order.indexOf('overdraft-cost')).toBeLessThan(order.indexOf('price-hike'));
    expect(order.indexOf('buffer')).toBeLessThan(order.indexOf('price-hike'));
  });

  test('a figure that is not money says so — a rate printed as ₪2 is a lying number', () => {
    const daily: DayBalance[] = MONTHS.flatMap((m) =>
      Array.from({ length: 28 }, (_, i) => ({ date: `${m}-${String(i + 1).padStart(2, '0')}`, balance: i > 20 ? -2000 : 5000 })),
    );
    const view = buildAdvice(baseInput({
      daily,
      summaries: [...MONTHS.map((m) => summary(m, 20000, 19400)), summary('2026-07', 9000, 7000)],
      recurring: [
        recurringItem({ merchant: 'משכורת', kind: 'income', amount: 20000, lastAmount: 20000, monthlyAmount: 20000, dayOfMonth: 1 }),
        recurringItem({ merchant: 'ויזה', excludedFlow: true, excludeReason: 'settlement', dayOfMonth: 22, amount: -6000, monthlyAmount: -6000 }),
        recurringItem({
          merchant: 'ביטוח רכב', sampleDescription: 'ביטוח רכב', intervalDays: 365, cadence: 'yearly',
          amount: -3600, lastAmount: -3600, monthlyAmount: -300, nextDate: '2026-10-01',
        }),
      ],
      limit: 12,
    }));
    const unitOf = (kind: string, label: string) =>
      view.items.find((a) => a.kind === kind)?.lines.find((l) => l.labelHe === label)?.unit;
    expect(unitOf('charge-date', 'יום חיוב הכרטיס')).toBe('day');
    expect(unitOf('annual-ahead', 'חודשים עד החיוב')).toBe('months');
    // and money still carries no unit at all — shekels are the default
    expect(unitOf('annual-ahead', 'הפרשה חודשית מוצעת')).toBeUndefined();
  });

  test('only certain savings are summed; money merely at stake is counted apart', () => {
    const input = baseInput({
      patterns: [
        // certain: a charge that provably went up
        pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 40, 60], monthlyAmount: 40 }),
        // at stake: two subscriptions in one category — dropping one is a judgement call
        pattern({ merchant: 'דיסני', category: 'leisure', monthlyAmount: 30, typicalAmount: 30, recent: [30, 30, 30] }),
      ],
    });
    const view = buildAdvice(input);
    expect(view.potential.certain).toBe(20);
    expect(view.potential.atStake).toBe(30);
  });
});

/* ——— the rules ——————————————————————————————————————————————————————————————————————— */

describe('price-hike', () => {
  test('a yearly premium is normalised to a MONTHLY value — the jump is not a monthly cost', () => {
    const item = buildAdvice(baseInput({
      patterns: [pattern({
        merchant: 'ביטוח רכב', cadence: 'yearly', cadenceHe: 'שנתי', intervalDays: 365,
        typicalAmount: 2400, monthlyAmount: 200, recent: [2400, 3000],
      })],
    })).items.find((a) => a.kind === 'price-hike');
    // a ₪600 yearly jump is ₪50 a month, never ₪600
    expect(item?.monthlyValue).toBe(50);
    expect(item?.annualValue).toBe(600);
  });

  test('the two figures each carry their own label — they never share a sentence', () => {
    const item = buildAdvice(baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 56], monthlyAmount: 40 })],
    })).items.find((a) => a.kind === 'price-hike');
    expect(item?.lines).toHaveLength(2);
    for (const line of item!.lines) expect(line.labelHe).toContain('נטפליקס');
  });

  test('small or proportionally minor rises stay silent', () => {
    // +8 ₪ on 100 is under both the ₪10 floor and the 12% floor
    expect(kinds(baseInput({
      patterns: [pattern({ merchant: 'ספוטיפיי', typicalAmount: 100, recent: [100, 108], monthlyAmount: 100 })],
    }))).not.toContain('price-hike');
  });

  test('a dead or dismissed commitment is not re-priced', () => {
    expect(kinds(baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 90], monthlyAmount: 40, active: false })],
    }))).not.toContain('price-hike');
    expect(kinds(baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 90], monthlyAmount: 40, dismissed: true })],
    }))).not.toContain('price-hike');
  });

  test('the key follows the new price, so a second hike reads as a new fact', () => {
    const first = buildAdvice(baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 56], monthlyAmount: 40 })],
    })).items[0].key;
    const second = buildAdvice(baseInput({
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 70], monthlyAmount: 40 })],
      suppressed: new Set([first]),
    })).items.find((a) => a.kind === 'price-hike');
    expect(second).toBeDefined();
  });
});

describe('duplicate-service', () => {
  test('two live subscriptions in one category quote the CHEAPER one — the floor of one drop', () => {
    const item = buildAdvice(baseInput({
      patterns: [
        pattern({ merchant: 'נטפליקס', category: 'leisure', monthlyAmount: 56, typicalAmount: 56, recent: [56] }),
        pattern({ merchant: 'דיסני', category: 'leisure', monthlyAmount: 30, typicalAmount: 30, recent: [30] }),
      ],
    })).items.find((a) => a.kind === 'duplicate-service');
    expect(item?.monthlyValue).toBe(30);
    expect(item?.lines.map((l) => l.labelHe)).toEqual(['נטפליקס', 'דיסני']);
  });

  test('essential categories are never called duplicates — two insurers is not a luxury', () => {
    expect(kinds(baseInput({
      patterns: [
        pattern({ merchant: 'ביטוח א', category: 'insurance', nature: 'subscription' }),
        pattern({ merchant: 'ביטוח ב', category: 'insurance', nature: 'subscription' }),
      ],
    }))).not.toContain('duplicate-service');
  });

  test('a habit is not a subscription and never pairs into a duplicate', () => {
    expect(kinds(baseInput({
      patterns: [
        pattern({ merchant: 'קפה א', category: 'restaurants', nature: 'habit', isCommitment: false, countsAsCommitted: false }),
        pattern({ merchant: 'קפה ב', category: 'restaurants', nature: 'habit', isCommitment: false, countsAsCommitted: false }),
      ],
    }))).not.toContain('duplicate-service');
  });
});

describe('bank-fees', () => {
  test('fires above ₪30 a month and is honest that the saving is not guaranteed', () => {
    const rows = baseInput().rows.concat(
      MONTHS.map((m) => flag(row({ date: `${m}-20T10:00:00.000Z`, amount: -60, description: 'עמלת ניהול', category: 'fees' }))),
    );
    const item = buildAdvice(baseInput({ rows })).items.find((a) => a.kind === 'bank-fees');
    expect(item?.monthlyValue).toBe(60);
    expect(item?.annualValue).toBe(720);
    expect(item?.valueCertain).toBe(false);
  });

  test('₪20 a month of fees is life, not a recommendation', () => {
    const rows = baseInput().rows.concat(
      MONTHS.map((m) => flag(row({ date: `${m}-20T10:00:00.000Z`, amount: -20, description: 'עמלה', category: 'fees' }))),
    );
    expect(kinds(baseInput({ rows }))).not.toContain('bank-fees');
  });
});

describe('overdraft-cost', () => {
  const deepMinus: DayBalance[] = MONTHS.flatMap((m) =>
    Array.from({ length: 28 }, (_, i) => ({ date: `${m}-${String(i + 1).padStart(2, '0')}`, balance: -10000 })),
  );

  test('prices the minus as money already paid, and says so', () => {
    const item = buildAdvice(baseInput({ daily: deepMinus, liquidTotal: 60000 }))
      .items.find((a) => a.kind === 'overdraft-cost');
    expect(item?.valueCertain).toBe(true);
    // 168 days × 10,000 × 12.7%/365 ≈ 584 ₪ over six months
    expect(item!.monthlyValue).toBeGreaterThan(80);
    expect(item!.monthlyValue).toBeLessThan(110);
  });

  test('days outside the complete-month window are not priced', () => {
    // the running month is deep in the red, but it is not a finished month
    const running: DayBalance[] = Array.from({ length: 15 }, (_, i) => ({ date: `2026-07-${String(i + 1).padStart(2, '0')}`, balance: -20000 }));
    expect(kinds(baseInput({ daily: running }))).not.toContain('overdraft-cost');
  });

  test('a shallow, brief dip is not worth an interruption', () => {
    const shallow: DayBalance[] = [{ date: '2026-06-14', balance: -300 }];
    expect(kinds(baseInput({ daily: shallow }))).not.toContain('overdraft-cost');
  });
});

describe('charge-date', () => {
  const daily: DayBalance[] = MONTHS.flatMap((m) =>
    Array.from({ length: 28 }, (_, i) => ({ date: `${m}-${String(i + 1).padStart(2, '0')}`, balance: i > 20 ? -2000 : 5000 })),
  );
  const salary = recurringItem({ merchant: 'משכורת', kind: 'income', amount: 20000, lastAmount: 20000, monthlyAmount: 20000, dayOfMonth: 1 });

  test('a card debited far from payday earns the cheapest fix in personal finance', () => {
    const item = buildAdvice(baseInput({
      daily,
      recurring: [salary, recurringItem({ merchant: 'ויזה', excludedFlow: true, excludeReason: 'settlement', dayOfMonth: 22, amount: -6000, monthlyAmount: -6000 })],
    })).items.find((a) => a.kind === 'charge-date');
    expect(item?.actionHe).toContain('ה-2 בחודש');
    expect(item?.lines).toEqual([
      { labelHe: 'יום המשכורת', amount: 1, unit: 'day' },
      { labelHe: 'יום חיוב הכרטיס', amount: 22, unit: 'day' },
    ]);
  });

  test('a card already debited close to payday is left alone', () => {
    expect(kinds(baseInput({
      daily,
      recurring: [salary, recurringItem({ merchant: 'ויזה', excludedFlow: true, excludeReason: 'settlement', dayOfMonth: 4, amount: -6000 })],
    }))).not.toContain('charge-date');
  });

  test('without a detected salary the suggestion would be a guess, so it stays quiet', () => {
    expect(kinds(baseInput({
      daily,
      recurring: [recurringItem({ merchant: 'ויזה', excludedFlow: true, excludeReason: 'settlement', dayOfMonth: 22, amount: -6000 })],
    }))).not.toContain('charge-date');
  });
});

describe('buffer', () => {
  test('a thin cushion proposes a rate drawn from the real surplus, and a goal to match', () => {
    // essentials ≈ 6,000/month ⇒ target 18,000; liquid 3,000 ⇒ gap 15,000
    const item = buildAdvice(baseInput({ liquidTotal: 3000 })).items.find((a) => a.kind === 'buffer');
    expect(item?.goal?.type).toBe('buffer');
    expect(item?.goal?.targetAmount).toBe(18000);
    // half the 5,000 monthly surplus is 2,500, but gap/12 is 1,250 — the slower one wins,
    // rounded to a rate a person would actually say out loud
    expect(item?.goal?.monthlyAmount).toBe(1300);
    expect(item?.valueKind).toBe('resilience');
  });

  test('no surplus to draw from: the advice refuses to invent a rate and points at what frees money', () => {
    const item = buildAdvice(baseInput({
      liquidTotal: 3000,
      summaries: [...MONTHS.map((m) => summary(m, 20000, 20000)), summary('2026-07', 9000, 7000)],
      patterns: [pattern({ merchant: 'נטפליקס', typicalAmount: 40, recent: [40, 200], monthlyAmount: 40 })],
    })).items.find((a) => a.kind === 'buffer');
    expect(item?.goal?.monthlyAmount).toBeNull();
    expect(item?.actionHe).toContain('משחררות');
  });

  test('a cushion over three months is not a problem to solve', () => {
    expect(kinds(baseInput({ liquidTotal: 60000 }))).not.toContain('buffer');
  });
});

describe('installments-freeing', () => {
  test('a plan about to end becomes a decision about where the money goes', () => {
    const item = buildAdvice(baseInput({ installments: [plan({ merchant: 'מקררים', endDate: '2026-09-05' })] }))
      .items.find((a) => a.kind === 'installments-freeing');
    expect(item?.monthlyValue).toBe(500);
    expect(item?.goal?.type).toBe('set-aside');
    expect(item?.goal?.monthlyAmount).toBe(500);
  });

  test('a plan that runs for another year is not news yet', () => {
    expect(kinds(baseInput({ installments: [plan({ merchant: 'מקררים', endDate: '2027-06-05' })] })))
      .not.toContain('installments-freeing');
  });
});

describe('category-creep', () => {
  test('the baseline never contains the months it judges, and the goal names the ceiling', () => {
    const rows = baseInput().rows.concat([
      ...['2026-01', '2026-02', '2026-03'].map((m) => flag(row({ date: `${m}-15T10:00:00.000Z`, amount: -600, description: 'מסעדה', category: 'restaurants' }))),
      ...['2026-04', '2026-05', '2026-06'].map((m) => flag(row({ date: `${m}-15T10:00:00.000Z`, amount: -1400, description: 'מסעדה', category: 'restaurants' }))),
    ]);
    const item = buildAdvice(baseInput({ rows })).items.find((a) => a.kind === 'category-creep');
    expect(item?.monthlyValue).toBe(800);
    expect(item?.goal?.category).toBe('restaurants');
    expect(item?.goal?.categoryCeiling).toBe(600);
    expect(item?.lines.map((l) => l.amount)).toEqual([1400, 600]);
  });

  test('"אחר" is never the target — "spend less on other" tells a household nothing', () => {
    const rows = baseInput().rows.concat([
      ...['2026-01', '2026-02', '2026-03'].map((m) => flag(row({ date: `${m}-15T10:00:00.000Z`, amount: -600, description: 'משהו', category: 'other' }))),
      ...['2026-04', '2026-05', '2026-06'].map((m) => flag(row({ date: `${m}-15T10:00:00.000Z`, amount: -4000, description: 'משהו', category: 'other' }))),
    ]);
    expect(kinds(baseInput({ rows }))).not.toContain('category-creep');
  });

  test('essentials are not "creep" — a household cannot be told to eat less', () => {
    const rows = baseInput().rows.concat([
      ...['2026-04', '2026-05', '2026-06'].map((m) => flag(row({ date: `${m}-16T10:00:00.000Z`, amount: -2000, description: 'שופרסל', category: 'groceries' }))),
    ]);
    expect(kinds(baseInput({ rows }))).not.toContain('category-creep');
  });
});

describe('annual-ahead', () => {
  test('a big yearly charge on the horizon becomes a monthly set-aside', () => {
    const item = buildAdvice(baseInput({
      recurring: [recurringItem({
        merchant: 'ביטוח רכב', sampleDescription: 'ביטוח רכב', intervalDays: 365, cadence: 'yearly',
        amount: -3600, lastAmount: -3600, monthlyAmount: -300, nextDate: '2026-10-01',
      })],
    })).items.find((a) => a.kind === 'annual-ahead');
    expect(item?.monthlyValue).toBe(1200); // 3,600 over three months
    expect(item?.goal?.targetAmount).toBe(3600);
  });

  test('a monthly charge is not an annual surprise', () => {
    expect(kinds(baseInput({
      recurring: [recurringItem({ merchant: 'חשמל', amount: -1200, lastAmount: -1200, nextDate: '2026-08-10' })],
    }))).not.toContain('annual-ahead');
  });
});

describe('dead-commitment', () => {
  test('a commitment that stopped charging is an accuracy fix, not a saving', () => {
    const item = buildAdvice(baseInput({
      patterns: [pattern({ merchant: 'חדר כושר', active: false, monthlyAmount: 250, lastDate: '2026-02-01' })],
    })).items.find((a) => a.kind === 'dead-commitment');
    expect(item?.valueKind).toBe('accuracy');
    expect(buildAdvice(baseInput({
      patterns: [pattern({ merchant: 'חדר כושר', active: false, monthlyAmount: 250, lastDate: '2026-02-01' })],
    })).potential.certain).toBe(0);
  });

  test('a finished installment plan is not a zombie — it ended on purpose', () => {
    expect(kinds(baseInput({
      patterns: [pattern({ merchant: 'ריהוט', active: false, installmentPlan: true, monthlyAmount: 500 })],
    }))).not.toContain('dead-commitment');
  });
});
