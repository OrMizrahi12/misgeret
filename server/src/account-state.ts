/**
 * מצב החשבון — the bank's own account summary, as domain logic.
 *
 * Pure by construction: no Express, no SQL. The three lines the scrapers cannot reach
 * (הלוואות / פקדונות / ניירות ערך) are user-maintained facts, so every decision about them —
 * what a paste means, which holding it refers to, when a number has rotted — is made here and
 * unit-tested in isolation.
 */

/** The full personal-balance-sheet taxonomy. The first three are the bank's own lines
 *  (paste-refreshable); the rest are off-bank facts the user maintains — a דירה, a car,
 *  a pension fund — each with its own decay cadence and net-worth layer. */
export type HoldingType =
  | 'deposit' | 'securities' | 'pension' | 'realEstate' | 'vehicle' | 'crypto' | 'business' | 'valuable'
  | 'loan' | 'mortgage' | 'other';

/** Single source of truth for API validation — the DB no longer CHECKs the type list. */
export const HOLDING_TYPE_IDS: readonly HoldingType[] = [
  'deposit', 'securities', 'pension', 'realEstate', 'vehicle', 'crypto', 'business', 'valuable',
  'loan', 'mortgage', 'other',
];

export function isHoldingType(value: unknown): value is HoldingType {
  return HOLDING_TYPE_IDS.includes(value as HoldingType);
}

/** The bank's five lines. NOT the same union as HoldingType: 'checking'/'card' are never holdings. */
export type AccountStateLine = 'checking' | 'card' | 'deposit' | 'loan' | 'securities';

/** 'readonly' is terminal: the two scraped lines are shown to prove the paste parsed, never applied. */
export type PreviewAction = 'create' | 'update' | 'unchanged' | 'ambiguous' | 'readonly';

export const APPLICABLE_LINES = ['deposit', 'loan', 'securities'] as const;
export type ApplicableLine = (typeof APPLICABLE_LINES)[number];

export function isApplicableLine(value: unknown): value is ApplicableLine {
  return APPLICABLE_LINES.includes(value as ApplicableLine);
}

/** `kind` is the arithmetic truth and carries the sign; `type` is the semantic layer above it. */
export function kindForType(type: HoldingType, fallback: 'asset' | 'liability'): 'asset' | 'liability' {
  return type === 'loan' || type === 'mortgage' ? 'liability' : type === 'other' ? fallback : 'asset';
}

/* ——— the parser ——— */

export interface ParsedLine {
  line: AccountStateLine;
  label: string;
  /** Always the magnitude the bank printed, non-negative (A8). */
  amount: number;
  /** The sign the bank printed. Only `checking`/`card` may consult it: they are not holdings, so
   *  no `kind` carries their sign, and an overdrafted עו"ש is the norm here rather than an edge. The
   *  three applicable lines derive their sign from `kind` and must ignore this. */
  printedSign: 1 | -1;
}

export interface ParseResult {
  lines: ParsedLine[];
  understood: number;
  ignored: number;
}

/** Longest label first so `יתרת עו"ש` wins over `עו"ש` and the bank's own wording is echoed back. */
const LABELS: { line: AccountStateLine; label: string }[] = [
  { line: 'deposit', label: 'פקדונות וחסכונות' },
  { line: 'securities', label: 'תיק ניירות ערך' },
  { line: 'card', label: 'כרטיסי אשראי' },
  { line: 'card', label: 'כרטיס אשראי' },
  { line: 'checking', label: 'יתרת עו"ש' },
  { line: 'securities', label: 'ניירות ערך' },
  { line: 'deposit', label: 'פקדונות' },
  { line: 'deposit', label: 'חסכונות' },
  { line: 'deposit', label: 'פיקדון' },
  { line: 'deposit', label: 'פקדון' },
  { line: 'deposit', label: 'חיסכון' },
  { line: 'deposit', label: 'חסכון' },
  { line: 'loan', label: 'הלוואות' },
  { line: 'loan', label: 'הלוואה' },
  { line: 'checking', label: 'עו"ש' },
];

/** The bank pastes gershayim and RTL marks; they are typography, not data. */
function normalize(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/[״“”]/g, '"')
    .replace(/[׳‘’]/g, "'")
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/ /g, ' ');
}

function matchLabel(line: string): { line: AccountStateLine; label: string } | null {
  for (const candidate of LABELS) {
    if (line.includes(candidate.label)) return { line: candidate.line, label: candidate.label };
  }
  return null;
}

/** An amount is a ₪-prefixed number. Magnitude and printed sign are separate facts: `amount` stays
 *  non-negative because `kind` carries the sign of every holding (A8), while the two lines that are
 *  not holdings have no `kind` and need the sign the bank actually printed. The minus lands before
 *  the ₪, after it, or trailing the number depending on how the page renders RTL — all one fact. */
const AMOUNT = /(-?)\s*₪\s*(-?)(\d[\d,]*(?:\.\d+)?)(-?)/;

