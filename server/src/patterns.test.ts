import { describe, expect, test } from 'vitest';
import { merchantKey } from './categories.js';
import type { FlaggedTxn } from './companies.js';
import { spendingPatterns, suggestNature } from './patterns.js';
import { row } from './test-helpers.js';

function charge(desc: string, amount: number, date: string, category: string | null = null): FlaggedTxn {
  return { ...row({ date: `${date}T10:00:00.000Z`, amount, description: desc, category }), excluded: false };
}
const K = (d: string) => merchantKey(d);

// monthly on a given day-of-month, Feb..Jul 2026 (6 occurrences, ~30-day gaps → the monthly band)
function monthly(desc: string, amount: number, day: string, category: string | null): FlaggedTxn[] {
  return ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].map((m) => charge(desc, amount, `${m}-${day}`, category));
}

describe('suggestNature', () => {
  test('a frequent cadence is a habit, whatever the merchant', () => {
    expect(suggestNature({ cadence: 'weekly', category: 'transport', amountStable: false, sampleDescription: 'פז' }, 200)).toBe('habit');
    expect(suggestNature({ cadence: 'biweekly', category: 'groceries', amountStable: true, sampleDescription: 'שופרסל' }, 300)).toBe('habit');
  });

  test('a stable periodic charge in a bill category is fixed', () => {
    expect(suggestNature({ cadence: 'monthly', category: 'housing', amountStable: true, sampleDescription: 'שכר דירה' }, 4500)).toBe('fixed');
    expect(suggestNature({ cadence: 'monthly', category: 'bills', amountStable: false, sampleDescription: 'חשמל' }, 400)).toBe('fixed'); // wobbly bill is still fixed
  });

  test('a stable charge reads as a subscription only when it is a recognised service', () => {
    expect(suggestNature({ cadence: 'monthly', category: 'leisure', amountStable: true, sampleDescription: 'NETFLIX' }, 55)).toBe('subscription');
    expect(suggestNature({ cadence: 'monthly', category: 'other', amountStable: true, sampleDescription: 'GOOGLE ONE' }, 75)).toBe('subscription'); // known brand
    expect(suggestNature({ cadence: 'monthly', category: 'other', amountStable: true, sampleDescription: 'לא ידוע' }, 90)).toBe('fixed');  // unknown stable → fixed, not subscription
    expect(suggestNature({ cadence: 'monthly', category: 'other', amountStable: true, sampleDescription: 'לא ידוע' }, 900)).toBe('fixed');
  });

  test('a known discretionary merchant is a habit even when miscategorized', () => {
    expect(suggestNature({ cadence: 'monthly', category: 'other', amountStable: true, sampleDescription: 'סופרמרקט' }, 1600)).toBe('habit'); // name tell beats a wrong category
    expect(suggestNature({ cadence: 'monthly', category: null, amountStable: false, sampleDescription: 'פנגו חשבונית' }, 50)).toBe('habit');
  });

  test('a habit merchant paid via a rail brand is still a habit (habit beats brand noise)', () => {
    // real bug: a supermarket charge whose raw descriptor carried "GOOGLE PAY" was read as a subscription
    expect(suggestNature({ cadence: 'monthly', category: 'other', amountStable: true, sampleDescription: 'GOOGLE PAY' }, 1600, 'סופרמרקט')).toBe('habit');
  });

  test('an installment plan is a fixed commitment, not a habit', () => {
    expect(suggestNature({ cadence: 'monthly', category: 'shopping', amountStable: true, sampleDescription: 'רהיטי הארץ', installmentPlan: true }, 180)).toBe('fixed');
  });

  test('a variable charge in a discretionary category is a habit', () => {
    expect(suggestNature({ cadence: 'monthly', category: 'groceries', amountStable: false, sampleDescription: 'סופר' }, 600)).toBe('habit');
    expect(suggestNature({ cadence: 'monthly', category: 'restaurants', amountStable: false, sampleDescription: 'מסעדה' }, 200)).toBe('habit');
  });

  test('a discretionary category stays a habit even when the amount is steady (category beats amount)', () => {
    // the bug this guards against: steady ₪1,000 of fuel / ₪1,600 of supermarket must NOT read as a commitment
    expect(suggestNature({ cadence: 'monthly', category: 'transport', amountStable: true, sampleDescription: 'דלק' }, 1000)).toBe('habit');
    expect(suggestNature({ cadence: 'monthly', category: 'groceries', amountStable: true, sampleDescription: 'סופרמרקט' }, 1600)).toBe('habit');
    expect(suggestNature({ cadence: 'monthly', category: 'shopping', amountStable: true, sampleDescription: 'קניות אונליין' }, 550)).toBe('habit');
    // but a recognised service filed under a discretionary category still escapes to subscription
    expect(suggestNature({ cadence: 'monthly', category: 'leisure', amountStable: true, sampleDescription: 'NETFLIX' }, 55)).toBe('subscription');
  });
});

