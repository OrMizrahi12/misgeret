/**
 * ההמלצות — where a diagnosis becomes an act.
 *
 * Every other analysis module in this app OBSERVES: metrics.ts issues a verdict, overview.ts
 * names a trend, insights.ts points at a row. None of them ever says what to DO about it, and
 * a household that already knew what to do would not need us. This module closes that gap.
 *
 * Three laws hold it honest:
 *
 *  1. NOTHING HERE APPLIES ITSELF. Every item is a proposal with an accept gesture, exactly as
 *     patterns propose a nature and the user confirms it (the curated-commitments law). The app
 *     advises; the household decides.
 *  2. EVERY ITEM CARRIES A NUMBER, AND SAYS HOW CERTAIN IT IS. `valueCertain` separates money
 *     that provably stops leaving (a cancelled charge, interest already paid) from money merely
 *     at stake (a bank fee track whose saving depends on which track you pick). Only certain
 *     money may be summed into "what your decisions are worth".
 *  3. SILENCE IS STILL A FEATURE. Rules fire on real thresholds, the queue is ranked and capped,
 *     and a key the user dismissed never comes back — keys are built from facts, not wording,
 *     so a rephrased recommendation is still the same recommendation.
 *
 * Scope: this module reasons about SPENDING, FEES, COMMITMENTS, DEBT AND CUSHION — arithmetic
 * over the household's own transactions. It deliberately says nothing about how to invest,
 * which fund to hold, or what to do with a pension. That is advice we are not licensed to give
 * and cannot derive from a bank feed.
 */

import type { DayBalance } from './balance-history.js';
import type { FlaggedTxn } from './companies.js';
import { monthsBack } from './flow.js';
import { ESSENTIAL_CATEGORIES, isLoanLike } from './metrics.js';
import { CATEGORIES } from './categories.js';
import { companyKind } from './companies.js';
import type { SpendingPattern } from './patterns.js';
import type { RecurringItem } from './recurring.js';
import type { InstallmentPlan } from './subscriptions.js';
import type { MonthlySummary } from './txns.js';
import { DEFAULT_OVERDRAFT_ANNUAL_RATE } from './overview.js';

export type AdviceKind =
  | 'price-hike'
  | 'duplicate-service'
  | 'bank-fees'
  | 'overdraft-cost'
  | 'charge-date'
  | 'buffer'
  | 'installments-freeing'
  | 'category-creep'
  | 'income-smoothing'
  | 'annual-ahead'
  | 'dead-commitment';

/** What accepting this item buys you.
 *  - saving     — money that stops leaving the household.
 *  - resilience — money that moves to a better place (a cushion, a set-aside). Not a saving.
 *  - accuracy   — nothing moves; the app's own picture of your commitments gets truer. */
export type AdviceValueKind = 'saving' | 'resilience' | 'accuracy';

export type AdviceEffort = 'easy' | 'medium' | 'hard';

/** Where a click on this item should land the user. */
export type AdviceTarget = 'month' | 'patterns' | 'savings' | 'future' | 'health' | 'overview';

/** A goal this recommendation becomes when the household accepts it. Seeds only — the goal
 *  itself is created by the caller, so nothing enters the plan without an explicit yes. */
export interface AdviceGoalSeed {
  type: 'buffer' | 'reduction' | 'set-aside';
  nameHe: string;
  /** ₪ to accumulate, when the goal has an end. */
  targetAmount: number | null;
  /** ₪ per month the goal needs. */
  monthlyAmount: number | null;
  /** Reduction goals only: the category and the ceiling it should come back to. */
  category: string | null;
  categoryCeiling: number | null;
}

/** A figure that must carry its own label. Two entities never share a sentence, so anything
 *  that names more than one merchant / month / category emits labelled rows instead of prose
 *  (the number-attribution law). */
export interface AdviceLine {
  labelHe: string;
  amount: number;
  /** How the figure is printed. Money is the default because most of these are money — but a
   *  savings RATE printed as "₪2" and a day-of-month printed as "₪1" are the same class of bug
   *  the attribution law exists to kill: a number that lies about what it is. */
  unit?: 'ils' | 'percent' | 'day' | 'months';
}

