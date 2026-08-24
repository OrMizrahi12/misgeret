import { describe, expect, test } from 'vitest';
import type { ExcludeReason, FlaggedTxn } from './companies.js';
import { addDays, bankCashFlows, detectRecurring } from './recurring.js';
import { row } from './test-helpers.js';

function flag(t: ReturnType<typeof row>, excluded = false, excludeReason?: ExcludeReason): FlaggedTxn {
  return { ...t, excluded, ...(excludeReason ? { excludeReason } : {}) };
}

function monthly(desc: string, amount: number, day: string, months: string[], extra: Partial<ReturnType<typeof row>> = {}) {
  return months.map((m) => flag(row({ date: `2026-${m}-${day}T10:00:00.000Z`, amount, description: desc, ...extra })));
}

const M6 = ['01', '02', '03', '04', '05', '06'];

describe('detectRecurring', () => {
  test('finds a stable monthly salary and projects the next date', () => {
    const items = detectRecurring(monthly('משכורת', 12400, '01', M6));
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it.kind).toBe('income');
    expect(it.amount).toBe(12400);
    expect(it.amountStable).toBe(true);
    expect(it.dayOfMonth).toBe(1);
    expect(it.occurrences).toBe(6);
    expect(it.nextDate > it.lastDate).toBe(true);
  });

  test('variable-amount recurring (electricity) detected but marked unstable', () => {
    const rows = M6.map((m, i) =>
      flag(row({ date: `2026-${m}-12T10:00:00.000Z`, amount: -(300 + i * 40), description: 'חשבון חשמל' })),
    );
    const [it] = detectRecurring(rows);
    expect(it).toBeDefined();
    expect(it.amountStable).toBe(false);
    expect(it.kind).toBe('expense');
  });

  test('two occurrences a month apart form an EMERGING (provisional) pattern; scattered dates form nothing', () => {
    const emerging = detectRecurring(monthly('ספוטיפיי', -25.9, '10', ['01', '02']));
    expect(emerging).toHaveLength(1);
    expect(emerging[0].provisional).toBe(true);
    expect(emerging[0].forecastEligible).toBe(true); // identical amounts → trusted by the forecast

    const differing = detectRecurring([
      flag(row({ date: '2026-01-10T10:00:00.000Z', amount: -100, description: 'חנות' })),
      flag(row({ date: '2026-02-10T10:00:00.000Z', amount: -180, description: 'חנות' })),
    ]);
    expect(differing[0].provisional).toBe(true);
    expect(differing[0].forecastEligible).toBe(false); // two different amounts prove nothing yet

    // two purchases a week apart happen by chance — no weekly pattern from a pair
    const weekPair = [
      flag(row({ date: '2026-01-05T10:00:00.000Z', amount: -50, description: 'קפה' })),
      flag(row({ date: '2026-01-12T10:00:00.000Z', amount: -50, description: 'קפה' })),
    ];
    expect(detectRecurring(weekPair)).toHaveLength(0);

    const scattered = [
      flag(row({ date: '2026-01-01T10:00:00.000Z', amount: -50, description: 'אקראי' })),
      flag(row({ date: '2026-01-15T10:00:00.000Z', amount: -50, description: 'אקראי' })),
      flag(row({ date: '2026-04-20T10:00:00.000Z', amount: -50, description: 'אקראי' })),
    ];
    expect(detectRecurring(scattered)).toHaveLength(0);
  });

  test('bimonthly ארנונה: ~60-day gaps → day-of-month projection at half monthly weight', () => {
    const rows = ['01', '03', '05'].map((m) =>
      flag(row({ date: `2026-${m}-01T10:00:00.000Z`, amount: -900, description: 'עיריית תל אביב ארנונה' })),
    );
    const [it] = detectRecurring(rows);
    expect(it.cadence).toBe('bimonthly');
    expect(it.provisional).toBe(false);
    expect(it.monthlyAmount).toBe(-450);
    expect(it.nextDate).toBe('2026-07-01');
  });

  test('yearly insurance: 2 stable occurrences suffice, weighted a twelfth per month', () => {
    const rows = [
      flag(row({ date: '2025-09-15T10:00:00.000Z', amount: -3200, description: 'ביטוח רכב חובה' })),
      flag(row({ date: '2026-09-14T10:00:00.000Z', amount: -3250, description: 'ביטוח רכב חובה' })),
    ];
    const [it] = detectRecurring(rows);
    expect(it.cadence).toBe('yearly');
    expect(it.provisional).toBe(false);
    expect(it.monthlyAmount).toBeCloseTo(-268.75, 2);
    expect(it.nextDate.slice(0, 7)).toBe('2027-09');
  });

  test('weekly cleaning: 7-day gaps, ~4.3× monthly weight', () => {
    const rows = ['01-05', '01-12', '01-19', '01-26'].map((d) =>
      flag(row({ date: `2026-${d}T10:00:00.000Z`, amount: -300, description: 'ניקיון' })),
    );
    const [it] = detectRecurring(rows);
    expect(it.cadence).toBe('weekly');
    expect(it.intervalDays).toBe(7);
    expect(it.monthlyAmount).toBeCloseTo((-300 * 30) / 7, 1);
    expect(it.nextDate).toBe('2026-02-02');
  });

  test('pending rows are ignored; digits in descriptions collapse to one merchant', () => {
    const rows = [
      ...M6.map((m) => flag(row({ date: `2026-${m}-05T10:00:00.000Z`, amount: -49.9, description: `נטפליקס ${m}` }))),
      flag(row({ date: '2026-06-25T10:00:00.000Z', amount: -49.9, description: 'נטפליקס', status: 'pending' })),
    ];
    const [it] = detectRecurring(rows);
    expect(it.occurrences).toBe(6);
    expect(it.merchant).toBe('נטפליקס');
  });

  test('majority-excluded stream is marked excludedFlow (card settlement)', () => {
    const rows = M6.map((m) =>
      flag(row({ date: `2026-${m}-10T10:00:00.000Z`, amount: -3500, description: 'ישראכרט בעמ' }), true, 'settlement'),
    );
    const [it] = detectRecurring(rows);
    expect(it.excludedFlow).toBe(true);
  });

  test('income and expense streams of the same merchant stay separate', () => {
    const rows = [
      ...monthly('העברה ב BIT', -350, '14', M6),
      ...monthly('העברה ב BIT', 350, '15', M6),
    ];
    expect(detectRecurring(rows)).toHaveLength(2);
  });

  test('salary with occasional extra payments: gap analysis fails, per-month totals detect it', () => {
    const rows = [
      ...M6.map((m) => flag(row({ date: `2026-${m}-08T10:00:00.000Z`, amount: 10000 + Number(m) * 100, description: 'שלג לבן' }))),
      // bonus / per-diem payments on scattered days break the gap-majority rule
      flag(row({ date: '2026-02-20T10:00:00.000Z', amount: 1500, description: 'שלג לבן' })),
      flag(row({ date: '2026-04-28T10:00:00.000Z', amount: 900, description: 'שלג לבן' })),
    ];
    const items = detectRecurring(rows);
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it.kind).toBe('income');
    expect(it.cadence).toBe('monthly');
    expect(it.dayOfMonth).toBe(8);
    expect(it.forecastEligible).toBe(true);
    // amount is the median PER-MONTH TOTAL: [10100, 11700, 10300, 11300, 10500, 10600] → 10550
    expect(it.amount).toBe(10550);
    expect(it.nextDate).toBe('2026-07-08');
  });

  test('settlement split into several debits per month is one monthly stream at the month total, never weekly', () => {
    const rows: FlaggedTxn[] = [];
    for (const m of ['01', '02', '03', '04']) {
      rows.push(flag(row({ date: `2026-${m}-09T10:00:00.000Z`, amount: -4000, description: 'מקס איט פיננסים' }), true, 'settlement'));
      rows.push(flag(row({ date: `2026-${m}-16T10:00:00.000Z`, amount: -500, description: 'מקס איט פיננסים' }), true, 'settlement'));
      rows.push(flag(row({ date: `2026-${m}-24T10:00:00.000Z`, amount: -250, description: 'מקס איט פיננסים' }), true, 'settlement'));
    }
    const items = detectRecurring(rows);
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it.cadence).toBe('monthly');
    expect(it.amount).toBe(-4750);
    expect(it.dayOfMonth).toBe(9); // the primary (largest) debit anchors the stream
    expect(it.excludedFlow).toBe(true);
    expect(it.nextDate).toBe('2026-05-09');
  });

  test('a merchant visited monthly on RANDOM days is not a monthly stream', () => {
    const rows = [
      flag(row({ date: '2026-01-03T10:00:00.000Z', amount: -230, description: 'סופרמרקט' })),
      flag(row({ date: '2026-01-21T10:00:00.000Z', amount: -180, description: 'סופרמרקט' })),
      flag(row({ date: '2026-02-11T10:00:00.000Z', amount: -310, description: 'סופרמרקט' })),
      flag(row({ date: '2026-02-27T10:00:00.000Z', amount: -140, description: 'סופרמרקט' })),
      flag(row({ date: '2026-03-06T10:00:00.000Z', amount: -260, description: 'סופרמרקט' })),
      flag(row({ date: '2026-03-19T10:00:00.000Z', amount: -200, description: 'סופרמרקט' })),
    ];
    expect(detectRecurring(rows)).toHaveLength(0);
  });

  test('a card refund pair is neither income nor a rhythm', () => {
    const rows = [
      // purchase + its reversal a day later, repeated across months — must NOT become "income"
      ...M6.map((m) => flag(row({ date: `2026-${m}-10T10:00:00.000Z`, amount: -95.5, description: 'דומינוס פיצה', company: 'max' }))),
      ...M6.map((m) => flag(row({ date: `2026-${m}-11T10:00:00.000Z`, amount: 95.5, description: 'דומינוס פיצה', company: 'max' }))),
    ];
    const items = detectRecurring(rows);
    expect(items.filter((i) => i.kind === 'income')).toHaveLength(0);
  });

  test('next-cycle card rows delivered in advance (excluded "future") do not shift the rhythm', () => {
    const rows = [
      ...monthly('נטפליקס', -49.9, '05', M6, { company: 'max' }),
      { ...flag(row({ date: '2026-07-05T10:00:00.000Z', amount: -49.9, description: 'נטפליקס', company: 'max' })), excluded: true, excludeReason: 'future' as const },
    ];
    const [it] = detectRecurring(rows);
    expect(it.occurrences).toBe(6);
    expect(it.lastDate).toBe('2026-06-05');
    expect(it.nextDate).toBe('2026-07-05');
  });

  test('a discontinued stream is still listed but marked inactive and never forecast-eligible', () => {
    const rows = monthly('חדר כושר', -199, '10', ['01', '02', '03']);
    const active = detectRecurring(rows, { today: '2026-04-20' });
    expect(active[0].active).toBe(true);
    expect(active[0].forecastEligible).toBe(true);
    const stale = detectRecurring(rows, { today: '2026-07-14' }); // last seen 03-10, 4+ months ago
    expect(stale).toHaveLength(1);
    expect(stale[0].active).toBe(false);
    expect(stale[0].forecastEligible).toBe(false);
  });

  test('a mid-way installment plan is active with a known end date', () => {
    const rows = ['01', '02', '03'].map((m, i) =>
      flag(row({
        date: `2026-${m}-05T10:00:00.000Z`, amount: -517.33, description: 'שניידר פתרונות מחשוב', company: 'max',
        type: 'installments', installmentNumber: i + 1, installmentTotal: 6,
      })),
    );
    const [it] = detectRecurring(rows, { today: '2026-03-20' });
    expect(it.installmentPlan).toBe(true);
    expect(it.active).toBe(true);
    expect(it.endDate).toBe('2026-06-05'); // 3 slices left after 3/6
  });

  test('a plan that delivered its final slice dies immediately — no grace period', () => {
    const rows = ['01', '02', '03'].map((m, i) =>
      flag(row({
        date: `2026-${m}-05T10:00:00.000Z`, amount: -517.33, description: 'שניידר פתרונות מחשוב', company: 'max',
        type: 'installments', installmentNumber: i + 4, installmentTotal: 6,
      })),
    );
    // today is only 15 days after the last slice — well inside the usual 45-day grace
    const [it] = detectRecurring(rows, { today: '2026-03-20' });
    expect(it.installmentPlan).toBe(true);
    expect(it.endDate).toBe('2026-03-05');
    expect(it.active).toBe(false);
    expect(it.forecastEligible).toBe(false);
  });
});