function matchAmount(line: string): { amount: number; printedSign: 1 | -1 } | null {
  const hit = AMOUNT.exec(line);
  if (!hit) return null;
  const value = Number.parseFloat(hit[3].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const negative = hit[1] === '-' || hit[2] === '-' || hit[4] === '-';
  return { amount: Math.abs(value), printedSign: negative ? -1 : 1 };
}

/**
 * Reads the bank's summary out of pasted text.
 *
 * Interpretation starts at the first recognized label: whatever the user swept up above it is page
 * chrome ("מצב החשבון שלך", nav, a greeting), not account data. From there each label owns the
 * block of lines up to the next label, and the block's first ₪ figure is its value — the bank puts
 * the number on the label's line, under it, or under a blank line, and all three are the same fact.
 * A block whose lines carry no ₪ figure yields nothing, so a label repeated as a heading above the
 * real row does not shadow it. `ignored` counts the lines inside the summary that carried neither a
 * label nor a figure — the honest measure of how much of the paste went unread.
 */
export function parseAccountState(text: string): ParseResult {
  const rows = normalize(text).split(/\r?\n/);
  const hits: { index: number; line: AccountStateLine; label: string }[] = [];
  rows.forEach((row, index) => {
    const hit = matchLabel(row);
    if (hit) hits.push({ index, ...hit });
  });
  if (hits.length === 0) return { lines: [], understood: 0, ignored: 0 };

  const found = new Map<AccountStateLine, ParsedLine>();
  let ignored = 0;
  for (let h = 0; h < hits.length; h++) {
    const start = hits[h].index;
    const end = h + 1 < hits.length ? hits[h + 1].index : rows.length;
    let money: { amount: number; printedSign: 1 | -1 } | null = null;
    for (let i = start; i < end; i++) {
      const value = matchAmount(rows[i]);
      if (value !== null) {
        if (money === null) money = value;
        continue;
      }
      if (i === start || rows[i].trim() === '') continue;
      ignored++;
    }
    if (money !== null && !found.has(hits[h].line)) {
      found.set(hits[h].line, { line: hits[h].line, label: hits[h].label, ...money });
    }
  }
  return { lines: [...found.values()], understood: found.size, ignored };
}

/* ——— resolution ——— */

export interface HoldingRef {
  id: number;
  /** Carried because every pre-`type` row is `type='other'` by migration default, and its name is
   *  the only thing left that says what it is. See `mayBeSameFact`. */
  name: string;
  type: HoldingType;
  amount: number;
}

/** Why a line resolved to `ambiguous`. The two reasons need different words: one asks the user to
 *  choose between holdings, the other to classify one. */
export type AmbiguityReason = 'multiple-holdings' | 'untyped-candidate';

export interface Resolution {
  action: PreviewAction;
  assetId: number | null;
  /** Only set when `action === 'ambiguous'`. */
  ambiguity?: AmbiguityReason;
}

/** Equal to the agora — the bank prints two decimals and so does everything downstream. */
function sameMoney(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100);
}

/** The parser's own synonyms for a line — the words a user would have named the row with. */
function synonymsOf(line: AccountStateLine): string[] {
  return LABELS.filter((candidate) => candidate.line === line).map((candidate) => candidate.label);
}

/**
 * Could this untyped row already BE the fact the bank just printed?
 *
 * Every row predating the `type` column is `type='other'` by the migration's default, and the הון
 * screen has always advertised exactly these holdings ("השתלמות, פיקדון, הלוואה…") — so the loan a
 * user has tracked by hand for a year looks to a type-only match like no loan at all, and the first
 * paste would create a second one. The balance catches the row that is already current; the name
 * catches the far more common one whose balance has rotted, which is why the user is pasting.
 */
function mayBeSameFact(holding: HoldingRef, line: ApplicableLine, amount: number): boolean {
  // ₪0.00 is the fixture's securities line: an amount match against a zeroed row is coincidence
  if (amount > 0 && sameMoney(holding.amount, amount)) return true;
  return synonymsOf(line).some((label) => holding.name.includes(label));
}

/**
 * What a parsed line means against the holdings we already have. `ambiguous` is the app refusing to
 * guess — which of two הלוואות the bank's single total refers to, or whether the untyped row named
 * "הלוואה בלאומי" is this same loan. Both refusals exist for one reason: creating beside a holding
 * that is already the fact doubles it in the שווי נקי, and a ₪91,357.80 debt reads as plausible.
 */
export function resolveLine(
  line: AccountStateLine,
  amount: number,
  holdings: HoldingRef[],
): Resolution {
  if (!isApplicableLine(line)) return { action: 'readonly', assetId: null };
  const matches = holdings.filter((holding) => holding.type === line);
  if (matches.length > 1) return { action: 'ambiguous', assetId: null, ambiguity: 'multiple-holdings' };
  if (matches.length === 0) {
    const candidate = holdings.some((h) => h.type === 'other' && mayBeSameFact(h, line, amount));
    return candidate
      ? { action: 'ambiguous', assetId: null, ambiguity: 'untyped-candidate' }
      : { action: 'create', assetId: null };
  }
  const holding = matches[0];
  return { action: sameMoney(holding.amount, amount) ? 'unchanged' : 'update', assetId: holding.id };
}