export interface Advice {
  /** Stable identity, built from the FACTS the rule fired on — never from its wording. A
   *  dismissal must survive a rephrasing; a genuinely new fact must read as a new item. */
  key: string;
  kind: AdviceKind;
  /** What in the data triggered this. */
  observationHe: string;
  /** The concrete act, in the imperative the user can actually perform. */
  actionHe: string;
  /** ₪/month this is worth under the stated act. */
  monthlyValue: number;
  /** ₪/year — the figure a household actually feels. */
  annualValue: number;
  valueKind: AdviceValueKind;
  /** False when the figure is money AT STAKE rather than money provably freed. Uncertain
   *  values are never summed into what the household's decisions are worth. */
  valueCertain: boolean;
  effort: AdviceEffort;
  /** The metrics.ts id this item moves, when it maps to one. */
  targetMetric: string | null;
  /** The arithmetic, spelled out. This app never shows a number it cannot explain. */
  detailHe: string;
  /** Labelled figures — rendered as rows, never folded into a sentence. */
  lines: AdviceLine[];
  target: AdviceTarget;
  goal: AdviceGoalSeed | null;
}

export interface AdviceView {
  items: Advice[];
  /** What the whole queue is worth per month: money that provably stops leaving, and money
   *  merely on the table. Resilience and accuracy items enter neither. */
  potential: { certain: number; atStake: number };
  /** How many items the rules produced before the cap — so the UI can say "ועוד N". */
  totalFound: number;
}

export interface AdviceInput {
  today: string;
  /** The running flow month. It is never averaged into a baseline. */
  currentMonth: string;
  /** Any order; the running month is excluded by comparison against `currentMonth`. */
  summaries: MonthlySummary[];
  /** The 12-month analysis window, flagged. */
  rows: FlaggedTxn[];
  recurring: RecurringItem[];
  patterns: SpendingPattern[];
  installments: InstallmentPlan[];
  /** Full daily EOD series, oldest→newest. May be empty — every rule that needs it checks. */
  daily: DayBalance[];
  /** The salary-aware calendar's bucketing — the same one that bucketed `rows`. */
  monthOf: (iso: string) => string;
  /** Bank balance + manual assets marked liquid + savings held outside the account.
   *  null when no bank balance is known at all. */
  liquidTotal: number | null;
  annualOverdraftRate?: number;
  /** Keys the household already accepted, dismissed or completed. Never proposed again. */
  suppressed?: ReadonlySet<string>;
  /** How many items the queue may hold. Fewer, stronger — silence is a feature. */
  limit?: number;
}

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;
const round0 = (n: number) => Math.round(n);

function categoryNameHe(id: string): string {
  if (id === 'uncategorized') return 'לא סווג';
  return CATEGORIES.find((c) => c.id === id)?.nameHe ?? id;
}

function hebMonth(month: string): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' });
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Round a monthly rate to something a person would actually say out loud. */
function roundRate(n: number): number {
  if (n <= 0) return 0;
  if (n < 100) return Math.max(25, Math.round(n / 25) * 25);
  if (n < 1000) return Math.round(n / 50) * 50;
  return Math.round(n / 100) * 100;
}

