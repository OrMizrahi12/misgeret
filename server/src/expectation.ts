import { CATEGORIES } from './categories.js';

/**
 * שכבת הציפייה — what this month is still going to cost.
 *
 * "נותר ביד" answers the wrong question in the middle of a
 * month: how much came in minus how much has left SO FAR. The rent has not gone out yet.
 * Neither have the groceries. A month-to-date subtraction, presented as a standing, is a
 * number that is arithmetically true and financially useless.
 *
 * "הוצאות צפויות" is not what has gone out, but what the month is expected to cost:
 * every fixed charge (paid or still due — their קרן מכבי on the 5.8, their שכ״ד of 3,500 that
 * has not moved yet) plus every habitual category at its typical size (סופר 2,354 against
 * 1,385 spent so far). One rule generates all of it:
 *
 *   **a bucket's expectation for this month = max(what already went out, what typically does)**
 *
 * Below its typical size a bucket is assumed to fill up; above it, the month has already
 * spoken and the actual is the expectation. Nothing here is a budget or a ceiling — it is a
 * forecast, and it never tells the household what it is allowed to do.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** How many complete flow months feed a bucket's typical size. */
export const TYPICAL_MONTHS = 3;
/**
 * A variable category may reserve money for the rest of the month only if it spent in EVERY
 * month of the basis — a real monthly rhythm, not a memory.
 *
 * Reserve categories with a real monthly rhythm and let everything else share one free pool.
 * Reserving every category that ever had
 * a big month instead — a 2,000 ₪ furniture month, a 1,000 ₪ dental month — buries the
 * household under commitments it does not actually have, and the bottom line goes negative on
 * a month that is heading for a surplus. Groceries happen every month; a sofa does not.
 */
const REQUIRE_EVERY_MONTH = true;
/** Below this, a bucket's forecast is noise that only clutters the breakdown. */
const MIN_TYPICAL = 30;

export interface ExpectationRow {
  /** Category id (variable buckets) or merchant key (fixed buckets). */
  key: string;
  labelHe: string;
  kind: 'fixed' | 'variable';
  /** Already out this month. */
  spent: number;
  /** The typical month's size for this bucket — 0 when history cannot say. */
  typical: number;
  /** max(spent, typical) — what the month is expected to cost here. */
  expected: number;
  /** expected − spent: the part still ahead. */
  ahead: number;
}

export interface ExpectationView {
  rows: ExpectationRow[];
  /** Σ expected over every bucket — the month's expected total spend. */
  expectedTotal: number;
  /** Σ ahead — what is still expected to go out before the month ends. */
  aheadTotal: number;
  /** Σ spent — month-to-date, for reconciliation against the plan's own figures. */
  spentTotal: number;
  fixed: { spent: number; expected: number; ahead: number };
  variable: { spent: number; expected: number; ahead: number };
}

export interface ExpectationInput {
  /** This month's variable spend per category id (positive magnitudes). */
  variableSpentByCategory: Record<string, number>;
  /** Complete flow months → category id → variable spend. Oldest or newest order irrelevant. */
  variableHistory: Record<string, Record<string, number>>;
  /** The complete months to read, newest first; only the first TYPICAL_MONTHS are used. */
  completeMonths: string[];
  /** This month's fixed spend per merchant key. */
  fixedSpentByMerchant: Record<string, number>;
  /** The recurring calendar's monthly size per merchant key (positive magnitudes) — a stream
   *  is expected once per month whether or not its usual day has already passed. */
  fixedMonthlyByMerchant: Record<string, number>;
}

function categoryLabelHe(id: string): string {
  if (id === 'other') return 'שאר הקטגוריות';
  return CATEGORIES.find((c) => c.id === id)?.nameHe ?? id;
}

/** The median is the honest "typical": one holiday month of groceries must not raise the
 *  forecast for every month after it, which is exactly what a mean would do. */
function typicalOf(values: number[]): number {
  if (values.length === 0) return 0;
  const withSpend = values.filter((v) => v > 0);
  const enough = REQUIRE_EVERY_MONTH ? withSpend.length === values.length : withSpend.length >= 2;
  if (!enough || withSpend.length < 2) return 0;
  const s = [...withSpend].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

export function buildExpectation(input: ExpectationInput): ExpectationView {
  const {
    variableSpentByCategory, variableHistory, completeMonths,
    fixedSpentByMerchant, fixedMonthlyByMerchant,
  } = input;

  const basis = [...completeMonths].sort().reverse().slice(0, TYPICAL_MONTHS);
  const rows: ExpectationRow[] = [];

  // ── variable: one row per category, typical from the last complete months ──────────────
  const categoryIds = new Set<string>(Object.keys(variableSpentByCategory));
  for (const m of basis) for (const cat of Object.keys(variableHistory[m] ?? {})) categoryIds.add(cat);
  for (const cat of categoryIds) {
    const spent = round2(variableSpentByCategory[cat] ?? 0);
    const raw = typicalOf(basis.map((m) => variableHistory[m]?.[cat] ?? 0));
    const typical = raw >= MIN_TYPICAL ? raw : 0;
    const expected = round2(Math.max(spent, typical));
    if (expected <= 0) continue;
    rows.push({
      key: cat, labelHe: categoryLabelHe(cat), kind: 'variable',
      spent, typical, expected, ahead: round2(expected - spent),
    });
  }

  // ── fixed: one row per stream. A stream whose usual day has already passed WITHOUT a
  //    charge is still expected — RiseUp keeps their 1,040 ₪ of the 12.7 in the month's
  //    expectation on the 26.7. Dropping it is how a plan quietly promises money that is
  //    already committed.
  const merchants = new Set([...Object.keys(fixedSpentByMerchant), ...Object.keys(fixedMonthlyByMerchant)]);
  for (const merchant of merchants) {
    const spent = round2(fixedSpentByMerchant[merchant] ?? 0);
    const typical = round2(fixedMonthlyByMerchant[merchant] ?? 0);
    const expected = round2(Math.max(spent, typical));
    if (expected <= 0) continue;
    rows.push({
      key: merchant, labelHe: merchant, kind: 'fixed',
      spent, typical, expected, ahead: round2(expected - spent),
    });
  }

  rows.sort((a, b) => b.expected - a.expected);
  const sum = (pick: (r: ExpectationRow) => number, kind?: ExpectationRow['kind']) =>
    round2(rows.filter((r) => kind === undefined || r.kind === kind).reduce((s, r) => s + pick(r), 0));

  return {
    rows,
    expectedTotal: sum((r) => r.expected),
    aheadTotal: sum((r) => r.ahead),
    spentTotal: sum((r) => r.spent),
    fixed: {
      spent: sum((r) => r.spent, 'fixed'),
      expected: sum((r) => r.expected, 'fixed'),
      ahead: sum((r) => r.ahead, 'fixed'),
    },
    variable: {
      spent: sum((r) => r.spent, 'variable'),
      expected: sum((r) => r.expected, 'variable'),
      ahead: sum((r) => r.ahead, 'variable'),
    },
  };
}
