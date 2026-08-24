import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  APPLICABLE_LINES,
  createdHolding,
  decays,
  isApplicableLine,
  kindForType,
  parseAccountState,
  remainingPaymentsTextHe,
  resolveLine,
  stalenessDays,
  type HoldingRef,
} from './account-state.js';

const FIXTURE = fs.readFileSync(new URL('../test/fixtures/discount-account-state.txt', import.meta.url), 'utf8');

describe('parseAccountState', () => {
  test('the real Discount paste parses to the bank`s five lines, every amount a magnitude', () => {
    const { lines, understood, ignored } = parseAccountState(FIXTURE);

    // the bank's own order, not the panel's
    expect(lines.map((l) => l.line)).toEqual(['checking', 'card', 'loan', 'deposit', 'securities']);
    expect(lines.map((l) => l.amount)).toEqual([3456.78, 1234.56, 45678.90, 12345.67, 0.00]);
    expect(understood).toBe(5);
    // nothing in the summary went unread — the fixture is the text the bank produced, nothing else (A13)
    expect(ignored).toBe(0);
    for (const line of lines) expect(line.amount).toBeGreaterThanOrEqual(0); // A8
  });

  test('echoes the bank`s own label back', () => {
    const byLine = new Map(parseAccountState(FIXTURE).lines.map((l) => [l.line, l.label]));
    expect(byLine.get('loan')).toBe('הלוואות');
    expect(byLine.get('deposit')).toBe('פקדונות וחסכונות');
    expect(byLine.get('securities')).toBe('תיק ניירות ערך');
  });

  test('a heading above the real row does not shadow it', () => {
    // the fixture's עו"ש label appears twice: once bare as a heading, once with the figure
    expect(parseAccountState(FIXTURE).lines.find((l) => l.line === 'checking')!.amount).toBe(3456.78);
  });

  test('the artifact the fixture used to carry would have been counted as unread', () => {
    expect(parseAccountState(`${FIXTURE}\n</content>`).ignored).toBe(1);
    expect(parseAccountState(`${FIXTURE}\n</content>`).understood).toBe(5);
  });

  test('unknown text understands nothing and invents nothing', () => {
    expect(parseAccountState('שלום עולם\nמשהו אחר לגמרי')).toEqual({ lines: [], understood: 0, ignored: 0 });
    expect(parseAccountState('')).toEqual({ lines: [], understood: 0, ignored: 0 });
    expect(parseAccountState('₪1,234.56')).toEqual({ lines: [], understood: 0, ignored: 0 });
  });

  test('partial text yields only what was there', () => {
    const { lines, understood } = parseAccountState('הלוואות\n₪45,678.90');
    expect(lines).toEqual([{ line: 'loan', label: 'הלוואות', amount: 45678.90, printedSign: 1 }]);
    expect(understood).toBe(1);
  });

  test('a label with no figure yields no line rather than a zero', () => {
    // אין ≠ 0: a label the bank printed without a number is not a balance of nothing
    expect(parseAccountState('הלוואות\nפקדונות וחסכונות\n₪500.00').lines).toEqual([
      { line: 'deposit', label: 'פקדונות וחסכונות', amount: 500, printedSign: 1 },
    ]);
  });

  test('counts lines inside the summary that carried neither label nor figure', () => {
    expect(parseAccountState('הלוואות\n₪100.00\nרעש כלשהו\nעוד רעש').ignored).toBe(2);
  });

  test('text above the first label is page chrome, not unread data', () => {
    const { ignored, understood } = parseAccountState('מצב החשבון שלך\nתפריט\nהלוואות\n₪100.00');
    expect(ignored).toBe(0);
    expect(understood).toBe(1);
  });

  test('gershayim, RTL marks and synonyms all reach the same line', () => {
    expect(parseAccountState('יתרת עו״ש\n‏₪3,456.78').lines[0]).toEqual({
      line: 'checking', label: 'יתרת עו"ש', amount: 3456.78, printedSign: 1,
    });
    expect(parseAccountState('פקדון\n₪10.00').lines[0].line).toBe('deposit');
    expect(parseAccountState('הלוואה\n₪10.00').lines[0].line).toBe('loan');
    expect(parseAccountState('ניירות ערך\n₪10.00').lines[0].line).toBe('securities');
  });

  test('a printed minus never becomes a negative amount — kind carries the sign', () => {
    expect(parseAccountState('הלוואות\n₪-45,678.90').lines[0].amount).toBe(45678.90);
    expect(parseAccountState('הלוואות\n-₪45,678.90').lines[0].amount).toBe(45678.90);
    expect(parseAccountState('הלוואות\n₪45,678.90-').lines[0].amount).toBe(45678.90);
  });

  test('an overdrafted עו"ש keeps the sign the bank printed — it has no kind to carry it', () => {
    // an overdraft is the norm in Israel, and עו"ש is not a holding: nothing else knows this sign.
    // RTL rendering puts the minus before the ₪, after it, or trailing — all one fact.
    for (const text of ['יתרת עו"ש\n₪3,456.78-', 'יתרת עו"ש\n-₪3,456.78', 'יתרת עו"ש\n₪-3,456.78']) {
      expect(parseAccountState(text).lines[0]).toEqual({
        line: 'checking', label: 'יתרת עו"ש', amount: 3456.78, printedSign: -1,
      });
    }
    // a credit balance prints no minus, and the loan beside it stays a magnitude either way (A8)
    const both = parseAccountState('יתרת עו"ש\n₪3,456.78\nהלוואות\n₪45,678.90-');
    expect(both.lines[0]).toMatchObject({ line: 'checking', amount: 3456.78, printedSign: 1 });
    expect(both.lines[1]).toMatchObject({ line: 'loan', amount: 45678.90 });
  });

  test('a number with no ₪ is not an amount', () => {
    // "45,678.90" bare could be an account number, a date, anything. The bank prints ₪.
    expect(parseAccountState('הלוואות\n45,678.90').lines).toEqual([]);
  });
});

