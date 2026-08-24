import { describe, expect, test } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_IDS,
  ISSUER_CATEGORY_MAP,
  isGenericTransferDescription,
  merchantFromMemo,
  merchantKey,
  merchantLabel,
  normalizePattern,
  resolveCategory,
  sectorToCategory,
} from './categories.js';
import { row } from './test-helpers.js';

describe('CATEGORIES', () => {
  test('has exactly the 14 spec categories', () => {
    expect(CATEGORIES.map((c) => c.id)).toEqual([
      'groceries', 'restaurants', 'transport', 'housing', 'bills', 'health', 'shopping',
      'leisure', 'education', 'insurance', 'transfers', 'fees', 'income', 'other',
    ]);
    expect(CATEGORY_IDS.has('groceries')).toBe(true);
    expect(CATEGORY_IDS.has('nope')).toBe(false);
  });
});

describe('resolveCategory', () => {
  const rules = [
    { id: 1, pattern: 'סופר', category: 'shopping' },
    { id: 2, pattern: 'שופרסל', category: 'groceries' },
  ];

  test('longest matching rule wins', () => {
    const t = row({ date: '2026-05-01T10:00:00.000Z', amount: -100, description: 'שופרסל דיל בע"מ' });
    expect(resolveCategory(t, rules)).toEqual({ category: 'groceries', source: 'rule' });
  });

  test('rule beats issuer category', () => {
    const t = row({
      date: '2026-05-01T10:00:00.000Z', amount: -100,
      description: 'שופרסל דיל', issuerCategory: 'מסעדות', company: 'max',
    });
    expect(resolveCategory(t, rules)).toEqual({ category: 'groceries', source: 'rule' });
  });

  test('issuer category maps when no rule matches', () => {
    const t = row({
      date: '2026-05-01T10:00:00.000Z', amount: -80,
      description: 'וולט', issuerCategory: 'מסעדות', company: 'visaCal',
    });
    expect(resolveCategory(t, [])).toEqual({ category: 'restaurants', source: 'issuer' });
  });

  test('unmapped issuer category falls to the refinable floor — never null', () => {
    const t = row({
      date: '2026-05-01T10:00:00.000Z', amount: -80,
      description: 'משהו', issuerCategory: 'ענף לא מוכר', company: 'max',
    });
    expect(resolveCategory(t, [])).toEqual({ category: 'other', source: 'auto' });
  });

  test('positive bank amount is income (salary keyword hits the semantic tier first)', () => {
    const t = row({ date: '2026-05-01T10:00:00.000Z', amount: 12400, description: 'משכורת', company: 'leumi' });
    expect(resolveCategory(t, []).category).toBe('income');
    const plain = row({ date: '2026-05-01T10:00:00.000Z', amount: 500, description: 'תקבול כלשהו', company: 'leumi' });
    expect(resolveCategory(plain, [])).toEqual({ category: 'income', source: 'income' });
  });

  test('positive card amount (refund) is NOT auto-income', () => {
    const t = row({ date: '2026-05-01T10:00:00.000Z', amount: 50, description: 'זיכוי', company: 'isracard' });
    expect(resolveCategory(t, []).category).not.toBe('income');
  });

  describe('the savings tier runs before the semantic families', () => {
    const bank = (amount: number, description: string, company = 'discount') =>
      row({ date: '2026-07-06T10:00:00.000Z', amount, description, company });

    test('real interest on a deposit is income — the fees family owns ריבית and must not win', () => {
      // the regression the tier ordering exists to prevent: filed under עמלות, this would still
      // be counted as income by sign in toMonthlySummary — a category lying about a real number
      expect(resolveCategory(bank(150, 'ריבית זכות על פיקדון'), [])).toEqual({ category: 'income', source: 'auto' });
      expect(resolveCategory(bank(700, 'רווח מפיקדון מתחדש'), [])).toEqual({ category: 'income', source: 'auto' });
    });

    test('the cost of a deposit is a fee, not אחר', () => {
      // says both רווח and מס; the amount sign is what makes it a fee
      expect(resolveCategory(bank(-105, 'תשלום מס על רווח מפיקדון שחודש'), [])).toEqual({ category: 'fees', source: 'auto' });
      expect(resolveCategory(bank(-32, 'דמי ניהול פקדון ני"ע'), [])).toEqual({ category: 'fees', source: 'auto' });
      expect(resolveCategory(bank(-18, 'דמי ניהול קרן השתלמות'), [])).toEqual({ category: 'fees', source: 'auto' });
    });

    test("the source is 'auto', not 'income' — a vocabulary decision is not a weak basis", () => {
      expect(resolveCategory(bank(700, 'רווח מפיקדון מתחדש'), []).source).toBe('auto');
    });

    test('a tax refund stays income — מס is a cost only next to an instrument', () => {
      expect(resolveCategory(bank(2000, 'החזר מס'), []).category).toBe('income');
    });

    test('the principal is left to the exclusion engine — its category is moot', () => {
      expect(resolveCategory(bank(20000, 'חידוש פיקדון פק"מ משנה ומעלה'), [])).toEqual({ category: 'income', source: 'income' });
      expect(resolveCategory(bank(-20700, 'חידוש פיקדון פק"מ משנה ומעלה'), [])).toEqual({ category: 'other', source: 'auto' });
    });

    test('bank rows only — a card merchant named פיקדון is not a savings instrument', () => {
      const card = row({ date: '2026-07-06T10:00:00.000Z', amount: -240, description: 'ריבית פיקדון בע"מ', company: 'isracard' });
      expect(resolveCategory(card, []).category).toBe('fees'); // the ordinary semantic tier, unchanged
    });

    test('a user rule still beats the vocabulary — the user is above every automatic tier', () => {
      const t = bank(700, 'רווח מפיקדון מתחדש');
      expect(resolveCategory(t, [{ id: 1, pattern: 'פיקדון', category: 'transfers' }]))
        .toEqual({ category: 'transfers', source: 'rule' });
    });
  });

  test('unknown bank debit falls to the refinable floor — never null', () => {
    const t = row({ date: '2026-05-01T10:00:00.000Z', amount: -300, description: 'חיוב כלשהו', company: 'leumi' });
    expect(resolveCategory(t, [])).toEqual({ category: 'other', source: 'auto' });
  });

  test('debit-card rows: the real merchant hides in the memo and drives the category', () => {
    const t = row({
      date: '2026-05-01T10:00:00.000Z', amount: -322.26, description: 'כרטיס דביט', company: 'leumi',
      memo: 'מתאריך 04/05/25  00:00 בכרטיס המסתיים ב-1649 ב-פז אפליקציית יילו',
    });
    expect(merchantFromMemo(t.memo)).toBe('פז אפליקציית יילו');
    expect(resolveCategory(t, [])).toEqual({ category: 'transport', source: 'auto' });
  });

  test('transfer memos carry the purpose in words — rent is housing, not a mystery transfer', () => {
    const rent = row({
      date: '2026-05-09T10:00:00.000Z', amount: -3500, description: 'העברה דיגיטל', company: 'leumi',
      memo: 'העברה אל: מנחם פינטו 12-642-000290739 שכר דירה',
    });
    expect(resolveCategory(rent, [])).toEqual({ category: 'housing', source: 'auto' });
  });

  test('semantic families classify businesses never seen before', () => {
    const tires = row({ date: '2026-05-01T10:00:00.000Z', amount: -630, description: 'צמיגי אבי חולון', company: 'max' });
    expect(resolveCategory(tires, [])).toEqual({ category: 'transport', source: 'auto' });
    const pizza = row({ date: '2026-05-01T10:00:00.000Z', amount: -42, description: 'פיצה יואב פלורנטין', company: 'max' });
    expect(resolveCategory(pizza, [])).toEqual({ category: 'restaurants', source: 'auto' });
    const pharm = row({ date: '2026-05-01T10:00:00.000Z', amount: -61.2, description: 'גוד פארם מבצע סיני', company: 'max' });
    expect(resolveCategory(pharm, [])).toEqual({ category: 'health', source: 'auto' });
  });

  test('a merchant categorized once propagates to its new transactions (hints)', () => {
    const hints = new Map([['שרון עיצוב שיער', 'other' as const], ['הסטוק', 'shopping' as const]]);
    const t = row({ date: '2026-06-01T10:00:00.000Z', amount: -160, description: 'הסטוק 42', company: 'max' });
    expect(resolveCategory(t, [], { hints })).toEqual({ category: 'shopping', source: 'auto' });
  });

  test('sector understanding is ELASTIC: a new issuer\'s own wording maps by its words', () => {
    // none of these exact strings are in the verified map — they map by vocabulary
    expect(sectorToCategory('בתי אוכל ובתי קפה')).toBe('restaurants');
    expect(sectorToCategory('תדלוק ותחזוקת רכב')).toBe('transport');
    expect(sectorToCategory('מוצרי חשמל לבית')).toBe('shopping');
    expect(sectorToCategory('ביטוח ופיננסים')).toBe('insurance');
    expect(sectorToCategory('שירותי רפואה פרטיים')).toBe('health');
    expect(sectorToCategory('רשתות שיווק ומזון')).toBe('groceries');
    expect(sectorToCategory('סקטור עלום לחלוטין')).toBeNull();
  });

  test('a user sector mapping beats the built-in understanding', () => {
    const t = row({
      date: '2026-06-01T10:00:00.000Z', amount: -80,
      description: 'עסק', issuerCategory: 'סקטור עלום לחלוטין', company: 'max',
    });
    expect(resolveCategory(t, []).category).toBe('other');
    const sectorOverrides = new Map([['סקטור עלום לחלוטין', 'leisure' as const]]);
    expect(resolveCategory(t, [], { sectorOverrides })).toEqual({ category: 'leisure', source: 'issuer' });
  });
});

