import { describe, expect, test } from 'vitest';
import {
  SYNC_WINDOW_MONTHS,
  companyKind,
  companyNameHe,
  companyOutage,
  flagExcluded,
  isCardSettlement,
  isSettlementShaped,
  isTransferLike,
  listCompanies,
  settlementCompany,
  syncErrorType,
  syncWindowMonths,
  type FlowClass,
} from './companies.js';
import { resolveCategory } from './categories.js';
import { toMonthlySummary } from './txns.js';
import { row } from './test-helpers.js';

describe('listCompanies', () => {
  test('excludes OTP-based companies (oneZero)', () => {
    expect(listCompanies().some((c) => c.id === 'oneZero')).toBe(false);
  });

  test('includes leumi with Hebrew name and translated fields', () => {
    const leumi = listCompanies().find((c) => c.id === 'leumi');
    expect(leumi).toBeDefined();
    expect(leumi!.nameHe).toBe('בנק לאומי');
    expect(leumi!.kind).toBe('bank');
    expect(leumi!.loginFields).toEqual([
      { name: 'username', labelHe: 'שם משתמש', secret: false },
      { name: 'password', labelHe: 'סיסמה', secret: true },
    ]);
  });

  test('marks card6Digits as secret and translates isracard fields', () => {
    const isracard = listCompanies().find((c) => c.id === 'isracard');
    expect(isracard!.kind).toBe('card');
    expect(isracard!.loginFields.map((f) => f.name)).toEqual(['id', 'card6Digits', 'password']);
    expect(isracard!.loginFields.find((f) => f.name === 'card6Digits')!.secret).toBe(true);
  });

  test('banks are listed before cards, cards before other', () => {
    const kinds = listCompanies().map((c) => c.kind);
    expect(kinds.slice(kinds.indexOf('card'))).not.toContain('bank');
    expect(kinds.slice(kinds.indexOf('other'))).not.toContain('card');
  });

  test('does not offer a bank that no longer exists (union)', () => {
    // the library still defines it; the picker is built from that list at run time, so without an
    // explicit withdrawal a bank that merged into Mizrahi-Tefahot in 2022 is still on offer
    expect(listCompanies().some((c) => c.id === 'union')).toBe(false);
    // but its name survives, for any row synced before it died
    expect(companyNameHe('union')).toBe('בנק איגוד');
  });

  test('every offered company states how far back it actually goes', () => {
    for (const c of listCompanies()) {
      expect(c.historyMonths).toBeGreaterThan(0);
      expect(c.historyMonths).toBeLessThanOrEqual(SYNC_WINDOW_MONTHS);
    }
    // the two that reach our full window, and the one that barely reaches at all
    expect(syncWindowMonths('leumi')).toBe(24);
    expect(syncWindowMonths('max')).toBe(24);
    expect(syncWindowMonths('visaCal')).toBe(18);
    expect(syncWindowMonths('hapoalim')).toBe(12);
    // three, not the six its README claims — the ceiling is read from the code
    expect(syncWindowMonths('yahav')).toBe(3);
    // an institution we have not measured is never assumed generous
    expect(syncWindowMonths('somethingNew')).toBe(12);
  });

  test('a known outage rides on the company it belongs to, and only on it', () => {
    const listed = listCompanies();
    expect(listed.find((c) => c.id === 'hapoalim')!.outage?.since).toBe('2026-06-02');
    expect(listed.find((c) => c.id === 'leumi')!.outage).toBeNull();
    expect(companyOutage('hapoalim')!.noteHe).toContain('בנק הפועלים');
  });
});