/** Whole months from `today` to `date`, at least 1 — the divisor of every set-aside rate. */
function monthsUntil(today: string, date: string): number {
  const a = new Date(`${today}T12:00:00Z`);
  const b = new Date(`${date}T12:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return Math.max(1, months);
}

/**
 * The queue. Rules run in a fixed order, each returns zero or one item (a few return two), and
 * the ranking at the bottom decides what the household actually sees.
 */
export function buildAdvice(input: AdviceInput): AdviceView {
  const {
    today, currentMonth, rows, recurring, patterns, installments, daily, monthOf, liquidTotal,
  } = input;
  const suppressed = input.suppressed ?? new Set<string>();
  const limit = input.limit ?? 6;
  const rate = input.annualOverdraftRate ?? DEFAULT_OVERDRAFT_ANNUAL_RATE;

  const items: Advice[] = [];
  const push = (a: Advice) => { if (!suppressed.has(a.key)) items.push(a); };

  // ── the shared baseline: COMPLETE months only, oldest → newest ───────────────────────────
  const complete = input.summaries
    .filter((s) => s.month < currentMonth)
    .sort((a, b) => a.month.localeCompare(b.month));
  const completeMonths = complete.map((s) => s.month);
  const nMonths = complete.length;
  const avgIncome = mean(complete.map((s) => s.income));
  const avgNet = mean(complete.map((s) => s.net));

  // expenses per category per complete month — the base of every category rule
  const catMonthly = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.status !== 'completed' || r.excluded || r.amount >= 0 || !r.category) continue;
    const byMonth = catMonthly.get(r.category) ?? new Map<string, number>();
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + -r.amount);
    catMonthly.set(r.category, byMonth);
  }
  const catAvg = (cat: string) => mean(completeMonths.map((m) => catMonthly.get(cat)?.get(m) ?? 0));
  const essentialAvg = mean(
    completeMonths.map((m) => [...ESSENTIAL_CATEGORIES].reduce((s, c) => s + (catMonthly.get(c)?.get(m) ?? 0), 0)),
  );

  const bufferMonths = liquidTotal !== null && essentialAvg > 0 ? liquidTotal / essentialAvg : null;

  // The queue used to open by asking the household to declare a spending ceiling. It no longer
  // does: the one thing declared is the target, and the card that asks for it sits directly
  // above this list. A recommendation to do what the card above already asks is noise.

  // ── 1 · a tracked commitment whose price went up ─────────────────────────────────────────
  for (const p of patterns) {
    if (!p.isCommitment || !p.active || p.dismissed) continue;
    const last = p.recent.length > 0 ? p.recent[p.recent.length - 1] : null;
    if (last === null || p.typicalAmount <= 0) continue;
    const jump = last - p.typicalAmount;
    if (jump < 10 || jump < p.typicalAmount * 0.12) continue;
    // a yearly premium that rose by ₪600 is ₪50/month, not ₪600/month
    const perMonth = round2(jump * (p.monthlyAmount / p.typicalAmount));
    push({
      key: `hike|${p.merchant}|${round0(last)}`,
      kind: 'price-hike',
      observationHe: `${p.name} מחייב היום יותר מהרגיל.`,
      actionHe: `בדוק מול ${p.name} מה השתנה — או שקול לוותר.`,
      monthlyValue: perMonth,
      annualValue: round2(perMonth * 12),
      valueKind: 'saving',
      valueCertain: true,
      effort: 'easy',
      targetMetric: 'subscriptions',
      detailHe: `החיוב האחרון גבוה מהחיוב הרגיל של אותו בית עסק. ההפרש מנורמל לחודש לפי ${p.cadenceHe}.`,
      lines: [
        { labelHe: `${p.name} — החיוב הרגיל`, amount: round0(p.typicalAmount) },
        { labelHe: `${p.name} — החיוב האחרון`, amount: round0(last) },
      ],
      target: 'patterns',
      goal: null,
    });
  }

  // ── 2 · two live subscriptions inside one non-essential category ─────────────────────────
  const subsByCategory = new Map<string, SpendingPattern[]>();
  for (const p of patterns) {
    if (p.nature !== 'subscription' || !p.active || p.dismissed) continue;
    if (!p.category || p.category === 'transfers' || ESSENTIAL_CATEGORIES.has(p.category)) continue;
    const g = subsByCategory.get(p.category) ?? [];
    g.push(p);
    subsByCategory.set(p.category, g);
  }
  for (const [category, group] of subsByCategory) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
    const cheapest = sorted[sorted.length - 1];
    push({
      key: `dup|${category}|${group.map((p) => p.merchant).sort().join('+')}`,
      kind: 'duplicate-service',
      observationHe: `${group.length} מנויים פעילים בקטגוריית ${categoryNameHe(category)}.`,
      actionHe: 'בדוק אם באמת צריך את כולם — ויתור על אחד מהם משחרר את הסכום שלו.',
      monthlyValue: round2(cheapest.monthlyAmount),
      annualValue: round2(cheapest.monthlyAmount * 12),
      valueKind: 'saving',
      valueCertain: false,
      effort: 'easy',
      targetMetric: 'subscriptions',
      detailHe: `הסכום שמוצג הוא של המנוי הזול בקבוצה — הרצפה של מה שוויתור אחד שווה. כל מנוי מנורמל לעלות חודשית.`,
      lines: sorted.map((p) => ({ labelHe: p.name, amount: round0(p.monthlyAmount) })),
      target: 'patterns',
      goal: null,
    });
  }

  // ── 3 · bank fees ────────────────────────────────────────────────────────────────────────
  const feesAvg = catAvg('fees');
  if (nMonths >= 3 && feesAvg >= 30) {
    push({
      key: `fees|${round0(feesAvg / 10) * 10}`,
      kind: 'bank-fees',
      observationHe: `עמלות וריביות עולות בממוצע ${ILS.format(feesAvg)} בחודש.`,
      actionHe: 'בדוק מול הבנק מסלול עמלות — המסלולים מפוקחים וניתנים להשוואה.',
      monthlyValue: round2(feesAvg),
      annualValue: round2(feesAvg * 12),
      valueKind: 'saving',
      valueCertain: false,
      effort: 'medium',
      targetMetric: 'fees',
      detailHe: `ממוצע קטגוריית "עמלות" על פני ${nMonths} חודשים שלמים. כמה מזה באמת ייחסך תלוי במסלול שתבחר — לכן הסכום מוצג ככסף שעל השולחן, לא כחיסכון מובטח.`,
      lines: [
        { labelHe: 'עמלות בחודש ממוצע', amount: round0(feesAvg) },
        { labelHe: 'עמלות בשנה', amount: round0(feesAvg * 12) },
      ],
      target: 'health',
      goal: null,
    });
  }

  // ── 4 · the minus, priced ────────────────────────────────────────────────────────────────
  // Interest is computed exactly as overview.ts prices it, over the same complete months, so
  // the two surfaces can never quote two different costs for the same overdraft.
  const windowSet = new Set(completeMonths);
  let overdraftInterest = 0;
  let minusDays = 0;
  const dailyByFlowMonth = new Map<string, DayBalance[]>();
  for (const d of daily) {
    const m = monthOf(d.date);
    (dailyByFlowMonth.get(m) ?? dailyByFlowMonth.set(m, []).get(m)!).push(d);
    if (!windowSet.has(m) || d.balance >= 0) continue;
    overdraftInterest += -d.balance * (rate / 365);
    minusDays += 1;
  }
  if (overdraftInterest >= 120 && nMonths >= 3) {
    const perMonth = round2(overdraftInterest / nMonths);
    push({
      key: `minus|${round0(overdraftInterest / 100) * 100}`,
      kind: 'overdraft-cost',
      observationHe: `${minusDays} ימי מינוס ב-${nMonths} החודשים האחרונים.`,
      actionHe: 'צא מהמינוס — כל יום בתוכו נושא ריבית, וזו ההוצאה היחידה שאין מולה שום דבר.',
      monthlyValue: perMonth,
      annualValue: round2(perMonth * 12),
      valueKind: 'saving',
      valueCertain: true,
      effort: 'hard',
      targetMetric: 'overdraft',
      detailHe: `הריבית מוערכת לפי ${Math.round(rate * 1000) / 10}% שנתי על היתרה השלילית של כל יום, על פני ${nMonths} חודשים שלמים. זה כסף ששולם בפועל.`,
      lines: [
        { labelHe: `ריבית מוערכת ב-${nMonths} חודשים`, amount: round0(overdraftInterest) },
        { labelHe: 'ריבית בחודש ממוצע', amount: round0(perMonth) },
      ],
      target: 'future',
      goal: null,
    });
  }

  // ── 5 · the charge date, against the trough ──────────────────────────────────────────────
  // The cheapest fix in personal finance: the same money, moved three days, stops crossing zero.
  const salary = recurring.find((r) => r.kind === 'income' && r.amountStable && r.active && r.amount >= 3000);
  const settlement = recurring
    .filter((r) => r.kind === 'expense' && r.excludeReason === 'settlement' && r.active)
    .sort((a, b) => a.amount - b.amount)[0];
  if (minusDays > 0 && salary && settlement && daily.length >= 60) {
    const salaryDay = salary.dayOfMonth;
    const chargeDay = settlement.dayOfMonth;
    // the gap the charge lands in: how many days AFTER the salary the card is debited
    const gapFromSalary = (chargeDay - salaryDay + 31) % 31;
    // a charge that lands in the second half of the salary cycle is the classic squeeze
    if (gapFromSalary >= 12) {
      const suggested = ((salaryDay + 1) % 31) || 1;
      push({
        key: `chargeday|${settlement.merchant}|${chargeDay}`,
        kind: 'charge-date',
        observationHe: 'חיוב הכרטיס נוחת רחוק מהמשכורת — בדיוק בחלק הרזה של החודש.',
        actionHe: `בקש מחברת האשראי להזיז את יום החיוב לסביבות ה-${suggested} בחודש.`,
        monthlyValue: 0,
        annualValue: 0,
        valueKind: 'resilience',
        valueCertain: true,
        effort: 'easy',
        targetMetric: 'overdraft',
        detailHe: `אותו כסף, אותן הוצאות — רק בתאריך אחר. חיוב שנוחת סמוך למשכורת פוגש יתרה גבוהה, ולכן מייצר פחות ימי מינוס. שיחה אחת לחברת האשראי.`,
        lines: [
          { labelHe: 'יום המשכורת', amount: salaryDay, unit: 'day' },
          { labelHe: 'יום חיוב הכרטיס', amount: chargeDay, unit: 'day' },
        ],
        target: 'future',
        goal: null,
      });
    }
  }

  // ── 6 · installment plans about to free money up ─────────────────────────────────────────
  const freeingSoon = installments
    .filter((p) => p.endDate !== null && monthsUntil(today, p.endDate) <= 4)
    .slice(0, 2);
  for (const p of freeingSoon) {
    const endMonth = (p.endDate as string).slice(0, 7);
    push({
      key: `free|${p.merchant}|${endMonth}`,
      kind: 'installments-freeing',
      observationHe: `התשלומים על ${p.name} נגמרים ב${hebMonth(endMonth)}.`,
      actionHe: 'החלט מראש לאן הסכום הזה הולך — אחרת הוא פשוט ייבלע בהוצאות.',
      monthlyValue: p.sliceAmount,
      annualValue: round2(p.sliceAmount * 12),
      valueKind: 'resilience',
      valueCertain: true,
      effort: 'easy',
      targetMetric: 'debt-service',
      detailHe: `נותרו ${p.remaining} תשלומים מתוך ${p.total}. מהחודש שאחרי האחרון, הסכום החודשי הזה מפסיק לצאת — וזו ההזדמנות הכי זולה להגדיל חיסכון בלי לוותר על שום דבר.`,
      lines: [
        { labelHe: 'תשלום חודשי שמשתחרר', amount: p.sliceAmount },
        { labelHe: 'נותר לשלם בסך הכול', amount: p.remainingAmount },
      ],
      target: 'savings',
      goal: {
        type: 'set-aside',
        nameHe: `הפניית ${p.name} לחיסכון`,
        targetAmount: null,
        monthlyAmount: p.sliceAmount,
        category: null,
        categoryCeiling: null,
      },
    });
  }

  // ── 7 · a category climbing away from its own baseline ───────────────────────────────────
  // The recent window is judged against the months BEFORE it — a baseline must never contain
  // the months it judges.
  if (nMonths >= 6) {
    let worst: { category: string; recent: number; base: number } | null = null;
    for (const [category, byMonth] of catMonthly) {
      // a category nobody can act on is not a recommendation: "spend less on אחר" tells
      // a household nothing, and an uncategorised bucket is a classification gap, not a habit
      if (ESSENTIAL_CATEGORIES.has(category) || category === 'fees' || category === 'transfers') continue;
      if (category === 'other' || category === 'uncategorized') continue;
      const series = completeMonths.map((m) => byMonth.get(m) ?? 0);
      const recent = mean(series.slice(-3));
      const base = mean(series.slice(0, -3));
      if (base < 100) continue;
      if (recent < base * 1.25 || recent - base < 200) continue;
      if (!worst || recent - base > worst.recent - worst.base) worst = { category, recent, base };
    }
    if (worst) {
      const gap = round2(worst.recent - worst.base);
      const ceiling = roundRate(worst.base);
      push({
        key: `creep|${worst.category}|${round0(worst.base / 50) * 50}`,
        kind: 'category-creep',
        observationHe: `${categoryNameHe(worst.category)} עלתה מעל הרמה שהייתה מקובלת אצלך.`,
        actionHe: `החזר את ${categoryNameHe(worst.category)} לסביבות ${ILS.format(ceiling)} בחודש.`,
        monthlyValue: gap,
        annualValue: round2(gap * 12),
        valueKind: 'saving',
        valueCertain: false,
        effort: 'medium',
        targetMetric: 'discretionary-trend',
        detailHe: `3 החודשים האחרונים מושווים לחודשים שלפניהם — הבסיס לעולם אינו כולל את החודשים שהוא שופט. חזרה לרמת הבסיס היא ההפרש שמוצג כאן.`,
        lines: [
          { labelHe: `${categoryNameHe(worst.category)} — 3 החודשים האחרונים`, amount: round0(worst.recent) },
          { labelHe: `${categoryNameHe(worst.category)} — החודשים שלפניהם`, amount: round0(worst.base) },
        ],
        target: 'overview',
        goal: {
          type: 'reduction',
          nameHe: `להחזיר את ${categoryNameHe(worst.category)} לקו`,
          targetAmount: null,
          monthlyAmount: gap,
          category: worst.category,
          categoryCeiling: ceiling,
        },
      });
    }
  }

  // ── 8 · the cushion ──────────────────────────────────────────────────────────────────────
  if (bufferMonths !== null && bufferMonths < 3 && essentialAvg > 0 && nMonths >= 3) {
    const target = round0(essentialAvg * 3);
    const gap = Math.max(0, round0(target - (liquidTotal ?? 0)));
    // an affordable rate: half the typical surplus, never a rate that closes it slower than
    // three years — and never a number invented above what the months actually produce
    const affordable = avgNet > 0 ? roundRate(Math.min(avgNet * 0.5, gap / 12)) : 0;
    const monthly = affordable > 0 ? affordable : null;
    push({
      key: `buffer|${round0(target / 500) * 500}`,
      kind: 'buffer',
      observationHe: `הכרית הנזילה מכסה ${bufferMonths.toFixed(1)} חודשי הוצאות חיוניות.`,
      actionHe: monthly !== null
        ? `בנה כרית של 3 חודשים בקצב של ${ILS.format(monthly)} בחודש.`
        : 'בנה כרית של 3 חודשים — כרגע אין עודף חודשי לממן אותה, אז היא מתחילה מההמלצות שמשחררות כסף.',
      monthlyValue: monthly ?? 0,
      annualValue: 0,
      valueKind: 'resilience',
      valueCertain: true,
      effort: 'hard',
      targetMetric: 'buffer',
      detailHe: monthly !== null
        ? `היעד הוא 3 חודשי הוצאות חיוניות. הקצב המוצע הוא חצי ממה שנשאר לך בחודש רגיל, כדי שהוא ישרוד גם חודש פחות טוב. בקצב הזה הפער נסגר בכ-${Math.max(1, Math.ceil(gap / monthly))} חודשים.`
        : `היעד הוא 3 חודשי הוצאות חיוניות. החודשים השלמים האחרונים לא הותירו עודף שממנו אפשר להפריש, ולכן הצעד הראשון הוא לשחרר כסף — לא להתחייב לקצב שלא יחזיק.`,
      lines: [
        { labelHe: 'הוצאות חיוניות בחודש ממוצע', amount: round0(essentialAvg) },
        { labelHe: 'כרית היעד (3 חודשים)', amount: target },
        { labelHe: 'נזיל היום', amount: round0(liquidTotal ?? 0) },
        { labelHe: 'הפער', amount: gap },
      ],
      target: 'savings',
      goal: {
        type: 'buffer',
        nameHe: 'כרית חירום',
        targetAmount: target,
        monthlyAmount: monthly,
        category: null,
        categoryCeiling: null,
      },
    });
  }

  // The savings-rate ladder used to live here, proposing "aim for 7%". It is gone: the target
  // card asks that exact question and the household answers it there. Two surfaces proposing a
  // savings rate — with different numbers — is the app arguing with itself.

  // ── 9 · volatile income without a cushion to absorb it ───────────────────────────────────
  if (nMonths >= 6 && avgIncome > 0 && bufferMonths !== null && bufferMonths < 2) {
    const incomes = complete.map((m) => m.income);
    const med = median(incomes);
    const dips = incomes.filter((i) => i < med * 0.75);
    if (med > 0 && dips.length >= 2) {
      const typicalDip = round0(med - median(dips));
      push({
        key: `smooth|${round0(typicalDip / 100) * 100}`,
        kind: 'income-smoothing',
        observationHe: `${dips.length} מתוך ${nMonths} החודשים נכנסו נמוך משמעותית מחודש רגיל.`,
        actionHe: `בחודש טוב שים בצד את ההפרש מחודש רגיל — כך החודש הרזה ממומן מראש.`,
        monthlyValue: 0,
        annualValue: 0,
        valueKind: 'resilience',
        valueCertain: true,
        effort: 'medium',
        targetMetric: 'income-volatility',
        detailHe: `הכנסה תנודתית אינה סיכון בפני עצמה — היא הופכת לסיכון רק כשאין כרית שתספוג אותה, וכרגע הכרית מכסה ${bufferMonths.toFixed(1)} חודשים. מעטפת החלקה פותרת בדיוק את זה.`,
        lines: [
          { labelHe: 'הכנסה בחודש רגיל', amount: round0(med) },
          { labelHe: 'הכנסה בחודש רזה רגיל', amount: round0(median(dips)) },
          { labelHe: 'הפרש להפרשה בחודש טוב', amount: typicalDip },
        ],
        target: 'savings',
        goal: {
          type: 'set-aside',
          nameHe: 'מעטפת החלקה',
          targetAmount: null,
          monthlyAmount: roundRate(typicalDip / 2),
          category: null,
          categoryCeiling: null,
        },
      });
    }
  }

  // ── 10 · a big annual charge on the horizon ──────────────────────────────────────────────
  const annualAhead = recurring
    .filter((r) => r.kind === 'expense' && r.active && !r.excludedFlow && r.intervalDays >= 150)
    .map((r) => ({ item: r, months: monthsUntil(today, r.nextDate), amount: Math.abs(r.lastAmount || r.amount) }))
    .filter((r) => r.amount >= 1000 && r.months >= 1 && r.months <= 5)
    .sort((a, b) => a.months - b.months)
    .slice(0, 2);
  for (const { item, months, amount } of annualAhead) {
    const perMonth = roundRate(amount / months);
    push({
      key: `ahead|${item.merchant}|${item.nextDate.slice(0, 7)}`,
      kind: 'annual-ahead',
      observationHe: `חיוב גדול צפוי ב${hebMonth(item.nextDate.slice(0, 7))}.`,
      actionHe: `הפרש ${ILS.format(perMonth)} בחודש מהיום ועד אז — והחיוב יגיע כשהכסף כבר בצד.`,
      monthlyValue: perMonth,
      annualValue: 0,
      valueKind: 'resilience',
      valueCertain: true,
      effort: 'easy',
      targetMetric: null,
      detailHe: `הוצאה שנתית או חצי-שנתית שנוחתת בבת אחת היא הסיבה הנפוצה ביותר לחודש חריג. פריסה מראש הופכת אותה לחודש רגיל.`,
      lines: [
        { labelHe: `${item.sampleDescription} — החיוב הצפוי`, amount: round0(amount) },
        { labelHe: 'חודשים עד החיוב', amount: months, unit: 'months' },
        { labelHe: 'הפרשה חודשית מוצעת', amount: perMonth },
      ],
      target: 'savings',
      goal: {
        type: 'set-aside',
        nameHe: `הפרשה ל${item.sampleDescription}`,
        targetAmount: round0(amount),
        monthlyAmount: perMonth,
        category: null,
        categoryCeiling: null,
      },
    });
  }

  // ── 11 · a commitment that stopped charging but is still counted ─────────────────────────
  // Not a saving — an accuracy fix. It matters because the frame subtracts commitments: a dead
  // one makes the household's own ceiling look smaller than it is.
  for (const p of patterns) {
    if (!p.countsAsCommitted || p.active || p.dismissed || p.installmentPlan) continue;
    if (p.monthlyAmount < 20) continue;
    push({
      key: `dead|${p.merchant}|${p.lastDate}`,
      kind: 'dead-commitment',
      observationHe: `${p.name} נספר אצלך כמחויבות קבועה, אך לא חויב מאז ${new Date(`${p.lastDate}T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' })}.`,
      actionHe: 'אם השירות הסתיים — הסר אותו מהמחויבויות, כדי שהמסגרת תשקף את האמת.',
      monthlyValue: round2(p.monthlyAmount),
      annualValue: 0,
      valueKind: 'accuracy',
      valueCertain: true,
      effort: 'easy',
      targetMetric: 'fixed-commitments',
      detailHe: 'מחויבות שאינה מחייבת עוד גורעת מהמרחב הפנוי שלך בלי סיבה — היא מקטינה את המסגרת המוצעת ומעוותת את מדד המחויבויות הקבועות.',
      lines: [{ labelHe: `${p.name} — נספר כמחויבות`, amount: round0(p.monthlyAmount) }],
      target: 'patterns',
      goal: null,
    });
  }

  // ── the chain: a cushion with no surplus is funded by the savings this queue frees ───────
  const freed = round0(items.filter((a) => a.valueKind === 'saving' && a.valueCertain).reduce((s, a) => s + a.monthlyValue, 0));
  const bufferItem = items.find((a) => a.kind === 'buffer');
  if (bufferItem && bufferItem.monthlyValue === 0 && freed >= 100) {
    bufferItem.actionHe = `בנה כרית של 3 חודשים — ההמלצות שמעליה משחררות ${ILS.format(freed)} בחודש, וזו נקודת ההתחלה.`;
    bufferItem.lines = [...bufferItem.lines, { labelHe: 'משתחרר מההמלצות האחרות', amount: freed }];
  }

  // ── ranking: what is broken first, then what is worth most ───────────────────────────────
  // Tier 0 — the cushion and the minus: the two things that decide whether a household survives
  //          a surprise. Tier 1 — money on the table. Tier 2 — housekeeping.
  const TIER: Record<AdviceKind, number> = {
    buffer: 0,
    'overdraft-cost': 0,
    'charge-date': 1,
    'price-hike': 1,
    'duplicate-service': 1,
    'bank-fees': 1,
    'category-creep': 1,
    'installments-freeing': 1,
    'annual-ahead': 1,
    'income-smoothing': 2,
    'dead-commitment': 2,
  };
  items.sort((a, b) => TIER[a.kind] - TIER[b.kind]
    || (b.annualValue || b.monthlyValue * 12) - (a.annualValue || a.monthlyValue * 12));

  const savings = items.filter((a) => a.valueKind === 'saving');
  return {
    items: items.slice(0, limit),
    potential: {
      certain: round0(savings.filter((a) => a.valueCertain).reduce((s, a) => s + a.monthlyValue, 0)),
      atStake: round0(savings.filter((a) => !a.valueCertain).reduce((s, a) => s + a.monthlyValue, 0)),
    },
    totalFound: items.length,
  };
}

