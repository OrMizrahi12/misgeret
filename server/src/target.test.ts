import { describe, expect, test } from 'vitest';
import { isValidTargetRate, savingsTarget, type SavingsTargetInput } from './target.js';
import type { MonthlySummary } from './txns.js';

/** A month said the way a household would: what came in, and what share of it stayed. */
function month(m: string, income: number, keptShare: number): MonthlySummary {
  const net = Math.round(income * keptShare);
  return { month: m, income, expenses: income - net, net };
}

function input(over: Partial<SavingsTargetInput> = {}): SavingsTargetInput {
  return {
    declaredRate: null,
    currentMonth: '2026-07',
    summaries: [
      month('2026-01', 20000, 0.1),
      month('2026-02', 20000, 0.1),
      month('2026-03', 20000, 0.1),
      month('2026-04', 20000, 0.1),
    ],
    commitments: 5000,
    essentialFloor: 3000,
    ...over,
  };
}

describe('savingsTarget — the illustration', () => {
  test('too little history: the rate still stands, but nothing is asserted in shekels', () => {
    const v = savingsTarget(input({ summaries: [month('2026-06', 20000, 0.1)], declaredRate: 0.15 }));
    expect(v.available).toBe(false);
    expect(v.rate).toBe(0.15);
    expect(v.effectiveRate).toBe(0.15);
    expect(v.reliableIncome).toBe(0);
    expect(v.reasonHe).toContain('3 חודשים שלמים');
  });

  test('the running month is never part of the baseline', () => {
    const v = savingsTarget(input({
      summaries: [
        month('2026-05', 20000, 0.1), month('2026-06', 20000, 0.1),
        month('2026-07', 20000, -2), // the running month, barely started
      ],
    }));
    expect(v.completeMonths).toBe(2);
    expect(v.available).toBe(false);
  });

  test('a month with no income at all never drags the baseline down', () => {
    const v = savingsTarget(input({
      summaries: [...input().summaries, { month: '2026-05', income: 0, expenses: 900, net: -900 }],
    }));
    expect(v.completeMonths).toBe(4);
    expect(v.observedRate).toBe(0.1);
  });

  test('the target is measured against RELIABLE income, not the median month', () => {
    const v = savingsTarget(input({
      summaries: [
        month('2026-01', 12000, 0.1), month('2026-02', 16000, 0.1),
        month('2026-03', 20000, 0.1), month('2026-04', 40000, 0.1),
      ],
      declaredRate: 0.1,
    }));
    // P25 of [12000, 16000, 20000, 40000] = 15000 — well under the 18,000 median
    expect(v.reliableIncome).toBe(15000);
    expect(v.keptAmount).toBe(1500);
  });

  test('what is left for variable spending is the derived ceiling', () => {
    const v = savingsTarget(input({ declaredRate: 0.1 }));
    expect(v.reliableIncome).toBe(20000);
    expect(v.keptAmount).toBe(2000);
    expect(v.commitments).toBe(5000);
    expect(v.leftForVariable).toBe(13000);
    expect(v.feasible).toBe(true);
  });

  test('a target that leaves less than the essential floor is called infeasible, out loud', () => {
    const v = savingsTarget(input({ declaredRate: 0.5, commitments: 8000, essentialFloor: 4000 }));
    expect(v.leftForVariable).toBe(2000);
    expect(v.feasible).toBe(false);
    expect(v.noteHe).toContain('לא יחזיק');
  });

  test('a shortfall is stated as a positive magnitude — a minus never rides inside a sentence', () => {
    const v = savingsTarget(input({ declaredRate: 0.2, commitments: 19_000 }));
    expect(v.leftForVariable).toBeLessThan(0);
    expect(v.noteHe).not.toContain('-');
    expect(v.noteHe).not.toContain('−');
    expect(v.noteHe).toContain('חסרים');
    expect(v.noteHe).toContain('לוותר על משהו קבוע');
  });
});

