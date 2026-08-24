import { describe, expect, test } from 'vitest';
import { merchantKey } from './categories.js';
import type { ExcludeReason, FlaggedTxn } from './companies.js';
import type { ManualRecurringRow } from './db.js';
import { detectRecurring, type RecurringItem } from './recurring.js';
import {
  activeInstallmentPlans, anchorsToBackfill, buildExpenseDetail, deriveMerchantMarks, isClassifiableExpense,
  isExpenseCharge, manualToRecurringItem, merchantHistory, nextOccurrence, promotedRecurringItems, regularityScore,
  subscriptionMerchants, subscriptionPriceChanges, type TxnMarkValue,
} from './subscriptions.js';
import { row } from './test-helpers.js';

function flag(t: ReturnType<typeof row>, excluded = false, excludeReason?: ExcludeReason): FlaggedTxn {
  return { ...t, excluded, ...(excludeReason ? { excludeReason } : {}) };
}
function charge(desc: string, amount: number, date: string): FlaggedTxn {
  return flag(row({ date: `${date}T10:00:00.000Z`, amount, description: desc }));
}

function manualRow(over: Partial<ManualRecurringRow> = {}): ManualRecurringRow {
  return {
    id: 1, name: 'ChatGPT', amount: 74, cadence: 'monthly', dayOfMonth: 20, category: 'other',
    mark: 'subscription', createdAt: '2026-07-01T00:00:00.000Z', ...over,
  };
}

const NETFLIX = [charge('NETFLIX', -54.9, '2026-06-15'), charge('NETFLIX', -54.9, '2026-07-15')];
const marksFor = (rows: FlaggedTxn[], mark: TxnMarkValue) => rows.map((r) => ({ key: r.key, mark }));

describe('deriveMerchantMarks', () => {
  test('a single per-transaction mark classifies the whole merchant', () => {
    const marks = [{ key: NETFLIX[0].key, mark: 'subscription' as const }];
    const m = deriveMerchantMarks(marks, NETFLIX);
    expect(m.get('NETFLIX')).toBe('subscription');
  });

  test('the dominant mark across a merchant wins', () => {
    const marks = [
      { key: NETFLIX[0].key, mark: 'subscription' as const },
      { key: NETFLIX[1].key, mark: 'fixed' as const },
      ...marksFor([charge('NETFLIX', -54.9, '2026-05-15')], 'subscription'),
    ];
    const rows = [...NETFLIX, charge('NETFLIX', -54.9, '2026-05-15')];
    // 2 subscription vs 1 fixed → subscription
    expect(deriveMerchantMarks(marks, rows).get('NETFLIX')).toBe('subscription');
  });

  test('a habit verdict aggregates like any other, and ties break toward the commitment mark', () => {
    expect(deriveMerchantMarks(marksFor(NETFLIX, 'habit'), NETFLIX).get('NETFLIX')).toBe('habit');
    // 1 fixed vs 1 habit — the more actionable (commitment) signal wins the tie
    const split = [
      { key: NETFLIX[0].key, mark: 'fixed' as const },
      { key: NETFLIX[1].key, mark: 'habit' as const },
    ];
    expect(deriveMerchantMarks(split, NETFLIX).get('NETFLIX')).toBe('fixed');
  });
});

describe('merchantHistory', () => {
  const noMarks: { key: string; mark: TxnMarkValue }[] = [];
  const K = (d: string) => merchantKey(d);

  test('rolls a merchant\'s charges into an oldest→newest history with pattern stats', () => {
    const rows = [
      charge('NETFLIX', -54.9, '2026-07-15'),
      charge('NETFLIX', -54.9, '2026-05-15'),
      charge('NETFLIX', -54.9, '2026-06-15'),
      charge('SPOTIFY', -20, '2026-06-01'),
    ];
    const h = merchantHistory({ rows, merchant: K('NETFLIX'), txnMarks: noMarks })!;
    expect(h.count).toBe(3);
    expect(h.charges.map((c) => c.date)).toEqual(['2026-05-15', '2026-06-15', '2026-07-15']);
    expect(h.charges.every((c) => c.amount === 54.9)).toBe(true); // positive magnitude
    expect(h.typicalAmount).toBe(54.9);
    expect(h.minAmount).toBe(54.9);
    expect(h.maxAmount).toBe(54.9);
    expect(h.varied).toBe(false);
    expect(h.firstDate).toBe('2026-05-15');
    expect(h.lastDate).toBe('2026-07-15');
    expect(h.dayOfMonth).toBe(15);
    expect(h.mark).toBeNull();
  });

  test('flags a variable-price charge as varied, with the true min/max spread', () => {
    const rows = [
      charge('OPENAI.COM', -70, '2026-03-20'),
      charge('OPENAI.COM', -308, '2026-04-20'),
      charge('OPENAI.COM', -700, '2026-05-20'),
    ];
    const h = merchantHistory({ rows, merchant: K('OPENAI.COM'), txnMarks: noMarks })!;
    expect(h.varied).toBe(true);
    expect(h.minAmount).toBe(70);
    expect(h.maxAmount).toBe(700);
    expect(h.typicalAmount).toBe(308); // median of [70, 308, 700]
  });

  test('reflects a merchant verdict; returns null for a merchant with no charges', () => {
    const rows = [charge('NETFLIX', -54.9, '2026-07-15')];
    const marked = merchantHistory({ rows, merchant: K('NETFLIX'), txnMarks: [{ key: rows[0].key, mark: 'subscription' }] })!;
    expect(marked.mark).toBe('subscription');
    expect(merchantHistory({ rows, merchant: 'NOSUCHMERCHANT', txnMarks: noMarks })).toBeNull();
  });
});