describe('ISSUER_CATEGORY_MAP', () => {
  test('all mapped values are valid category ids', () => {
    for (const v of Object.values(ISSUER_CATEGORY_MAP)) expect(CATEGORY_IDS.has(v)).toBe(true);
  });
});

describe('normalizePattern', () => {
  test('strips digits, punctuation and בע"מ', () => {
    expect(normalizePattern('שופרסל דיל בע"מ 123')).toBe('שופרסל דיל');
    expect(normalizePattern('פז יישום (סניף 44)')).toBe('פז יישום סניף');
  });
  test('collapses whitespace and trims', () => {
    expect(normalizePattern('  חברת   החשמל  ')).toBe('חברת החשמל');
  });
  test('a geresh inside a word is spelling, not separation — issuer drift merges to one identity', () => {
    // the real bug: the issuer switched "פאפא גונס" → "פאפא ג'ונס" mid-2026, splitting one pizza
    // habit into a "dead" fragment and an "invisible" one
    expect(normalizePattern("פאפא ג'ונס")).toBe(normalizePattern('פאפא גונס'));
    expect(merchantKey("פאפא ג'ונס")).toBe(merchantKey('פאפא גונס'));
    expect(normalizePattern("ג'פה פיצה קיטצ'ן")).toBe('גפה פיצה קיטצן');
    expect(normalizePattern('סופר צ׳יפ')).toBe('סופר ציפ'); // Hebrew geresh ׳, not just ASCII '
  });
});

