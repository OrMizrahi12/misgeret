import { describe, expect, test } from 'vitest';
import {
  analyzeVariableSpend, applyForecastConfigPatch, calibrateDrift, DAYS_PER_MONTH, DEFAULT_FORECAST_CONFIG,
  forecastBalance, impliedMonthlyNet, parseForecastConfig, projectEvents, variableDailySpend,
  type VariableSpendConfig,
} from './forecast.js';
import type { RecurringItem } from './recurring.js';

const flow = (partial: Partial<RecurringItem>): RecurringItem => ({
  merchant: 'x',
  sampleDescription: 'x',
  company: 'leumi',
  connectionId: 1,
  category: null,
  amount: -100,
  lastAmount: partial.amount ?? -100,
  amountStable: true,
  amountMin: partial.amount ?? -100,
  amountMax: partial.amount ?? -100,
  cadence: 'monthly',
  intervalDays: 30,
  monthlyAmount: partial.amount ?? -100,
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
  ...partial,
});

describe('projectEvents', () => {
  test('monthly flows land on their day-of-month, catching up past nextDate', () => {
    const events = projectEvents([flow({ nextDate: '2026-05-10' })], '2026-07-01', '2026-08-31');
    expect(events.map((e) => e.date)).toEqual(['2026-07-10', '2026-08-10']);
  });

  test('a salary on the 1st stays on the 1st — no +30-day drift', () => {
    const events = projectEvents(
      [flow({ nextDate: '2026-08-01', dayOfMonth: 1, amount: 10000, kind: 'income' })],
      '2026-07-14', '2026-12-31',
    );
    expect(events.map((e) => e.date)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']);
  });

  test('day-of-month clamps in short months (31st → Feb 28th)', () => {
    const events = projectEvents([flow({ nextDate: '2027-01-31', dayOfMonth: 31 })], '2027-01-01', '2027-03-31');
    expect(events.map((e) => e.date)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  test('bimonthly (ארנונה) and yearly (ביטוח) cadences become dated events, not smeared spend', () => {
    const arnona = flow({ merchant: 'ארנונה', cadence: 'bimonthly', nextDate: '2026-08-01', dayOfMonth: 1, amount: -900 });
    const insurance = flow({ merchant: 'ביטוח רכב', cadence: 'yearly', nextDate: '2026-09-15', dayOfMonth: 15, amount: -3200 });
    const events = projectEvents([arnona, insurance], '2026-07-14', '2026-12-31');
    expect(events.filter((e) => e.merchant === 'ארנונה').map((e) => e.date)).toEqual(['2026-08-01', '2026-10-01', '2026-12-01']);
    expect(events.filter((e) => e.merchant === 'ביטוח רכב').map((e) => e.date)).toEqual(['2026-09-15']);
  });

  test('weekly flows step by their interval', () => {
    const events = projectEvents(
      [flow({ cadence: 'weekly', intervalDays: 7, nextDate: '2026-07-15', amount: -200 })],
      '2026-07-14', '2026-08-05',
    );
    expect(events.map((e) => e.date)).toEqual(['2026-07-15', '2026-07-22', '2026-07-29', '2026-08-05']);
  });

  test('ineligible provisional items are skipped; stable items project the LAST amount (price hikes propagate)', () => {
    expect(projectEvents([flow({ provisional: true, forecastEligible: false })], '2026-07-01', '2026-08-31')).toHaveLength(0);
    const hiked = flow({ amount: -50, lastAmount: -55, nextDate: '2026-07-10' });
    expect(projectEvents([hiked], '2026-07-01', '2026-07-31')[0].amount).toBe(-55);
  });

  test('a finite installment plan stops dead at its endDate — no phantom slices beyond it', () => {
    const plan = flow({ installmentPlan: true, nextDate: '2026-07-10', endDate: '2026-08-10', amount: -517 });
    const events = projectEvents([plan], '2026-07-01', '2026-12-31');
    expect(events.map((e) => e.date)).toEqual(['2026-07-10', '2026-08-10']);
  });
});

describe('variableDailySpend', () => {
  test('median of 30-day blocks: a one-off big purchase no longer inflates the rate', () => {
    const rows = [
      { amount: -600, status: 'completed', localDay: '2026-07-25', description: 'קפה' },
      { amount: -600, status: 'completed', localDay: '2026-06-20', description: 'קפה' },
      { amount: -600, status: 'completed', localDay: '2026-05-20', description: 'קפה' },
      { amount: -9000, status: 'completed', localDay: '2026-07-20', description: 'ריהוט חד פעמי' },
      { amount: -700, status: 'completed', localDay: '2026-07-22', description: 'שכר דירה' },
      { amount: 500, status: 'completed', localDay: '2026-07-23', description: 'זיכוי' },
      { amount: -100, status: 'pending', localDay: '2026-07-24', description: 'ממתין' },
    ];
    // blocks: [9600, 600, 600] → median 600 → 20/day; recurring, credits and pending skipped
    expect(variableDailySpend(rows, new Set(['שכר דירה']), (r) => r.description, '2026-07-30')).toBe(20);
  });

  test('short history: unobserved blocks are not "quiet months" that drag the median to zero', () => {
    const rows = [
      { amount: -1500, status: 'completed', localDay: '2026-07-10', description: 'קניות' },
      { amount: -1500, status: 'completed', localDay: '2026-07-20', description: 'קניות' },
    ];
    // 40 days of history → only the newest block is fully observed → 3000/30 = 100/day
    expect(variableDailySpend(rows, new Set(), (r) => r.description, '2026-07-30', 3, '2026-06-21')).toBe(100);
    // 25 days of history → no full block; rate over the days actually observed
    expect(variableDailySpend(rows, new Set(), (r) => r.description, '2026-07-30', 3, '2026-07-06')).toBe(120);
    // lumpy spending (zero median, real total) falls back to the observed average — never a flat 0
    expect(variableDailySpend(rows, new Set(), (r) => r.description, '2026-07-30')).toBeCloseTo(3000 / 90, 2);
  });
});

describe('forecastBalance', () => {
  test('applies salary and rent on their days, finds the trough before salary', () => {
    const flows = [
      flow({ merchant: 'משכורת', amount: 10000, nextDate: '2026-08-01', dayOfMonth: 1, kind: 'income' }),
      flow({ merchant: 'שכר דירה', amount: -4000, nextDate: '2026-07-20', dayOfMonth: 20 }),
    ];
    const fc = forecastBalance(1000, flows, 50, '2026-07-13', 30);
    expect(fc.path[0]).toEqual({ date: '2026-07-13', balance: 1000 });
    // by 07-31: 1000 − 18×50 − 4000 = −3900 (trough); on 08-01: +10000 − 50
    expect(fc.trough.balance).toBe(-3900);
    expect(fc.trough.date).toBe('2026-07-31');
    const aug1 = fc.path.find((p) => p.date === '2026-08-01')!;
    expect(aug1.balance).toBe(6050);
    expect(fc.endOfMonth.date).toBe('2026-07-31');
  });

  test('a known cycle charge replaces the nearest projected settlement occurrence of its company', () => {
    const flows = [flow({ merchant: 'ישראכרט', amount: -3500, nextDate: '2026-07-20', dayOfMonth: 20 })];
    const fc = forecastBalance(10000, flows, 0, '2026-07-13', 40, [
      { company: 'isracard', merchant: 'ישראכרט', date: '2026-07-22', amount: -4123.45 },
    ]);
    const events = fc.events.filter((e) => e.merchant.includes('ישראכרט'));
    // the July occurrence is overridden (real date + amount); the August one keeps the history
    expect(events.some((e) => e.date === '2026-07-22' && e.amount === -4123.45)).toBe(true);
    expect(events.some((e) => e.date === '2026-07-20')).toBe(false);
    expect(events.some((e) => e.amount === -3500)).toBe(true);
    expect(fc.known).toHaveLength(1);
  });

  test('a known charge consumes EVERY projected settlement of its company in the window (two-name cards) and keeps the cautious amount', () => {
    // Max settles under two bank names → two projected streams, both company 'max'
    const flows = [
      flow({ merchant: 'מקס איט פיננ', amount: -2200, nextDate: '2026-08-09', dayOfMonth: 9 }),
      flow({ merchant: 'לאומי ויזה', amount: -6100, nextDate: '2026-08-09', dayOfMonth: 9 }),
    ];
    // the delivered next cycle is still filling up — only ₪989 known so far
    const fc = forecastBalance(30000, flows, 0, '2026-07-14', 60, [
      { company: 'max', merchant: 'מקס', date: '2026-08-10', amount: -989.56 },
    ]);
    const augEvents = fc.events.filter((e) => e.date.slice(0, 7) === '2026-08');
    // both August projections were consumed into ONE event, at the projected (larger) total —
    // the known sum is a floor, not the final cycle
    expect(augEvents).toHaveLength(1);
    expect(augEvents[0]).toMatchObject({ date: '2026-08-10', merchant: 'מקס', amount: -8300 });
    // September projections survive untouched
    const sepEvents = fc.events.filter((e) => e.date.slice(0, 7) === '2026-09');
    expect(sepEvents.map((e) => e.amount).sort((a, b) => a - b)).toEqual([-6100, -2200]);
  });

  test('a known charge with no recurring history becomes its own event — forecast works from the first sync', () => {
    const fc = forecastBalance(10000, [], 0, '2026-07-13', 30, [
      { company: 'visaCal', merchant: 'כאל', date: '2026-08-02', amount: -1200 },
    ]);
    expect(fc.events).toHaveLength(1);
    expect(fc.events[0]).toMatchObject({ date: '2026-08-02', merchant: 'כאל', amount: -1200, source: 'known' });
    const aug2 = fc.path.find((p) => p.date === '2026-08-02')!;
    expect(aug2.balance).toBe(8800);
  });

  test('known charges outside the horizon or in the past are ignored', () => {
    const fc = forecastBalance(1000, [], 0, '2026-07-13', 10, [
      { company: 'isracard', merchant: 'ישראכרט', date: '2026-07-10', amount: -500 },
      { company: 'isracard', merchant: 'ישראכרט', date: '2026-09-10', amount: -500 },
    ]);
    expect(fc.events).toHaveLength(0);
    expect(fc.known).toHaveLength(0);
  });

  test('pending rows enter as dated events; end-of-month honors the flow anchor', () => {
    const fc = forecastBalance(1000, [], 0, '2026-07-13', 30, [], '2026-08-09', [
      { date: '2026-07-15', merchant: 'צ׳ק ממתין', amount: -400, source: 'pending' },
    ]);
    expect(fc.path.find((p) => p.date === '2026-07-15')!.balance).toBe(600);
    expect(fc.endOfMonth.date).toBe('2026-08-09');
  });

  test('every event names its source — the transparency backbone', () => {
    const fc = forecastBalance(
      10000,
      [flow({ merchant: 'שכר דירה', amount: -4000, nextDate: '2026-07-20', dayOfMonth: 20 })],
      0, '2026-07-13', 30,
      [{ company: 'visaCal', merchant: 'כאל', date: '2026-08-02', amount: -1200 }],
      undefined,
      [{ date: '2026-07-15', merchant: 'הו"ק ממתינה', amount: -400, source: 'pending' }],
    );
    const bySource = Object.fromEntries(fc.events.map((e) => [e.source, e.merchant]));
    expect(bySource.recurring).toBe('שכר דירה');
    expect(bySource.known).toBe('כאל');
    expect(bySource.pending).toBe('הו"ק ממתינה');
  });
});

describe('forecast bands (uncertainty envelope)', () => {
  test('band walks the spend-rate quantiles; expected path always inside', () => {
    const fc = forecastBalance(10000, [], 100, '2026-07-13', 30, [], undefined, [], {
      band: true, p25Daily: 60, p75Daily: 180,
    });
    expect(fc.bands).not.toBeNull();
    const last = fc.path.at(-1)!;
    const lastLow = fc.bands!.low.at(-1)!;
    const lastHigh = fc.bands!.high.at(-1)!;
    // 30 days: expected −3000, low −5400, high −1800
    expect(last.balance).toBe(7000);
    expect(lastLow.balance).toBe(4600);
    expect(lastHigh.balance).toBe(8200);
    expect(fc.troughLow!.balance).toBe(4600);
  });

  test('unstable recurring streams span their recently-seen extremes in the band', () => {
    const electricity = flow({
      merchant: 'חשמל', amount: -800, amountStable: false, amountMin: -1400, amountMax: -500,
      nextDate: '2026-07-20', dayOfMonth: 20,
    });
    const fc = forecastBalance(10000, [electricity], 0, '2026-07-13', 30, [], undefined, [], { band: true });
    const day = '2026-07-20';
    const expected = fc.path.find((p) => p.date === day)!.balance;
    const low = fc.bands!.low.find((p) => p.date === day)!.balance;
    const high = fc.bands!.high.find((p) => p.date === day)!.balance;
    expect(expected).toBe(9200); // the median
    expect(low).toBe(8600); // the worst recent bill
    expect(high).toBe(9500); // the best recent bill
  });

  test('a still-filling known cycle spans known-floor..history in the band', () => {
    const flows = [flow({ merchant: 'ישראכרט', amount: -3500, nextDate: '2026-07-20', dayOfMonth: 20 })];
    const fc = forecastBalance(10000, flows, 0, '2026-07-13', 25, [
      { company: 'isracard', merchant: 'ישראכרט', date: '2026-07-22', amount: -989 },
    ], undefined, [], { band: true });
    const day = '2026-07-22';
    // expected: the cautious −3500 (history); high: only the known −989
    expect(fc.path.find((p) => p.date === day)!.balance).toBe(6500);
    expect(fc.bands!.high.find((p) => p.date === day)!.balance).toBe(9011);
    expect(fc.bands!.low.find((p) => p.date === day)!.balance).toBe(6500);
  });

  test('band off → no envelope computed', () => {
    const fc = forecastBalance(10000, [], 100, '2026-07-13', 30);
    expect(fc.bands).toBeNull();
    expect(fc.troughLow).toBeNull();
  });

  test('weekday factors shape WHERE the money leaves, not HOW MUCH leaves per week', () => {
    // spend only on Saturdays (factor 7 clamped to mean-1 normalization): total per full week stays daily×7
    const factors = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 4]; // mean 1
    const fc = forecastBalance(10000, [], 70, '2026-07-13', 14, [], undefined, [], { weekdayFactors: factors });
    const last = fc.path.at(-1)!;
    // 14 days = 2 full weeks → 2 × 7 × 70 = 980 regardless of shape
    expect(10000 - last.balance).toBeCloseTo(980, 1);
    // but a Saturday drops 4×70=280 while a Sunday drops 35
    const sat = fc.path.find((p) => p.date === '2026-07-18')!; // Saturday
    const fri = fc.path.find((p) => p.date === '2026-07-17')!;
    expect(fri.balance - sat.balance).toBeCloseTo(280, 1);
  });
});

describe('analyzeVariableSpend — the explainable variable model', () => {
  const cfg = (partial: Partial<VariableSpendConfig> = {}): VariableSpendConfig => ({
    lookbackBlocks: 3, variableModel: 'median', manualDaily: null, weekdayPattern: false, ...partial,
  });
  const spendRows = [
    { amount: -600, status: 'completed', localDay: '2026-07-25', description: 'קפה' },
    { amount: -600, status: 'completed', localDay: '2026-06-20', description: 'קפה' },
    { amount: -1200, status: 'completed', localDay: '2026-05-20', description: 'קפה' },
  ];

  test('reports every observed block with dates, totals and rates — the "show the math" table', () => {
    const a = analyzeVariableSpend(spendRows, new Set(), (r) => r.description, '2026-07-30', cfg());
    expect(a.blocks).toHaveLength(3);
    expect(a.blocks[0]).toEqual({ from: '2026-07-01', to: '2026-07-30', total: 600, daily: 20, observedDays: 30, used: true });
    expect(a.blocks[2].total).toBe(1200);
    expect(a.daily).toBe(20); // median of 20, 20, 40
    expect(a.basis).toBe('blocks');
    expect(a.p75Daily).toBe(30); // interpolated between 20 and 40
  });

  test('model selection: average includes the crazy month, p75 plans for a spendy one, manual overrides', () => {
    expect(analyzeVariableSpend(spendRows, new Set(), (r) => r.description, '2026-07-30', cfg({ variableModel: 'average' })).daily)
      .toBeCloseTo(26.67, 2);
    expect(analyzeVariableSpend(spendRows, new Set(), (r) => r.description, '2026-07-30', cfg({ variableModel: 'p75' })).daily).toBe(30);
    const manual = analyzeVariableSpend(spendRows, new Set(), (r) => r.description, '2026-07-30', cfg({ variableModel: 'manual', manualDaily: 55 }));
    expect(manual.daily).toBe(55);
    expect(manual.basis).toBe('manual');
    expect(manual.blocks).toHaveLength(3); // the table still shows what history says
  });

  test('a partial block is displayed but never votes', () => {
    const a = analyzeVariableSpend(spendRows, new Set(), (r) => r.description, '2026-07-30', cfg(), '2026-06-16');
    // 45 days of history → one full block votes, the 15-day tail is display-only
    expect(a.blocks).toHaveLength(2);
    expect(a.blocks[1]).toMatchObject({ observedDays: 15, used: false });
    expect(a.daily).toBe(20);
    expect(a.basis).toBe('blocks');
  });

  test('weekday factors: heavier spend days get proportionally heavier factors, mean stays 1', () => {
    // four Saturdays of ₪700 vs everything else quiet, over 8 weeks of history
    const rows = ['2026-07-25', '2026-07-18', '2026-07-11', '2026-07-04'].map((d) => (
      { amount: -700, status: 'completed', localDay: d, description: 'סופר' }
    ));
    const a = analyzeVariableSpend(rows, new Set(), (r) => r.description, '2026-07-30', cfg({ lookbackBlocks: 3, weekdayPattern: true }));
    expect(a.weekdayFactors).not.toBeNull();
    const f = a.weekdayFactors!;
    expect(f[6]).toBeGreaterThan(f[0]); // Saturday ≫ Sunday
    expect(f.reduce((x, y) => x + y, 0) / 7).toBeCloseTo(1, 1);
    // disabled → null
    expect(analyzeVariableSpend(rows, new Set(), (r) => r.description, '2026-07-30', cfg()).weekdayFactors).toBeNull();
  });

  test('no data at all → explicit no-data basis, zero rate', () => {
    const a = analyzeVariableSpend([], new Set(), (r) => r.description, '2026-07-30', cfg(), '2026-07-25');
    expect(a.basis).toBe('no-data');
    expect(a.daily).toBe(0);
  });
});

describe('forecast config: parse and patch', () => {
  test('parse: null/garbage/partial all land on safe defaults', () => {
    expect(parseForecastConfig(null)).toEqual(DEFAULT_FORECAST_CONFIG);
    expect(parseForecastConfig('not json')).toEqual(DEFAULT_FORECAST_CONFIG);
    expect(parseForecastConfig('{"lookbackBlocks": 7, "variableModel": "p75"}')).toEqual({
      ...DEFAULT_FORECAST_CONFIG, lookbackBlocks: 7, variableModel: 'p75', // any integer 1..60 is allowed now
    });
    // out of the 1..60 range → default kept
    expect(parseForecastConfig('{"lookbackBlocks": 999}')).toEqual(DEFAULT_FORECAST_CONFIG);
  });

  test('patch: valid fields merge, invalid are rejected whole', () => {
    const ok = applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { lookbackBlocks: 12, showBand: false });
    expect(ok).toEqual({ ok: true, config: { ...DEFAULT_FORECAST_CONFIG, lookbackBlocks: 12, showBand: false } });
    // lookback is now a free 1..60 range — 5 is fine; 0 and 61 are out of bounds
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { lookbackBlocks: 5 }).ok).toBe(true);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { lookbackBlocks: 0 }).ok).toBe(false);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { lookbackBlocks: 61 }).ok).toBe(false);
    // horizon runs to ~50 years now — 400 is valid, only beyond the hard cap is refused
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { horizonDays: 400 }).ok).toBe(true);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { horizonDays: 18262 }).ok).toBe(true);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { horizonDays: 20000 }).ok).toBe(false);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { nonsense: true }).ok).toBe(false);
    // manual model without a manual rate is a broken state — refused
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { variableModel: 'manual' }).ok).toBe(false);
    expect(applyForecastConfigPatch(DEFAULT_FORECAST_CONFIG, { variableModel: 'manual', manualDaily: 120 }).ok).toBe(true);
  });
});