describe('syncErrorType', () => {
  test('sanitises whatever the library returns before it reaches the DB or the screen', () => {
    expect(syncErrorType('leumi', 'INVALID_PASSWORD')).toBe('INVALID_PASSWORD');
    expect(syncErrorType('leumi', 'Error: connect ECONNREFUSED')).toBe('GENERIC');
    expect(syncErrorType('leumi', '<script>')).toBe('GENERIC');
  });

  test('a known outage explains a hang — never a wrong password', () => {
    // the shapes a dead login page produces
    expect(syncErrorType('hapoalim', 'TIMEOUT')).toBe('PROVIDER_OUTAGE');
    expect(syncErrorType('hapoalim', 'GENERIC')).toBe('PROVIDER_OUTAGE');
    expect(syncErrorType('hapoalim', 'GENERAL_ERROR')).toBe('PROVIDER_OUTAGE');
    // and the ones that are the person's own business, which must survive untouched: telling
    // someone "the bank is broken" when their password expired sends them nowhere
    expect(syncErrorType('hapoalim', 'INVALID_PASSWORD')).toBe('INVALID_PASSWORD');
    expect(syncErrorType('hapoalim', 'CHANGE_PASSWORD')).toBe('CHANGE_PASSWORD');
    expect(syncErrorType('hapoalim', 'ACCOUNT_BLOCKED')).toBe('ACCOUNT_BLOCKED');
    // a bank with no outage keeps its timeout
    expect(syncErrorType('leumi', 'TIMEOUT')).toBe('TIMEOUT');
  });
});

describe('companyKind / companyNameHe', () => {
  test('classifies known companies and falls back for unknown', () => {
    expect(companyKind('hapoalim')).toBe('bank');
    expect(companyKind('visaCal')).toBe('card');
    expect(companyKind('whatever')).toBe('other');
    expect(companyNameHe('max')).toBe('מקס');
    expect(companyNameHe('whatever')).toBe('whatever');
  });
});

describe('isCardSettlement', () => {
  test('matches only when that card company is connected', () => {
    expect(isCardSettlement('ישראכרט בעמ', new Set(['isracard']))).toBe(true);
    expect(isCardSettlement('ישראכרט בעמ', new Set(['visaCal']))).toBe(false);
    expect(isCardSettlement('ישראכרט בעמ', new Set())).toBe(false);
    expect(isCardSettlement('העברה לפקדון', new Set(['isracard']))).toBe(false);
  });
});

