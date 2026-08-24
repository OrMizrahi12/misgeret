/** The savings-instrument vocabulary: Israeli banking Hebrew, shared by every bank the app
 *  supports. Read by categories.ts (a return is income, a cost is a fee) and by companies.ts
 *  (the principal itself is not a flow at all). It imports neither, so it adds no cycle. */

export type SavingsShape = 'return' | 'cost' | 'principal' | null;

/** Bare גמל is deliberately absent — it is also "camel" and "repaid". The realistic surface
 *  forms carry their own noun and are long enough for the safe substring path. */
const INSTRUMENT_STEMS = [
  'פיקדון', 'פקדון', 'פק"ם', 'פק"מ', 'מק"ם', 'מק"מ', 'תוכנית חיסכון', 'תכנית חסכון', 'חסכון', 'חיסכון',
  'ני"ע', 'ניירות ערך', 'אג"ח', 'קרן נאמנות', 'קרן השתלמות', 'קופת גמל', 'קרן גמל', 'קופ"ג',
  'פוליסת חיסכון',
];

/** A return on the instrument — or a payout FROM it. An annuity belongs here and not with the
 *  principal: a retiree's monthly קצבה is the money he lives on, entering his spendable world,
 *  not a pot-to-pot move. A lump-sum 'משיכה מקופת גמל' names no payout word and stays principal. */
const RETURN_STEMS = ['רווח', 'ריבית', 'דיבידנד', 'תשואה', 'קצבה', 'קצבת', 'פנסיה', 'גמלה'];

/** The fees family reads this list too, so the two can never drift apart. */
export const FEE_STEMS = ['עמל.', 'עמל ', 'עמלת', 'עמלה', 'ריבית', 'דמי כרטיס', 'דמי ניהול', 'הקצאת אשראי', 'FEE'];

/** מס/ניכוי live HERE and not in the fees family: 'החזר מס' is income, and the fees family is
 *  scanned first. Sharing FEE_STEMS is what keeps 'דמי ניהול פקדון ני"ע' — a real quarterly
 *  custody fee — from being swallowed whole as principal. */
const COST_STEMS = ['מס', 'ניכוי', ...FEE_STEMS];

/** Banks write one abbreviation three ways: פק"ם · פק״ם · לפק"ם. normalizePattern already strips
 *  ״/׳, which is proof the banks emit them. */
const normalizeQuotes = (s: string) => s.replace(/״/g, '"').replace(/׳/g, "'");

/** One inseparable prefix (ל/ב/מ/ה/ו/ש), peeled off short tokens only. */
const PREFIXED = /^[לבמהוש](.+)$/;

/** matchesStem's discipline plus the two additions the abbreviations need. Kept private here
 *  rather than widening categories.ts's matcher, which every existing family depends on. */
function hasStem(text: string, tokens: Set<string>, stem: string): boolean {
  const s = normalizeQuotes(stem).toUpperCase();
  if (s.endsWith(' ')) return tokens.has(s.trim());
  if (s.replace(/[."']/g, '').length <= 3) {
    return tokens.has(s) || [...tokens].some((t) => PREFIXED.exec(t)?.[1] === s);
  }
  return text.includes(s);
}

/** What a description says happened to a savings instrument, or null if it names none.
 *  'return' is tested before 'cost' and that is load-bearing: 'תשלום מס על רווח מפיקדון' says
 *  both, and the AMOUNT SIGN at the call site is what turns it into a fee. */
export function savingsShape(text: string): SavingsShape {
  const t = normalizeQuotes(text).toUpperCase();
  const tokens = new Set(t.split(/[^A-Zא-ת0-9"']+/).filter(Boolean));
  if (!INSTRUMENT_STEMS.some((s) => hasStem(t, tokens, s))) return null;
  if (RETURN_STEMS.some((s) => hasStem(t, tokens, s))) return 'return';
  if (COST_STEMS.some((s) => hasStem(t, tokens, s))) return 'cost';
  return 'principal';
}
