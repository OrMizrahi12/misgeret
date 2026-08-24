import { describe, expect, test } from 'vitest';
import type { FlaggedTxn } from './companies.js';
import { computeMetrics, type MetricsInput } from './metrics.js';
import type { SpendingPattern, SpendingPatternsView } from './patterns.js';
import type { RecurringItem } from './recurring.js';
import { row } from './test-helpers.js';
import type { MonthlySummary } from './txns.js';

const M = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];

function summaries(income: number, expenses: number): MonthlySummary[] {
  // newest first, like the API; 2026-07 is the running month
  return [...M].reverse().map((month) => ({ month, income, expenses, net: income - expenses }));
}

function flagged(t: ReturnType<typeof row>): FlaggedTxn {
  return { ...t, excluded: false };
}

function monthlyRows(desc: string, amount: number, category: string, day = '05'): FlaggedTxn[] {
  return M.map((m) => flagged(row({ date: `${m}-${day}T10:00:00.000Z`, amount, description: desc, category, categorySource: 'rule' })));
}

const rentFlow: RecurringItem = {
  merchant: 'שכר דירה', sampleDescription: 'שכר דירה', company: 'leumi', connectionId: 1,
  category: 'housing', amount: -4000, lastAmount: -4000, amountStable: true, amountMin: -4000, amountMax: -4000,
  cadence: 'monthly', intervalDays: 30, monthlyAmount: -4000, dayOfMonth: 3, occurrences: 6,
  firstDate: '2026-01-03', lastDate: '2026-06-03', nextDate: '2026-07-03', kind: 'expense', excludedFlow: false,
  excludeReason: null, provisional: false, forecastEligible: true, active: true, installmentPlan: false, endDate: null,
};
const salaryFlow: RecurringItem = {
  ...rentFlow, merchant: 'משכורת', category: 'income', amount: 12000, lastAmount: 12000,
  amountMin: 12000, amountMax: 12000, monthlyAmount: 12000, kind: 'income', dayOfMonth: 1,
};
const netflixFlow: RecurringItem = {
  ...rentFlow, merchant: 'נטפליקס', category: 'leisure', amount: -50, lastAmount: -50, monthlyAmount: -50,
};

/** A row of "מה יורד לי כל חודש?" — confirmed by the household unless the caller says otherwise.
 *  `monthlyAmount` is a positive magnitude there, exactly as the tab renders it. */
function pattern(over: Partial<SpendingPattern> & { name: string; monthlyAmount: number }): SpendingPattern {
  const nature = over.nature ?? 'fixed';
  const isCommitment = nature === 'subscription' || nature === 'fixed';
  return {
    merchant: over.name, category: null,
    cadence: 'monthly', cadenceHe: 'חודשי', intervalDays: 30, regularity: 1, occurrences: 6,
    firstDate: '2026-01-03', lastDate: '2026-06-03', nextDate: '2026-07-03',
    active: true, installmentPlan: false, endDate: null,
    typicalAmount: over.monthlyAmount, minAmount: over.monthlyAmount, maxAmount: over.monthlyAmount,
    amountStable: true, totalToDate: 0, recent: [], dayOfMonth: 3, dayOfWeek: null,
    suggestedNature: nature, nature, confidence: 1, userMarked: true, dismissed: false,
    isCommitment, countsAsCommitted: isCommitment, countsAsHabit: nature === 'habit',
    source: 'detected', installmentsPaid: null, installmentsTotal: null,
    ...over,
  };
}

/** The summary the patterns tab publishes, computed by its own rules — so a metric that reads it
 *  and the tab that renders it can only ever print the same shekels. */
function view(patterns: SpendingPattern[]): SpendingPatternsView {
  const sum = (pred: (p: SpendingPattern) => boolean) =>
    Math.round(patterns.filter(pred).reduce((s, p) => s + p.monthlyAmount, 0));
  const subscriptionMonthly = sum((p) => p.countsAsCommitted && p.nature === 'subscription');
  const fixedMonthly = sum((p) => p.countsAsCommitted && p.nature === 'fixed');
  return {
    patterns,
    summary: {
      total: patterns.length,
      subscriptionMonthly,
      fixedMonthly,
      committedMonthly: subscriptionMonthly + fixedMonthly,
      habitMonthly: sum((p) => p.countsAsHabit),
      rhythmMonthly: sum((p) => p.active && !p.dismissed),
      totalMonthlySpend: 9000,
      pctOnRhythm: 0,
    },
  };
}