describe('flagExcluded — card settlements', () => {
  const connected = new Set(['isracard']);
  const settlement = () =>
    row({ date: '2026-05-10T10:00:00.000Z', amount: -3500, description: 'ישראכרט בעמ', company: 'leumi' });
  const cardTxn = () =>
    row({ date: '2026-05-02T10:00:00.000Z', amount: -3500, description: 'קניה בכרטיס', company: 'isracard', account: 'card-1' });

  test('flags the settlement when the card connection covers that month', () => {
    const flagged = flagExcluded([settlement(), cardTxn()], connected);
    const s = flagged.find((r) => r.company === 'leumi')!;
    expect(s.excluded).toBe(true);
    expect(s.excludeReason).toBe('settlement');
  });

  test('does NOT flag the settlement when no card data exists for that month — it is the only record of the spending', () => {
    expect(flagExcluded([settlement()], connected)[0].excluded).toBe(false);
    const juneCard = row({ date: '2026-06-02T10:00:00.000Z', amount: -900, description: 'קניה', company: 'isracard' });
    expect(flagExcluded([settlement(), juneCard], connected).find((r) => r.company === 'leumi')!.excluded).toBe(false);
  });

  test('never flags rows from card connections themselves', () => {
    const rows = [row({ date: '2026-05-10T10:00:00.000Z', amount: -100, description: 'ישראכרט חיוב', company: 'isracard' })];
    expect(flagExcluded(rows, connected)[0].excluded).toBe(false);
  });

  test('refund credits from the card company are excluded too — they already exist in the card details', () => {
    // card details net −3400 (purchases −3500 + refund +100); bank side: debit −3500 + credit +100
    const refundInDetails = row({ date: '2026-05-20T10:00:00.000Z', amount: 100, description: 'זיכוי דומינוס', company: 'isracard', account: 'card-1' });
    const bankCredit = row({ date: '2026-05-22T10:00:00.000Z', amount: 100, description: 'ישראכרט זיכוי', company: 'leumi' });
    const flagged = flagExcluded([settlement(), bankCredit, cardTxn(), refundInDetails], connected);
    const leumiRows = flagged.filter((r) => r.company === 'leumi');
    expect(leumiRows.every((r) => r.excluded && r.excludeReason === 'settlement')).toBe(true);
    expect(flagged.filter((r) => r.company === 'isracard').every((r) => !r.excluded)).toBe(true);
  });

  test('one card account settling under two bank descriptions — both excluded when details cover the total', () => {
    // the real-world Max case: part debits as "מקס איט פיננ-י", part as "לאומי ויזה"
    const maxIt = row({ date: '2026-03-09T10:00:00.000Z', amount: -1426.93, description: 'מקס איט פיננ-י', company: 'leumi' });
    const leumiVisa = row({ date: '2026-03-09T10:00:00.000Z', amount: -6924.04, description: 'לאומי ויזה', company: 'leumi', account: 'acc-x' });
    const details = row({ date: '2026-03-09T10:00:00.000Z', amount: -8350.97, description: 'סך עסקאות', company: 'max', account: 'card-1' });
    const flagged = flagExcluded([maxIt, leumiVisa, details], new Set(['max']));
    expect(flagged.filter((r) => r.company === 'leumi').every((r) => r.excluded && r.excludeReason === 'settlement')).toBe(true);
    expect(flagged.find((r) => r.company === 'max')!.excluded).toBe(false);
  });

  test('bank credits from the card company with no counterpart in the details stay counted as income', () => {
    // the details mirror the debits exactly — the credit (cashback / interest refund) is money
    // the card statement knows nothing about, so excluding it would erase real income
    const debit = row({ date: '2026-03-09T10:00:00.000Z', amount: -8350.97, description: 'לאומי ויזה', company: 'leumi' });
    const credit = row({ date: '2026-03-16T10:00:00.000Z', amount: 872.78, description: 'לאומי ויזה', company: 'leumi' });
    const details = row({ date: '2026-03-09T10:00:00.000Z', amount: -8350.97, description: 'סך עסקאות', company: 'max', account: 'card-1' });
    const flagged = flagExcluded([debit, credit, details], new Set(['max']));
    expect(flagged.find((r) => r.amount === -8350.97 && r.company === 'leumi')!.excludeReason).toBe('settlement');
    expect(flagged.find((r) => r.amount === 872.78)!.excluded).toBe(false);
    expect(flagged.find((r) => r.company === 'max')!.excluded).toBe(false);
  });

  test('partial card history: details fall short of the settlement → bank rows count, details excluded', () => {
    // history starts mid-cycle: the card shows only 2058.47 of a 6586.56 debit
    const maxIt = row({ date: '2026-02-09T10:00:00.000Z', amount: -1091.68, description: 'מקס איט פיננ-י', company: 'leumi' });
    const leumiVisa = row({ date: '2026-02-09T10:00:00.000Z', amount: -5494.88, description: 'לאומי ויזה', company: 'leumi', account: 'acc-x' });
    const details = row({ date: '2026-02-05T10:00:00.000Z', amount: -2058.47, description: 'קניה', company: 'max', account: 'card-1' });
    const flagged = flagExcluded([maxIt, leumiVisa, details], new Set(['max']));
    expect(flagged.filter((r) => r.company === 'leumi').every((r) => !r.excluded)).toBe(true);
    const d = flagged.find((r) => r.company === 'max')!;
    expect(d.excluded).toBe(true);
    expect(d.excludeReason).toBe('partial');
  });

  test('pending card rows are not coverage — the settlement still counts', () => {
    const pendingCard = { ...cardTxn(), status: 'pending' as const };
    const flagged = flagExcluded([settlement(), pendingCard], connected);
    expect(flagged.find((r) => r.company === 'leumi')!.excluded).toBe(false);
  });

  test('does not flag when the card is not connected', () => {
    expect(flagExcluded([settlement(), cardTxn()], new Set())[0].excluded).toBe(false);
  });

  test("short patterns match whole words only — a transfer to מיכאל is not a Cal settlement", () => {
    expect(settlementCompany('העברה למיכאל כהן')).toBeNull();
    expect(settlementCompany('חיוב כאל')).toBe('visaCal');
    expect(settlementCompany('כ.א.ל ויזה')).toBe('visaCal');
    expect(settlementCompany('מקס איט פיננסים')).toBe('max');
    expect(settlementCompany('מקס איט פיננ-י')).toBe('max');
    expect(settlementCompany('לאומי ויזה')).toBe('max');
    expect(settlementCompany('העברה מבנק לאומי')).toBeNull();
    expect(settlementCompany('מקסיקני טעים')).toBeNull();
  });
});

