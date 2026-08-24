import type { BalanceStats } from './balance-history.js';
import { companyKind, type FlaggedTxn } from './companies.js';
import type { SpendingPatternsView } from './patterns.js';
import type { RecurringItem } from './recurring.js';
import type { MonthlySummary } from './txns.js';

export type Band = 'green' | 'yellow' | 'red' | 'na';
export type Axis = 'level' | 'resilience';

type RatedBand = Exclude<Band, 'na'>;

export interface VisualPoint {
  label: string;
  value: number;
}

export interface VisualMarker {
  value: number;
  labelHe: string;
}

export type MetricVisual =
  | {
      kind: 'bullet';
      value: number;
      min: number;
      max: number;
      format: 'percent';
      zones: { from: number; to: number; band: RatedBand }[];
      markers: VisualMarker[];
    }
  | {
      kind: 'segments';
      value: number;
      max: number;
      markers: VisualMarker[];
    }
  | {
      kind: 'trend';
      points: VisualPoint[];
      references: {
        value: number;
        labelHe: string;
        tone: 'neutral' | 'danger';
        dangerDirection?: 'below' | 'above';
      }[];
      format: 'ils';
    }
  | {
      kind: 'composition';
      used: number;
      total: number;
      ratio: number;
      usedLabelHe: string;
      remainderLabelHe: string;
      markers: VisualMarker[];
    }
  | {
      kind: 'month-outcomes';
      points: VisualPoint[];
    }
  | {
      kind: 'overdraft';
      points: { label: string; minBalance: number; daysBelowZero: number }[];
      slope: number | null;
      declineThreshold: number;
    }
  | {
      kind: 'subscriptions';
      items: VisualPoint[];
      total: number;
      share: number;
      markers: VisualMarker[];
    }
  | {
      kind: 'comparison';
      primary: number;
      reference: number;
      ratio: number;
      primaryLabelHe: string;
      referenceLabelHe: string;
      markers: VisualMarker[];
    };

export interface MetricResult {
  id: string;
  nameHe: string;
  axis: Axis;
  band: Band;
  display: string; // the headline value, already formatted
  detailHe: string; // the math, shown to the user — every number must be explainable
  visual: MetricVisual | null; // raw, typed values for an honest visualization; null means unavailable, never zero
}

export interface HealthReport {
  overall: { statusHe: string; band: Band; reasonHe: string };
  level: MetricResult[];
  resilience: MetricResult[];
}

/** Categories a household cannot realistically drop (needs, not wants). */
export const ESSENTIAL_CATEGORIES: ReadonlySet<string> = new Set([
  'housing', 'groceries', 'bills', 'health', 'insurance', 'education', 'transport',
]);
const DISCRETIONARY_CATEGORIES: ReadonlySet<string> = new Set(['restaurants', 'shopping', 'leisure']);

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const pct = (n: number) => `${Math.round(n * 100)}%`;

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export interface MetricsInput {
  /** newest first, as toMonthlySummary returns */
  summaries: MonthlySummary[];
  /** flagged window rows (12 months), completed+pending */
  rows: FlaggedTxn[];
  recurring: RecurringItem[];
  /**
   * The verdict surface — "מה יורד לי כל חודש?", with the household's own מנוי/קבוע/הרגל rulings
   * already applied. Every COMMITMENT claim here reads this and only this.
   *
   * Money is "spoken for" when the household vouched for it, signed for it through an installment
   * plan, or typed it in — never merely because a detector noticed a rhythm.
   */
  patterns: SpendingPatternsView;
  bankStats: BalanceStats | null; // null when no balance snapshot exists
  latestBankBalance: number | null;
  /** Manual assets the user marked liquid (deposits, funds) — they ARE an emergency buffer. */
  liquidAssetsTotal: number;
}

/** Bank descriptions of loan repayments — installment debt the cards never see. */
export function isLoanLike(description: string): boolean {
  return description.includes('הלוואה') || description.includes('הלואה');
}

function na(id: string, nameHe: string, axis: Axis, why: string): MetricResult {
  return { id, nameHe, axis, band: 'na', display: '—', detailHe: why, visual: null };
}

const NEED_3 = 'נדרשים לפחות 3 חודשי נתונים.';
const NEED_6 = 'נדרשים לפחות 6 חודשי נתונים.';