/* ——— what a created row is (A12) ——— */

export interface CreatedHolding {
  name: string;
  type: ApplicableLine;
  kind: 'asset' | 'liability';
  liquid: boolean;
  institution: string;
}

/** A breakable פקדון is a real emergency buffer — that flag is the whole point of `liquid`.
 *  ניירות ערך are not (market risk) and a loan cannot be. */
export function createdHolding(line: ApplicableLine, name: string): CreatedHolding {
  return {
    name,
    type: line,
    kind: kindForType(line, 'asset'),
    liquid: line === 'deposit',
    institution: 'בנק לאומי',
  };
}

/* ——— decay ——— */

/** How long a manual value stays believable before the panel nags, per type — matched to how
 *  fast each really moves: crypto swings daily, a pension statement is quarterly, a flat gets
 *  repriced maybe yearly. 0 = never nags (a business valuation is stale by design — nothing
 *  external refreshes it, so nagging would only train the user to ignore the nag). */
const STALENESS_BY_TYPE: Record<HoldingType, number> = {
  deposit: 45, securities: 45, loan: 45, mortgage: 45,
  crypto: 14, pension: 120, vehicle: 180, realEstate: 365,
  business: 0, valuable: 0, other: 0,
};

/** A loan/mortgage being paid every month is wrong within a month; the rest follow their type. */
export function stalenessDays(a: { type: HoldingType; monthlyPayment: number | null }): number {
  if ((a.type === 'loan' || a.type === 'mortgage') && a.monthlyPayment != null) return 30;
  return STALENESS_BY_TYPE[a.type] || Number.POSITIVE_INFINITY;
}

/** Whether this type's value rots at all — callers gate the staleness nag on it. */
export function decays(type: HoldingType): boolean {
  return STALENESS_BY_TYPE[type] > 0;
}

/* ——— the one derived number a person wants from a loan (A2) ——— */

/**
 * A *bound*, never a projection: `ceil(balance / payment)` is only correct at 0% interest, and
 * modelling interest is an explicit non-goal. Returns the sentence, not the bare number, because
 * the caveat is what makes the bound honest — printing `N` alone would be a flattering lie.
 */
export function remainingPaymentsTextHe(balance: number, monthlyPayment: number | null): string | null {
  if (monthlyPayment == null || !Number.isFinite(monthlyPayment) || monthlyPayment <= 0) return null;
  if (!Number.isFinite(balance) || balance <= 0) return null;
  return `לפחות ${Math.ceil(balance / monthlyPayment)} תשלומים · ריבית אינה מחושבת — המספר האמיתי גבוה יותר`;
}

/* ——— the panel's fixed wording ——— */

export const PANEL_LABELS_HE: Record<AccountStateLine, string> = {
  checking: 'יתרת עו"ש',
  // never `כרטיסי אשראי`: this is our number (connected cards only), not the bank's line (A1)
  card: 'יתרה לחיוב בכרטיסים המחוברים',
  loan: 'הלוואות',
  deposit: 'פקדונות וחסכונות',
  securities: 'תיק ניירות ערך',
};

/**
 * Names the connected cards that report no יתרה לחיוב, rather than the three issuers that
 * structurally cannot (A1). Naming מקס/ישראכרט/אמקס in front of a user who connected none of them
 * explains a limitation he does not have; saying nothing in front of a Cal+Max user hides a real
 * hole in the שווי נקי. `null` when every connected card reports — or when none is connected.
 */
export const NOTE_NO_CARD_CONNECTED_HE = 'אין כרטיס אשראי מחובר — אין לנו מספר משלנו לשורה הזו';

export function noteMissingCardBalanceHe(missing: string[], haveFigure: boolean): string | null {
  if (missing.length === 0) return null;
  const who = missing.join(', ');
  return haveFigure
    ? `${who} לא מדווחים יתרה לחיוב — המספר הזה מכסה רק את שאר הכרטיסים`
    : `${who} לא מדווחים יתרה לחיוב — אין לנו מספר משלנו לשורה הזו`;
}

/** A3: the plan and the הון screen disagree here by design. Saying so beats guessing which debit funded it. */
export const NOTE_DEPOSIT_FUNDING_HE =
  'הפקדה לפקדון נספרת כהוצאה בתקציב החודשי — ההון נשאר נכון';

export const NOTE_AMBIGUOUS_HE = 'יש יותר מהחזקה אחת מהסוג הזה — לא נוכל לדעת לאיזו הסכום מתייחס';

/** The legacy untyped row. Says the consequence out loud: this is the one path that would double
 *  the largest number in the app, and the fix is one classification away. */
export const NOTE_UNTYPED_CANDIDATE_HE =
  'יש החזקה ללא סוג שייתכן שזו אותה עובדה — קבע לה סוג ברשימה למטה ונסה שוב, אחרת המספר ייספר פעמיים';

export function noteForAmbiguity(reason: AmbiguityReason): string {
  return reason === 'untyped-candidate' ? NOTE_UNTYPED_CANDIDATE_HE : NOTE_AMBIGUOUS_HE;
}
