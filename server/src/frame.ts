/**
 * המסגרת החודשית — the intention layer.
 *
 * One number the household declares: how much variable spending a month should hold.
 * Everything else in the app OBSERVES; this is the single place the user DECIDES, and the
 * month is then measured against the decision.
 *
 * History is append-per-month: one row per flow month in which the number was (re)declared.
 * The frame in force for month M is the newest declaration made in a month ≤ M — so a
 * finished month is always judged against the frame that was in force THEN, never against
 * today's ambition. A NULL amount is a declaration too: "off from this month on".
 *
 * Since 4.9 the app no longer asks for the number cold. `frameProposal` derives it from the
 * household's own data and offers three stances, because the premise "the user knows what a
 * good ceiling is" was never true — someone who could name that number would not need us.
 * The proposal is still only a proposal: nothing is ever declared without an explicit accept.
 */

import { CATEGORIES, merchantKey } from './categories.js';
import type { FlaggedTxn } from './companies.js';
import { ESSENTIAL_CATEGORIES } from './metrics.js';
import type { MonthlySummary } from './txns.js';

export interface FrameEntry {
  /** Flow month (YYYY-MM) in which the declaration was made. */
  month: string;
  /** The declared ceiling in ₪, or null when the frame was switched off from this month on. */
  amount: number | null;
  setAt: string;
}