/** Kept out of the rule bodies so the loan-detection heuristic has exactly one home. */
export function loanRepaymentsPerMonth(rows: FlaggedTxn[], months: string[]): number {
  if (months.length === 0) return 0;
  return mean(
    months.map((m) =>
      rows
        .filter((r) => r.month === m && r.status === 'completed' && !r.excluded && r.amount < 0
          && companyKind(r.company) === 'bank' && isLoanLike(r.description))
        .reduce((s, r) => s + -r.amount, 0),
    ),
  );
}

/** Installment slices per month, averaged over the given complete months. */
export function installmentsPerMonth(rows: FlaggedTxn[], months: string[]): number {
  if (months.length === 0) return 0;
  return mean(
    months.map((m) =>
      rows
        .filter((r) => r.month === m && r.status === 'completed' && !r.excluded
          && r.type === 'installments' && r.amount < 0)
        .reduce((s, r) => s + -r.amount, 0),
    ),
  );
}

/** Re-exported so the frame proposal and the advice queue can never disagree about which
 *  months count as "complete". */
export function completeMonthsOf(summaries: MonthlySummary[], currentMonth: string): MonthlySummary[] {
  return summaries.filter((s) => s.month < currentMonth).sort((a, b) => a.month.localeCompare(b.month));
}

/** The month N months before the running one — used by callers assembling windows. */
export const monthBefore = (month: string, n: number) => monthsBack(month, n);