describe('resolveLine', () => {
  const loan: HoldingRef = { id: 7, name: 'הלוואות', type: 'loan', amount: 45678.90 };
  const deposit: HoldingRef = { id: 8, name: 'פקדונות וחסכונות', type: 'deposit', amount: 12345.67 };

  test('the two scraped lines are readonly — they can never be applied', () => {
    expect(resolveLine('checking', 3456.78, [])).toEqual({ action: 'readonly', assetId: null });
    expect(resolveLine('card', 1234.56, [loan, deposit])).toEqual({ action: 'readonly', assetId: null });
  });

  test('no holding of that type is a create', () => {
    expect(resolveLine('loan', 45678.90, [deposit])).toEqual({ action: 'create', assetId: null });
  });

  test('one holding is an update, or unchanged when it matches to the agora', () => {
    expect(resolveLine('loan', 20000, [loan, deposit])).toEqual({ action: 'update', assetId: 7 });
    expect(resolveLine('loan', 45678.90, [loan])).toEqual({ action: 'unchanged', assetId: 7 });
    expect(resolveLine('loan', 45678.901, [loan])).toEqual({ action: 'unchanged', assetId: 7 });
    expect(resolveLine('loan', 21048.49, [loan])).toEqual({ action: 'update', assetId: 7 });
  });

  test('two holdings of a type is ambiguous — the app must not guess which the total means', () => {
    const holdings = [loan, { id: 9, name: 'הלוואה שנייה', type: 'loan' as const, amount: 5000 }];
    expect(resolveLine('loan', 45678.90, holdings)).toEqual({
      action: 'ambiguous', assetId: null, ambiguity: 'multiple-holdings',
    });
  });

  test("a type='other' holding never satisfies a typed line", () => {
    // it does not become the update target — nothing here may guess that it is the same fact
    expect(resolveLine('deposit', 100, [{ id: 1, name: 'דירה', type: 'other', amount: 5000 }])).toEqual({
      action: 'create', assetId: null,
    });
  });

  test("an untyped row that may BE the fact refuses to create beside it, rather than doubling it", () => {
    // every row predating the `type` column is type='other', and the הון screen always advertised
    // exactly these holdings — so this is what the FIRST paste of an existing user hits
    const legacyLoan: HoldingRef = { id: 1, name: 'הלוואה בלאומי', type: 'other', amount: 22000 };
    expect(resolveLine('loan', 45678.90, [legacyLoan])).toEqual({
      action: 'ambiguous', assetId: null, ambiguity: 'untyped-candidate',
    });

    // …matched by name even when the balance has rotted, which is WHY the user is pasting
    const legacyDeposit: HoldingRef = { id: 2, name: 'פיקדון בלאומי', type: 'other', amount: 15000 };
    expect(resolveLine('deposit', 12345.67, [legacyDeposit]).action).toBe('ambiguous');

    // …and by balance even when the name says nothing
    const nameless: HoldingRef = { id: 3, name: 'לאומי', type: 'other', amount: 45678.90 };
    expect(resolveLine('loan', 45678.90, [nameless]).action).toBe('ambiguous');
  });

  test('an unrelated untyped row does not block a create', () => {
    const flat: HoldingRef = { id: 1, name: 'דירה', type: 'other', amount: 2_000_000 };
    expect(resolveLine('loan', 45678.90, [flat])).toEqual({ action: 'create', assetId: null });
  });

  test('a ₪0.00 untyped row does not block the fixture`s ₪0.00 securities line', () => {
    // amount-matching at zero is coincidence, not a clue — and 0.00 is what the bank prints there
    const zeroed: HoldingRef = { id: 1, name: 'משהו', type: 'other', amount: 0 };
    expect(resolveLine('securities', 0, [zeroed])).toEqual({ action: 'create', assetId: null });
    // the name still speaks, though
    const named: HoldingRef = { id: 2, name: 'ניירות ערך', type: 'other', amount: 0 };
    expect(resolveLine('securities', 0, [named]).action).toBe('ambiguous');
  });

  test('once the legacy row is classified, the next paste updates it instead of creating', () => {
    const classified: HoldingRef = { id: 1, name: 'הלוואה בלאומי', type: 'loan', amount: 22000 };
    expect(resolveLine('loan', 45678.90, [classified])).toEqual({ action: 'update', assetId: 1 });
  });
});