describe('flagExcluded — internal transfers', () => {
  const bitOut = (account: string, day: string, amount = -350) =>
    row({ date: `2026-05-${day}T10:00:00.000Z`, amount, description: 'העברה ב BIT', account, company: 'leumi' });
  const bitIn = (account: string, day: string, amount = 350) =>
    row({ date: `2026-05-${day}T10:00:00.000Z`, amount, description: 'העברה ב BIT', account, company: 'hapoalim' });

  test('opposite amounts, different accounts, within 3 days → both excluded as transfer', () => {
    const flagged = flagExcluded([bitOut('a', '14'), bitIn('b', '15')], new Set());
    expect(flagged.every((r) => r.excluded && r.excludeReason === 'transfer')).toBe(true);
  });

  test('same account never pairs', () => {
    const flagged = flagExcluded([bitOut('a', '14'), bitIn('a', '15')], new Set());
    expect(flagged.every((r) => !r.excluded)).toBe(true);
  });

  test('more than 3 days apart never pairs', () => {
    const flagged = flagExcluded([bitOut('a', '10'), bitIn('b', '15')], new Set());
    expect(flagged.every((r) => !r.excluded)).toBe(true);
  });

  test('different magnitudes never pair', () => {
    const flagged = flagExcluded([bitOut('a', '14', -350), bitIn('b', '15', 351)], new Set());
    expect(flagged.every((r) => !r.excluded)).toBe(true);
  });

  test('no transfer-like description on either side → no pair', () => {
    const rows = [
      row({ date: '2026-05-14T10:00:00.000Z', amount: -350, description: 'קניה', account: 'a' }),
      row({ date: '2026-05-15T10:00:00.000Z', amount: 350, description: 'זיכוי', account: 'b' }),
    ];
    expect(flagExcluded(rows, new Set()).every((r) => !r.excluded)).toBe(true);
  });

  test('pending rows never pair', () => {
    const rows = [bitOut('a', '14'), { ...bitIn('b', '15'), status: 'pending' as const }];
    expect(flagExcluded(rows, new Set()).every((r) => !r.excluded)).toBe(true);
  });

  test('a row participates in at most one pair; earliest counterpart wins', () => {
    const flagged = flagExcluded([bitOut('a', '14'), bitIn('b', '15'), bitIn('c', '16')], new Set());
    const excluded = flagged.filter((r) => r.excluded);
    expect(excluded).toHaveLength(2);
    expect(excluded.some((r) => r.account === 'c')).toBe(false);
  });

  test('ביט matches whole words only — insurance and refunds are NOT transfers', () => {
    expect(isTransferLike('ביטוח הראל בריאות')).toBe(false);
    expect(isTransferLike('ביטול עסקה')).toBe(false);
    expect(isTransferLike('ביט העברה')).toBe(true);
    expect(isTransferLike('העברה ב BIT')).toBe(true);
    expect(isTransferLike('BITON BAKERY')).toBe(false);
  });

  test('card rows never participate in transfer pairs', () => {
    const cardRefund = row({
      date: '2026-05-15T10:00:00.000Z', amount: 350, description: 'ביט זיכוי', account: 'card-1', company: 'isracard',
    });
    const flagged = flagExcluded([bitOut('a', '14'), cardRefund], new Set());
    expect(flagged.every((r) => !r.excluded)).toBe(true);
  });
});

