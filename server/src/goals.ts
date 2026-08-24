/**
 * המטרות — an intention, measured.
 *
 * The app already had savings goals: an envelope, money you put in it, a ring that fills. What
 * it could not express is the other half of household finance — a goal to spend LESS. "להוריד
 * מסעדות ל-700" is a goal; it has no envelope, nobody deposits into it, and the only honest way
 * to know whether it is being kept is to read the transactions.
 *
 * So there are three shapes here, and each is measured by whatever tells the truth about it:
 *   buffer    — measured against real liquid money, not against deposits. A household that
 *               already holds ₪3,000 is 3,000 into its cushion, and a ring starting at zero
 *               would be a lie.
 *   set-aside — measured through the savings envelope funding it. This is the classic jar.
 *   reduction — measured off the transactions, month by month, from the month it started. A
 *               goal never claims credit for months that ended before it existed.
 *
 * Nothing here judges the running month. A partial month is not a kept promise or a broken one.
 */

import { CATEGORIES } from './categories.js';
import type { PlanGoalRow } from './db.js';

export interface PlanGoalProgress extends PlanGoalRow {
  /** What the goal has now: ₪ accumulated, or — for reductions — the latest complete month. */
  current: number;
  /** What it is heading for. null when the goal is an open-ended habit with no number. */
  target: number | null;
  /** 0..1, clamped. null when there is nothing to fill. */
  ratio: number | null;
  /** Months to the target at the committed rate; null when unknowable or already there. */
  etaMonths: number | null;
  /** Complete months judged since the goal started, and how many of them held. */
  monthsJudged: number;
  monthsHeld: number;
  /** null before there is a single complete month to judge. */
  onTrack: boolean | null;
  /** One line, in the goal's own terms. */
  standingHe: string;
  /** The category's Hebrew name, for reduction goals. */
  categoryNameHe: string | null;
}

export interface GoalsInput {
  goals: PlanGoalRow[];
  /** The running flow month — never judged. */
  currentMonth: string;
  /** Every complete flow month that holds data, oldest first. */
  completeMonths: string[];
  /** Bank + liquid assets + savings held outside the account; null when unknown. */
  liquidTotal: number | null;
  /** Savings envelope id → ₪ currently in it. */
  savedByGoalId: Record<number, number>;
  /** flow month → category → expense magnitude. */
  categoryByMonth: Record<string, Record<string, number>>;
}

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const round0 = (n: number) => Math.round(n);
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function categoryNameHe(id: string): string {
  if (id === 'uncategorized') return 'לא סווג';
  return CATEGORIES.find((c) => c.id === id)?.nameHe ?? id;
}

export function goalProgress(input: GoalsInput): PlanGoalProgress[] {
  const { goals, currentMonth, completeMonths, liquidTotal, savedByGoalId, categoryByMonth } = input;
  return goals.map((goal) => {
    // months this goal is entitled to judge: complete, and not older than the goal itself
    const judged = completeMonths.filter((m) => m >= goal.startMonth && m < currentMonth).sort();

    if (goal.type === 'reduction') return reductionProgress(goal, judged, categoryByMonth);
    if (goal.type === 'buffer') return bufferProgress(goal, judged, liquidTotal);
    return setAsideProgress(goal, judged, savedByGoalId);
  });
}

function base(goal: PlanGoalRow, judged: string[]): PlanGoalProgress {
  return {
    ...goal,
    current: 0,
    target: goal.targetAmount,
    ratio: null,
    etaMonths: null,
    monthsJudged: judged.length,
    monthsHeld: 0,
    onTrack: null,
    standingHe: '',
    categoryNameHe: goal.category ? categoryNameHe(goal.category) : null,
  };
}

