import { describe, expect, test } from 'vitest';
import type { FlaggedTxn } from './companies.js';
import {
  computeDrift, frameForMonth, frameProposal, proposeSplit, splitProgress, variableByMonth,
  type FrameEntry, type FrameProposalInput,
} from './frame.js';
import { row } from './test-helpers.js';
import type { MonthlySummary } from './txns.js';

const entry = (month: string, amount: number | null): FrameEntry => ({ month, amount, setAt: `${month}-01T00:00:00.000Z` });

describe('frameForMonth', () => {
  test('no history — no frame', () => {
    expect(frameForMonth([], '2026-07')).toBeNull();
  });

  test('a declaration covers its own month and every later month', () => {
    const history = [entry('2026-05', 6000)];
    expect(frameForMonth(history, '2026-05')).toBe(6000);
    expect(frameForMonth(history, '2026-07')).toBe(6000);
    expect(frameForMonth(history, '2027-01')).toBe(6000);
  });

  test('months before the first declaration have no frame — the past is not re-judged', () => {
    expect(frameForMonth([entry('2026-05', 6000)], '2026-04')).toBeNull();
  });

  test('a re-declaration takes over from its month; earlier months keep the frame in force then', () => {
    const history = [entry('2026-05', 6000), entry('2026-07', 6500)];
    expect(frameForMonth(history, '2026-06')).toBe(6000);
    expect(frameForMonth(history, '2026-07')).toBe(6500);
    expect(frameForMonth(history, '2026-08')).toBe(6500);
  });

  test('order of history rows does not matter', () => {
    const history = [entry('2026-07', 6500), entry('2026-05', 6000)];
    expect(frameForMonth(history, '2026-06')).toBe(6000);
  });

  test('switching off is a declaration: null from that month on, earlier months keep their frame', () => {
    const history = [entry('2026-05', 6000), entry('2026-08', null)];
    expect(frameForMonth(history, '2026-07')).toBe(6000);
    expect(frameForMonth(history, '2026-08')).toBeNull();
    expect(frameForMonth(history, '2026-09')).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────── */

function flag(t: ReturnType<typeof row>): FlaggedTxn {
  return { ...t, excluded: false };
}

describe('variableByMonth', () => {
  test('a live commitment is fixed; everything else is variable, split by category', () => {
    const rows: FlaggedTxn[] = [
      flag(row({ date: '2026-06-02T10:00:00.000Z', amount: -4200, description: 'שכר דירה', category: 'housing' })),
      flag(row({ date: '2026-06-05T10:00:00.000Z', amount: -600, description: 'שופרסל', category: 'groceries' })),
      flag(row({ date: '2026-06-09T10:00:00.000Z', amount: -180, description: 'מסעדה', category: 'restaurants' })),
      flag(row({ date: '2026-06-11T10:00:00.000Z', amount: 12000, description: 'משכורת' })),
    ];
    const fixed = new Set(['שכר דירה']);
    const { total, byCategory } = variableByMonth(rows, fixed);
    expect(total['2026-06']).toBe(780);
    expect(byCategory['2026-06']).toEqual({ groceries: 600, restaurants: 180 });
  });

  test('pending and excluded rows never enter — the frame measures money that moved', () => {
    const rows: FlaggedTxn[] = [
      flag(row({ date: '2026-06-05T10:00:00.000Z', amount: -600, description: 'שופרסל', category: 'groceries', status: 'pending' })),
      { ...flag(row({ date: '2026-06-06T10:00:00.000Z', amount: -900, description: 'העברה', category: 'transfers' })), excluded: true },
    ];
    expect(variableByMonth(rows, new Set()).total['2026-06']).toBeUndefined();
  });
});

/* ───────────────────────────────────────────────────────────────────────────────────────── */

const summary = (month: string, income: number, expenses: number): MonthlySummary =>
  ({ month, income, expenses, net: income - expenses });

/** Six complete months of a household that earns 20,000, is committed to 9,000 and spends
 *  6,000 of variable — plus the running month, which must never enter a baseline. */
function baseInput(over: Partial<FrameProposalInput> = {}): FrameProposalInput {
  const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const variable: Record<string, number> = {};
  const variableCategory: Record<string, Record<string, number>> = {};
  for (const m of months) {
    variable[m] = 6000;
    variableCategory[m] = { groceries: 3000, restaurants: 1200, transport: 900, shopping: 600, leisure: 300 };
  }
  return {
    currentMonth: '2026-07',
    summaries: [...months.map((m) => summary(m, 20000, 15000)), summary('2026-07', 9000, 7000)],
    variable,
    variableCategory,
    fixedMonthly: 9000,
    liquidTotal: 60000,
    history: [],
    ...over,
  };
}

describe('frameProposal', () => {
  test('thin data proposes nothing and says why — a ceiling invented from one month is a guess', () => {
    const p = frameProposal(baseInput({
      summaries: [summary('2026-06', 20000, 15000), summary('2026-07', 9000, 7000)],
      variable: { '2026-06': 6000 },
      variableCategory: { '2026-06': { groceries: 6000 } },
    }));
    expect(p.available).toBe(false);
    expect(p.reasonHe).toContain('3 חודשים');
    expect(p.recommended).toBe(0);
  });

  test('the running month never enters the baseline', () => {
    // July holds a partial 500 ₪ of variable spend; if it counted, the median would collapse
    const input = baseInput();
    input.variable['2026-07'] = 500;
    input.variableCategory['2026-07'] = { groceries: 500 };
    expect(frameProposal(input).observed.medianVariable).toBe(6000);
  });

  test('the ceiling is built on RELIABLE income, never the median — half the months sit below a median', () => {
    // three lean months among six: the median shrugs them off, a ceiling cannot
    const input = baseInput();
    input.summaries = input.summaries.map((s) =>
      ['2026-01', '2026-02', '2026-03'].includes(s.month) ? summary(s.month, 12000, 15000) : s);
    const p = frameProposal(input);
    expect(p.observed.typicalIncome).toBe(16000); // the middle month, kept for context only
    expect(p.observed.reliableIncome).toBe(12000); // what the frame is actually built on
    // and the ceiling follows the reliable figure, not the middle one
    expect(p.observed.freeSpace).toBeLessThan(16000 - 9000);
  });

  test('a single bonus month never raises the ceiling', () => {
    const input = baseInput();
    input.summaries = input.summaries.map((s) => (s.month === '2026-03' ? summary(s.month, 60000, 15000) : s));
    expect(frameProposal(input).observed.reliableIncome).toBe(20000);
  });

  test('something is ALWAYS set aside — a household that declared no savings still protects a share', () => {
    const p = frameProposal(baseInput());
    // 10% of reliable income, because the cushion is healthy
    expect(p.observed.setAside).toBe(2000);
    expect(p.observed.freeSpace).toBe(9000); // 20,000 − 9,000 commitments − 2,000 aside
    expect(p.derivation.map((d) => d.labelHe)).toContain('הפרשה לצד');
  });

  test('a thin cushion protects MORE, not less', () => {
    // essentials 3,900 + commitments 9,000 = 12,900/month; 12,000 liquid is under a month
    const p = frameProposal(baseInput({ liquidTotal: 12000 }));
    expect(p.observed.setAside).toBe(3000); // 15%, not 10%
    expect(p.observed.freeSpace).toBe(8000);
  });

  test('THE PROMISE: staying inside the frame sets money aside and closes the month in plus', () => {
    const p = frameProposal(baseInput());
    expect(p.recommended).toBe(6000); // the structure allows 9,000; the habit is 6,000
    expect(p.promise).toEqual({ atIncome: 20000, setAside: 2000, leftOver: 3000, kept: true });
    // and the promise reconciles: income − commitments − aside − frame = what is left over
    expect(20000 - 9000 - p.promise!.setAside - p.recommended).toBe(p.promise!.leftOver);
    expect(p.rationaleHe).toContain('אין סיבה להזמין הוצאה נוספת');
  });

  test('spending above what the structure allows: the frame lands on the number that keeps both promises', () => {
    const p = frameProposal(baseInput({ fixedMonthly: 13000 }));
    // 20,000 − 13,000 − 2,000 = 5,000 of room against a 6,000 habit
    expect(p.observed.freeSpace).toBe(5000);
    expect(p.recommended).toBe(5000);
    expect(p.promise).toMatchObject({ setAside: 2000, leftOver: 0, kept: true });
    expect(p.rationaleHe).toContain('גם מפרישים וגם לא נכנסים לגירעון');
  });

  test('the essential floor is absolute — and when it breaks the promise, the promise says so', () => {
    const input = baseInput({ fixedMonthly: 14000 });
    for (const m of Object.keys(input.variableCategory)) {
      input.variableCategory[m] = { groceries: 4000, transport: 1200, bills: 800 };
    }
    const p = frameProposal(input);
    expect(p.observed.essentialFloor).toBe(6000);
    expect(p.observed.freeSpace).toBe(4000); // 20,000 − 14,000 − 2,000
    // the structure says 4,000; the floor refuses to go under 6,600
    expect(p.recommended).toBe(6600);
    expect(p.rationaleHe).toContain('נעצרה ברצפה החיונית');
    // ...and the app does not pretend the guarantee still holds
    expect(p.promise?.kept).toBe(false);
    expect(p.promise!.leftOver).toBeLessThan(0);
    expect(p.stances[1].meaningHe).toContain('לא מבטיחה חודש מאוזן');
  });

  test('the three stances are ordered, and the derivation reconciles to the room left', () => {
    const p = frameProposal(baseInput());
    const [tight, recommended, comfortable] = p.stances;
    expect(tight.amount).toBeLessThanOrEqual(recommended.amount);
    expect(recommended.amount).toBeLessThanOrEqual(comfortable.amount);
    const plus = p.derivation.filter((d) => d.sign === 'plus').reduce((s, d) => s + d.amount, 0);
    const minus = p.derivation.filter((d) => d.sign === 'minus').reduce((s, d) => s + d.amount, 0);
    const total = p.derivation.find((d) => d.sign === 'total');
    expect(total?.amount).toBe(plus - minus);
    expect(total?.amount).toBe(9000); // 20,000 − 9,000 − 2,000 (the 10% beats the declared 1,000)
    // "נוח" drops the extra protection but keeps what the household itself committed to
    expect(comfortable.amount).toBe(11000);
  });

  test('a negative free space is named rather than dressed up as a ceiling', () => {
    const p = frameProposal(baseInput({ fixedMonthly: 23000 }));
    expect(p.observed.freeSpace).toBeLessThan(0);
    expect(p.stances[2].meaningHe).toContain('שלילי');
  });

  test('commitments beyond reliable income: the frame drops to the floor and names the real problem', () => {
    const p = frameProposal(baseInput({ fixedMonthly: 23000 }));
    // the cushion is thin against these commitments, so 15% is protected: 20,000 − 23,000 − 3,000
    expect(p.observed.setAside).toBe(3000);
    expect(p.observed.freeSpace).toBe(-6000);
    expect(p.observed.essentialFloor).toBe(3900);
    expect(p.recommended).toBe(4300); // the floor + 10%, not the 6,000 habit
    expect(p.rationaleHe).toContain('להקטין מחויבות');
    expect(p.promise?.kept).toBe(false);
  });
});

describe('proposeSplit', () => {
  const months = ['2026-05', '2026-06'];
  const cats = {
    '2026-05': { groceries: 3000, restaurants: 1200, transport: 900, shopping: 600, leisure: 200, health: 100 },
    '2026-06': { groceries: 3000, restaurants: 1200, transport: 900, shopping: 600, leisure: 200, health: 100 },
  };

  test('the split always sums to the frame exactly', () => {
    const split = proposeSplit(6000, months, cats);
    expect(split.reduce((s, r) => s + r.amount, 0)).toBe(6000);
  });

  test('at most four named rows; the tail folds into one steerable remainder', () => {
    const split = proposeSplit(6000, months, cats);
    expect(split.filter((r) => r.category !== 'rest')).toHaveLength(4);
    expect(split[split.length - 1].category).toBe('rest');
    expect(split[0].category).toBe('groceries');
  });

  test('shares scale with the frame, not with history — a smaller frame shrinks every row', () => {
    const big = proposeSplit(6000, months, cats);
    const small = proposeSplit(3000, months, cats);
    expect(small[0].amount).toBeLessThan(big[0].amount);
    expect(small.reduce((s, r) => s + r.amount, 0)).toBe(3000);
  });

  test('a category nobody can steer never gets a row — its shekels fold into the remainder', () => {
    const withTransfers = {
      '2026-05': { transfers: 7000, groceries: 2000, restaurants: 900 },
      '2026-06': { transfers: 7000, groceries: 2000, restaurants: 900 },
    };
    const split = proposeSplit(10000, months, withTransfers);
    expect(split.map((r) => r.category)).not.toContain('transfers');
    expect(split.map((r) => r.category)).toContain('groceries');
    // nothing vanishes: the frame is still fully allocated, the tail just sits in the remainder
    expect(split.reduce((s, r) => s + r.amount, 0)).toBe(10000);
    expect(split[split.length - 1].category).toBe('rest');
  });

  test('no history, no split — the app never invents a household it has not seen', () => {
    expect(proposeSplit(6000, [], {})).toEqual([]);
    expect(proposeSplit(0, months, cats)).toEqual([]);
  });
});

describe('splitProgress', () => {
  test('projects each category at its own pace and flags the ones running over', () => {
    const split = [
      { category: 'groceries', nameHe: 'מזון', amount: 3000, medianSpend: 3000 },
      { category: 'restaurants', nameHe: 'מסעדות', amount: 1200, medianSpend: 1200 },
      { category: 'rest', nameHe: 'שאר ההוצאות', amount: 800, medianSpend: 800 },
    ];
    // ten days in: groceries on pace, restaurants already at half its month
    const progress = splitProgress(split, { groceries: 1000, restaurants: 600, leisure: 200 }, 10, 30);
    expect(progress[0].projected).toBe(3000);
    expect(progress[0].over).toBe(false);
    expect(progress[1].projected).toBe(1800);
    expect(progress[1].over).toBe(true);
    // anything outside the named rows lands in the remainder
    expect(progress[2].spent).toBe(200);
  });
});

describe('computeDrift', () => {
  const months = ['2026-04', '2026-05', '2026-06'];
  const history = [entry('2026-01', 6000)];

  test('three consecutive overruns say the number was wrong, not that the household failed', () => {
    const drift = computeDrift(history, { '2026-04': 6900, '2026-05': 6800, '2026-06': 6700 }, months);
    expect(drift?.direction).toBe('over');
    expect(drift?.gap).toBe(800);
    expect(drift?.honestAmount).toBe(6800);
  });

  test('a mixed run is life, not a signal', () => {
    expect(computeDrift(history, { '2026-04': 6900, '2026-05': 5500, '2026-06': 6700 }, months)).toBeNull();
  });

  test('a small consistent gap is not worth re-opening a decision', () => {
    expect(computeDrift(history, { '2026-04': 6100, '2026-05': 6150, '2026-06': 6120 }, months)).toBeNull();
  });

  test('consistently far under is drift too — a frame nobody touches steers nothing', () => {
    const drift = computeDrift(history, { '2026-04': 4200, '2026-05': 4000, '2026-06': 4300 }, months);
    expect(drift?.direction).toBe('under');
    expect(drift?.honestAmount).toBe(4200);
  });

  test('months with no frame in force are not judged', () => {
    // the frame starts in May, so only two months could ever be judged
    expect(computeDrift([entry('2026-05', 6000)], { '2026-04': 9000, '2026-05': 9000, '2026-06': 9000 }, months)).toBeNull();
  });

  test('each month is judged against the frame in force THEN', () => {
    const raised = [entry('2026-01', 6000), entry('2026-06', 9000)];
    // June's 8,000 is UNDER its own 9,000 frame, so the run is no longer consistent
    expect(computeDrift(raised, { '2026-04': 6900, '2026-05': 6800, '2026-06': 8000 }, months)).toBeNull();
  });
});
