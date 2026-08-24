import { companyKind } from './companies.js';
import { FEE_STEMS, savingsShape } from './savings.js';
import type { TxnRow } from './txns.js';

/** The app's flat category taxonomy — fixed in code, ids are stable API strings. */
export const CATEGORIES = [
  { id: 'groceries', nameHe: 'מזון' },
  { id: 'restaurants', nameHe: 'מסעדות' },
  { id: 'transport', nameHe: 'תחבורה' },
  { id: 'housing', nameHe: 'דיור' },
  { id: 'bills', nameHe: 'חשבונות' },
  { id: 'health', nameHe: 'בריאות' },
  { id: 'shopping', nameHe: 'קניות' },
  { id: 'leisure', nameHe: 'פנאי' },
  { id: 'education', nameHe: 'חינוך' },
  { id: 'insurance', nameHe: 'ביטוח' },
  { id: 'transfers', nameHe: 'העברות' },
  { id: 'fees', nameHe: 'עמלות' },
  { id: 'income', nameHe: 'הכנסה' },
  { id: 'other', nameHe: 'אחר' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];

export const CATEGORY_IDS: ReadonlySet<string> = new Set(CATEGORIES.map((c) => c.id));

/** Hebrew sector names Max/Cal return on card transactions → our categories.
 *  The issuer's own classification is the single richest signal we have — every Max row
 *  carries one. This map must stay COMPLETE: GET /api/issuer-sectors lists any stragglers. */
export const ISSUER_CATEGORY_MAP: Record<string, CategoryId> = {
  'מזון וצריכה': 'groceries',
  'סופרמרקטים': 'groceries',
  'מזון': 'groceries',
  'מסעדות': 'restaurants',
  'מסעדות וקפה': 'restaurants',
  'מסעדות, קפה וברים': 'restaurants',
  'בתי קפה ומסעדות': 'restaurants',
  'דלק ותחבורה': 'transport',
  'דלק, חשמל וגז': 'transport',
  'תחבורה ורכבים': 'transport',
  'דלק': 'transport',
  'תחבורה': 'transport',
  'רכב': 'transport',
  'אופנה': 'shopping',
  'קניות': 'shopping',
  'חשמל ומחשבים': 'shopping',
  'עיצוב הבית': 'shopping',
  'חיות מחמד': 'shopping',
  'פארם ובריאות': 'health',
  'קוסמטיקה וטיפוח': 'health',
  'רפואה ובתי מרקחת': 'health',
  'בריאות': 'health',
  'רפואה': 'health',
  'ביטוח': 'insurance',
  'חינוך': 'education',
  'ספרים ודפוס': 'education',
  'פנאי ובידור': 'leisure',
  'פנאי, בידור וספורט': 'leisure',
  'בידור': 'leisure',
  'תיירות': 'leisure',
  'טיסות ותיירות': 'leisure',
  'תקשורת': 'bills',
  'שירותי תקשורת': 'bills',
  'עירייה וממשלה': 'bills',
  'שירותים': 'bills',
  'העברות': 'transfers',
  'העברת כספים': 'transfers',
  'עמלות': 'fees',
  'משיכת מזומן': 'other',
  'שונות': 'other',
};

export interface CategoryRule {
  id: number;
  pattern: string;
  category: string;
}

export interface ResolvedCategory {
  category: string;
  source: 'rule' | 'issuer' | 'income' | 'auto';
}

/** Semantic WORD FAMILIES, not a business registry: a stem like 'פיצה' or 'צמיגי' classifies
 *  by what the merchant's NAME SAYS, so a business that opens tomorrow is still recognized.
 *  Short/ambiguous tokens match whole words only (same discipline as the settlement patterns).
 *  Order matters — first hit wins; more specific families come first. */
const SEMANTIC_FAMILIES: { category: CategoryId; stems: string[] }[] = [
  { category: 'fees', stems: FEE_STEMS },
  { category: 'income', stems: ['משכורת', 'שכר עבודה', 'קצבת', 'ביטוח לאומי זיכוי', 'החזר מס'] },
  { category: 'housing', stems: ['שכר דירה', 'שכ"ד', 'שכד ', 'משכנתא', 'ועד בית', 'דמי שכירות'] },
  {
    category: 'transport',
    stems: ['דלק', 'תחנת', 'פז ', 'סונול', 'דור אלון', 'יילו', 'צמיג', 'מוסך', 'חניון', 'חניה', 'חנייה', 'רכבת', 'אוטובוס',
      'מונית', 'GETT', 'UBER', 'YANGO', 'פנגו', 'סלופארק', 'רב קו', 'רב-קו', 'נתיבי ', 'כביש 6', 'טסט ליין', 'רישוי'],
  },
  {
    category: 'groceries',
    stems: ['סופרמרקט', 'סופר ', 'מינימרקט', 'מרקט', 'מכולת', 'שופרסל', 'רמי לוי', 'ויקטורי', 'יוחננוף', 'אושר עד',
      'טיב טעם', 'יינות ביתן', 'מגה בעיר', 'ירקות', 'קצבי', 'אטליז', 'מעדני'],
  },
  {
    category: 'restaurants',
    stems: ['פיצה', 'פיצריי', 'בורגר', 'המבורגר', 'סושי', 'שווארמה', 'שוארמה', 'פלאפל', 'חומוס', 'מסעד', 'קפה ', 'בית קפה',
      'קפית', 'מאפי', 'קונדיטורי', 'גלידה', 'גלידרי', 'בר ', 'טאבון', 'WOLT', 'תן ביס', 'TENBIS', 'מקדונלד', 'ברגר קינג', 'דומינוס', "פאפא ג'ונס", 'פאפא גונס', 'ארומה', 'קופיקס', 'לנדוור', 'גרג', 'רולדין', 'גולדה'],
  },
  {
    category: 'health',
    stems: ['פארם', 'בית מרקחת', 'מרפא', 'רופא', 'ד"ר', 'דר ', 'שיניים', 'מכבי', 'כללית', 'מאוחדת', 'לאומית', 'אופטיק',
      'משקפי', 'עדשות', 'קופת חולים', 'מעבדה רפואית'],
  },
  {
    category: 'bills',
    stems: ['חברת החשמל', 'חח"י', 'מי אביבים', 'תאגיד מים', 'ארנונה', 'עיריית', 'עירית', 'מועצה מקומית', 'סלקום', 'פלאפון',
      'פרטנר', 'הוט ', 'HOT', 'בזק', 'יס ', 'YES', 'גולן טלקום', '012', '019', 'GOOGLE', 'MICROSOFT', 'APPLE.COM', 'ANTHROPIC', 'OPENAI', 'דואר ישראל'],
  },
  {
    category: 'leisure',
    stems: ['NETFLIX', 'SPOTIFY', 'DISNEY', 'סינמה', 'קולנוע', 'יס פלנט', 'תיאטרון', 'הופעה', 'מלון ', 'מלונות', 'צימר',
      'טיסה', 'טיסות', 'אל על', 'ארקיע', 'ישראייר', 'WIZZ', 'RYANAIR', 'BOOKING', 'AIRBNB', 'TRIP.COM', 'חדר כושר', 'סטודיו ', 'בריכה'],
  },
  { category: 'education', stems: ['בית ספר', 'גן ילדים', 'צהרון', 'חוג ', 'שיעור', 'קורס', 'מכללת', 'אוניברסיט', 'סטימצקי', 'צומת ספרים'] },
  { category: 'insurance', stems: ['ביטוח', 'ווישור', 'הראל ', 'מנורה מבטחים', 'הפניקס', 'מגדל ', 'כלל חברה', 'AIG', 'ליברה', '9 מיליון'] },
  { category: 'transfers', stems: ['העברה', 'העברת', 'ביט', 'BIT', 'PAYBOX', 'פייבוקס', 'זיכוי מיידי', 'הו"ק', 'הוראת קבע', 'זה"ב', 'משיכה לחשבון'] },
  { category: 'shopping', stems: ['פרחי', 'זר ', 'רהיט', 'איקאה', 'IKEA', 'הום סנטר', 'ACE', 'אייס ', 'חשמל ומחשבים', 'KSP', 'באג', 'איביי', 'EBAY', 'AMAZON', 'ALIEXPRESS', 'SHEIN', 'עליאקספרס', 'זארה', 'ZARA', 'קסטרו', 'פוקס', 'H&M', 'טרמינל'] },
];

/** Sector-name vocabulary: understands what an issuer's sector STRING says, so a NEW card
 *  company's wording ("בתי אוכל ובתי קפה", "מוצרי חשמל", "ביטוח ופיננסים") maps itself without
 *  code changes. Order = priority; first hit wins. This is the elastic tier behind the exact
 *  map — the exact map stays only as a precision fast-path for strings we've already verified. */
const SECTOR_VOCABULARY: { category: CategoryId; words: string[] }[] = [
  { category: 'transport', words: ['דלק', 'תחבורה', 'רכב', 'חניה', 'חנייה', 'תדלוק'] },
  { category: 'groceries', words: ['סופרמרקט', 'סופר', 'מזון', 'צריכה', 'מכולת', 'שוק'] },
  { category: 'restaurants', words: ['מסעד', 'קפה', 'בר', 'אוכל', 'הסעדה'] },
  { category: 'health', words: ['בריאות', 'רפואה', 'מרקחת', 'פארם', 'קוסמטיקה', 'טיפוח', 'אופטיקה'] },
  { category: 'insurance', words: ['ביטוח', 'פנסיה', 'גמל'] },
  { category: 'education', words: ['חינוך', 'לימוד', 'ספרים', 'דפוס', 'הוראה'] },
  { category: 'leisure', words: ['פנאי', 'בידור', 'ספורט', 'תיירות', 'טיס', 'מלונ', 'נופש', 'תרבות', 'קולנוע'] },
  { category: 'bills', words: ['תקשורת', 'עירי', 'ממשל', 'מוניציפל', 'שירותים', 'מים', 'גז'] },
  { category: 'transfers', words: ['העברה', 'העברת', 'כספים'] },
  { category: 'fees', words: ['עמלה', 'עמלות', 'ריבית'] },
  { category: 'housing', words: ['דיור', 'שכירות', 'משכנתא'] },
  { category: 'shopping', words: ['אופנה', 'ביגוד', 'הנעלה', 'הלבשה', 'מחשב', 'אלקטרוניקה', 'חשמל', 'ריהוט', 'בית', 'חיות', 'מתנות', 'צעצועים', 'תכשיט', 'קניות', 'קמעונ'] },
  { category: 'other', words: ['מזומן', 'שונות', 'אחר'] },
];

/** Elastic sector understanding: exact verified map first, then the sector's own words. */
export function sectorToCategory(sector: string): CategoryId | null {
  const s = sector.trim();
  if (!s) return null;
  const exact = ISSUER_CATEGORY_MAP[s];
  if (exact) return exact;
  for (const { category, words } of SECTOR_VOCABULARY) {
    if (words.some((w) => s.includes(w))) return category;
  }
  return null;
}

function wordTokens(text: string): Set<string> {
  return new Set(text.toUpperCase().split(/[^A-Zא-ת0-9"']+/).filter(Boolean));
}

/** Stem matching: stems of ≤3 letters (or ending with a space marker) match whole words;
 *  longer stems match as substrings of the uppercased text. */
function matchesStem(text: string, tokens: Set<string>, stem: string): boolean {
  const s = stem.toUpperCase();
  if (s.endsWith(' ')) {
    return tokens.has(s.trim());
  }
  if (s.replace(/[."']/g, '').length <= 3) return tokens.has(s);
  return text.includes(s);
}

/** The semantic tier: classify by what the name says. Works on description + memo together,
 *  because Leumi hides the actual merchant of debit-card rows inside the memo. */
export function semanticCategory(text: string): CategoryId | null {
  const upper = text.toUpperCase();
  const tokens = wordTokens(text);
  for (const family of SEMANTIC_FAMILIES) {
    if (family.stems.some((stem) => matchesStem(upper, tokens, stem))) return family.category;
  }
  return null;
}

/** Leumi debit-card rows are all described 'כרטיס דביט'; the real merchant hides in the memo:
 *  "מתאריך 26/05/25 22:52 בכרטיס המסתיים ב-1649 ב-פז אפליקציית יילו". Extract it. */
export function merchantFromMemo(memo: string | null): string | null {
  if (!memo) return null;
  const m = memo.match(/ ב-(?!\d)(.+)$/);
  return m ? m[1].trim() : null;
}

/** Optional cross-transaction signal: what this merchant was already categorized as.
 *  Built from rows the user/rules/issuer categorized; keys are normalizePattern(description). */
export type MerchantCategoryHints = ReadonlyMap<string, CategoryId>;

/** User-defined sector→category mappings (stored in the DB, editable from Settings).
 *  The final elastic guarantee: whatever wording a future issuer invents, one click maps it. */
export type SectorOverrides = ReadonlyMap<string, CategoryId>;

export interface ResolveContext {
  hints?: MerchantCategoryHints;
  sectorOverrides?: SectorOverrides;
}

/** Resolution order — every tier is deterministic and explainable, and NOTHING stays null:
 *  user rule (longest match) → user sector mapping → issuer sector (exact, then by the
 *  sector's own words — elastic across issuers) → savings instrument → memo/semantic meaning →
 *  seen-before merchant → bank-credit income → 'other'. A transaction ALWAYS has a category;
 *  'other' + source 'auto' is the refinable floor, not a debt. */
export function resolveCategory(
  txn: Pick<TxnRow, 'description' | 'amount' | 'company' | 'issuerCategory'> & { memo?: string | null },
  rules: CategoryRule[],
  context: ResolveContext = {},
): ResolvedCategory {
  const { hints, sectorOverrides } = context;
  let best: CategoryRule | null = null;
  for (const r of rules) {
    if (!txn.description.includes(r.pattern)) continue;
    if (!best || r.pattern.length > best.pattern.length) best = r;
  }
  if (best) return { category: best.category, source: 'rule' };

  if (txn.issuerCategory) {
    const sector = txn.issuerCategory.trim();
    const userMapped = sectorOverrides?.get(sector);
    if (userMapped) return { category: userMapped, source: 'issuer' };
    const mapped = sectorToCategory(sector);
    if (mapped) return { category: mapped, source: 'issuer' };
  }

  // A savings instrument's own words beat the semantic families, which own 'ריבית' and would
  // file real interest income under עמלות while toMonthlySummary counts it as income by sign.
  // Bank rows only: a merchant literally named פיקדון arrives on a card row.
  if (companyKind(txn.company) === 'bank') {
    const shape = savingsShape(`${txn.description} ${txn.memo ?? ''}`);
    if (shape === 'return' && txn.amount > 0) return { category: 'income', source: 'auto' };
    if (shape === 'return' || shape === 'cost') return { category: 'fees', source: 'auto' };
  }

  // the merchant the bank hid inside the memo is the strongest text we have — try it alone
  // first (so 'סופרפארם בת ים' wins over the generic 'כרטיס דביט'), then the full text
  const memoMerchant = merchantFromMemo(txn.memo ?? null);
  const semantic =
    (memoMerchant && semanticCategory(memoMerchant)) ||
    semanticCategory(`${txn.description} ${txn.memo ?? ''}`);
  if (semantic && !(semantic === 'income' && txn.amount < 0)) {
    return { category: semantic, source: 'auto' };
  }

  if (hints) {
    const seen = hints.get(normalizePattern(memoMerchant ?? txn.description));
    if (seen) return { category: seen, source: 'auto' };
  }

  if (txn.amount > 0 && companyKind(txn.company) === 'bank') {
    return { category: 'income', source: 'income' };
  }

  return { category: 'other', source: 'auto' };
}

/** Suggested rule pattern from a description: strip digits, punctuation and בע"מ, collapse spaces. */
export function normalizePattern(description: string): string {
  return description
    .replace(/בע["״׳']?מ/g, ' ') // drop the בע"מ suffix before quotes get stripped and split it
    .replace(/[0-9]/g, ' ')
    // a geresh INSIDE a word is spelling, not separation — ג'ונס is one word, and issuers drift
    // between "פאפא גונס" and "פאפא ג'ונס" for the same merchant. Deleting (not space-splitting)
    // makes both spellings collapse to one identity. Gershayim (״/") stay space-split: they mark
    // acronyms, and both spellings of an acronym carry them consistently.
    .replace(/['׳]/g, '')
    .replace(/[["״().,:;/\\#*_\-\]]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'בעמ')
    .join(' ')
    .trim();
}

/** Bank-transfer descriptions too generic to identify a payee. Israeli banks (Leumi's "העברה
 *  דיגיטל", an instant credit "זיכוי מיידי", a מס"ב debit) write the SAME description for every
 *  transfer and put the actual beneficiary + purpose in the MEMO — e.g. description "העברה דיגיטל",
 *  memo "העברה אל: מנחם פינטו 12-642-… שכר דירה". Grouping such rows by description alone collapses
 *  rent, a gift, and a broker funding into one meaningless bucket, so the memo must carry identity. */
const GENERIC_TRANSFER_DESCRIPTIONS = new Set([
  'העברה דיגיטל', 'העברה', 'העברה עצמית', 'העברה מיידית', 'זיכוי מיידי', 'זיכוי',
  'חיוב מיידי', 'מסב', 'מזומן', 'משיכת מזומן', 'הפקדה', 'הפקדת מזומן',
]);

/** True when a description is a generic transfer stub whose real payee lives in the memo. */
export function isGenericTransferDescription(description: string): boolean {
  return GENERIC_TRANSFER_DESCRIPTIONS.has(normalizePattern(description));
}

/** The merchant-grouping identity of a transaction. Normally the normalized description; for a
 *  generic bank transfer it folds in the memo so distinct payees separate into distinct merchants
 *  (and a recurring one — monthly rent — becomes a clean, detectable stream). Non-transfer merchants
 *  are unaffected: their descriptions are never in the generic set, so the key is identical. */
export function merchantKey(description: string, memo?: string | null): string {
  const base = normalizePattern(description);
  if (memo && GENERIC_TRANSFER_DESCRIPTIONS.has(base)) {
    const withMemo = normalizePattern(`${description} ${memo}`);
    if (withMemo.length > base.length) return withMemo;
  }
  return base;
}

/** A human label for a transaction's merchant. For a generic transfer, the payee/purpose pulled from
 *  the memo ("מנחם פינטו שכר דירה") instead of the useless "העברה דיגיטל"; otherwise the description. */
export function merchantLabel(description: string, memo?: string | null): string {
  if (memo && GENERIC_TRANSFER_DESCRIPTIONS.has(normalizePattern(description))) {
    const label = memo
      .replace(/^\s*העברה\s+(?:אל|מאת)\s*[:：]?\s*/u, '') // drop the "העברה אל/מאת:" direction prefix
      .replace(/\d[\d-]{3,}/g, ' ')                        // drop account numbers
      .replace(/\s+/g, ' ')
      .trim();
    if (label.length >= 2) return label;
  }
  return description;
}