describe('savingsTarget — the suggestion', () => {
  test('a household closing at 10% is offered the next step up, not a round number from a book', () => {
    const v = savingsTarget(input());
    expect(v.observedRate).toBe(0.1);
    expect(v.suggestedRate).toBe(0.15);
    expect(v.suggestionHe).toContain('10%');
    expect(v.suggestionHe).toContain('15%');
  });

  test('a good saver is offered its OWN rate — never a round number below what it already does', () => {
    const v = savingsTarget(input({
      summaries: [
        month('2026-01', 20000, 0.24), month('2026-02', 20000, 0.24),
        month('2026-03', 20000, 0.24), month('2026-04', 20000, 0.24),
      ],
    }));
    // 20% here would be the app telling a 24% saver to save less while claiming to preserve
    // its level — the sentence and the number contradicting each other in one breath
    expect(v.observedRate).toBe(0.24);
    expect(v.suggestedRate).toBe(0.24);
    expect(v.suggestedRate).toBeGreaterThanOrEqual(v.observedRate ?? 0);
    expect(v.suggestionHe).toContain('לקבע בדיוק את זה');
  });

  test('a household closing in the minus gets the turning point, and it is named as one', () => {
    const v = savingsTarget(input({
      summaries: [
        month('2026-01', 20000, -0.05), month('2026-02', 20000, -0.05),
        month('2026-03', 20000, -0.05), month('2026-04', 20000, -0.05),
      ],
    }));
    expect(v.observedRate).toBeLessThan(0);
    expect(v.suggestedRate).toBe(0.05);
    expect(v.suggestionHe).toContain('נקודת המפנה');
  });

  test('the structure caps the suggestion — a target above what the floor allows is never offered', () => {
    // 20,000 reliable − 11,000 commitments − 6,000 essential floor = 3,000 → 15% is the most possible
    const v = savingsTarget(input({ commitments: 11_000, essentialFloor: 6000 }));
    expect(v.maxRate).toBe(0.15);
    expect(v.suggestedRate).toBe(0.15);
    expect(v.suggestionHe).toContain('יותר מ־15% אי אפשר');
  });

  test('when commitments and the floor already take everything, the app says the structure is the problem', () => {
    const v = savingsTarget(input({ commitments: 14_000, essentialFloor: 6000 }));
    expect(v.maxRate).toBe(0);
    expect(v.suggestedRate).toBe(0.05);
    expect(v.suggestionHe).toContain('לוותר על משהו קבוע');
    expect(v.feasible).toBe(false);
  });

  test('the declared rate wins over the suggestion — the app proposes, the household decides', () => {
    const v = savingsTarget(input({ declaredRate: 0.25 }));
    expect(v.suggestedRate).toBe(0.15);
    expect(v.effectiveRate).toBe(0.25);
    expect(v.keptAmount).toBe(5000);
  });

  test('a suggestion always moves in fives — a target is said out loud, not exported to a sheet', () => {
    for (const share of [0.03, 0.07, 0.11, 0.13, 0.17]) {
      const v = savingsTarget(input({
        summaries: ['2026-01', '2026-02', '2026-03', '2026-04'].map((m) => month(m, 20000, share)),
        commitments: 2000,
        essentialFloor: 2000,
      }));
      expect(Math.round(v.suggestedRate * 100) % 5).toBe(0);
    }
  });
});

describe('isValidTargetRate', () => {
  test('accepts a share, rejects a percentage, a zero, a string and a NaN', () => {
    expect(isValidTargetRate(0.15)).toBe(true);
    expect(isValidTargetRate(0.01)).toBe(true);
    expect(isValidTargetRate(0.6)).toBe(true);
    expect(isValidTargetRate(15)).toBe(false);
    expect(isValidTargetRate(0)).toBe(false);
    expect(isValidTargetRate(-0.1)).toBe(false);
    expect(isValidTargetRate('0.15')).toBe(false);
    expect(isValidTargetRate(Number.NaN)).toBe(false);
  });
});
