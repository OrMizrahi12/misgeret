/**
 * היעד שלי — the one thing the household actually declares.
 *
 * Everything else in this app is derived. This is the single input, and it is deliberately a
 * QUESTION A PERSON CAN ANSWER: *with what share of your income do you want to close each
 * month?* Nobody can name a good ceiling for variable spending off the top of their head — that
 * premise was always false, and a card that asked for one was asking the household to do the
 * app's job. But everyone can answer "I want to keep a tenth".
 *
 * From that one percentage the rest follows, and nothing else needs declaring:
 *
 *     reliable income − commitments − what the target keeps = what is left for variable spending
 *
 * So the ceiling is a CONSEQUENCE, not a decision. The app can now be wrong in only one place,
 * and the household can only be wrong about something it genuinely knows.
 *
 * Two figures keep the target honest, and both are computed here rather than asserted:
 *   • `observedRate` — what the household actually closes with today. A target set without it
 *     is a wish; set beside it, it is a step.
 *   • `maxRate` — the most that can be kept before variable spending drops under the essential
 *     floor. Above that line a target is not ambitious, it is arithmetic that cannot happen,
 *     and the card says so instead of congratulating the household on a number it will break.
 */

import { reliableIncomeOf } from './frame.js';
import type { MonthlySummary } from './txns.js';

export interface SavingsTargetInput {
  /** The declared share of income to keep (0–1), or null when nothing has been declared yet. */
  declaredRate: number | null;
  /** The running flow month — never part of a baseline. */
  currentMonth: string;
  /** Any order; only complete months with income are used. */
  summaries: MonthlySummary[];
  /** Monthly-equivalent of every LIVE expense commitment. */
  commitments: number;
  /** Median variable spend on categories a household cannot realistically drop. */
  essentialFloor: number;
  /** How many complete months before the illustration is honest. */
  minMonths?: number;
}

export interface SavingsTargetView {
  /** False when there is not enough history to say what a rate would MEAN in shekels.
   *  The declared rate still stands and still binds — it needs no history to apply. */
  available: boolean;
  reasonHe: string;
  completeMonths: number;

  /** What the household declared. null = not declared yet; nothing binds. */
  rate: number | null;
  /** What the app would propose — offered, never applied on its own. */
  suggestedRate: number;
  suggestionHe: string;
  /** `rate ?? suggestedRate` — what the illustration below is computed at. */
  effectiveRate: number;

  /** The median share of income the household actually closed its months with. */
  observedRate: number | null;
  /** The income the target is measured against — the level reached in 3 of 4 months. */
  reliableIncome: number;

  /** effectiveRate × reliableIncome. */
  keptAmount: number;
  commitments: number;
  /** The derived ceiling: what is left once the target and the commitments are honoured. */
  leftForVariable: number;
  essentialFloor: number;

  /** The highest rate that still leaves the essential floor standing. */
  maxRate: number;
  feasible: boolean;
  noteHe: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round0 = (n: number) => Math.round(n);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const pct = (r: number) => `${Math.round(r * 100)}%`;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A target is said out loud, so it moves in fives. "12.5%" is a spreadsheet, not an intention.
 *  Stepping happens in PERCENT, never in the share itself: `0.15 / 0.05` is 2.9999999999999996
 *  in binary floating point, and a naive floor turns a legitimate 15% into 10%. */
const percentOf = (r: number) => Math.round(r * 1000) / 10;
const stepDown = (r: number) => Math.max(0, Math.floor(percentOf(r) / 5 + 1e-9) * 5) / 100;
const stepUp = (r: number) => (Math.ceil(percentOf(r) / 5 - 1e-9) * 5) / 100;

/** The band a declared target may live in. Below 5% the number stops steering anything; above
 *  half the income it stops being a household budget and starts being a fantasy. */
export const TARGET_MIN = 0.05;
export const TARGET_MAX = 0.5;

export function isValidTargetRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0.01 && rate <= 0.6;
}

/**
 * The target, everything it implies, and the two facts that keep it honest.
 *
 * The suggestion is built from the household's own closing rate, never from a round number
 * somebody read in a book: one step above what it already does when there is room, the same
 * level when it is already doing well, and capped by what the structure can actually carry.
 */