describe('spendingPatterns', () => {
  const rows: FlaggedTxn[] = [
    ...monthly('NETFLIX', -54.9, '15', 'leisure'),               // stable service → subscription
    ...monthly('שכר דירה', -4500, '02', 'housing'),             // stable obligation → fixed
    // weekly fuel, variable amount → habit (9 charges, 7-day gaps)
    ...['2026-06-02', '2026-06-09', '2026-06-16', '2026-06-23', '2026-06-30', '2026-07-07', '2026-07-14', '2026-07-21', '2026-07-28']
      .map((d, i) => charge('פז', -(150 + i * 20), d, 'transport')),
  ];

  test('detects and classifies each rhythm by its nature', () => {
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01' });
    const p = (k: string) => view.patterns.find((x) => x.merchant === K(k));
    expect(p('NETFLIX')?.nature).toBe('subscription');
    expect(p('שכר דירה')?.nature).toBe('fixed');
    expect(p('פז')?.nature).toBe('habit');
    expect(p('פז')?.cadence).toBe('weekly');
    expect(p('פז')?.dayOfWeek).not.toBeNull(); // a weekly habit carries a day-of-week tell
  });

  test('a bare detection NEVER counts as committed — only a user verdict lets it in', () => {
    // The approval gate keeps "מחויב מראש" curated rather than auto-populated.
    const unconfirmed = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01' });
    const u = (k: string) => unconfirmed.patterns.find((x) => x.merchant === K(k))!;
    expect(u('NETFLIX').countsAsCommitted).toBe(false);  // confident detection — still a proposal
    expect(u('שכר דירה').countsAsCommitted).toBe(false);
    expect(u('פז').countsAsCommitted).toBe(false);
    expect(unconfirmed.summary.committedMonthly).toBe(0);
    // The same gate covers habits. A guessed habit is a proposal like any other, so it is
    // not summed either — the tab shows it as "מוצע" and the total waits for the user's word.
    expect(u('פז').countsAsHabit).toBe(false);
    expect(unconfirmed.summary.habitMonthly).toBe(0);

    const netflixRow = rows.find((r) => r.description === 'NETFLIX')!;
    const rentRow = rows.find((r) => r.description === 'שכר דירה')!;
    const confirmed = spendingPatterns({
      rows,
      txnMarks: [{ key: netflixRow.key, mark: 'subscription' }, { key: rentRow.key, mark: 'fixed' }],
      today: '2026-08-01',
    });
    const c = (k: string) => confirmed.patterns.find((x) => x.merchant === K(k))!;
    expect(c('NETFLIX').countsAsCommitted).toBe(true);
    expect(c('שכר דירה').countsAsCommitted).toBe(true);
    expect(confirmed.summary.committedMonthly).toBe(confirmed.summary.subscriptionMonthly + confirmed.summary.fixedMonthly);
    expect(confirmed.summary.committedMonthly).toBeGreaterThan(4000); // rent + netflix
  });

  test('a user override wins over the engine guess and marks it confirmed', () => {
    const netflixRow = rows.find((r) => r.description === 'NETFLIX')!;
    const view = spendingPatterns({ rows, txnMarks: [{ key: netflixRow.key, mark: 'fixed' }], today: '2026-08-01' });
    const nf = view.patterns.find((x) => x.merchant === K('NETFLIX'))!;
    expect(nf.nature).toBe('fixed');       // override beats the 'subscription' suggestion
    expect(nf.suggestedNature).toBe('subscription');
    expect(nf.userMarked).toBe(true);
  });

  test('a dismissed merchant stops counting', () => {
    const rentRow = rows.find((r) => r.description === 'שכר דירה')!;
    const view = spendingPatterns({ rows, txnMarks: [{ key: rentRow.key, mark: 'dismissed' }], today: '2026-08-01' });
    const rent = view.patterns.find((x) => x.merchant === K('שכר דירה'))!;
    expect(rent.dismissed).toBe(true);
    expect(rent.countsAsCommitted).toBe(false);
  });

  test('a habit verdict wins over a commitment guess and never counts as committed', () => {
    const netflixRow = rows.find((r) => r.description === 'NETFLIX')!;
    const view = spendingPatterns({ rows, txnMarks: [{ key: netflixRow.key, mark: 'habit' }], today: '2026-08-01' });
    const nf = view.patterns.find((x) => x.merchant === K('NETFLIX'))!;
    expect(nf.suggestedNature).toBe('subscription'); // the engine still thinks it's a service…
    expect(nf.nature).toBe('habit');                 // …but the user's verdict rules
    expect(nf.userMarked).toBe(true);
    expect(nf.countsAsCommitted).toBe(false);
    expect(nf.countsAsHabit).toBe(true);              // confirmed BY the user, so it counts
    expect(view.summary.habitMonthly).toBeGreaterThanOrEqual(nf.monthlyAmount);
  });

  test('an installment plan is committed from its first slices — contractual, no confidence bar', () => {
    // only 2 slices seen: too little support for the statistical auto-count, but the contract is real
    const slice = (n: number, date: string) => charge('רהיטי הארץ', -180, date, 'shopping');
    const instRows = [
      { ...slice(1, '2026-06-05'), type: 'installments' as const, installmentNumber: 1, installmentTotal: 12 },
      { ...slice(2, '2026-07-05'), type: 'installments' as const, installmentNumber: 2, installmentTotal: 12 },
    ];
    const view = spendingPatterns({ rows: instRows, txnMarks: [], today: '2026-07-20' });
    const p = view.patterns.find((x) => x.merchant === K('רהיטי הארץ'))!;
    expect(p.installmentPlan).toBe(true);
    expect(p.nature).toBe('fixed');
    expect(p.countsAsCommitted).toBe(true);
    expect(p.installmentsPaid).toBe(2);
    expect(p.installmentsTotal).toBe(12);
  });

  test('hand-typed manual charges ride in as confirmed committed patterns', () => {
    const manual = [{
      id: 7, name: 'חוג ג׳ודו', amount: 250, cadence: 'monthly' as const, dayOfMonth: 3,
      category: 'education', mark: 'fixed' as const, createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01', manual });
    const m = view.patterns.find((x) => x.merchant === 'manual:7')!;
    expect(m).toBeDefined();
    expect(m.source).toBe('manual');
    expect(m.nature).toBe('fixed');
    expect(m.userMarked).toBe(true);
    expect(m.countsAsCommitted).toBe(true);
    expect(m.monthlyAmount).toBe(250);
    // ONLY the manual charge counts — the detected (unconfirmed) rent stays a proposal
    expect(view.summary.fixedMonthly).toBe(250);
  });

  test('a manual row that duplicates a detected merchant is skipped (no double count)', () => {
    const manual = [{
      id: 8, name: 'NETFLIX', amount: 55, cadence: 'monthly' as const, dayOfMonth: 15,
      category: null, mark: 'subscription' as const, createdAt: '2026-01-01T00:00:00.000Z',
    }];
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01', manual });
    expect(view.patterns.some((x) => x.merchant === 'manual:8')).toBe(false);
    expect(view.patterns.filter((x) => x.name.includes('NETFLIX'))).toHaveLength(1);
  });

  test('detected patterns carry their provenance', () => {
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01' });
    expect(view.patterns.every((p) => p.source === 'detected')).toBe(true);
  });

  test('a rhythm-detected merchant is not duplicated by the frequency path', () => {
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-08-01' });
    expect(view.patterns.filter((x) => x.merchant === K('פז'))).toHaveLength(1);
  });
});

describe('frequency-detected habits (the פז/ילו blind spot)', () => {
  // The real shape that exposed the gap: fuel every ~2 weeks PLUS same-station shop visits on
  // scattered days. Mixed gaps → no cadence band ever wins the detector's ⅔ vote; the monthly
  // fallback demands a steady day-of-month by design. 18 charges over 5 months — and before the
  // frequency path, the richest habit in the account was simply invisible.
  const YELLOW: [string, number][] = [
    ['2026-03-06', -54.18], ['2026-03-13', -327.66], ['2026-03-20', -25], ['2026-04-02', -300],
    ['2026-04-03', -64.7], ['2026-04-10', -25], ['2026-04-17', -49.8], ['2026-04-24', -44.9],
    ['2026-05-01', -364.17], ['2026-05-08', -63.99], ['2026-05-22', -34.9], ['2026-06-05', -300],
    ['2026-06-16', -320.14], ['2026-06-18', -17.42], ['2026-06-26', -41], ['2026-07-02', -300],
    ['2026-07-03', -61.25], ['2026-07-17', -343.51],
  ];
  const yellowRows = YELLOW.map(([d, a]) => charge('פז אפליקציית יילו', a, d, 'transport'));

  test('a rich, frequent, irregular merchant surfaces as a habit', () => {
    const view = spendingPatterns({ rows: yellowRows, txnMarks: [], today: '2026-07-24' });
    const p = view.patterns.find((x) => x.merchant === K('פז אפליקציית יילו'))!;
    expect(p).toBeDefined();
    expect(p.nature).toBe('habit');
    expect(p.occurrences).toBe(18);
    expect(p.active).toBe(true);
    expect(p.countsAsCommitted).toBe(false);              // insight, never money
    // the honest monthly figure: what it actually costs per month over the span
    const total = YELLOW.reduce((s, [, a]) => s + Math.abs(a), 0);
    expect(p.monthlyAmount).toBe(Math.round(total / 5));  // Mar..Jul = 5 months
    // detected but unconfirmed: a proposal, so it is not in the habit total yet
    expect(p.countsAsHabit).toBe(false);
    expect(view.summary.habitMonthly).toBe(0);
  });

  test('confirming the proposed habit is what puts it into the habit total', () => {
    const confirmed = spendingPatterns({
      rows: yellowRows,
      txnMarks: [{ key: yellowRows[0].key, mark: 'habit' }],
      today: '2026-07-24',
    });
    const p = confirmed.patterns.find((x) => x.merchant === K('פז אפליקציית יילו'))!;
    expect(p.userMarked).toBe(true);
    expect(p.countsAsHabit).toBe(true);
    expect(p.countsAsCommitted).toBe(false);              // a habit is never money owed
    expect(confirmed.summary.habitMonthly).toBeGreaterThanOrEqual(p.monthlyAmount);
  });

  test('the frequency path respects verdicts: dismiss removes, a mark confirms', () => {
    const dismissedView = spendingPatterns({
      rows: yellowRows, txnMarks: [{ key: yellowRows[0].key, mark: 'dismissed' }], today: '2026-07-24',
    });
    expect(dismissedView.patterns.find((x) => x.merchant === K('פז אפליקציית יילו'))!.dismissed).toBe(true);

    const markedView = spendingPatterns({
      rows: yellowRows, txnMarks: [{ key: yellowRows[0].key, mark: 'habit' }], today: '2026-07-24',
    });
    const marked = markedView.patterns.find((x) => x.merchant === K('פז אפליקציית יילו'))!;
    expect(marked.userMarked).toBe(true);
    expect(marked.nature).toBe('habit');
  });

  test('issuer spelling drift does not kill a live habit (the פאפא ג\'ונס case)', () => {
    // old spelling for months, then the issuer adds a geresh — one merchant, one live pattern
    const papa = [
      charge('פאפא גונס', -139, '2026-02-06'), charge('פאפא גונס', -120, '2026-02-20'),
      charge('פאפא גונס', -138, '2026-03-06'), charge('פאפא גונס', -131, '2026-03-20'),
      charge('פאפא גונס', -137, '2026-04-03'), charge('פאפא גונס', -125, '2026-04-24'),
      charge("פאפא ג'ונס", -137, '2026-05-29'), charge("פאפא ג'ונס", -143, '2026-06-26'),
      charge("פאפא ג'ונס", -121, '2026-07-10'), charge("פאפא ג'ונס", -142, '2026-07-17'),
    ];
    const view = spendingPatterns({ rows: papa, txnMarks: [], today: '2026-07-24' });
    const mine = view.patterns.filter((x) => x.name.includes('פאפא'));
    expect(mine).toHaveLength(1);          // ONE identity, not a dead fragment + an invisible one
    expect(mine[0].occurrences).toBe(10);
    expect(mine[0].active).toBe(true);
    expect(mine[0].nature).toBe('habit');
  });

  test('one skipped cycle does not kill a pattern — death takes ~2 missed periods', () => {
    // a biweekly habit whose last charge was 40 days ago: silent for ~2.2 gaps, but within the
    // flexible threshold max(45, 2×14+14) = 45 — still alive; another silent week moves it to the archive
    const dates = ['2026-03-05', '2026-03-19', '2026-04-02', '2026-04-16', '2026-04-30', '2026-05-14', '2026-05-28', '2026-06-14'];
    const rows = dates.map((d) => charge('פיצה של שישי', -120, d, 'restaurants'));
    const view = spendingPatterns({ rows, txnMarks: [], today: '2026-07-24' }); // 40d after the last
    const p = view.patterns.find((x) => x.merchant === K('פיצה של שישי'))!;
    expect(p.active).toBe(true);
  });

  test('sparse or stale merchants do NOT qualify — no noise flood', () => {
    // 4 charges: rich enough for a coffee run, not for a pattern
    const sparse = [
      charge('מאפיית השכונה', -18, '2026-05-03'), charge('מאפיית השכונה', -22, '2026-06-01'),
      charge('מאפיית השכונה', -19, '2026-06-20'), charge('מאפיית השכונה', -21, '2026-07-11'),
    ];
    const sparseView = spendingPatterns({ rows: sparse, txnMarks: [], today: '2026-07-24' });
    expect(sparseView.patterns.find((x) => x.merchant === K('מאפיית השכונה'))).toBeUndefined();

    // rich but long-dead: qualifies as a pattern yet reads INACTIVE (falls to the archive, not the wall)
    const staleRows = YELLOW.map(([d, a]) => charge('תחנה ישנה', a, d.replace('2026', '2025'), 'transport'));
    const staleView = spendingPatterns({ rows: staleRows, txnMarks: [], today: '2026-07-24' });
    const stale = staleView.patterns.find((x) => x.merchant === K('תחנה ישנה'))!;
    expect(stale).toBeDefined();
    expect(stale.active).toBe(false);
  });
});

describe('zombie commitments (the שחר רוזן bug)', () => {
  // the real shape: a monthly standing order, 6 charges on the 11th, last on May 11 — by
  // July 24 it is 74 days silent and TWO expected dates (June 11, July 11) came and went,
  // yet the old view kept it "live" with הבא 12 ביוני — a date six weeks in the past.
  const SHAHAR_DATES = ['2025-12-11', '2026-01-11', '2026-02-11', '2026-03-11', '2026-04-11', '2026-05-11'];
  const shahar = SHAHAR_DATES.map((d) => charge('שחר רוזן - רוזן שחר', -1040, d, 'other'));

  test('a monthly commitment that fully missed a cycle (+half-cycle grace) is ENDED', () => {
    const view = spendingPatterns({ rows: shahar, txnMarks: [], today: '2026-07-24' });
    const p = view.patterns.find((x) => x.merchant === K('שחר רוזן - רוזן שחר'))!;
    expect(p.nature).toBe('fixed');
    expect(p.active).toBe(false);               // the archive, not the live wall
    expect(view.summary.rhythmMonthly).toBe(0); // dead money is not "on a rhythm"
  });

  test('a live pattern never advertises a next charge in the past', () => {
    // the same stream observed only ~8 days past a missed date: still inside the grace
    // window, so it is alive — and its "next" must roll forward to a real future date.
    const view = spendingPatterns({ rows: shahar, txnMarks: [], today: '2026-06-19' });
    const p = view.patterns.find((x) => x.merchant === K('שחר רוזן - רוזן שחר'))!;
    expect(p.active).toBe(true);
    expect(p.nextDate >= '2026-06-19').toBe(true);
  });

  test('a habit keeps the generous window the commitment lost', () => {
    // identical silence (74d ≈ 2.4 gaps) — but behaviour, not a contract: the vacation
    // rule (2 missed periods + slack) survives for habits only.
    const habit = SHAHAR_DATES.map((d) => charge('סופר השכונה', -900, d, 'groceries'));
    const view = spendingPatterns({ rows: habit, txnMarks: [], today: '2026-07-24' });
    const p = view.patterns.find((x) => x.merchant === K('סופר השכונה'))!;
    expect(p.nature).toBe('habit');
    expect(p.active).toBe(true);
  });
});
