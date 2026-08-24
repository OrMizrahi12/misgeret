import { describe, expect, test } from 'vitest';
import { buildLayerValues, computeAttribution, grossTotals, holdingLayer, LAYER_KEYS, stepTotals } from './networth.js';

describe('holdingLayer', () => {
  test('typed holdings derive their layer; only other consults kind', () => {
    expect(holdingLayer('loan', 'liability')).toBe('loan');
    expect(holdingLayer('deposit', 'asset')).toBe('deposit');
    expect(holdingLayer('securities', 'asset')).toBe('securities');
    expect(holdingLayer('other', 'asset')).toBe('otherAsset');
    expect(holdingLayer('other', 'liability')).toBe('otherLiability');
  });

  test('the widened taxonomy: mortgage rides the loan layer, big classes get their own', () => {
    expect(holdingLayer('mortgage', 'liability')).toBe('loan');
    expect(holdingLayer('pension', 'asset')).toBe('pension');
    expect(holdingLayer('realEstate', 'asset')).toBe('realEstate');
    expect(holdingLayer('vehicle', 'asset')).toBe('otherAsset');
    expect(holdingLayer('crypto', 'asset')).toBe('otherAsset');
    expect(holdingLayer('business', 'asset')).toBe('otherAsset');
    expect(holdingLayer('valuable', 'asset')).toBe('otherAsset');
  });
});

describe('stepTotals', () => {
  test('steps on the recorded day and back-fills the first value into earlier days', () => {
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04'];
    const perKey = new Map([
      ['a', [{ day: '2026-07-02', signed: 100 }, { day: '2026-07-04', signed: 150 }]],
    ]);
    // 07-01 back-fills to 100 (display convention), 07-04 steps to 150
    expect(stepTotals(days, perKey)).toEqual([100, 100, 100, 150]);
  });

  test('sums independent keys', () => {
    const days = ['2026-07-01', '2026-07-02'];
    const perKey = new Map([
      ['a', [{ day: '2026-07-01', signed: 100 }]],
      ['b', [{ day: '2026-07-02', signed: -40 }]],
    ]);
    expect(stepTotals(days, perKey)).toEqual([60, 60]);
  });
});

describe('buildLayerValues', () => {
  const bank = [
    { date: '2026-07-01', balance: 1000 },
    { date: '2026-07-02', balance: 900 },
    { date: '2026-07-03', balance: 1200 },
  ];
  const perHolding = new Map([
    [1, [{ day: '2026-07-01', signed: 5000 }]],                                   // deposit
    [2, [{ day: '2026-07-01', signed: -2000 }, { day: '2026-07-03', signed: -1900 }]], // loan repaid a slice
    [3, [{ day: '2026-07-02', signed: 700 }]],                                    // other asset
  ]);
  const layerOf = new Map<number, ReturnType<typeof holdingLayer>>([
    [1, 'deposit'],
    [2, 'loan'],
    [3, 'otherAsset'],
  ]);
  const perCard = new Map([
    ['5|acc', [{ day: '2026-07-01', signed: -300 }, { day: '2026-07-02', signed: -450 }]],
  ]);

  test('each class gets its own aligned series', () => {
    const layers = buildLayerValues(bank, perHolding, layerOf, perCard);
    expect(layers.checking).toEqual([1000, 900, 1200]);
    expect(layers.card).toEqual([-300, -450, -450]);
    expect(layers.deposit).toEqual([5000, 5000, 5000]);
    expect(layers.loan).toEqual([-2000, -2000, -1900]);
    expect(layers.otherAsset).toEqual([700, 700, 700]); // back-filled first value
    expect(layers.securities).toEqual([0, 0, 0]);
    expect(layers.otherLiability).toEqual([0, 0, 0]);
  });

  test('the layers sum to the combined net-worth series on every day', () => {
    const layers = buildLayerValues(bank, perHolding, layerOf, perCard);
    const total = (i: number) => LAYER_KEYS.reduce((s, k) => s + layers[k][i], 0);
    expect(total(0)).toBe(1000 - 300 + 5000 - 2000 + 700);
    expect(total(1)).toBe(900 - 450 + 5000 - 2000 + 700);
    expect(total(2)).toBe(1200 - 450 + 5000 - 1900 + 700);
  });

  test('a snapshot of a deleted holding is skipped, an empty card map yields zeroes', () => {
    const orphan = new Map([[99, [{ day: '2026-07-01', signed: 123 }]]]);
    const layers = buildLayerValues(bank, orphan, new Map(), new Map());
    expect(layers.card).toEqual([0, 0, 0]);
    expect(layers.deposit).toEqual([0, 0, 0]);
    expect(LAYER_KEYS.reduce((s, k) => s + layers[k][1], 0)).toBe(900);
  });
});