export function savingsTarget(input: SavingsTargetInput): SavingsTargetView {
  const { declaredRate, currentMonth, commitments, essentialFloor } = input;
  const minMonths = input.minMonths ?? 3;

  const complete = input.summaries.filter((s) => s.month < currentMonth && s.income > 0);
  const K = complete.length;

  if (K < minMonths) {
    const effectiveRate = declaredRate ?? 0.1;
    return {
      available: false,
      reasonHe: `נדרשים לפחות ${minMonths} חודשים שלמים כדי להראות מה יעד החיסכון אומר בשקלים. יש כרגע ${K}.`,
      completeMonths: K,
      rate: declaredRate,
      suggestedRate: 0.1,
      suggestionHe: 'עשרה אחוזים הם נקודת פתיחה מקובלת. כשיצטברו כמה חודשים שלמים, ההצעה תיגזר מההתנהלות שלך עצמך.',
      effectiveRate,
      observedRate: null,
      reliableIncome: 0,
      keptAmount: 0,
      commitments: round0(commitments),
      leftForVariable: 0,
      essentialFloor: round0(essentialFloor),
      maxRate: 0,
      feasible: true,
      noteHe: '',
    };
  }

  const reliableIncome = reliableIncomeOf(complete.map((s) => s.income));
  const observedRate = round3(median(complete.map((s) => s.net / s.income)));

  // the ceiling on ambition: keep more than this and the month cannot buy groceries
  const maxRate = reliableIncome > 0
    ? Math.max(0, round3((reliableIncome - commitments - essentialFloor) / reliableIncome))
    : 0;
  const cap = stepDown(maxRate);

  // ── the suggestion ──────────────────────────────────────────────────────────────────────
  let suggested: number;
  let suggestionHe: string;

  if (observedRate >= 0.2) {
    // NOT rounded down to a five. A household closing at 24% that is told "keep your level"
    // and offered 20% has been told to save less than it already does, in the same breath —
    // the sentence and the number contradicting each other is worse than either being wrong.
    // Here the household's own rate IS the sayable number, so it is offered exactly.
    suggested = Math.min(0.4, Math.round(observedRate * 100) / 100);
    suggestionHe = `בחודש רגיל אתה כבר חוסך ${pct(observedRate)} מההכנסה. ההצעה: לקבע בדיוק את זה. מי שכבר חוסך חמישית — צריך רק להמשיך.`;
  } else if (observedRate <= 0) {
    suggested = TARGET_MIN;
    suggestionHe = `בחודשים השלמים האחרונים סגרת בממוצע ${observedRate < 0 ? 'במינוס' : 'על אפס'}. ${pct(TARGET_MIN)} זה לא יעד שאפתני — זו נקודת המפנה, החודש הראשון שנגמר עם משהו בצד.`;
  } else {
    suggested = Math.max(TARGET_MIN, stepUp(observedRate + 0.02));
    suggestionHe = `חודש רגיל נסגר אצלך עם ${pct(observedRate)} מההכנסה. ${pct(suggested)} הם הצעד הבא — קרוב מספיק כדי להחזיק, גבוה מספיק כדי להרגיש.`;
  }

  if (cap <= 0) {
    // Not a preference problem. Commitments plus the essential floor already take everything a
    // household can count on, and no percentage fixes that — saying otherwise would be the app
    // handing out a goal it knows will break.
    suggested = TARGET_MIN;
    suggestionHe = `הקבועות שלך + הוצאות החיים הבסיסיות כבר לוקחות כמעט את כל ההכנסה. ${pct(TARGET_MIN)} הם נקודת פתיחה — אבל כדי לעמוד בהם תצטרך לוותר על משהו קבוע, לא רק לקנות פחות.`;
  } else if (suggested >= cap) {
    // The ceiling is worth saying even when the suggestion happens to land exactly on it: "there
    // is no room above this" is information, and a household that raises the target anyway
    // deserves to have been told first.
    suggested = cap;
    suggestionHe += ` יותר מ־${pct(cap)} אי אפשר — לא יישאר לקבועות ולמחיה הבסיסית. לכן ההצעה נעצרת שם.`;
  }

  // ── what the effective rate actually means ──────────────────────────────────────────────
  const effectiveRate = declaredRate ?? suggested;
  const keptAmount = round2(reliableIncome * effectiveRate);
  const leftForVariable = round2(reliableIncome - commitments - keptAmount);
  const feasible = leftForVariable >= essentialFloor;

  // A negative figure is never printed inside a Hebrew sentence: a minus sign that ends up on
  // the wrong side of its number reads as a different number. The shortfall is stated as a
  // positive magnitude with the direction in words.
  let noteHe: string;
  if (feasible) {
    // The percent is always a share of the income that ACTUALLY arrived, never of an estimated month. No typical-month
    // shekel figure belongs in this sentence; typical income is structural context only.
    noteHe = `החיסכון הוא אחוז, לא סכום קבוע: בכל חודש נשמרים ${pct(effectiveRate)} ממה שנכנס בו בפועל. חודש חזק שם בצד יותר שקלים, חודש רזה פחות — החלק תמיד זהה, ולכן הוא נכון לכל חודש ולכל חשבון.`;
  } else if (leftForVariable < 0) {
    noteHe = `הקבועות + החיסכון יחד גדולים מההכנסה שאפשר לסמוך עליה — חסרים ${ILS.format(-leftForVariable)} בחודש, עוד לפני קנייה אחת. שום אחוז לא סוגר פער כזה; הצעד האמיתי הוא לוותר על משהו קבוע.`;
  } else {
    noteHe = `אחרי ${pct(effectiveRate)} לחיסכון נשארים ${ILS.format(leftForVariable)} לכל השאר — אבל רק הבסיס שלך (סופר, דלק, בית) עולה ${ILS.format(essentialFloor)}. היעד הזה לא יחזיק חודש שלם בלי לוותר על משהו קבוע.`;
  }


  return {
    available: true,
    reasonHe: '',
    completeMonths: K,
    rate: declaredRate,
    suggestedRate: round2(suggested),
    suggestionHe,
    effectiveRate: round3(effectiveRate),
    observedRate,
    reliableIncome: round0(reliableIncome),
    keptAmount: round0(keptAmount),
    commitments: round0(commitments),
    leftForVariable: round0(leftForVariable),
    essentialFloor: round0(essentialFloor),
    maxRate: round3(maxRate),
    feasible,
    noteHe,
  };
}