export function computeMetrics(input: MetricsInput): HealthReport {
  const { summaries, rows, bankStats, latestBankBalance, liquidAssetsTotal, patterns } = input;
  // The household's own rulings, and the proposals still waiting for one. A pending proposal is
  // never summed — but it IS named, so a metric that reads low reads low for a reason the user
  // can act on ("עוד 4 מחכים להחלטה שלך") instead of looking like the app lost money.
  const counted = patterns.patterns.filter((p) => p.countsAsCommitted);
  const pendingCommitments = patterns.patterns.filter(
    (p) => p.active && !p.dismissed && !p.userMarked && !p.installmentPlan && p.isCommitment,
  );
  // emerging (2-occurrence) patterns are hints for the forecast, not evidence for verdicts
  // health metrics describe the PRESENT — a discontinued stream (dead subscription, finished
  // installment plan, lost income) is history and must not count as a current commitment
  const recurring = input.recurring.filter((r) => !r.provisional && r.active);
  const oldestFirst = [...summaries].reverse();
  const complete = oldestFirst.slice(0, Math.max(0, oldestFirst.length - 1)); // drop the running month
  const nMonths = complete.length;
  const avgIncome = mean(complete.map((m) => m.income));
  const results: MetricResult[] = [];

  // ——— expenses per category per month (from flagged rows) ———
  const catMonthly = new Map<string, Map<string, number>>(); // category → month → sum
  for (const r of rows) {
    if (r.status !== 'completed' || r.excluded || r.amount >= 0 || !r.category) continue;
    const byMonth = catMonthly.get(r.category) ?? new Map<string, number>();
    byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + -r.amount);
    catMonthly.set(r.category, byMonth);
  }
  const completeMonths = complete.map((m) => m.month);
  const avgOfCategory = (cats: ReadonlySet<string>) =>
    mean(
      completeMonths.map((m) =>
        [...cats].reduce((s, c) => s + (catMonthly.get(c)?.get(m) ?? 0), 0),
      ),
    );

  // 1 · savings rate (level) — over the caller's whole window: the user picks the basis
  if (nMonths >= 3) {
    const inc = complete.reduce((s, m) => s + m.income, 0);
    const exp = complete.reduce((s, m) => s + m.expenses, 0);
    const rate = inc > 0 ? (inc - exp) / inc : 0;
    results.push({
      id: 'savings-rate', nameHe: 'שיעור חיסכון', axis: 'level',
      band: rate >= 0.15 ? 'green' : rate >= 0.05 ? 'yellow' : 'red',
      display: pct(rate),
      detailHe: `‏${nMonths} חודשים שלמים: הכנסות ${ILS.format(inc)} − הוצאות ${ILS.format(exp)} = ${ILS.format(inc - exp)}. יעד מקובל: ‎15%+‎.`,
      visual: {
        kind: 'bullet', value: rate, min: -0.2, max: 0.3, format: 'percent',
        zones: [
          { from: -0.2, to: 0.05, band: 'red' },
          { from: 0.05, to: 0.15, band: 'yellow' },
          { from: 0.15, to: 0.3, band: 'green' },
        ],
        markers: [{ value: 0, labelHe: 'אפס' }, { value: 0.15, labelHe: 'יעד 15%' }],
      },
    });
  } else results.push(na('savings-rate', 'שיעור חיסכון', 'level', NEED_3));

  // 2 · emergency buffer (resilience) — bank balances plus manual assets the user marked
  // liquid plus savings plans held outside the checking account (inside-goals already sit
  // in the bank balance — adding them here would count the same shekel twice)
  const essentialAvg = avgOfCategory(ESSENTIAL_CATEGORIES);
  const liquidTotal = (latestBankBalance ?? 0) + liquidAssetsTotal;
  let bufferMonths: number | null = null; // volatility reads this: a cushion absorbs swings
  if ((latestBankBalance !== null || liquidAssetsTotal > 0) && essentialAvg > 0 && nMonths >= 3) {
    const monthsOfBuffer = liquidTotal / essentialAvg;
    bufferMonths = monthsOfBuffer;
    results.push({
      id: 'buffer', nameHe: 'כרית חירום', axis: 'resilience',
      band: monthsOfBuffer >= 3 ? 'green' : monthsOfBuffer >= 1 ? 'yellow' : 'red',
      display: `${monthsOfBuffer.toFixed(1)} חודשים`,
      detailHe: `נזיל ${ILS.format(liquidTotal)} (בנק ${ILS.format(latestBankBalance ?? 0)}${liquidAssetsTotal > 0 ? ` + נכסים שסומנו נזילים ${ILS.format(liquidAssetsTotal)}` : ''}) ÷ הוצאות חיוניות ממוצעות ${ILS.format(essentialAvg)}/חודש. מקובל: 3–6 חודשים; נכס ידני נספר רק אם סומן "נזיל" במסך ההון, ובאותו שער מטבע שההון מציג.`,
      visual: {
        kind: 'segments', value: monthsOfBuffer, max: 6,
        markers: [{ value: 1, labelHe: 'מינימום' }, { value: 3, labelHe: 'יעד' }, { value: 6, labelHe: '6+' }],
      },
    });
  } else results.push(na('buffer', 'כרית חירום', 'resilience', latestBankBalance === null ? 'אין יתרת בנק — סנכרן חיבור בנק.' : NEED_3));

  // 3 · income volatility (resilience) — DOWNSIDE only, anchored to the median.
  // A bonus month is not a risk: only months that come in LOW count, and even those
  // only bite when there is no cushion to absorb them (the JPMC framing: volatility
  // matters in proportion to the buffer, not on its own).
  if (nMonths >= 6 && avgIncome > 0) {
    const incomes = complete.map((m) => m.income);
    const sorted = [...incomes].sort((a, b) => a - b);
    const medianIncome = sorted.length % 2
      ? sorted[Math.floor(sorted.length / 2)]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const downside = medianIncome > 0
      ? Math.sqrt(mean(incomes.map((i) => Math.min(0, i - medianIncome) ** 2))) / medianIncome
      : 0;
    const dips = incomes.filter((i) => i < medianIncome * 0.75).length;
    const dipsAllowed = Math.ceil(nMonths / 6); // one soft month per half-year is life, not risk
    let band: Band = dips === 0 && downside < 0.1 ? 'green'
      : dips <= dipsAllowed && downside <= 0.25 ? 'yellow'
        : 'red';
    const cushioned = bufferMonths !== null && bufferMonths >= 2;
    if (band === 'red' && cushioned) band = 'yellow'; // real swings, but the cushion is there for exactly this
    results.push({
      id: 'income-volatility', nameHe: 'יציבות הכנסה', axis: 'resilience',
      band,
      display: `ירידות ‏${pct(downside)}`,
      detailHe: `נמדדות רק ירידות מתחת לחודש רגיל (${ILS.format(medianIncome)}) — חודש בונוס אינו סיכון. ${dips} חודשים רכים (הכנסה < ‎75%‎ מחודש רגיל) מתוך ${nMonths}.${cushioned && bufferMonths !== null ? ` כרית של ${bufferMonths.toFixed(1)} חודשים סופגת את התנודות.` : ''}`,
      visual: {
        kind: 'trend',
        points: complete.map((m) => ({ label: m.month, value: m.income })),
        references: [
          { value: medianIncome, labelHe: 'חודש רגיל', tone: 'neutral' },
          { value: medianIncome * 0.75, labelHe: 'קו נפילה', tone: 'danger', dangerDirection: 'below' },
        ],
        format: 'ils',
      },
    });
  } else results.push(na('income-volatility', 'יציבות הכנסה', 'resilience', NEED_6));

  // 4 · fixed commitments (resilience) — exactly what "מה יורד לי כל חודש?" counts as committed,
  // in per-month equivalents, so a yearly premium weighs a twelfth and a weekly charge ~4.3×.
  // Same set, same shekels, same tab — the two surfaces can no longer disagree.
  const committedMonthly = patterns.summary.committedMonthly;
  const pendingHe = pendingCommitments.length === 0 ? ''
    : pendingCommitments.length === 1
      ? ' עוד חיוב חוזר אחד מחכה להחלטה שלך — הוא לא נספר כאן.'
      : ` עוד ${pendingCommitments.length} חיובים חוזרים מחכים להחלטה שלך — הם לא נספרים כאן.`;
  if (avgIncome > 0 && counted.length > 0) {
    const ratio = committedMonthly / avgIncome;
    results.push({
      id: 'fixed-commitments', nameHe: 'מחויבויות קבועות', axis: 'resilience',
      band: ratio < 0.5 ? 'green' : ratio <= 0.65 ? 'yellow' : 'red',
      display: pct(ratio),
      detailHe: `${counted.length} חיובים שאישרת ב"מה יורד לי כל חודש?" = ${ILS.format(committedMonthly)}/חודש (שבועי/דו-חודשי/שנתי מתורגמים לחודש) ÷ הכנסה ממוצעת ${ILS.format(avgIncome)}. מעל ‎65%‎ = מרחב תמרון קטן בזעזוע.${pendingHe}`,
      visual: {
        kind: 'composition', used: committedMonthly, total: avgIncome, ratio,
        usedLabelHe: 'קבוע', remainderLabelHe: 'מרחב תמרון',
        markers: [{ value: 0.5, labelHe: '50%' }, { value: 0.65, labelHe: '65%' }],
      },
    });
  } else {
    results.push(na('fixed-commitments', 'מחויבויות קבועות', 'resilience',
      pendingCommitments.length === 0 ? 'טרם זוהו חיובים קבועים.'
        : pendingCommitments.length === 1
          ? 'חיוב חוזר אחד מחכה להחלטה שלך ב"מה יורד לי כל חודש?". עד שתחליט — אין מה לספור כאן.'
          : `${pendingCommitments.length} חיובים חוזרים מחכים להחלטה שלך ב"מה יורד לי כל חודש?". עד שתחליט — אין מה לספור כאן.`));
  }

  // 5 · housing ratio (level)
  const housingAvg = avgOfCategory(new Set(['housing']));
  if (avgIncome > 0 && nMonths >= 3 && housingAvg === 0) {
    results.push(na('housing', 'עלות דיור', 'level', 'לא נמצאו הוצאות דיור מסווגות — סווג שכר דירה/משכנתה כדי למדוד.'));
  } else if (avgIncome > 0 && nMonths >= 3) {
    const ratio = housingAvg / avgIncome;
    results.push({
      id: 'housing', nameHe: 'עלות דיור', axis: 'level',
      band: ratio < 0.3 ? 'green' : ratio <= 0.4 ? 'yellow' : 'red',
      display: pct(ratio),
      detailHe: `דיור ${ILS.format(housingAvg)}/חודש ÷ הכנסה נטו ${ILS.format(avgIncome)}. הספים כאן על בסיס נטו (המקבילה לכלל ה-28% על ברוטו).`,
      visual: {
        kind: 'composition', used: housingAvg, total: avgIncome, ratio,
        usedLabelHe: 'דיור', remainderLabelHe: 'שאר ההכנסה',
        markers: [{ value: 0.3, labelHe: '30%' }, { value: 0.4, labelHe: '40%' }],
      },
    });
  } else results.push(na('housing', 'עלות דיור', 'level', NEED_3));

  // 6 · debt service (level): what is owed NOW — the OPEN installment plans' slices plus the live
  // bank loan repayments. A window average answered the same question with history: two plans that
  // delivered their final slice in 2025 (3,104 ₪ and 1,147 ₪) kept the figure at 1,359 ₪ while the
  // תשלומים card two tabs away printed 833 ₪ for the same debt on the same day. A debt you finished
  // paying is not debt you service.
  const instMonthly = patterns.patterns
    .filter((p) => p.installmentPlan && p.active && p.installmentsTotal !== null && p.installmentsPaid !== null
      && p.installmentsTotal > 0 && p.installmentsPaid < p.installmentsTotal)
    .reduce((s, p) => s + p.monthlyAmount, 0);
  // A loan repayment carries no "k מתוך N", so the engine's own liveness flag is the only evidence
  // it is still running — `recurring` here is already the active, non-provisional set.
  const loanMonthly = recurring
    .filter((r) => r.kind === 'expense' && !r.excludedFlow && companyKind(r.company) === 'bank'
      && (isLoanLike(r.sampleDescription) || isLoanLike(r.merchant)))
    .reduce((s, r) => s + -r.monthlyAmount, 0);
  const debtMonthly = instMonthly + loanMonthly;
  // context, never the headline: what the window actually charged, so the present-tense figure can
  // be reconciled against the months behind it instead of contradicting them
  const debtPaidAvg = mean(
    completeMonths.map((m) =>
      rows.filter((r) => r.month === m && r.status === 'completed' && !r.excluded && r.amount < 0 &&
        (r.type === 'installments' || (companyKind(r.company) === 'bank' && isLoanLike(r.description))))
        .reduce((s, r) => s + -r.amount, 0),
    ),
  );
  if (avgIncome > 0 && nMonths >= 3) {
    const ratio = debtMonthly / avgIncome;
    results.push({
      id: 'debt-service', nameHe: 'שירות חוב', axis: 'level',
      band: ratio < 0.1 ? 'green' : ratio <= 0.2 ? 'yellow' : 'red',
      display: pct(ratio),
      detailHe: `תשלומים פתוחים ${ILS.format(instMonthly)} + החזרי הלוואה פעילים ${ILS.format(loanMonthly)} = ${ILS.format(debtMonthly)}/חודש ÷ הכנסה ${ILS.format(avgIncome)}. נספר מה שעוד רץ, לא מה שכבר סיימת לשלם — ב-${nMonths} החודשים האחרונים ירדו בפועל ${ILS.format(debtPaidAvg)} בממוצע. החזר שאין בתיאורו "הלוואה" לא יזוהה — המדד עדיין שמרני.`,
      visual: {
        kind: 'bullet', value: ratio, min: 0, max: 0.3, format: 'percent',
        zones: [
          { from: 0, to: 0.1, band: 'green' },
          { from: 0.1, to: 0.2, band: 'yellow' },
          { from: 0.2, to: 0.3, band: 'red' },
        ],
        markers: [{ value: 0.1, labelHe: '10%' }, { value: 0.2, labelHe: '20%' }],
      },
    });
  } else results.push(na('debt-service', 'שירות חוב (תשלומים)', 'level', NEED_3));

  // 7 · overdraft (resilience)
  if (bankStats && bankStats.minByMonth.length >= 1) {
    const latest = bankStats.daysBelowZeroByMonth[bankStats.daysBelowZeroByMonth.length - 1];
    // "כרוני" is a condition you are IN, not one you were once in. On the שנתיים basis a stretch
    // that ENDED in 2025 still held the majority of the window, so a man seven months clean, his
    // trough climbing, zero minus days last month, was handed a red verdict with "0 ימי מינוס"
    // printed right next to it. The chart keeps every month; the verdict reads the recent ones.
    const recent = bankStats.daysBelowZeroByMonth.slice(-6);
    const recentInMinus = recent.filter((d) => d.days > 0).length;
    const chronic = recentInMinus >= Math.ceil(recent.length / 2);
    const slope = bankStats.troughSlope;
    const declining = slope !== null && slope < -200;
    results.push({
      id: 'overdraft', nameHe: 'מינוס ומגמת שפל', axis: 'resilience',
      band: latest.days === 0 && !declining && !chronic ? 'green' : chronic || (latest.days > 7 && declining) ? 'red' : latest.days > 0 || declining ? 'yellow' : 'green',
      display: `${latest.days} ימי מינוס`,
      // The sentence must describe the household's actual trend, not a generic dangerous trend.
      detailHe: `ימי יתרה שלילית בחודש האחרון: ${latest.days}. ב-${recent.length} החודשים האחרונים ${recentInMinus === 0 ? 'לא היה מינוס בכלל' : `${recentInMinus} נגמרו במינוס`}. מגמת נקודת השפל החודשית: ${
        slope === null ? 'אין מספיק היסטוריה — צריך עוד חודשים כדי לראות כיוון.'
          : slope >= 0 ? `עולה ${ILS.format(slope)} בחודש. השפל שלך מטפס, וזה הכיוון הנכון.`
            : `יורדת ${ILS.format(-slope)} בחודש — שפל יורד בהכנסה יציבה הוא סימן ההידרדרות הנקי ביותר.`
      }`,
      visual: {
        kind: 'overdraft',
        points: bankStats.minByMonth.map((p) => ({
          label: p.month,
          minBalance: p.min,
          daysBelowZero: bankStats.daysBelowZeroByMonth.find((d) => d.month === p.month)?.days ?? 0,
        })),
        slope,
        declineThreshold: -200,
      },
    });
  } else results.push(na('overdraft', 'מינוס ומגמת שפל', 'resilience', 'אין יתרת בנק לשחזור היסטוריה.'));

  // 8 · surplus streak (level)
  if (nMonths >= 3) {
    const surplus = complete.filter((m) => m.net > 0).length;
    const ratio = surplus / nMonths;
    results.push({
      id: 'surplus-streak', nameHe: 'חודשי עודף', axis: 'level',
      band: ratio >= 0.83 ? 'green' : ratio >= 0.58 ? 'yellow' : 'red',
      display: `${surplus}/${nMonths}`,
      detailHe: `חודשים שהסתיימו בעודף מתוך ${nMonths} חודשים שלמים. חודש-חסר בודד סביב הוצאה שנתית — נורמלי; ההתמדה היא שמנבאת חוסן.`,
      visual: {
        kind: 'month-outcomes',
        points: complete.map((m) => ({ label: m.month, value: m.net })),
      },
    });
  } else results.push(na('surplus-streak', 'חודשי עודף', 'level', NEED_3));

  // 9 · discretionary trend (level) — as a SHARE OF INCOME, recent 3 months vs the months
  // BEFORE them. Spending more in a month that earned more is not creep — the שקל series
  // punished exactly that; the income share doesn't. And the baseline must not contain the
  // months it judges.
  if (nMonths >= 6) {
    const series = completeMonths.map((m) =>
      [...DISCRETIONARY_CATEGORIES].reduce((s, c) => s + (catMonthly.get(c)?.get(m) ?? 0), 0),
    );
    const shares = complete.map((m, i) => (m.income > 0 ? series[i] / m.income : null));
    const recentShares = shares.slice(-3).filter((s): s is number => s !== null);
    const baseShares = shares.slice(0, -3).filter((s): s is number => s !== null);
    if (recentShares.length >= 2 && baseShares.length >= 2 && mean(baseShares) > 0) {
      const recentShare = mean(recentShares);
      const baseShare = mean(baseShares);
      const ratio = recentShare / baseShare;
      const baseAbs = mean(series.slice(0, -3));
      results.push({
        id: 'discretionary-trend', nameHe: 'מגמת הוצאה משתנה', axis: 'level',
        band: ratio <= 1.1 ? 'green' : ratio <= 1.25 ? 'yellow' : 'red',
        display: `×${ratio.toFixed(2)}`,
        detailHe: `הנתח מההכנסה שהולך למסעדות/קניות/פנאי: ‎${pct(recentShare)} ב-3 החודשים האחרונים מול ‎${pct(baseShare)} בחודשים שלפניהם. נמדד כנתח מההכנסה — חודש שהרוויח יותר רשאי גם להוציא יותר.`,
        visual: {
          kind: 'trend',
          points: completeMonths.map((month, i) => ({ label: month, value: series[i] })),
          references: [
            { value: baseAbs, labelHe: 'ממוצע התקופה הקודמת', tone: 'neutral' },
            { value: baseAbs * 1.25, labelHe: 'סף חריגה +25%', tone: 'danger', dangerDirection: 'above' },
          ],
          format: 'ils',
        },
      });
    } else results.push(na('discretionary-trend', 'מגמת הוצאה משתנה', 'level', 'אין מספיק חודשים עם הכנסה להשוואה הוגנת.'));
  } else results.push(na('discretionary-trend', 'מגמת הוצאה משתנה', 'level', NEED_6));

  // 10 · subscription load (resilience) — the מנויים the household MARKED as such.
  // This used to run on a category proxy ("stable amount, category present, not essential"), which
  // answers a different question and answered it wrong: it printed 0 מנויים · 0 ₪ over a man paying
  // for ChatGPT every month, because a dollar charge is never ±15% stable and the one tab that
  // knows it is a מנוי was never asked. An installment plan is debt, not a subscription — it lands
  // in nature 'fixed' by construction, so it cannot leak in here.
  const subs = counted.filter((p) => p.nature === 'subscription');
  const subsMonthly = patterns.summary.subscriptionMonthly;
  const pendingSubs = pendingCommitments.filter((p) => p.nature === 'subscription');
  const pendingSubsHe = pendingSubs.length === 0 ? ''
    : pendingSubs.length === 1
      ? ' עוד חיוב אחד נראה כמו מנוי ומחכה להחלטה שלך.'
      : ` עוד ${pendingSubs.length} חיובים נראים כמו מנוי ומחכים להחלטה שלך.`;
  if (avgIncome > 0 && subs.length > 0) {
    const ratio = subsMonthly / avgIncome;
    results.push({
      id: 'subscriptions', nameHe: 'עומס מנויים', axis: 'resilience',
      band: ratio < 0.05 ? 'green' : ratio <= 0.1 ? 'yellow' : 'red',
      display: `${subs.length} ${subs.length === 1 ? 'מנוי' : 'מנויים'} · ${ILS.format(subsMonthly)}`,
      detailHe: `המנויים שסימנת ב"מה יורד לי כל חודש?" (מתורגמים לחודש): ${subs.map((p) => p.name).join(', ')}. ${pct(ratio)} מההכנסה. הספים כאן מוסכמה, לא מדע.${pendingSubsHe}`,
      visual: {
        kind: 'subscriptions',
        items: [...subs]
          .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
          .slice(0, 5)
          .map((p) => ({ label: p.name, value: p.monthlyAmount })),
        total: subsMonthly,
        share: ratio,
        markers: [{ value: 0.05, labelHe: '5%' }, { value: 0.1, labelHe: '10%' }],
      },
    });
  } else {
    results.push(na('subscriptions', 'עומס מנויים', 'resilience',
      pendingSubs.length === 0 ? 'טרם סימנת מנויים.'
        : pendingSubs.length === 1
          ? 'חיוב אחד נראה כמו מנוי ומחכה להחלטה שלך ב"מה יורד לי כל חודש?".'
          : `${pendingSubs.length} חיובים נראים כמו מנוי ומחכים להחלטה שלך ב"מה יורד לי כל חודש?".`));
  }

  // 11 · fees drag (level)
  const feesAvg = avgOfCategory(new Set(['fees']));
  const totalExpAvg = mean(complete.map((m) => m.expenses));
  if (nMonths >= 3 && totalExpAvg > 0) {
    const ratio = feesAvg / totalExpAvg;
    // de-minimis floor: 30 ₪ of bank fees a month is not a "לתשומת לב" — it is life
    results.push({
      id: 'fees', nameHe: 'עמלות וריביות', axis: 'level',
      band: feesAvg < 30 || ratio < 0.001 ? 'green' : ratio < 0.005 ? 'yellow' : 'red',
      display: ILS.format(feesAvg) + '/חודש',
      detailHe: `קטגוריית עמלות ${ILS.format(feesAvg)} מתוך הוצאות ${ILS.format(totalExpAvg)} בממוצע חודשי${feesAvg < 30 ? ' — מתחת ל-30 ₪, זניח' : ''}. חיוב ריבית חוזר או חיוב חוזר (הו"ק שסורבה) הם סמני מצוקה מובהקים.`,
      visual: {
        kind: 'bullet', value: ratio, min: 0, max: 0.01, format: 'percent',
        zones: [
          { from: 0, to: 0.001, band: 'green' },
          { from: 0.001, to: 0.005, band: 'yellow' },
          { from: 0.005, to: 0.01, band: 'red' },
        ],
        markers: [{ value: 0.001, labelHe: '0.1%' }, { value: 0.005, labelHe: '0.5%' }],
      },
    });
  } else results.push(na('fees', 'עמלות וריביות', 'level', NEED_3));

  // 12 · end-of-month squeeze (resilience) — needs a detected salary day and enough daily activity
  // The metric needs ONE fact about the salary: the day it lands. It used to demand a stable AMOUNT
  // too, and went dark on a man whose pay had arrived on the 9th sixteen months running — because
  // the sum moves (overtime, a bonus, a thin month) it never sat inside ±15%. The rhythm is what is
  // metronomic here, not the shekels. Biggest monthly income stream with enough history to trust
  // its day-of-month; `recurring` is already the active, non-provisional set.
  const salary = recurring
    .filter((r) => r.kind === 'income' && !r.excludedFlow && r.cadence === 'monthly'
      && r.amount >= 3000 && r.occurrences >= 6)
    .sort((a, b) => b.amount - a.amount)[0];
  // EVERY purchase, on the day it was made — not just the bank side. The question is behavioural
  // ("do you hold back in the days before payday"), and in an Israeli household most of the answer
  // is on the cards: filtering to bank rows left 12 months of real spending with too few rows to
  // measure and printed "אין מספיק פעילות" over an account with hundreds of purchases. `!excluded`
  // already drops the card settlements, so nothing is counted twice.
  const spendRows = rows.filter((r) => r.status === 'completed' && !r.excluded && r.amount < 0);
  if (salary && nMonths >= 3 && spendRows.length >= nMonths * 15) {
    const day = salary.dayOfMonth;
    // exactly the 7 days [day-7 .. day-1] before the salary — the divisor below is 7
    const inWindow = (d: number) => {
      const start = ((day - 7) + 31) % 31 || 31;
      return start <= day - 1 ? d >= start && d <= day - 1 : d >= start || d <= ((day - 1 + 31) % 31 || 31);
    };
    const dayOf = (iso: string) => Number(new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(8, 10));
    const windowSpend = spendRows.filter((r) => inWindow(dayOf(r.date))).reduce((s, r) => s + -r.amount, 0) / (nMonths * 7);
    const overallDaily = spendRows.reduce((s, r) => s + -r.amount, 0) / (nMonths * 30);
    const ratio = overallDaily > 0 ? windowSpend / overallDaily : 1;
    results.push({
      id: 'squeeze', nameHe: 'מחנק סוף חודש', axis: 'resilience',
      band: ratio >= 0.8 ? 'green' : ratio >= 0.5 ? 'yellow' : 'red',
      display: `×${ratio.toFixed(2)}`,
      detailHe: `קצב הוצאה יומי ב-7 הימים שלפני המשכורת (יום ${day}) ÷ הקצב היומי הכללי. נספרות כל הקניות ביום שבו נעשו — גם בכרטיס. דחיסה חדה (מתחת 0.5) = חיים ממשכורת למשכורת.`,
      visual: {
        kind: 'comparison',
        primary: windowSpend,
        reference: overallDaily,
        ratio,
        primaryLabelHe: `7 ימים לפני משכורת (יום ${day})`,
        referenceLabelHe: 'יום ממוצע',
        markers: [{ value: 0.5, labelHe: '0.5×' }, { value: 0.8, labelHe: '0.8×' }],
      },
    });
  } else results.push(na('squeeze', 'מחנק סוף חודש', 'resilience', salary ? 'אין מספיק פעילות יומית למדידה אמינה.' : 'טרם זוהתה משכורת קבועה.'));

  const level = results.filter((r) => r.axis === 'level');
  const resilience = results.filter((r) => r.axis === 'resilience');
  // a verdict needs evidence: with fewer than 6 measurable metrics, two green dots must not
  // read as "healthy" — credibility beats encouragement
  const measurable = results.filter((r) => r.band !== 'na');
  if (measurable.length < 6) {
    return { overall: { statusHe: 'אין מספיק נתונים', band: 'na', reasonHe: 'פחות מ-6 מדדים מדידים — אין על מה לפסוק.' }, level, resilience };
  }

  // The verdict is carried by the FUNDAMENTALS — the metrics that measure whether money
  // actually holds: saving, cushion, overdraft, surplus, debt load, fixed load. Behavioral
  // context (volatility shape, spending trend, fees, subscriptions, housing share, squeeze)
  // can pull a verdict down one notch, never sink it alone: an account with green
  // fundamentals is NOT "פגיע" because a bonus arrived or a hobby got pricier.
  const CORE = new Set(['savings-rate', 'buffer', 'overdraft', 'surplus-streak', 'debt-service', 'fixed-commitments']);
  const core = measurable.filter((r) => CORE.has(r.id));
  const context = measurable.filter((r) => !CORE.has(r.id));
  const coreReds = core.filter((r) => r.band === 'red');
  const coreYellows = core.filter((r) => r.band === 'yellow');
  const ctxReds = context.filter((r) => r.band === 'red');

  let overallBand: Band;
  if (coreReds.length >= 2 || (coreReds.length === 1 && coreYellows.length >= 2)) overallBand = 'red';
  else if (coreReds.length === 1 || coreYellows.length >= 2 || ctxReds.length >= 1) overallBand = 'yellow';
  else overallBand = 'green';

  const names = (list: MetricResult[]) => list.map((r) => r.nameHe).join(', ');
  const parts = [
    coreReds.length > 0 ? `ליבה אדומה: ${names(coreReds)}` : null,
    coreYellows.length > 0 ? `ליבה לתשומת לב: ${names(coreYellows)}` : null,
    ctxReds.length > 0 ? `הקשר: ${names(ctxReds)}` : null,
  ].filter((p): p is string => p !== null);
  const reasonHe = parts.length > 0
    ? `הציון נקבע לפי מדדי הליבה (חיסכון, כרית, מינוס, עודף, חוב, קבועות). ${parts.join(' · ')}.`
    : 'כל מדדי הליבה ירוקים.';

  const statusHe = overallBand === 'green' ? 'בריא' : overallBand === 'yellow' ? 'מסתדר' : 'פגיע';
  return { overall: { statusHe, band: overallBand, reasonHe }, level, resilience };
}