describe('merchantKey / merchantLabel — generic transfers folded by memo', () => {
  const RENT_MEMO = 'העברה אל: מנחם פינטו 12-642-000290739 שכר דירה';
  const GIFT_MEMO = 'העברה אל: נועה לב ארי 31-039-000416142 חתונה';

  test('a generic transfer description is recognized; a real merchant is not', () => {
    expect(isGenericTransferDescription('העברה דיגיטל')).toBe(true);
    expect(isGenericTransferDescription('זיכוי מיידי')).toBe(true);
    expect(isGenericTransferDescription('שופרסל דיל')).toBe(false);
  });

  test('two transfers with the SAME generic description separate by their memo payee', () => {
    const rent = merchantKey('העברה דיגיטל', RENT_MEMO);
    const gift = merchantKey('העברה דיגיטל', GIFT_MEMO);
    expect(rent).not.toBe(gift);           // the whole bug — no longer one bucket
    // stable across months (account number stripped)
    expect(merchantKey('העברה דיגיטל', 'העברה אל: מנחם פינטו 12-642-999 שכר דירה')).toBe(rent);
  });

  test('a normal merchant keeps its description as the key (memo ignored)', () => {
    expect(merchantKey('שופרסל דיל', 'קבלה 12345')).toBe(normalizePattern('שופרסל דיל'));
  });

  test('the label is the memo payee/purpose, not the useless "העברה דיגיטל"', () => {
    expect(merchantLabel('העברה דיגיטל', RENT_MEMO)).toBe('מנחם פינטו שכר דירה');
    expect(merchantLabel('שופרסל דיל', 'קבלה 12345')).toBe('שופרסל דיל');
  });
});