describe('isExpenseCharge', () => {
  test('an ordinary expense qualifies; income and excluded flows do not', () => {
    expect(isExpenseCharge(charge('NETFLIX', -54.9, '2026-07-15'))).toBe(true);
    expect(isExpenseCharge(charge('SALARY', 12000, '2026-07-01'))).toBe(false);
    expect(isExpenseCharge(flag(row({ date: '2026-07-15T10:00Z', amount: -100, description: 'X' }), true))).toBe(false);
  });
});

describe('isClassifiableExpense', () => {
  test('a transfer the engine excluded is still classifiable; card double-counts and income are not', () => {
    const rentTransfer = flag(row({ date: '2026-07-02T10:00Z', amount: -5200, description: 'העברה שכר דירה' }), true, 'transfer');
    const savingsMove = flag(row({ date: '2026-07-05T10:00Z', amount: -2000, description: 'הפקדה לפקדון' }), true, 'savings');
    const partialMirror = flag(row({ date: '2026-07-10T10:00Z', amount: -3000, description: 'חיוב כרטיס' }), true, 'partial');
    expect(isClassifiableExpense(rentTransfer)).toBe(true);   // a real recurring commitment — must be visible
    expect(isClassifiableExpense(savingsMove)).toBe(true);
    expect(isClassifiableExpense(partialMirror)).toBe(false); // card double-count — withheld
    expect(isClassifiableExpense(charge('SALARY', 12000, '2026-07-01'))).toBe(false); // income
  });
});

describe('promotedRecurringItems', () => {
  test('a user-marked merchant the detector missed becomes a forecastable item', () => {
    const merchantMark = new Map([['NETFLIX', 'subscription' as const]]);
    const items = promotedRecurringItems(merchantMark, NETFLIX, new Set(), '2026-07-20');
    expect(items).toHaveLength(1);
    const [it] = items;
    expect(it.merchant).toBe('NETFLIX');
    expect(it.company).toBe('manual');        // stays out of the calibrated balance curve
    expect(it.cadence).toBe('monthly');        // ~30-day gap
    expect(it.amount).toBe(-54.9);
    expect(it.kind).toBe('expense');
  });

  test('a merchant the detector already found is not double-promoted', () => {
    const merchantMark = new Map([['NETFLIX', 'subscription' as const]]);
    const items = promotedRecurringItems(merchantMark, NETFLIX, new Set(['NETFLIX']), '2026-07-20');
    expect(items).toHaveLength(0);
  });

  test('a dismissed merchant is never promoted', () => {
    const merchantMark = new Map([['NETFLIX', 'dismissed' as const]]);
    expect(promotedRecurringItems(merchantMark, NETFLIX, new Set(), '2026-07-20')).toHaveLength(0);
  });

  test('a habit merchant is never promoted — behaviour is not a bill', () => {
    const merchantMark = new Map([['NETFLIX', 'habit' as const]]);
    expect(promotedRecurringItems(merchantMark, NETFLIX, new Set(), '2026-07-20')).toHaveLength(0);
  });

  test('a promoted merchant whose charges STOPPED goes inactive — a verdict is not immortality', () => {
    // the שחר רוזן zombie, promoted-path variant: marked "fixed", last charge months back.
    // Without the staleness law it would feed the plan and the forecast forever.
    const merchantMark = new Map([['NETFLIX', 'fixed' as const]]);
    const fresh = promotedRecurringItems(merchantMark, NETFLIX, new Set(), '2026-07-20')[0];
    expect(fresh.active).toBe(true);           // 5 days after the last charge — alive
    expect(fresh.forecastEligible).toBe(true);
    const stale = promotedRecurringItems(merchantMark, NETFLIX, new Set(), '2026-10-20')[0];
    expect(stale.active).toBe(false);          // ~3 months silent — dead, and OUT of the forecast
    expect(stale.forecastEligible).toBe(false);
  });
});