/** The father's real Discount statement of 06.07 — the four rows that motivated this engine.
 *  The app reported ~+20,700 income and ~−20,805 expenses for that day. The truth is +700
 *  income and −105 tax, and July's ₪39,679 "אחר" was ₪20,700 of pure fiction. */
const RENEWAL = 'חידוש פיקדון פק"מ משנה ומעלה';
const fathersJuly = () => [
  row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: RENEWAL, company: 'discount' }),
  row({ date: '2026-07-06T10:00:00.000Z', amount: 700, description: 'רווח מפיקדון מתחדש', company: 'discount' }),
  row({ date: '2026-07-06T10:00:00.000Z', amount: -20700, description: RENEWAL, company: 'discount' }),
  row({ date: '2026-07-06T10:00:00.000Z', amount: -105, description: 'תשלום מס על רווח מפיקדון שחודש', company: 'discount' }),
];

describe("flagExcluded — savings principal (the father's July)", () => {
  test('both legs of the renewal are excluded as savings; the interest and the tax are not', () => {
    const flagged = flagExcluded(fathersJuly(), new Set());
    const principal = flagged.filter((r) => r.description === RENEWAL);
    expect(principal).toHaveLength(2);
    expect(principal.every((r) => r.excluded && r.excludeReason === 'savings')).toBe(true);
    // the two legs are never equal (principal returns, principal + interest re-deposits) and land
    // in the same account — which is exactly why the transfer pairing engine could never see them
    expect(flagged.find((r) => r.amount === 700)!.excluded).toBe(false);
    expect(flagged.find((r) => r.amount === -105)!.excluded).toBe(false);
  });

  test('THE HEADLINE: that month reports income 700 and expenses 105 — not 20,700 / 20,805', () => {
    const categorized = fathersJuly().map((t) => {
      const resolved = resolveCategory(t, [], {});
      return { ...t, category: resolved.category, categorySource: resolved.source };
    });
    expect(categorized.find((t) => t.amount === 700)!.category).toBe('income');
    expect(categorized.find((t) => t.amount === -105)!.category).toBe('fees');

    const summary = toMonthlySummary(flagExcluded(categorized, new Set()));
    expect(summary).toEqual([{ month: '2026-07', income: 700, expenses: 105, net: 595 }]);
  });

  test('a one-legged deposit is internal too — no pairing, no equal amounts, cross-month', () => {
    // money into a deposit in March and back out in September is not an expense in March
    // nor income in September. Either sign, on its own.
    const out = row({ date: '2026-03-10T10:00:00.000Z', amount: -50000, description: 'הפקדה לפק"ם', company: 'discount' });
    const back = row({ date: '2026-09-10T10:00:00.000Z', amount: 50000, description: 'משיכה מפק״ם', company: 'discount' });
    expect(flagExcluded([out], new Set())[0]).toMatchObject({ excluded: true, excludeReason: 'savings' });
    expect(flagExcluded([back], new Set())[0]).toMatchObject({ excluded: true, excludeReason: 'savings' });
  });

  test('a routine custody fee is a real expense and must never be deleted', () => {
    const rows = [
      row({ date: '2026-07-01T10:00:00.000Z', amount: -32, description: 'דמי ניהול פקדון ני"ע', company: 'discount' }),
      row({ date: '2026-07-01T10:00:00.000Z', amount: -18, description: 'דמי ניהול קרן השתלמות', company: 'discount' }),
    ];
    expect(flagExcluded(rows, new Set()).every((r) => !r.excluded)).toBe(true);
  });

  test('pending rows are not data yet', () => {
    const pending = { ...fathersJuly()[0], status: 'pending' as const };
    expect(flagExcluded([pending], new Set())[0].excluded).toBe(false);
  });

  test('the bank-only guard: a card row is never swallowed by the vocabulary', () => {
    // a merchant literally named פיקדון arrives on a card row — that is real spending
    const merchant = row({
      date: '2026-07-06T10:00:00.000Z', amount: -240, description: 'פיקדון בע"מ', company: 'isracard', account: 'card-1',
    });
    expect(flagExcluded([merchant], new Set())[0].excluded).toBe(false);
  });

  test('a salary and an ordinary merchant name no instrument and are never touched', () => {
    const rows = [
      row({ date: '2026-07-01T10:00:00.000Z', amount: 12400, description: 'משכורת חברה בע"מ', company: 'discount' }),
      row({ date: '2026-07-02T10:00:00.000Z', amount: -95, description: 'מסעדת שקשוקה', company: 'discount' }),
      row({ date: '2026-07-03T10:00:00.000Z', amount: 2000, description: 'החזר מס', company: 'discount' }),
    ];
    expect(flagExcluded(rows, new Set()).every((r) => !r.excluded)).toBe(true);
  });

  test('THE MEMO IS READ HERE TOO — one vocabulary cannot read two different texts', () => {
    // resolveCategory has always read description + memo. Reading description alone here meant the
    // two tiers judged different text and this one silently won: a bank that puts the return word
    // in the memo had its real interest income deleted, and one that puts the INSTRUMENT there got
    // no fix at all. Both directions, on the field israeli-bank-scrapers actually populates.
    const interest = row({
      date: '2026-07-06T10:00:00.000Z', amount: 700, description: 'זיכוי פיקדון', memo: 'ריבית זכות', company: 'discount',
    });
    expect(resolveCategory(interest, [], {})).toEqual({ category: 'income', source: 'auto' });
    expect(flagExcluded([interest], new Set())[0].excluded).toBe(false);

    const principal = row({
      date: '2026-07-06T10:00:00.000Z', amount: -20000, description: 'העברה', memo: 'פיקדון פק"ם', company: 'discount',
    });
    expect(flagExcluded([principal], new Set())[0]).toMatchObject({ excluded: true, excludeReason: 'savings' });
  });

  test('AN ANNUITY CREDIT IS INCOME, NOT PRINCIPAL — and the two tiers now agree', () => {
    // a retiree's monthly קצבה names a גמל instrument: the income family resolved it to income
    // while this tier deleted it as principal, taking his main credit out of the savings rate,
    // the plan's incomeSoFar and the green streak — while the balance forecast still saw it land.
    const annuity = row({ date: '2026-07-05T10:00:00.000Z', amount: 5000, description: 'קצבת פנסיה מקרן גמל', company: 'discount' });
    expect(resolveCategory(annuity, [], {})).toEqual({ category: 'income', source: 'auto' });
    expect(flagExcluded([annuity], new Set())[0].excluded).toBe(false);

    // a lump-sum withdrawal from the same pot names no payout word: still principal
    const lumpSum = row({ date: '2026-07-05T10:00:00.000Z', amount: 80000, description: 'משיכה מקופת גמל', company: 'discount' });
    expect(flagExcluded([lumpSum], new Set())[0]).toMatchObject({ excluded: true, excludeReason: 'savings' });
  });
});