function baseInput(): MetricsInput {
  return {
    summaries: summaries(12000, 9000),
    rows: [
      ...monthlyRows('שכר דירה', -4000, 'housing'),
      ...monthlyRows('סופרמרקט', -2000, 'groceries'),
      ...monthlyRows('מסעדות', -1500, 'restaurants'),
      ...monthlyRows('חשמל', -500, 'bills'),
      ...monthlyRows('נטפליקס', -50, 'leisure'),
    ],
    recurring: [salaryFlow, rentFlow, netflixFlow],
    patterns: view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      pattern({ name: 'נטפליקס', monthlyAmount: 50, category: 'leisure', nature: 'subscription' }),
    ]),
    bankStats: {
      series: [],
      minByMonth: M.map((month) => ({ month, min: 2000 })),
      daysBelowZeroByMonth: M.map((month) => ({ month, days: 0 })),
      troughSlope: 0,
    },
    latestBankBalance: 30000,
    liquidAssetsTotal: 0,
  };
}

describe('computeMetrics', () => {
  test('healthy household: savings green, buffer green, no overdraft', () => {
    const report = computeMetrics(baseInput());
    const byId = Object.fromEntries([...report.level, ...report.resilience].map((m) => [m.id, m]));
    expect(byId['savings-rate'].band).toBe('green'); // 25%
    expect(byId['savings-rate'].display).toBe('25%');
    expect(byId['buffer'].band).toBe('green'); // 30000 / 6500 ≈ 4.6
    expect(byId['income-volatility'].band).toBe('green'); // constant income
    expect(byId['housing'].band).toBe('yellow'); // 4000/12000 = 33%
    expect(byId['overdraft'].band).toBe('green');
    expect(byId['surplus-streak'].band).toBe('green'); // 6/6
    expect(report.overall.band).not.toBe('red');
  });

  test('every measurable metric exposes typed visualization data and unavailable metrics expose null', () => {
    const report = computeMetrics(baseInput());
    const byId = Object.fromEntries([...report.level, ...report.resilience].map((m) => [m.id, m]));
    const expectedKinds: Record<string, string> = {
      'savings-rate': 'bullet',
      buffer: 'segments',
      'income-volatility': 'trend',
      'fixed-commitments': 'composition',
      housing: 'composition',
      'debt-service': 'bullet',
      overdraft: 'overdraft',
      'surplus-streak': 'month-outcomes',
      'discretionary-trend': 'trend',
      subscriptions: 'subscriptions',
      fees: 'bullet',
    };

    for (const metric of [...report.level, ...report.resilience]) {
      if (metric.band === 'na') expect(metric.visual).toBeNull();
      else expect(metric.visual).not.toBeNull();
    }
    for (const [id, kind] of Object.entries(expectedKinds)) expect(byId[id].visual?.kind).toBe(kind);
    expect(byId['savings-rate'].visual).toMatchObject({ kind: 'bullet', value: 0.25 });
    expect(byId.buffer.visual).toMatchObject({ kind: 'segments', value: expect.any(Number), max: 6 });
    expect(byId['income-volatility'].visual).toMatchObject({ kind: 'trend', points: expect.any(Array) });
    expect(byId.squeeze.visual).toBeNull();
  });

  test('negative savings and chronic overdraft go red', () => {
    const input = baseInput();
    input.summaries = summaries(9000, 11000);
    input.bankStats = {
      series: [],
      minByMonth: M.map((month, i) => ({ month, min: -500 - i * 300 })),
      daysBelowZeroByMonth: M.map((month) => ({ month, days: 12 })),
      troughSlope: -300,
    };
    input.latestBankBalance = -500;
    const report = computeMetrics(input);
    const byId = Object.fromEntries([...report.level, ...report.resilience].map((m) => [m.id, m]));
    expect(byId['savings-rate'].band).toBe('red');
    expect(byId['overdraft'].band).toBe('red');
    expect(byId['buffer'].band).toBe('red');
    expect(report.overall.band).toBe('red');
  });

  test('insufficient history yields na, never a fake verdict', () => {
    const input = baseInput();
    input.summaries = input.summaries.slice(0, 2); // one complete month
    input.rows = input.rows.filter((r) => r.month >= '2026-06');
    const report = computeMetrics(input);
    const byId = Object.fromEntries([...report.level, ...report.resilience].map((m) => [m.id, m]));
    expect(byId['savings-rate'].band).toBe('na');
    expect(byId['income-volatility'].band).toBe('na');
    // and the OVERALL verdict admits it — two green dots must not read as "healthy"
    expect(report.overall.band).toBe('na');
    expect(report.overall.statusHe).toBe('אין מספיק נתונים');
  });

  test('a bonus month is not instability: upside deviations never redden volatility', () => {
    const input = baseInput();
    // steady 12K salary, one month with a 24K bonus — the reported real-world lie
    input.summaries = summaries(12000, 9000).map((m) =>
      m.month === '2026-04' ? { ...m, income: 36000, net: 27000 } : m,
    );
    const vol = computeMetrics(input).resilience.find((m) => m.id === 'income-volatility')!;
    expect(vol.band).toBe('green');
    expect(vol.detailHe).toContain('חודש בונוס אינו סיכון');
  });

  test('real downside swings with a solid cushion soften to yellow, never red', () => {
    const input = baseInput();
    // choppy income with genuine LOW months, but a 30K balance = several months of cushion
    const incomes: Record<string, number> = {
      '2026-01': 6000, '2026-02': 14000, '2026-03': 5500, '2026-04': 15000, '2026-05': 6500, '2026-06': 14000,
    };
    input.summaries = summaries(12000, 9000).map((m) =>
      incomes[m.month] ? { ...m, income: incomes[m.month], net: incomes[m.month] - 9000 } : m,
    );
    const report = computeMetrics(input);
    const vol = report.resilience.find((m) => m.id === 'income-volatility')!;
    expect(vol.band).toBe('yellow');
    expect(vol.detailHe).toContain('סופגת את התנודות');
  });

  test('spending that grows with income is not creep: discretionary reads the income share', () => {
    const input = baseInput();
    // income doubles in the recent 3 months, restaurants spending doubles with it — share flat
    input.summaries = summaries(12000, 9000).map((m) =>
      m.month >= '2026-04' && m.month <= '2026-06' ? { ...m, income: 24000, net: 24000 - 9000 } : m,
    );
    input.rows = input.rows.map((r) =>
      r.description === 'מסעדות' && r.month >= '2026-04' && r.month <= '2026-06' ? { ...r, amount: -3000 } : r,
    );
    const disc = computeMetrics(input).level.find((m) => m.id === 'discretionary-trend')!;
    expect(disc.band).toBe('green'); // ₪ ratio would scream ×~1.6; the share barely moves
    expect(disc.detailHe).toContain('נתח מההכנסה');
  });

  test('trivial bank fees stay green: 30 shekels a month is life, not a warning', () => {
    const input = baseInput();
    for (const m of M) {
      input.rows.push(flagged(row({
        date: `${m}-20T10:00:00.000Z`, amount: -20, description: 'עמלת ערוץ ישיר', category: 'fees', categorySource: 'rule',
      })));
    }
    const fees = computeMetrics(input).level.find((m) => m.id === 'fees')!;
    expect(fees.band).toBe('green');
    expect(fees.detailHe).toContain('זניח');
  });

  test('green fundamentals cannot be sunk by context metrics: no red verdict without core reds', () => {
    const input = baseInput();
    // force context reds: a huge fee habit AND raise housing share — core stays green
    for (const m of M) {
      input.rows.push(flagged(row({
        date: `${m}-21T10:00:00.000Z`, amount: -300, description: 'ריבית חובה', category: 'fees', categorySource: 'rule',
      })));
    }
    const report = computeMetrics(input);
    const fees = report.level.find((m) => m.id === 'fees')!;
    expect(fees.band).toBe('red'); // the context metric itself still tells the truth
    expect(report.overall.band).not.toBe('red'); // but it cannot declare the account פגיע alone
    expect(report.overall.reasonHe).toContain('מדדי הליבה');
  });

  test('manual assets marked liquid extend the emergency buffer', () => {
    const thin = baseInput();
    thin.latestBankBalance = 3000; // ~0.5 months of essential spend on its own
    const before = computeMetrics(thin).resilience.find((m) => m.id === 'buffer')!;
    expect(before.band).toBe('red');

    thin.liquidAssetsTotal = 30000; // a liquid deposit changes the verdict
    const after = computeMetrics(thin).resilience.find((m) => m.id === 'buffer')!;
    expect(after.band).toBe('green');
    expect(after.detailHe).toContain('נכסים שסומנו נזילים');
  });

  test('an active bank loan counts as debt service alongside open installment plans', () => {
    const input = baseInput();
    input.recurring = [...input.recurring, {
      ...rentFlow, merchant: 'החזר הלוואה לאומי', sampleDescription: 'החזר הלוואה לאומי',
      category: 'other', amount: -1500, lastAmount: -1500, monthlyAmount: -1500,
    }];
    const debt = computeMetrics(input).level.find((m) => m.id === 'debt-service')!;
    expect(debt.band).toBe('yellow'); // 1500/12000 = 12.5%
    expect(debt.detailHe).toContain('החזרי הלוואה');
  });

  test('debt service is what still runs: a plan that delivered its last slice stops counting', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      // finished: 12 of 12 paid. The rows are still in the window; the obligation is not.
      pattern({ name: 'מחשב בתשלומים', monthlyAmount: 3104, installmentPlan: true, installmentsPaid: 12, installmentsTotal: 12 }),
      // running: 3 of 12
      pattern({ name: 'ביטוח בתשלומים', monthlyAmount: 500, installmentPlan: true, installmentsPaid: 3, installmentsTotal: 12 }),
    ]);
    const debt = computeMetrics(input).level.find((m) => m.id === 'debt-service')!;
    expect(debt.display).toBe('4%'); // 500/12000 — not (500+3104)/12000 = 30%
    expect(debt.detailHe).toContain('תשלומים פתוחים');
    expect(debt.detailHe).toContain('נספר מה שעוד רץ');
  });

  test('fixed commitments count exactly what "מה יורד לי כל חודש?" counts, in per-month equivalents', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'ניקיון', monthlyAmount: 1286 }),    // weekly 300 ₪ → 1,285.71 a month
      pattern({ name: 'ביטוח שנתי', monthlyAmount: 300 }), // yearly 3,600 ₪ → 300 a month
    ]);
    const fixed = computeMetrics(input).resilience.find((m) => m.id === 'fixed-commitments')!;
    // 1,586 → 13% of 12,000, not the raw (300 + 3,600) = 3,900
    expect(fixed.display).toBe('13%');
    expect(fixed.detailHe).toContain('2 חיובים שאישרת');
  });

  test('a הרגל the household declared is never counted as a commitment', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      // he ruled פנגו a habit. It repeats, it is real money — and it is not money spoken for.
      pattern({ name: 'פנגו', monthlyAmount: 500, category: 'transport', nature: 'habit' }),
    ]);
    const fixed = computeMetrics(input).resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.display).toBe('33%'); // 4000/12000 — the 500 stays out
    expect(fixed.detailHe).toContain('1 חיובים שאישרת');
  });

  test('a bare detection is a proposal: never summed, always named', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      pattern({ name: 'עמל ערוץ יש', monthlyAmount: 25, userMarked: false, countsAsCommitted: false }),
    ]);
    const fixed = computeMetrics(input).resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.display).toBe('33%'); // 4000/12000 — the unreviewed 25 ₪ stays out
    expect(fixed.detailHe).toContain('עוד חיוב חוזר אחד מחכה להחלטה שלך');
  });

  test('nothing approved yet is not a green zero — it is a question with a name', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, userMarked: false, countsAsCommitted: false }),
      pattern({ name: 'נטפליקס', monthlyAmount: 50, nature: 'subscription', userMarked: false, countsAsCommitted: false }),
    ]);
    const report = computeMetrics(input);
    const fixed = report.resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.band).toBe('na');
    expect(fixed.display).toBe('—');
    expect(fixed.detailHe).toContain('מחכים להחלטה שלך');
    const subs = report.resilience.find((m) => m.id === 'subscriptions')!;
    expect(subs.band).toBe('na');
    expect(subs.detailHe).toContain('נראה כמו מנוי');
  });

  test('subscription load counts the מנויים he marked — and a dollar charge that never sits still still counts', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      // the reported real-world bug: confirmed מנוי, category 'shopping', amount wobbling with the
      // dollar. The old category+stability proxy printed 0 מנויים · 0 ₪ over exactly this row.
      pattern({ name: 'ChatGPT', monthlyAmount: 446, category: 'shopping', nature: 'subscription', amountStable: false }),
      pattern({ name: 'ספוטיפיי', monthlyAmount: 20, category: 'leisure', nature: 'subscription', userMarked: false, countsAsCommitted: false }),
    ]);
    const report = computeMetrics(input);
    const subs = report.resilience.find((m) => m.id === 'subscriptions')!;
    expect(subs.display).toContain('1 מנוי');
    expect(subs.display).not.toContain('מנויים');
    expect(subs.detailHe).toContain('ChatGPT');
    expect(subs.detailHe).not.toContain('ספוטיפיי'); // a guess is not a verdict
    expect(subs.detailHe).toContain('עוד חיוב אחד נראה כמו מנוי');
    // and the same shekels are inside the commitment total — one set, two questions
    const fixed = report.resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.display).toBe('37%'); // (4000 + 446)/12000
  });

  test('a discontinued commitment is history: dropped from subscriptions AND fixed commitments', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      pattern({ name: 'נטפליקס', monthlyAmount: 50, category: 'leisure', nature: 'subscription' }),
      // a big computing-services stream whose last charge is months old — the reported real-world bug
      pattern({ name: 'שניידר פתרונות מחשוב', monthlyAmount: 3104, active: false, countsAsCommitted: false }),
    ]);
    const report = computeMetrics(input);
    const subs = report.resilience.find((m) => m.id === 'subscriptions')!;
    expect(subs.display).toContain('1 מנוי'); // netflix only — the dead stream is not "current"
    expect(subs.detailHe).not.toContain('שניידר');
    const fixed = report.resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.display).toBe('34%'); // 4050/12000 — without the dead 3104
    expect(fixed.detailHe).not.toContain('מחכה להחלטה'); // a dead stream is not a pending question
  });

  test('an installment plan is committed the moment it exists — no verdict needed, never a subscription', () => {
    const input = baseInput();
    input.patterns = view([
      pattern({ name: 'שכר דירה', monthlyAmount: 4000, category: 'housing' }),
      pattern({ name: 'נטפליקס', monthlyAmount: 50, category: 'leisure', nature: 'subscription' }),
      pattern({
        name: 'מחשב בתשלומים', monthlyAmount: 500, category: 'shopping', installmentPlan: true,
        endDate: '2026-10-03', installmentsPaid: 3, installmentsTotal: 12, userMarked: false,
      }),
    ]);
    const report = computeMetrics(input);
    const subs = report.resilience.find((m) => m.id === 'subscriptions')!;
    expect(subs.display).toContain('1 מנוי');
    expect(subs.detailHe).not.toContain('מחשב בתשלומים');
    const fixed = report.resilience.find((m) => m.id === 'fixed-commitments')!;
    expect(fixed.display).toBe('38%'); // 4550/12000 — the live plan still narrows maneuvering room
    expect(fixed.detailHe).not.toContain('מחכה להחלטה'); // signed for, not proposed
    // and it is debt: the open plan carries the debt-service figure
    expect(report.level.find((m) => m.id === 'debt-service')!.display).toBe('4%');
  });

  test('a salary whose AMOUNT moves is still a salary: the payday is what has to be steady', () => {
    const input = baseInput();
    // sixteen months of pay on the 10th, never twice the same sum (overtime, a bonus, a thin month)
    input.recurring = [
      { ...salaryFlow, dayOfMonth: 10, amountStable: false, occurrences: 16, amount: 14215, amountMin: 9800, amountMax: 21400 },
      rentFlow, netflixFlow,
    ];
    for (const month of M.slice(0, -1)) {
      for (let day = 2; day <= 16; day += 1) {
        input.rows.push(flagged(row({
          date: `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
          amount: -20, description: 'קפה יומי', category: 'restaurants', categorySource: 'rule',
        })));
      }
    }
    const squeeze = computeMetrics(input).resilience.find((m) => m.id === 'squeeze')!;
    expect(squeeze.band).not.toBe('na');
    expect(squeeze.detailHe).toContain('יום 10');
  });

  test('the squeeze counts card purchases too — a card-heavy household is not "no activity"', () => {
    const input = baseInput();
    input.recurring = [{ ...salaryFlow, dayOfMonth: 10 }, rentFlow, netflixFlow];
    // every purchase on a credit card, as an Israeli household actually spends
    for (const month of M.slice(0, -1)) {
      for (let day = 2; day <= 16; day += 1) {
        input.rows.push(flagged(row({
          date: `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
          amount: -20, description: 'קפה יומי', category: 'restaurants', categorySource: 'rule',
          company: 'max', connectionId: 2,
        })));
      }
    }
    const squeeze = computeMetrics(input).resilience.find((m) => m.id === 'squeeze')!;
    expect(squeeze.band).not.toBe('na'); // bank-only, these 90 purchases were invisible
    expect(squeeze.detailHe).toContain('גם בכרטיס');
  });

  test('a minus he climbed out of is history: seven clean months cannot be called chronic', () => {
    const input = baseInput();
    const M24 = Array.from({ length: 24 }, (_, i) => `2024-${String(i + 1).padStart(2, '0')}`);
    input.bankStats = {
      series: [],
      minByMonth: M24.map((month, i) => ({ month, min: i < 17 ? -4000 : 5000 })),
      // seventeen months deep in overdraft, then seven clean ones — the majority of the window
      // is still red, and he is not
      daysBelowZeroByMonth: M24.map((month, i) => ({ month, days: i < 17 ? 25 : 0 })),
      troughSlope: 842,
    };
    const od = computeMetrics(input).resilience.find((m) => m.id === 'overdraft')!;
    expect(od.band).toBe('green');
    expect(od.detailHe).toContain('לא היה מינוס בכלל');

    // and the reverse still bites: back in the minus, the verdict is red however clean 2024 was
    input.bankStats.daysBelowZeroByMonth = M24.map((month, i) => ({ month, days: i < 17 ? 0 : 25 }));
    const back = computeMetrics(input).resilience.find((m) => m.id === 'overdraft')!;
    expect(back.band).toBe('red');
    expect(back.detailHe).toContain('6 נגמרו במינוס');
  });

  test('the trough sentence describes HIS trend, not the dangerous one', () => {
    const rising = baseInput();
    rising.bankStats = { ...rising.bankStats!, troughSlope: 3139 };
    const up = computeMetrics(rising).resilience.find((m) => m.id === 'overdraft')!;
    expect(up.detailHe).toContain('השפל שלך מטפס');
    expect(up.detailHe).not.toContain('סימן ההידרדרות');

    const falling = baseInput();
    falling.bankStats = { ...falling.bankStats!, troughSlope: -3139 };
    const down = computeMetrics(falling).resilience.find((m) => m.id === 'overdraft')!;
    expect(down.detailHe).toContain('סימן ההידרדרות');
    expect(down.detailHe).not.toContain('מטפס');
  });

  test('squeeze is na without dense daily activity', () => {
    const report = computeMetrics(baseInput());
    const squeeze = report.resilience.find((m) => m.id === 'squeeze')!;
    expect(squeeze.band).toBe('na');
    expect(squeeze.visual).toBeNull();
  });

  test('squeeze exposes a paired daily-pace comparison when activity is dense enough', () => {
    const input = baseInput();
    input.recurring[0] = { ...salaryFlow, dayOfMonth: 10 };
    for (const month of M.slice(0, -1)) {
      for (let day = 2; day <= 16; day += 1) {
        input.rows.push(flagged(row({
          date: `${month}-${String(day).padStart(2, '0')}T10:00:00.000Z`,
          amount: -20,
          description: 'קפה יומי',
          category: 'restaurants',
          categorySource: 'rule',
        })));
      }
    }

    const squeeze = computeMetrics(input).resilience.find((m) => m.id === 'squeeze')!;
    expect(squeeze.visual).toMatchObject({
      kind: 'comparison',
      primary: expect.any(Number),
      reference: expect.any(Number),
      markers: [{ value: 0.5 }, { value: 0.8 }],
    });
  });
});