describe('computeAttribution', () => {
  // daily history across two whole flow months (anchor=1) plus a running third
  const history = [
    { date: '2026-04-30', balance: 10_000 },
    { date: '2026-05-15', balance: 11_000 },
    { date: '2026-05-31', balance: 12_000 },
    { date: '2026-06-15', balance: 11_500 },
    { date: '2026-06-30', balance: 13_000 },
    { date: '2026-07-10', balance: 13_400 },
  ];
  const summaries = [
    { month: '2026-07', income: 1_000, expenses: 700 },
    { month: '2026-06', income: 9_000, expenses: 8_500 },
    { month: '2026-05', income: 9_000, expenses: 7_500 },
  ];

  test('flows come from the summaries, revaluation is the residual against ΔNW', () => {
    const rows = computeAttribution(history, summaries, (m) => `${m}-01`, '2026-07');
    expect(rows.map((r) => r.month)).toEqual(['2026-05', '2026-06', '2026-07']);

    const may = rows[0];
    // open = end of 04-30 (last day before 05-01), close = end of 05-31
    expect(may).toMatchObject({ from: '2026-05-01', to: '2026-06-01', open: 10_000, close: 12_000, partial: false });
    // ΔNW 2,000 − flows 1,500 → 500 came from revaluation/coverage
    expect(may.revaluation).toBe(500);

    const june = rows[1];
    expect(june).toMatchObject({ open: 12_000, close: 13_000 });
    expect(june.revaluation).toBe(13_000 - 12_000 - (9_000 - 8_500));

    const july = rows[2];
    expect(july.partial).toBe(true);
    expect(july).toMatchObject({ open: 13_000, close: 13_400 }); // close = the latest point
    expect(july.revaluation).toBe(13_400 - 13_000 - 300);
  });

  test('stops where history can no longer provide an opening balance — nothing invented', () => {
    const rows = computeAttribution(history, summaries, (m) => `${m}-01`, '2026-07');
    // 2026-04 would need a close before 04-01; history starts 04-30 → April is absent
    expect(rows.some((r) => r.month === '2026-04')).toBe(false);
  });

  test('honors the anchor day when cutting month boundaries', () => {
    const rows = computeAttribution(history, summaries, (m) => `${m}-10`, '2026-07');
    const first = rows[0];
    expect(first.from.endsWith('-10')).toBe(true);
    expect(first.to.endsWith('-10')).toBe(true);
  });

  test('a month with no transactions still gets a row with zero flows', () => {
    const rows = computeAttribution(history, [], (m) => `${m}-01`, '2026-07');
    expect(rows[0].income).toBe(0);
    expect(rows[0].expenses).toBe(0);
    expect(rows[0].revaluation).toBe(2_000); // the whole ΔNW is unexplained by flows
  });

  test('empty history yields no rows', () => {
    expect(computeAttribution([], summaries, (m) => `${m}-01`, '2026-07')).toEqual([]);
  });
});

describe('grossTotals', () => {
  test('signed account balances split by sign; manual holdings split by kind', () => {
    const gross = grossTotals(
      [33_000, -4_500], // bank in credit, card debt
      [
        { kind: 'asset', amount: 96_400 },
        { kind: 'liability', amount: 118_600 },
      ],
    );
    expect(gross).toEqual({ assets: 129_400, liabilities: 123_100 });
    // the identity the Sankey draws: assets − liabilities = netWorth
    expect(gross.assets - gross.liabilities).toBe(33_000 - 4_500 + 96_400 - 118_600);
  });

  test('an overdrafted checking account joins the liabilities side', () => {
    const gross = grossTotals([-2_000], []);
    expect(gross).toEqual({ assets: 0, liabilities: 2_000 });
  });
});