describe('SETTLEMENT_SHAPED — a settlement, not any row with a card word in it', () => {
  test('a card brand stands alone; the generic כרטיס needs a settlement verb', () => {
    expect(isSettlementShaped('חיוב לכרטיס ויזה 5020')).toBe(true);
    expect(isSettlementShaped('דיינרס בע"מ')).toBe(true);
    expect(isSettlementShaped('פרעון כרטיס אשראי')).toBe(true);
  });

  test('EVERY LEUMI DEBIT PURCHASE IS NOT A DOUBLE COUNT', () => {
    // 'כרטיס דביט' describes every Leumi debit-card purchase and the merchant hides in the memo;
    // 'עמלת דמי כרטיס' is a ₪40 fee. A bare-כרטיס match made a permanent, unactionable alarm out
    // of a real user's entire everyday spending — false, and it never retires.
    expect(isSettlementShaped('כרטיס דביט')).toBe(false);
    expect(isSettlementShaped('עמלת דמי כרטיס')).toBe(false);
    expect(isSettlementShaped('הקצאת אשראי')).toBe(false);
    expect(isSettlementShaped('חיוב ריבית אשראי')).toBe(false);
  });

  test('a settlement pays a card, never a merchant: a memo naming one is a purchase', () => {
    const memo = 'מתאריך 26/05/25 22:52 בכרטיס המסתיים ב-1649 ב-פז אפליקציית יילו';
    expect(isSettlementShaped('חיוב בכרטיס דביט', memo)).toBe(false);
    expect(isSettlementShaped('חיוב לכרטיס ויזה 5020', null)).toBe(true);
  });
});