describe('calibration — level from history', () => {
  test('impliedMonthlyNet mirrors projectEvents: eligible only, stable→last amount, cadence scaled', () => {
    const salary = flow({ merchant: 'salary', kind: 'income', amount: 10000, lastAmount: 10500, amountStable: true });
    const rent = flow({ merchant: 'rent', amount: -4000, lastAmount: -4000 });
    const ineligible = flow({ merchant: 'noise', amount: -9999, forecastEligible: false });
    const weekly = flow({ merchant: 'weekly', cadence: 'weekly', intervalDays: 7, amount: -70, amountStable: false });
    // 10500 − 4000 − 70×(30.44/7) − variable 20×30.44
    expect(impliedMonthlyNet([salary, rent, ineligible, weekly], 20)).toBeCloseTo(10500 - 4000 - 70 * (DAYS_PER_MONTH / 7) - 20 * DAYS_PER_MONTH, 1);
  });

  test('calibrateDrift: the drift closes exactly the gap between calendar and observed median', () => {
    const months = [
      { month: '2026-06', net: 9500 }, { month: '2026-05', net: 7700 }, { month: '2026-04', net: 11000 },
    ];
    const cal = calibrateDrift(months, 3, 800);
    expect(cal).not.toBeNull();
    expect(cal!.medianNet).toBe(9500);
    expect(cal!.driftDaily).toBeCloseTo((9500 - 800) / DAYS_PER_MONTH, 2);
    // frugal/spendy edges come from the observed month percentiles, never invented
    expect(cal!.p25Net).toBeCloseTo(8600, 0);
    expect(cal!.p75Net).toBeCloseTo(10250, 0);
    expect(cal!.driftLow).toBeLessThan(cal!.driftDaily);
    expect(cal!.driftHigh).toBeGreaterThan(cal!.driftDaily);
  });

  test('calibrateDrift honesty floors: no months → null; one month → center without an envelope', () => {
    expect(calibrateDrift([], 6, 500)).toBeNull();
    const one = calibrateDrift([{ month: '2026-06', net: 3000 }], 6, 500);
    expect(one!.driftDaily).toBeCloseTo(2500 / DAYS_PER_MONTH, 2);
    expect(one!.p25Net).toBeNull();
    expect(one!.driftLow).toBeNull();
  });

  test('forecastBalance applies the drift daily — a bare account climbs by the observed net', () => {
    const fc = forecastBalance(1000, [], 0, '2026-07-16', 30, [], undefined, [], { driftDaily: 100 });
    expect(fc.driftDaily).toBe(100);
    expect(fc.path.at(-1)!.balance).toBeCloseTo(1000 + 100 * 30, 2);
  });

  test('drift-band mode: month-level variance lives in the drift edges — recurring extremes collapse, known charges keep their cycle spread', () => {
    const unstable = flow({ merchant: 'מקס', amount: -4000, amountStable: false, amountMin: -8000, amountMax: -1000, nextDate: '2026-08-10' });
    const stillFilling = [{ company: 'max', merchant: 'מקס ספטמבר', date: '2026-09-10', amount: -500 }];
    const fc = forecastBalance(50000, [unstable], 10, '2026-07-16', 90, stillFilling, undefined, [], {
      band: true, p25Daily: 5, p75Daily: 300, driftDaily: 50, driftLow: -30, driftHigh: 120,
    });
    // 2026-08-10: the unstable settlement projects its MEDIAN in all three walks (its
    // month-to-month swing is already inside the observed-net percentiles)
    const aug10 = fc.path.findIndex((p) => p.date === '2026-08-10');
    const evExpected = fc.path[aug10].balance - fc.path[aug10 - 1].balance;
    const evLow = fc.bands!.low[aug10].balance - fc.bands!.low[aug10 - 1].balance;
    const evHigh = fc.bands!.high[aug10].balance - fc.bands!.high[aug10 - 1].balance;
    expect(evLow - (-30 - 10)).toBeCloseTo(evExpected - (50 - 10), 2);
    expect(evHigh - (120 - 10)).toBeCloseTo(evExpected - (50 - 10), 2);
    // band rates: low/high walk the drift percentiles, not the variable-spend quantiles
    const end = fc.path.length - 1;
    expect(fc.bands!.low[end].balance).toBeCloseTo(fc.path[end].balance - (50 - -30) * 90, 1);
    // the September known charge is a still-filling cycle: applied cautious (history median),
    // optimistic edge at the known floor — THIS-cycle information survives in the band
    const sep = fc.events.find((e) => e.source === 'known' && e.date === '2026-09-10')!;
    expect(sep.amount).toBe(-4000);
    expect(sep.high).toBe(-500);
    expect(fc.bands!.high[end].balance).toBeCloseTo(fc.path[end].balance + (120 - 50) * 90 + 3500, 1);
    // the envelope still contains the expected path
    for (let i = 0; i <= end; i++) {
      expect(fc.bands!.low[i].balance).toBeLessThanOrEqual(fc.path[i].balance + 0.01);
      expect(fc.bands!.high[i].balance).toBeGreaterThanOrEqual(fc.path[i].balance - 0.01);
    }
  });

  test('drift edges are clamped to contain the expected drift', () => {
    const fc = forecastBalance(1000, [], 0, '2026-07-16', 10, [], undefined, [], {
      band: true, driftDaily: 100, driftLow: 150, driftHigh: 90, // degenerate percentiles
    });
    expect(fc.bands!.low.at(-1)!.balance).toBeLessThanOrEqual(fc.path.at(-1)!.balance);
    expect(fc.bands!.high.at(-1)!.balance).toBeGreaterThanOrEqual(fc.path.at(-1)!.balance);
  });
});