/** The frame in force for `month`, or null when none was declared yet (or it was switched off). */
export function frameForMonth(history: FrameEntry[], month: string): number | null {
  let best: FrameEntry | null = null;
  for (const e of history) {
    if (e.month > month) continue;
    if (!best || e.month > best.month) best = e;
  }
  return best?.amount ?? null;
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * The split
 * ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * "Variable" has exactly ONE definition in this app: completed, non-excluded expenses that did
 * NOT go to a live fixed commitment. The frame card, the plan card, the month review and the
 * proposal all read it from here, so they can never quote two different numbers for the same
 * month — the bug class that would make the whole feature untrustworthy.
 */
export function variableByMonth(
  rows: FlaggedTxn[],
  fixedMerchants: ReadonlySet<string>,
): { total: Record<string, number>; byCategory: Record<string, Record<string, number>> } {
  const total: Record<string, number> = {};
  const byCategory: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (r.status !== 'completed' || r.excluded || r.amount >= 0) continue;
    if (fixedMerchants.has(merchantKey(r.description, r.memo))) continue;
    const amount = -r.amount;
    total[r.month] = round2((total[r.month] ?? 0) + amount);
    const cat = r.category ?? 'other';
    const g = byCategory[r.month] ?? (byCategory[r.month] = {});
    g[cat] = round2((g[cat] ?? 0) + amount);
  }
  return { total, byCategory };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * The proposal
 * ───────────────────────────────────────────────────────────────────────────────────────── */

export type FrameStanceId = 'tight' | 'recommended' | 'comfortable';

export interface FrameStance {
  id: FrameStanceId;
  nameHe: string;
  amount: number;
  /** What choosing this stance means, in one line. */
  meaningHe: string;
}

/** One line of the arithmetic, so the household can follow the ceiling to its source. */
export interface FrameDerivationRow {
  labelHe: string;
  amount: number;
  sign: 'plus' | 'minus' | 'total';
}

export interface FrameSplitRow {
  category: string;
  nameHe: string;
  /** The share of the frame this category should hold. */
  amount: number;
  /** The household's own median for this category — what the share was derived from. */
  medianSpend: number;
}

export interface FrameDrift {
  /** The complete months judged, oldest first. */
  months: { month: string; frame: number; spent: number }[];
  direction: 'over' | 'under';
  /** Median gap between reality and the declared frame (positive magnitude). */
  gap: number;
  /** What reality says the frame actually is. */
  honestAmount: number;
}

/**
 * The promise the frame carries. A ceiling with no promise attached is just a number; this is
 * what makes it checkable: at an income level the household actually reaches, staying inside
 * the frame sets THIS much aside and closes the month THIS far in the plus.
 */
export interface FramePromise {
  /** The income the promise is made at — the level reached in 3 of 4 months. */
  atIncome: number;
  /** What gets put aside at that income, every month, before any variable spending. */
  setAside: number;
  /** What is still left over at the ceiling. Negative only when the essential floor forced the
   *  frame above what the structure can carry — and then the promise is broken, out loud. */
  leftOver: number;
  kept: boolean;
}

export interface FrameProposal {
  available: boolean;
  /** Why there is no proposal, when there is none. */
  reasonHe: string;
  completeMonths: number;
  stances: FrameStance[];
  /** The stance the app puts its name behind. */
  recommended: number;
  /** The specific thing the recommendation is trying to fix — never a generic platitude. */
  rationaleHe: string;
  derivation: FrameDerivationRow[];
  split: FrameSplitRow[];
  promise: FramePromise | null;
  observed: {
    /** The household's own median variable month. */
    medianVariable: number;
    /** Median variable spend on categories a household cannot realistically drop. */
    essentialFloor: number;
    /** Reliable income − live commitments − what is set aside. */
    freeSpace: number;
    /** The middle month. Kept for context; the frame is NOT built on it. */
    typicalIncome: number;
    /** The income reached in 3 of 4 months — what the frame IS built on. */
    reliableIncome: number;
    /** What the frame protects every month before a shekel of variable spending. */
    setAside: number;
  };
  /** Reality vs the declared frame over the last complete months; null when not judgeable. */
  drift: FrameDrift | null;
}

export interface FrameProposalInput {
  /** The running flow month — never part of a baseline. */
  currentMonth: string;
  /** Any order. */
  summaries: MonthlySummary[];
  /** flow month → variable spend, from `variableByMonth`. */
  variable: Record<string, number>;
  /** flow month → category → variable spend, from `variableByMonth`. */
  variableCategory: Record<string, Record<string, number>>;
  /** Monthly-equivalent of every LIVE expense commitment — the same set the plan calls "fixed". */
  fixedMonthly: number;
  /** Bank + liquid assets + external savings; null when unknown. */
  liquidTotal: number | null;
  /** The declarations made so far — drives the drift judgment. */
  history: FrameEntry[];
  /** How many complete months a proposal needs before it is honest. */
  minMonths?: number;
  /** Share of reliable income to protect when the household has declared no savings of its own.
   *  Raised automatically while the emergency cushion is thin. */
  setAsideRate?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round0 = (n: number) => Math.round(n);

/** A frame is a round intention, not an accounting figure. */
function roundFrame(n: number): number {
  if (n <= 0) return 0;
  if (n < 5000) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile, oldest statistic in the book. */
function percentile(nums: number[], p: number): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/**
 * The income a household can actually count on — the level it reaches in 3 months out of 4.
 *
 * A MEDIAN is the wrong statistic for a ceiling, and this is the single most important line in
 * the module. By definition half the months fall below the median, so a ceiling built on it is
 * unaffordable half the time — which is precisely how the app once recommended ₪10,700 to a
 * household whose July earned ₪12,953. A ceiling has to survive the ordinary bad month, not the
 * average one.
 */
export function reliableIncomeOf(incomes: number[]): number {
  return round2(percentile(incomes, 0.25));
}

function categoryNameHe(id: string): string {
  if (id === 'uncategorized') return 'לא סווג';
  return CATEGORIES.find((c) => c.id === id)?.nameHe ?? id;
}

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

const EMPTY: FrameProposal = {
  available: false,
  reasonHe: '',
  completeMonths: 0,
  stances: [],
  recommended: 0,
  rationaleHe: '',
  derivation: [],
  split: [],
  promise: null,
  observed: {
    medianVariable: 0, essentialFloor: 0, freeSpace: 0, typicalIncome: 0,
    reliableIncome: 0, setAside: 0,
  },
  drift: null,
};

/**
 * The recommendation — derived from a PROMISE, not from a habit.
 *
 * The frame is built top-down from the guarantee that it protects money set aside and avoids
 * ending an ordinary low-income month in overdraft:
 *
 *     RELIABLE income  (the level reached in 3 of 4 months — never the median, because half
 *                       the months fall below a median and a ceiling must survive an ordinary
 *                       bad month, not an average one)
 *   − live commitments
 *   − what is deliberately set aside  (the household's own savings commitments, or a protected
 *                                      share of income when it has declared none)
 *   ─────────────────
 *   = the most that can be spent while BOTH promises hold
 *
 * ...and then capped at what the household actually spends, because there is never a reason to
 * invite more spending than a household already does. Finally clamped up to the essential floor
 * — and if the floor sits above the structure, the promise is broken and says so out loud.
 *
 * The result carries `promise`: at an income the household really reaches, staying inside the
 * frame sets this much aside and closes the month this far in the plus. A ceiling with no
 * promise attached is just a number.
 */
export function frameProposal(input: FrameProposalInput): FrameProposal {
  const {
    currentMonth, variable, variableCategory, fixedMonthly, liquidTotal, history,
  } = input;
  const minMonths = input.minMonths ?? 3;

  const complete = input.summaries
    .filter((s) => s.month < currentMonth)
    .sort((a, b) => a.month.localeCompare(b.month));
  // a month with no variable spend at all is a month we do not really hold — it would drag
  // every median down and propose a ceiling nobody could live inside
  const months = complete.map((s) => s.month).filter((m) => (variable[m] ?? 0) > 0);
  const K = months.length;

  if (K < minMonths) {
    return {
      ...EMPTY,
      completeMonths: K,
      reasonHe: `נדרשים לפחות ${minMonths} חודשים שלמים כדי להציע מסגרת שמבוססת על ההתנהלות שלך. יש כרגע ${K}.`,
      drift: computeDrift(history, variable, complete.map((s) => s.month)),
    };
  }

  const typicalIncome = round2(median(complete.map((s) => s.income)));
  const reliableIncome = reliableIncomeOf(complete.map((s) => s.income));
  const medianVariable = round2(median(months.map((m) => variable[m] ?? 0)));

  // the floor: variable spend on categories a household cannot realistically drop
  const essentialFloor = round2(median(months.map((m) => {
    const g = variableCategory[m] ?? {};
    return [...ESSENTIAL_CATEGORIES].reduce((s, c) => s + (g[c] ?? 0), 0);
  })));

  // ── what gets protected before a shekel of variable spending ────────────────────────────
  // The household's own savings commitments come first; when it has declared none, a share of
  // reliable income is protected anyway, because "set something aside" is the whole point. The
  // share rises while the cushion is thin — that is the buffer rule, folded in rather than
  // bolted on as a separate nudge.
  const essentialAll = essentialFloor + fixedMonthly; // the whole "cannot drop" side of a month
  const bufferMonths = liquidTotal !== null && essentialAll > 0 ? liquidTotal / essentialAll : null;
  const thinCushion = bufferMonths !== null && bufferMonths < 3;
  const rate = input.setAsideRate ?? (thinCushion ? 0.15 : 0.1);
  const setAside = round2(reliableIncome * rate);

  const freeSpace = round2(reliableIncome - fixedMonthly - setAside);

  // ── the recommendation ──────────────────────────────────────────────────────────────────
  let recommendedRaw: number;
  let rationaleHe: string;

  if (freeSpace <= 0) {
    // Commitments plus the set-aside already outrun income a household can count on. No ceiling
    // closes that, and a number derived from the habit here would look like a plan while the
    // structure is what needs to change.
    recommendedRaw = essentialFloor;
    rationaleHe = `המחויבויות הקבועות שלך, יחד עם ההפרשה לצד, כבר גדולות מההכנסה שאפשר לסמוך עליה — עוד לפני הוצאה משתנה אחת. שום מסגרת לא סוגרת פער כזה, ולכן ההמלצה מוצמדת לרצפה החיונית בלבד. הצעד האמיתי כאן הוא להקטין מחויבות, לא להידק את הקניות.`;
  } else if (medianVariable > freeSpace) {
    recommendedRaw = freeSpace;
    rationaleHe = `אתה מוציא היום יותר ממה שנשאר אחרי המחויבויות וההפרשה לצד. ההמלצה היא בדיוק הסכום שמאפשר לשניהם להתקיים — בחודש שנכנסת בו הכנסה שאפשר לסמוך עליה, נשארים בתוכו וגם מפרישים וגם לא נכנסים לגירעון.`;
  } else {
    // there is never a reason to invite MORE spending than a household already does
    recommendedRaw = medianVariable;
    rationaleHe = `המבנה שלך מאפשר יותר ממה שאתה בפועל מוציא, ולכן ההמלצה היא פשוט הרמה שלך עצמך — אין סיבה להזמין הוצאה נוספת. בתוכה ההפרשה לצד מובטחת, והחודש נסגר בעודף.`;
  }

  // the floor is absolute: no recommendation may sit under what a household must spend
  const floorWithMargin = roundFrame(essentialFloor * 1.1);
  const recommended = roundFrame(Math.max(recommendedRaw, floorWithMargin));
  const floorWon = freeSpace > 0 && recommended > roundFrame(recommendedRaw);
  if (floorWon) {
    rationaleHe += ' ההמלצה נעצרה ברצפה החיונית — מתחתיה זו כבר לא מסגרת אלא הבטחה שלא תחזיק.';
  }

  // ── the promise the frame carries ───────────────────────────────────────────────────────
  const leftOver = round2(freeSpace - recommended);
  const promise: FramePromise = {
    atIncome: round0(reliableIncome),
    setAside: round0(setAside),
    leftOver: round0(leftOver),
    kept: leftOver >= 0,
  };

  // "נוח" drops the extra protection but keeps whatever the household itself committed to —
  // it is the ceiling, not permission to save nothing
  const comfortable = roundFrame(Math.max(reliableIncome - fixedMonthly, recommended));
  const stances: FrameStance[] = [
    {
      id: 'tight',
      nameHe: 'שמרני',
      amount: floorWithMargin,
      meaningHe: 'חודש הצלה — הרצפה החיונית שלך בתוספת מרווח נשימה קטן.',
    },
    {
      id: 'recommended',
      nameHe: 'מומלץ',
      amount: recommended,
      meaningHe: promise.kept
        ? `בתוכה מופרשים ${ILS.format(setAside)} בחודש, והחודש נסגר בפלוס גם בחודש רזה.`
        : 'הרצפה החיונית שלך גבוהה ממה שהמבנה מאפשר — המסגרת הזו לא מבטיחה חודש מאוזן.',
    },
    {
      id: 'comfortable',
      nameHe: 'נוח',
      amount: comfortable,
      meaningHe: freeSpace > 0
        ? 'התקרה — כאן כבר לא מופרש כלום מעבר למה שהתחייבת, והחודש נסגר בערך על אפס.'
        : 'המרחב הפנוי שלילי, ולכן אין כאן תקרה אמיתית — כל הוצאה משתנה מגדילה את הפער.',
    },
  ];

  // ── the derivation, in the order a person would say it out loud ─────────────────────────
  const derivation: FrameDerivationRow[] = [
    { labelHe: 'הכנסה שאפשר לסמוך עליה', amount: round0(reliableIncome), sign: 'plus' },
    { labelHe: 'מחויבויות קבועות ותשלומים', amount: round0(fixedMonthly), sign: 'minus' },
    { labelHe: 'הפרשה לצד', amount: round0(setAside), sign: 'minus' },
    { labelHe: 'נשאר להוצאות משתנות', amount: round0(freeSpace), sign: 'total' },
  ];

  return {
    available: true,
    reasonHe: '',
    completeMonths: K,
    stances,
    recommended,
    rationaleHe,
    derivation,
    split: proposeSplit(recommended, months, variableCategory),
    promise,
    observed: {
      medianVariable,
      essentialFloor,
      freeSpace,
      typicalIncome,
      reliableIncome,
      setAside,
    },
    drift: computeDrift(history, variable, complete.map((s) => s.month)),
  };
}

/**
 * The frame, broken into the categories that actually carry it.
 *
 * One number is a good headline and a poor instrument: a household told "you overran" in week
 * three cannot act on it without knowing WHERE. The split is derived from the household's own
 * medians and scaled to the declared frame — nothing to configure, and it follows habits as
 * they change. Categories below a meaningful share fold into "שאר ההוצאות" rather than
 * producing a row nobody can steer.
 */
export function proposeSplit(
  frameAmount: number,
  months: string[],
  variableCategory: Record<string, Record<string, number>>,
  maxRows = 4,
): FrameSplitRow[] {
  if (frameAmount <= 0 || months.length === 0) return [];

  const medians = new Map<string, number>();
  const categories = new Set<string>();
  for (const m of months) for (const c of Object.keys(variableCategory[m] ?? {})) categories.add(c);
  for (const c of categories) {
    medians.set(c, median(months.map((m) => variableCategory[m]?.[c] ?? 0)));
  }

  const ranked = [...medians.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return [];

  const totalMedian = ranked.reduce((s, [, v]) => s + v, 0);
  if (totalMedian <= 0) return [];

  // A row exists to be steered, so a category nobody can steer never gets one. Transfers are
  // money moving, not a habit with a dial; "אחר" and "לא סווג" are classification gaps. Their
  // shekels still count — they land in the remainder, which is where an unsteerable number
  // belongs. (Same reasoning that keeps the creep rule off these categories.)
  const UNSTEERABLE = new Set(['transfers', 'other', 'uncategorized']);
  // a row worth steering: at least a twelfth of the frame, and never more rows than maxRows
  const named = ranked
    .filter(([c, v]) => !UNSTEERABLE.has(c) && v / totalMedian >= 1 / 12)
    .slice(0, maxRows);
  const namedSum = named.reduce((s, [, v]) => s + v, 0);

  const rows: FrameSplitRow[] = named.map(([category, med]) => ({
    category,
    nameHe: categoryNameHe(category),
    amount: roundFrame((med / totalMedian) * frameAmount),
    medianSpend: round0(med),
  }));

  // the remainder carries the rounding, so the split always sums to the frame exactly
  const rest = round0(frameAmount - rows.reduce((s, r) => s + r.amount, 0));
  if (rest > 0) {
    rows.push({
      category: 'rest',
      nameHe: 'שאר ההוצאות',
      amount: rest,
      medianSpend: round0(totalMedian - namedSum),
    });
  }
  return rows;
}

/** This month's standing against the split — the mid-month "where exactly am I leaking". */
export interface FrameSplitProgress extends FrameSplitRow {
  spent: number;
  /** Spend projected to the end of the month at the pace walked so far. */
  projected: number;
  /** Over the category's share at the current pace. */
  over: boolean;
}

export function splitProgress(
  split: FrameSplitRow[],
  spentByCategory: Record<string, number>,
  daysElapsed: number,
  daysInMonth: number,
): FrameSplitProgress[] {
  const namedCategories = new Set(split.map((r) => r.category));
  const restSpent = Object.entries(spentByCategory)
    .filter(([c]) => !namedCategories.has(c))
    .reduce((s, [, v]) => s + v, 0);
  const factor = daysElapsed > 0 ? daysInMonth / daysElapsed : 1;
  return split.map((row) => {
    const spent = round2(row.category === 'rest' ? restSpent : (spentByCategory[row.category] ?? 0));
    const projected = round0(spent * factor);
    return { ...row, spent, projected, over: projected > row.amount };
  });
}

/**
 * Reality against the declaration.
 *
 * The single most valuable thing a frame can do is refuse to let a household lie to itself —
 * in EITHER direction. Three complete months that all overran by a similar amount do not mean
 * the household failed three times; they mean the number was wrong. And three months that all
 * landed far under mean the frame is not steering anything.
 *
 * Judged only on months that had a frame in force, and only on the last three of them, so a
 * correction made two months ago is not still being argued with.
 */
export function computeDrift(
  history: FrameEntry[],
  variable: Record<string, number>,
  completeMonths: string[],
): FrameDrift | null {
  const judged: { month: string; frame: number; spent: number }[] = [];
  for (const month of [...completeMonths].sort()) {
    const frame = frameForMonth(history, month);
    const spent = variable[month];
    if (frame === null || frame <= 0 || spent === undefined) continue;
    judged.push({ month, frame, spent: round2(spent) });
  }
  const last = judged.slice(-3);
  if (last.length < 3) return null;

  const gaps = last.map((m) => m.spent - m.frame);
  // "consistent" means every month agrees on the direction — one bad month is life, not a signal
  const allOver = gaps.every((g) => g > 0);
  const allUnder = gaps.every((g) => g < 0);
  if (!allOver && !allUnder) return null;

  const gap = Math.abs(median(gaps));
  const referenceFrame = last[last.length - 1].frame;
  // a gap must be material before it is worth re-opening a decision
  if (gap < Math.max(200, referenceFrame * 0.08)) return null;

  return {
    months: last,
    direction: allOver ? 'over' : 'under',
    gap: round0(gap),
    honestAmount: roundFrame(median(last.map((m) => m.spent))),
  };
}

/** The sentence the drift deserves — one place, so the month card and the review never differ. */
export function driftSentenceHe(drift: FrameDrift): string {
  return drift.direction === 'over'
    ? `שלושה חודשים שלמים ברצף נגמרו מעל המסגרת. זה כבר לא חודש חריג — זה אומר שהמסגרת שלך אינה ${ILS.format(drift.months[drift.months.length - 1].frame)} אלא ${ILS.format(drift.honestAmount)}. או שמורידים בפועל, או שמעדכנים את המספר לאמת.`
    : `שלושה חודשים שלמים ברצף נגמרו הרבה מתחת למסגרת. מסגרת רחבה מדי לא מכוונת כלום — הורדה ל-${ILS.format(drift.honestAmount)} תחזיר לה משמעות.`;
}