/** A cushion is what you HOLD, not what you deposited — existing liquid money counts. */
function bufferProgress(goal: PlanGoalRow, judged: string[], liquidTotal: number | null): PlanGoalProgress {
  const out = base(goal, judged);
  if (liquidTotal === null) {
    out.standingHe = 'אין יתרת בנק ידועה — סנכרן חיבור כדי למדוד את הכרית.';
    return out;
  }
  out.current = round0(liquidTotal);
  const target = goal.targetAmount;
  if (target === null || target <= 0) {
    out.standingHe = `נזיל היום ${ILS.format(out.current)}.`;
    return out;
  }
  out.ratio = clamp01(liquidTotal / target);
  const gap = Math.max(0, target - liquidTotal);
  if (gap === 0) {
    out.onTrack = true;
    out.standingHe = 'הכרית הושגה.';
    return out;
  }
  if (goal.monthlyAmount && goal.monthlyAmount > 0) {
    out.etaMonths = Math.ceil(gap / goal.monthlyAmount);
    out.standingHe = `נותרו ${ILS.format(gap)} — בקצב שנקבע, כ-${out.etaMonths} חודשים.`;
  } else {
    out.standingHe = `נותרו ${ILS.format(gap)} עד היעד.`;
  }
  return out;
}

/** A jar: what is in it against what it is for. */
function setAsideProgress(goal: PlanGoalRow, judged: string[], savedByGoalId: Record<number, number>): PlanGoalProgress {
  const out = base(goal, judged);
  const saved = goal.savingsGoalId !== null ? (savedByGoalId[goal.savingsGoalId] ?? 0) : 0;
  out.current = round0(saved);
  if (goal.savingsGoalId === null) {
    out.standingHe = goal.monthlyAmount
      ? `התחייבות של ${ILS.format(goal.monthlyAmount)} בחודש. אין תוכנית חיסכון מקושרת, אז ההתקדמות אינה נמדדת אוטומטית.`
      : 'אין תוכנית חיסכון מקושרת, אז ההתקדמות אינה נמדדת אוטומטית.';
    return out;
  }
  const target = goal.targetAmount;
  if (target === null || target <= 0) {
    out.standingHe = `נצבר עד היום ${ILS.format(out.current)}.`;
    return out;
  }
  out.ratio = clamp01(saved / target);
  const gap = Math.max(0, target - saved);
  if (gap === 0) {
    out.onTrack = true;
    out.standingHe = 'היעד הושג.';
    return out;
  }
  if (goal.monthlyAmount && goal.monthlyAmount > 0) {
    out.etaMonths = Math.ceil(gap / goal.monthlyAmount);
    out.standingHe = `נותרו ${ILS.format(gap)} — בקצב שנקבע, כ-${out.etaMonths} חודשים.`;
  } else {
    out.standingHe = `נותרו ${ILS.format(gap)} עד היעד.`;
  }
  return out;
}

/**
 * A promise to spend less, checked month by month.
 *
 * "On track" is deliberately generous about ONE month and strict about the pattern: a single
 * month over the ceiling is life, and a household told it failed the first time it went out to
 * dinner stops believing the app. A majority of judged months holding is the bar.
 */
function reductionProgress(
  goal: PlanGoalRow,
  judged: string[],
  categoryByMonth: Record<string, Record<string, number>>,
): PlanGoalProgress {
  const out = base(goal, judged);
  const ceiling = goal.categoryCeiling;
  out.target = ceiling;
  if (goal.category === null || ceiling === null || ceiling <= 0) {
    out.standingHe = 'למטרה הזו חסר סף — עדכן כמה זה אמור להיות בחודש.';
    return out;
  }
  const spends = judged.map((m) => ({ month: m, amount: categoryByMonth[m]?.[goal.category as string] ?? 0 }));
  out.monthsHeld = spends.filter((s) => s.amount <= ceiling).length;
  if (spends.length === 0) {
    out.standingHe = `המטרה נקבעה החודש — החודש הראשון שיישפט הוא זה שרץ עכשיו.`;
    return out;
  }
  const latest = spends[spends.length - 1];
  out.current = round0(latest.amount);
  // the ring shows the LATEST complete month against its ceiling, capped: over is over
  out.ratio = clamp01(latest.amount / ceiling);
  out.onTrack = out.monthsHeld * 2 >= spends.length;
  const gap = round0(latest.amount - ceiling);
  out.standingHe = gap <= 0
    ? `החודש השלם האחרון נסגר בתוך הסף, ${out.monthsHeld} מתוך ${spends.length} החודשים שנשפטו החזיקו.`
    : `החודש השלם האחרון חרג ב-${ILS.format(gap)}, ${out.monthsHeld} מתוך ${spends.length} החודשים שנשפטו החזיקו.`;
  return out;
}