describe('flagExcluded — the user is the final authority over meaning', () => {
  const overrides = (pattern: string, cls: FlowClass) => new Map([[pattern, cls]]);

  test("'internal' excludes a pattern the vocabulary knows nothing about", () => {
    const r = row({ date: '2026-07-06T10:00:00.000Z', amount: -9000, description: 'משהו שהבנק המציא 123', company: 'discount' });
    const flagged = flagExcluded([r], new Set(), overrides('משהו שהבנק המציא', 'internal'));
    expect(flagged[0]).toMatchObject({ excluded: true, excludeReason: 'manual' });
  });

  test("'flow' un-excludes what the savings vocabulary decided", () => {
    const flagged = flagExcluded(fathersJuly(), new Set(), overrides('חידוש פיקדון פק מ משנה ומעלה', 'flow'));
    expect(flagged.filter((r) => r.description === RENEWAL).every((r) => !r.excluded)).toBe(true);
  });

  test("'flow' pins a transfer-like pair open — the pairing loop may not undo the user's word", () => {
    const out = row({ date: '2026-05-14T10:00:00.000Z', amount: -350, description: 'העברה ב BIT', account: 'a', company: 'leumi' });
    const back = row({ date: '2026-05-15T10:00:00.000Z', amount: 350, description: 'העברה ב BIT', account: 'b', company: 'hapoalim' });
    expect(flagExcluded([out, back], new Set()).every((r) => r.excluded)).toBe(true);
    const flagged = flagExcluded([out, back], new Set(), overrides('העברה ב BIT', 'flow'));
    expect(flagged.every((r) => !r.excluded)).toBe(true);
  });

  test('the settlement arbitration is untouchable — meaning is the user\'s, arbitration is not', () => {
    // which of two records of ONE payment counts is not an opinion: a second one here produces
    // either a double count or an artificially green month
    const settlement = row({ date: '2026-05-10T10:00:00.000Z', amount: -3500, description: 'ישראכרט בעמ', company: 'leumi' });
    const cardTxn = row({ date: '2026-05-02T10:00:00.000Z', amount: -3500, description: 'קניה בכרטיס', company: 'isracard', account: 'card-1' });
    const flagged = flagExcluded([settlement, cardTxn], new Set(['isracard']), overrides('ישראכרט בעמ', 'flow'));
    expect(flagged.find((r) => r.company === 'leumi')!).toMatchObject({ excluded: true, excludeReason: 'settlement' });
  });

  test('both legs of one renewal collapse to a single taught key — one click, not two', () => {
    const flagged = flagExcluded(fathersJuly(), new Set(), overrides('חידוש פיקדון פק מ משנה ומעלה', 'internal'));
    const principal = flagged.filter((r) => r.description === RENEWAL);
    expect(principal.every((r) => r.excluded && r.excludeReason === 'manual')).toBe(true);
  });
});
