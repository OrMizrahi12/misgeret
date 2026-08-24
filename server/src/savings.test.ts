import { describe, expect, test } from 'vitest';
import { savingsShape } from './savings.js';
import { normalizePattern } from './categories.js';

describe('savingsShape — instruments', () => {
  test('both quote forms of the abbreviations name an instrument', () => {
    expect(savingsShape('חידוש פיקדון פק"ם משנה ומעלה')).toBe('principal');
    expect(savingsShape('חידוש פיקדון פק״ם משנה ומעלה')).toBe('principal');
    expect(savingsShape('קניית ני"ע')).toBe('principal');
    expect(savingsShape('קניית ני״ע')).toBe('principal');
    expect(savingsShape('רכישת אג"ח ממשלתי')).toBe('principal');
    expect(savingsShape('רכישת אג״ח ממשלתי')).toBe('principal');
    expect(savingsShape('הפקדה לקופ"ג')).toBe('principal');
    expect(savingsShape('הפקדה לקופ״ג')).toBe('principal');
    expect(savingsShape('קניית מק"ם')).toBe('principal');
  });

  test('one inseparable prefix is peeled off the abbreviations', () => {
    expect(savingsShape('הפקדה לפק"ם')).toBe('principal');
    expect(savingsShape('משיכה מפק״ם')).toBe('principal');
    expect(savingsShape('העברה לקופת גמל')).toBe('principal');
  });

  test('the spelled-out instruments', () => {
    expect(savingsShape('הפקדה לתוכנית חיסכון')).toBe('principal');
    expect(savingsShape('משיכה מחסכון')).toBe('principal');
    expect(savingsShape('קרן נאמנות מניות')).toBe('principal');
    expect(savingsShape('הפקדה לקרן השתלמות')).toBe('principal');
    expect(savingsShape('פוליסת חיסכון הראל')).toBe('principal');
    expect(savingsShape('קניית ניירות ערך')).toBe('principal');
  });
});

describe('savingsShape — what happened to the instrument', () => {
  test('a return on it', () => {
    expect(savingsShape('רווח מפיקדון מתחדש')).toBe('return');
    expect(savingsShape('ריבית זכות על פיקדון')).toBe('return');
    expect(savingsShape('דיבידנד ני"ע')).toBe('return');
    expect(savingsShape('תשואה על קרן נאמנות')).toBe('return');
  });

  test('tax on a return reads as return — the sign decides at the call site', () => {
    // says both רווח and מס; return wins here ON PURPOSE, and categories.ts turns the
    // negative amount into a fee. Reordering this silently deletes real interest income.
    expect(savingsShape('תשלום מס על רווח מפיקדון שחודש')).toBe('return');
  });

  test('AN ANNUITY IS A PAYOUT, NOT PRINCIPAL — the retiree this feature was built for', () => {
    // his monthly קצבה names a גמל instrument and no return word, so it read as principal and was
    // deleted from his income entirely — while resolveCategory called it income. His main credit.
    expect(savingsShape('קצבת פנסיה מקרן גמל')).toBe('return');
    expect(savingsShape('קצבה מקופת גמל')).toBe('return');
    expect(savingsShape('העברת קצבה מקופ"ג הראל')).toBe('return');
    expect(savingsShape('גמלה חודשית מקרן השתלמות')).toBe('return');
  });

  test('a lump sum out of the same pot names no payout word and stays principal', () => {
    expect(savingsShape('משיכה מקופת גמל')).toBe('principal');
    expect(savingsShape('פדיון קרן השתלמות')).toBe('principal');
  });

  test('a cost of it', () => {
    expect(savingsShape('דמי ניהול פקדון ני"ע')).toBe('cost');
    expect(savingsShape('דמי ניהול קרן השתלמות')).toBe('cost');
    expect(savingsShape('ניכוי במקור פיקדון')).toBe('cost');
    expect(savingsShape('עמלת קניית ני"ע')).toBe('cost');
  });

  test('the principal itself — no return word, no cost word', () => {
    expect(savingsShape('חידוש פיקדון פק"ם משנה ומעלה')).toBe('principal');
  });
});

describe('savingsShape — names no instrument', () => {
  test('a merchant, a salary and a tax refund are not savings', () => {
    expect(savingsShape('מסעדת שקשוקה')).toBeNull();
    expect(savingsShape('משכורת חברה בע"מ')).toBeNull();
    expect(savingsShape('החזר מס')).toBeNull();
    expect(savingsShape('ריבית חובה')).toBeNull();
    expect(savingsShape('העברה עצמית')).toBeNull();
  });
});

describe('the override key collapses both legs of one renewal', () => {
  test("normalizePattern erases the sign and the quotes — both legs are principal", () => {
    const a = normalizePattern('חידוש פיקדון פק"ם משנה ומעלה');
    const b = normalizePattern('חידוש פיקדון פק״ם משנה ומעלה');
    expect(a).toBe(b);
    expect(a).toBe('חידוש פיקדון פק ם משנה ומעלה');
  });
});