describe('buildExpenseDetail', () => {
  const detected: RecurringItem[] = [];

  test('lists expense charges with their own marks and a merchant summary', () => {
    const rows = [...NETFLIX, charge('SALARY', 12000, '2026-07-01')]; // income excluded from the list
    const view = buildExpenseDetail({ rows, detected, txnMarks: marksFor(NETFLIX, 'subscription'), manual: [], today: '2026-07-20' });
    expect(view.txns).toHaveLength(2); // only the two NETFLIX expense rows
    expect(view.txns.every((t) => t.merchant === 'NETFLIX')).toBe(true);
    expect(view.txns.every((t) => t.mark === 'subscription')).toBe(true);
    expect(view.summary.subscriptionCount).toBe(1);      // one merchant
    expect(view.summary.subscriptionMonthly).toBe(55);   // synthesized monthly of ~54.9
    expect(view.summary.unclassifiedCount).toBe(0);
    expect(view.summary.totalTxns).toBe(2);
  });

  test('unmarked expenses are counted as unclassified', () => {
    const view = buildExpenseDetail({ rows: NETFLIX, detected, txnMarks: [], manual: [], today: '2026-07-20' });
    expect(view.summary.unclassifiedCount).toBe(2);
    expect(view.summary.subscriptionCount).toBe(0);
    expect(view.txns.every((t) => t.mark === null)).toBe(true);
  });

  test('manual subscriptions add to the count and the monthly total', () => {
    const view = buildExpenseDetail({ rows: [], detected, txnMarks: [], manual: [manualRow()], today: '2026-07-20' });
    expect(view.summary.subscriptionCount).toBe(1);
    expect(view.summary.subscriptionMonthly).toBe(74);
    expect(view.manual).toHaveLength(1);
  });

  test('charges roll up to a merchant group carrying count, verdict, and the underlying txns', () => {
    const rows = [
      ...NETFLIX,
      charge('רמי לוי', -180, '2026-07-03'),
      charge('רמי לוי', -212, '2026-06-19'),
      charge('רמי לוי', -95, '2026-06-04'),
    ];
    const view = buildExpenseDetail({ rows, detected, txnMarks: marksFor(NETFLIX, 'subscription'), manual: [], today: '2026-07-20' });
    const netflix = view.merchants.find((m) => m.merchant === 'NETFLIX');
    const rami = view.merchants.find((m) => m.merchant === 'רמי לוי');
    expect(netflix?.count).toBe(2);
    expect(netflix?.mark).toBe('subscription');
    expect(netflix?.txns).toHaveLength(2);
    expect(rami?.count).toBe(3);
    expect(rami?.mark).toBeNull();            // unclassified
    expect(rami?.typicalAmount).toBe(-180);   // median of -180/-212/-95
    // newest charge is the display name/date; txns come newest-first
    expect(rami?.lastDate.startsWith('2026-07-03')).toBe(true);
    expect(rami?.txns[0].date.startsWith('2026-07-03')).toBe(true);
  });

  test('a recurring bank transfer the engine excluded is surfaced, labeled, and classifiable', () => {
    const rent = ['2026-05-02', '2026-06-02', '2026-07-02'].map((d) =>
      flag(row({ date: `${d}T10:00:00.000Z`, amount: -5200, description: 'העברה שכר דירה' }), true, 'transfer'));
    const view = buildExpenseDetail({ rows: rent, detected, txnMarks: [], manual: [], today: '2026-07-20' });
    const m = view.merchants.find((x) => x.name === 'העברה שכר דירה');
    expect(m?.count).toBe(3);                    // it appears at all — the whole point
    expect(m?.excluded).toBe(true);
    expect(m?.excludeReasonHe).toBe('העברה');    // labeled so the user understands why it wasn't counted
    expect(view.txns.every((t) => t.excluded && t.excludeReasonHe === 'העברה')).toBe(true);
  });
});