describe('excludeReason — excludedFlow says "not spending", this says which kind', () => {
  test('a renewing deposit is an excluded flow, and the reason names it', () => {
    const rows = monthly('חידוש פיקדון פק"מ משנה ומעלה', -20700, '06', M6, { company: 'discount' })
      .map((r) => ({ ...r, excluded: true, excludeReason: 'savings' as const }));
    const [item] = detectRecurring(rows);
    expect(item.excludedFlow).toBe(true);
    expect(item.excludeReason).toBe('savings');
  });

  test('the pulse projects settlement streams ONLY — a renewing פק"ם is not an upcoming charge', () => {
    // routes.ts's "nearest card debit" selector. Keyed on excludedFlow alone, a monthly deposit
    // renewal would win Math.min(knownSum, streamSum) and announce a phantom ₪20,700 charge.
    const savings = monthly('חידוש פיקדון פק"מ משנה ומעלה', -20700, '06', M6, { company: 'discount' })
      .map((r) => ({ ...r, excluded: true, excludeReason: 'savings' as const }));
    const settlements = monthly('ישראכרט בעמ', -3500, '10', M6)
      .map((r) => ({ ...r, excluded: true, excludeReason: 'settlement' as const }));
    const items = detectRecurring([...savings, ...settlements]);
    const streamItems = items.filter((i) => i.excludeReason === 'settlement' && i.kind === 'expense');
    expect(streamItems.map((i) => i.merchant)).toEqual(['ישראכרט']);
    expect(items.find((i) => i.merchant.includes('פיקדון'))!.excludedFlow).toBe(true);
  });

  test('a reason needs a strict majority of the occurrences', () => {
    const rows = monthly('משהו', -500, '05', M6);
    rows[0].excluded = true;
    rows[0].excludeReason = 'savings';
    expect(detectRecurring(rows)[0].excludeReason).toBeNull();
  });

  test('an ordinary stream carries no reason', () => {
    expect(detectRecurring(monthly('משכורת', 12400, '01', M6))[0].excludeReason).toBeNull();
  });
});

describe('bankCashFlows', () => {
  test('keeps bank settlements, drops card items and internal-transfer merchants', () => {
    const bankRows = [
      ...M6.map((m) => flag(row({ date: `2026-${m}-10T10:00:00.000Z`, amount: -3500, description: 'ישראכרט בעמ' }), true, 'settlement')),
      ...M6.map((m) => flag(row({ date: `2026-${m}-14T10:00:00.000Z`, amount: -350, description: 'העברה ב BIT' }), true, 'transfer')),
    ];
    const cardRows = M6.map((m) =>
      flag(row({ date: `2026-${m}-02T10:00:00.000Z`, amount: -180, description: 'רהיטי הארץ', company: 'isracard' })),
    );
    const all = [...bankRows, ...cardRows];
    const flows = bankCashFlows(detectRecurring(all), all);
    expect(flows.map((f) => f.merchant)).toEqual(['ישראכרט']); // normalizePattern drops בעמ
  });
});

describe('addDays', () => {
  test('crosses month boundaries', () => {
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
  });
});