describe('kindForType', () => {
  test('a loan is a liability, a deposit and securities are assets, other defers to the user', () => {
    expect(kindForType('loan', 'asset')).toBe('liability');
    expect(kindForType('deposit', 'liability')).toBe('asset');
    expect(kindForType('securities', 'liability')).toBe('asset');
    expect(kindForType('other', 'liability')).toBe('liability');
    expect(kindForType('other', 'asset')).toBe('asset');
  });
});

describe('createdHolding', () => {
  test('a created פקדון is liquid; securities and loans are not', () => {
    expect(createdHolding('deposit', 'פקדונות וחסכונות')).toEqual({
      name: 'פקדונות וחסכונות', type: 'deposit', kind: 'asset', liquid: true, institution: 'בנק לאומי',
    });
    expect(createdHolding('loan', 'הלוואות')).toEqual({
      name: 'הלוואות', type: 'loan', kind: 'liability', liquid: false, institution: 'בנק לאומי',
    });
    expect(createdHolding('securities', 'תיק ניירות ערך')).toEqual({
      name: 'תיק ניירות ערך', type: 'securities', kind: 'asset', liquid: false, institution: 'בנק לאומי',
    });
  });
});

describe('staleness', () => {
  test('a loan/mortgage being paid monthly decays in 30 days; bank lines in 45', () => {
    expect(stalenessDays({ type: 'loan', monthlyPayment: 700 })).toBe(30);
    expect(stalenessDays({ type: 'mortgage', monthlyPayment: 4200 })).toBe(30);
    expect(stalenessDays({ type: 'loan', monthlyPayment: null })).toBe(45);
    expect(stalenessDays({ type: 'deposit', monthlyPayment: null })).toBe(45);
    expect(stalenessDays({ type: 'securities', monthlyPayment: null })).toBe(45);
  });

  test('each off-bank type rots at the pace it really moves', () => {
    expect(stalenessDays({ type: 'crypto', monthlyPayment: null })).toBe(14);
    expect(stalenessDays({ type: 'pension', monthlyPayment: null })).toBe(120);
    expect(stalenessDays({ type: 'vehicle', monthlyPayment: null })).toBe(180);
    expect(stalenessDays({ type: 'realEstate', monthlyPayment: null })).toBe(365);
  });

  test("what nothing external refreshes never nags — 'עסק' is stale by design", () => {
    expect(decays('other')).toBe(false);
    expect(decays('business')).toBe(false);
    expect(decays('valuable')).toBe(false);
    expect(decays('realEstate')).toBe(true);
    expect(decays('mortgage')).toBe(true);
    for (const line of APPLICABLE_LINES) expect(decays(line)).toBe(true);
  });
});

describe('remainingPaymentsTextHe', () => {
  test('a bound, and the caveat that makes it honest — never separable', () => {
    // 45678.90 / 700 = 30.07 → 31 at 0% interest. The real number is 33 at 6%, 36 at 12%.
    expect(remainingPaymentsTextHe(45678.90, 700)).toBe(
      'לפחות 66 תשלומים · ריבית אינה מחושבת — המספר האמיתי גבוה יותר',
    );
  });

  test('no payment, no claim', () => {
    expect(remainingPaymentsTextHe(45678.90, null)).toBeNull();
    expect(remainingPaymentsTextHe(45678.90, 0)).toBeNull();
    expect(remainingPaymentsTextHe(45678.90, -5)).toBeNull();
    expect(remainingPaymentsTextHe(0, 700)).toBeNull();
  });
});

describe('isApplicableLine', () => {
  test('exactly the three user-maintained lines', () => {
    expect(APPLICABLE_LINES).toEqual(['deposit', 'loan', 'securities']);
    expect(isApplicableLine('checking')).toBe(false);
    expect(isApplicableLine('card')).toBe(false);
    expect(isApplicableLine('other')).toBe(false);
    expect(isApplicableLine('loan')).toBe(true);
  });
});