describe('regularityScore', () => {
  test('an even monthly cadence scores near 1', () => {
    expect(regularityScore(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'])).toBeGreaterThan(0.85);
  });
  test('an erratic cadence scores low', () => {
    expect(regularityScore(['2026-01-01', '2026-01-03', '2026-06-01'])).toBeLessThan(0.3);
  });
  test('a lone charge has no rhythm; a single gap is neutral', () => {
    expect(regularityScore(['2026-01-01'])).toBe(0);
    expect(regularityScore(['2026-01-01', '2026-02-01'])).toBe(0.5);
  });
});

describe('subscriptionMerchants', () => {
  test('subscription merchants (not fixed) and manual subscriptions are tagged', () => {
    const set = subscriptionMerchants(
      new Map([['NETFLIX', 'subscription'], ['ARNONA', 'fixed']]),
      [manualRow({ name: 'Spotify', mark: 'subscription' })],
    );
    expect(set.has('NETFLIX')).toBe(true);
    expect(set.has('ARNONA')).toBe(false);
    expect(set.has('Spotify')).toBe(true); // normalizePattern preserves case
  });
});

describe('manualToRecurringItem / nextOccurrence', () => {
  test('a yearly charge becomes a signed expense with a monthly-equivalent', () => {
    const it = manualToRecurringItem(manualRow({ name: 'ביטוח', amount: 3600, cadence: 'yearly', dayOfMonth: 3 }), '2026-07-10');
    expect(it.amount).toBe(-3600);
    expect(it.monthlyAmount).toBe(-300);
    expect(it.company).toBe('manual');
  });

  test('nextOccurrence lands strictly in the future on the anchor day', () => {
    expect(nextOccurrence('2026-07-10', 'monthly', 20)).toBe('2026-07-20');
    expect(nextOccurrence('2026-07-25', 'monthly', 20)).toBe('2026-08-20');
  });
});

describe('generic transfers split by memo payee (the "העברה דיגיטל" bug)', () => {
  const digital = (date: string, amount: number, memo: string): FlaggedTxn =>
    flag(row({ date: `${date}T10:00:00.000Z`, amount, description: 'העברה דיגיטל', memo, company: 'leumi' }));
  const RENT = 'העברה אל: מנחם פינטו 12-642-000290739 שכר דירה';
  const GIFT = 'העברה אל: נועה לב ארי 31-039-000416142 חתונה';

  test('rent becomes its own named, detectable merchant — not lumped with an unrelated transfer', () => {
    const rows = [
      digital('2026-04-08', -3500, RENT), digital('2026-05-09', -3500, RENT),
      digital('2026-06-08', -3500, RENT), digital('2026-07-08', -3500, RENT),
      digital('2026-06-18', -4100, GIFT), // same description, different payee — the wedding gift
    ];
    const detected = detectRecurring(rows, { today: '2026-07-20' });
    const view = buildExpenseDetail({ rows, detected, txnMarks: [], manual: [], today: '2026-07-20' });

    const rentM = view.merchants.find((m) => m.name === 'מנחם פינטו שכר דירה');
    const giftM = view.merchants.find((m) => m.name === 'נועה לב ארי חתונה');
    expect(rentM?.count).toBe(4);          // the four rent charges grouped together
    expect(giftM?.count).toBe(1);          // the gift is a SEPARATE merchant, not folded in
    expect(rentM?.detected).toBe(true);    // and the recurring rent is auto-recognized
    // the detector produced a clean monthly stream for the rent
    const rentStream = detected.find((d) => d.sampleDescription === 'מנחם פינטו שכר דירה');
    expect(rentStream?.cadence).toBe('monthly');
    expect(rentStream?.amount).toBe(-3500);
  });
});

describe('subscription price anchoring & change detection (the OpenAI tier-change case)', () => {
  // the user's real shape: a variable-price sub that ramped up, with a two-charge upgrade month
  const OPENAI = [
    charge('OPENAI', -70, '2026-03-29'),
    charge('OPENAI', -308, '2026-04-28'),
    charge('OPENAI', -452, '2026-05-04'),
    charge('OPENAI', -700, '2026-06-04'),
    charge('OPENAI', -390, '2026-07-04'), // the upgrade shuffle: two charges, one month…
    charge('OPENAI', -310, '2026-07-04'), // …that together total ₪700
  ];
  const subMarks = marksFor(OPENAI, 'subscription');
  const mark = deriveMerchantMarks(subMarks, OPENAI);

  test('the displayed amount is the ANCHOR, not the median of the noisy charges', () => {
    const view = buildExpenseDetail({
      rows: OPENAI, detected: [], txnMarks: subMarks, manual: [], today: '2026-07-23',
      expected: new Map([['OPENAI', 700]]),
    });
    const m = view.merchants.find((x) => x.merchant === 'OPENAI');
    expect(m?.monthlyAmount).toBe(700);              // what the user marked — NOT the ₪350 median
    expect(view.summary.subscriptionMonthly).toBe(700);
  });

  test('backfill anchors an un-anchored sub to its latest SETTLED month total (₪700, not a partial)', () => {
    const anchors = anchorsToBackfill(OPENAI, mark, new Set(), '2026-07-23');
    // July is the running month → June (₪700) is the latest settled month
    expect(anchors).toEqual([{ merchant: 'OPENAI', amount: 700 }]);
    // and it never overwrites an existing anchor
    expect(anchorsToBackfill(OPENAI, mark, new Set(['OPENAI']), '2026-07-23')).toEqual([]);
  });

  test('a two-charge upgrade month that still totals the anchor does NOT false-alarm', () => {
    // now July is settled (today in August); its two charges sum to ₪700 = the anchor
    const changes = subscriptionPriceChanges({
      rows: OPENAI, merchantMark: mark,
      expected: [{ merchant: 'OPENAI', amount: 700, alertedAmount: null }], today: '2026-08-05',
    });
    expect(changes).toEqual([]); // per-MONTH aggregation is what saves us here
  });

  test('a real tier change fires one alert with the new monthly cost', () => {
    const rows = [charge('OPENAI', -700, '2026-06-04'), charge('OPENAI', -300, '2026-07-04')];
    const m2 = deriveMerchantMarks(marksFor(rows, 'subscription'), rows);
    const changes = subscriptionPriceChanges({
      rows, merchantMark: m2, expected: [{ merchant: 'OPENAI', amount: 700, alertedAmount: null }], today: '2026-08-05',
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ merchant: 'OPENAI', expected: 700, latest: 300, month: '2026-07' });
  });

  test('an FX / rounding wiggle stays quiet (within 15% AND ₪15)', () => {
    const rows = [charge('OPENAI', -700, '2026-06-04'), charge('OPENAI', -690, '2026-07-04')];
    const m2 = deriveMerchantMarks(marksFor(rows, 'subscription'), rows);
    expect(subscriptionPriceChanges({
      rows, merchantMark: m2, expected: [{ merchant: 'OPENAI', amount: 700, alertedAmount: null }], today: '2026-08-05',
    })).toEqual([]);
  });

  test('a dismissed one-off (alertedAmount) does not nag again', () => {
    const rows = [charge('OPENAI', -700, '2026-06-04'), charge('OPENAI', -300, '2026-07-04')];
    const m2 = deriveMerchantMarks(marksFor(rows, 'subscription'), rows);
    expect(subscriptionPriceChanges({
      rows, merchantMark: m2, expected: [{ merchant: 'OPENAI', amount: 700, alertedAmount: 300 }], today: '2026-08-05',
    })).toEqual([]);
  });
});

describe('activeInstallmentPlans (open תשלומים for cash-flow)', () => {
  const inst = (desc: string, amount: number, date: string, n: number, total: number): FlaggedTxn =>
    flag(row({ date: `${date}T10:00:00.000Z`, amount, description: desc, company: 'max', type: 'installments', installmentNumber: n, installmentTotal: total }));

  test('surfaces payments/amount left and the end month from the k/N the card reports', () => {
    const rows = [
      inst('ווישור ביטוח רכב', -176, '2026-04-12', 3, 12),
      inst('ווישור ביטוח רכב', -176, '2026-05-12', 4, 12),
      inst('ווישור ביטוח רכב', -176, '2026-06-12', 5, 12),
      inst('ווישור ביטוח רכב', -176, '2026-07-12', 6, 12),
    ];
    const detected = detectRecurring(rows, { today: '2026-07-23' });
    const plans = activeInstallmentPlans(detected);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ paid: 6, total: 12, remaining: 6, sliceAmount: 176, remainingAmount: 1056 });
    expect(plans[0].endDate?.slice(0, 7)).toBe('2027-01'); // six more monthly slices after July
  });

  test('a finished plan (last slice N/N) is not "open"', () => {
    const rows = [
      inst('רהיטי הארץ', -180, '2026-02-12', 4, 6),
      inst('רהיטי הארץ', -180, '2026-03-12', 5, 6),
      inst('רהיטי הארץ', -180, '2026-04-12', 6, 6),
    ];
    expect(activeInstallmentPlans(detectRecurring(rows, { today: '2026-07-23' }))).toEqual([]);
  });

  test('an open-ended subscription (no installment slices) is not an installment plan', () => {
    expect(activeInstallmentPlans(detectRecurring(NETFLIX, { today: '2026-07-23' }))).toEqual([]);
  });
});
