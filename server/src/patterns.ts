import { merchantKey, merchantLabel, normalizePattern } from './categories.js';
import { type FlaggedTxn } from './companies.js';
import type { ManualRecurringRow } from './db.js';
import { addDays, addMonthsClamped, CADENCE_MONTHS, CADENCE_NAME_HE, type Cadence, detectRecurring, type RecurringItem } from './recurring.js';
import {
  cadenceFromGaps, deriveMerchantMarks, isClassifiableExpense, manualToRecurringItem, regularityScore, type TxnMarkValue,
} from './subscriptions.js';

/** "מה יורד לי כל חודש?" — every repeating rhythm the engine can find in your spending, each carried with the
 *  statistics that justify it and a SUGGESTED nature. Three natures, one axis of meaning:
 *   - subscription (מנוי)  — a stable periodic SERVICE (Netflix, ChatGPT, gym)
 *   - fixed        (קבוע)  — a stable/periodic OBLIGATION (rent, insurance, a utility bill)
 *   - habit        (הרגל)  — a discretionary BEHAVIOUR that recurs (weekly fuel, the supermarket run)
 *  Commitments (subscription/fixed) are money already spoken for; habits are behavioural insight and
 *  never count as "committed". The engine proposes; the user confirms/corrects with one click. */
export type PatternNature = 'subscription' | 'fixed' | 'habit';

export interface SpendingPattern {
  merchant: string;
  name: string;
  category: string | null;
  // — rhythm —
  cadence: Cadence;
  cadenceHe: string;
  intervalDays: number;      // median gap between charges
  regularity: number;        // 0..1 — how metronomic the gaps are
  occurrences: number;       // support
  firstDate: string;
  lastDate: string;
  nextDate: string;          // projected next
  active: boolean;           // still live (recent enough)
  installmentPlan: boolean;  // finite financed purchase (has an end)
  endDate: string | null;
  // — money (positive magnitudes) —
  typicalAmount: number;     // median charge
  minAmount: number;
  maxAmount: number;
  amountStable: boolean;     // charges within ±15% of the median
  monthlyAmount: number;     // monthly-equivalent
  totalToDate: number;       // sum of all charges so far
  recent: number[];          // up to the last 12 charge magnitudes, oldest→newest — the row sparkline
  // — timing detail —
  dayOfMonth: number | null; // median day-of-month (monthly+ cadences)
  dayOfWeek: number | null;  // median day-of-week 0=Sun..6=Sat (weekly/biweekly — the habit tell)
  // — classification —
  suggestedNature: PatternNature; // the engine's guess
  nature: PatternNature;          // effective (a user override wins over the guess)
  confidence: number;             // 0..1 — support × regularity × recency
  userMarked: boolean;            // the user set an explicit verdict (מנוי/קבוע/הרגל)
  dismissed: boolean;             // the user removed it from the picture
  isCommitment: boolean;          // nature ∈ {subscription, fixed}
  countsAsCommitted: boolean;     // flows into "מחויב מראש": user-confirmed OR contractual (תשלומים) — never a bare detection
  countsAsHabit: boolean;         // flows into "הרגלים": user-confirmed only — the same curated law, no exception
  // — provenance + installment detail (the treemap's single source of truth) —
  source: 'detected' | 'manual';  // detected from transactions, or hand-typed by the user
  installmentsPaid: number | null;   // k of "k מתוך N" (installment plans only)
  installmentsTotal: number | null;  // N (installment plans only)
}

export interface SpendingPatternsView {
  patterns: SpendingPattern[];    // newest-money-first (monthlyAmount desc)
  summary: {
    total: number;
    subscriptionMonthly: number;  // counted subscriptions
    fixedMonthly: number;         // counted fixed obligations
    committedMonthly: number;     // subscription + fixed that count
    habitMonthly: number;         // habits you CONFIRMED — insight, never committed; a bare guess is not counted
    rhythmMonthly: number;        // everything on a rhythm (committed + habits + uncounted)
    totalMonthlySpend: number;    // all classifiable spend / months observed
    pctOnRhythm: number;          // rhythmMonthly / totalMonthlySpend, 0..100
  };
}

/** Categories that are obligations by nature — a charge here on a periodic rhythm is a "fixed" bill,
 *  even when the amount wobbles (electric, water). */
const FIXED_CATEGORIES = new Set(['housing', 'bills', 'insurance', 'education']);
/** Categories that are discretionary — a rhythm here is a behavioural habit, not a contract. */
const HABIT_CATEGORIES = new Set(['groceries', 'restaurants', 'transport', 'shopping', 'leisure']);
/** Brand/word tells that a stable periodic charge is a service subscription rather than a bill. */
const SUBSCRIPTION_HINTS = [
  'NETFLIX', 'SPOTIFY', 'YOUTUBE', 'DISNEY', 'HBO', 'APPLE', 'ICLOUD', 'GOOGLE', 'CHATGPT', 'OPENAI',
  'MICROSOFT', 'ADOBE', 'DROPBOX', 'AMAZON', 'PRIME', 'LINKEDIN', 'NOTION', 'STORE', 'חדר כושר', 'כושר', 'מנוי',
];
/** Merchant tells that a charge is discretionary BEHAVIOUR — catches habit merchants even when the
 *  category is missing or wrong (a supermarket filed as 'other', fuel with no category). */
const HABIT_HINTS = [
  'סופר', 'שופרסל', 'רמי לוי', 'מגה', 'ויקטורי', 'יינות', 'טיב טעם', 'אושר עד', 'יוחננוף', 'מרקט',
  'דלק', 'פז', 'סונול', 'דור אלון', 'ten', 'פנגו', 'חניון', 'חנייה', 'רכבת', 'מקדונ', 'בורגר',
  'קפה', 'מסעד', 'וולט', 'WOLT', 'משלוח', 'קניון',
];

function localDate(iso: string): string { return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function daysBetween(a: string, b: string): number { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000); }
/** Calendar months from a to b, inclusive — the honest denominator for "how much per month". */
function monthSpan(a: string, b: string): number {
  const idx = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7));
  return Math.max(1, idx(b) - idx(a) + 1);
}
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The engine's guess at what a detected rhythm MEANS. Frequent = behaviour; stable+periodic in a bill
 *  category = obligation; stable+periodic elsewhere (or a known brand) = subscription; variable in a
 *  discretionary category = habit. Deliberately simple and legible — the user corrects in one click. */
export function suggestNature(
  item: Pick<RecurringItem, 'cadence' | 'category' | 'amountStable' | 'sampleDescription'> & { installmentPlan?: boolean },
  typicalMag: number,
  displayName = '',
): PatternNature {
  // 0. a financed purchase (תשלומים) is a fixed commitment — you're contractually paying it off.
  if (item.installmentPlan) return 'fixed';
  // 1. a frequent cadence is behaviour — you don't subscribe weekly, you fuel up weekly.
  if (item.cadence === 'weekly' || item.cadence === 'biweekly') return 'habit';
  const cat = item.category ?? '';
  // match name tells against BOTH the cleaned display name and the raw descriptor — a supermarket's
  // raw bank string ("SHUFERSAL 4471") may not carry the word the friendly label does.
  const hay = `${displayName} ${item.sampleDescription ?? ''}`.toUpperCase();
  const looksSub = SUBSCRIPTION_HINTS.some((k) => hay.includes(k.toUpperCase()));
  const looksHabit = HABIT_HINTS.some((k) => hay.includes(k.toUpperCase()));
  // 2. a recognised discretionary merchant is a habit — and it WINS over a subscription-brand match,
  //    because that match is usually just the payment rail ("GOOGLE PAY", "APPLE PAY") on a real
  //    supermarket/fuel charge, not a service you subscribe to.
  if (looksHabit) return 'habit';
  // 3. obligation categories are fixed — even a wobbly bill (electric, water) is still a commitment.
  if (FIXED_CATEGORIES.has(cat)) return 'fixed';
  // 4. discretionary categories are habits — category beats amount, so a steady ₪1,600 of supermarket
  //    or ₪1,000 of fuel stays a HABIT. Only a recognised stable service inside escapes to subscription.
  if (HABIT_CATEGORIES.has(cat)) return looksSub && item.amountStable ? 'subscription' : 'habit';
  // 5. ambiguous (health / fees / transfers / other / null): a known service is a subscription; an
  //    unstable charge is behavioural; an otherwise-steady periodic charge is a fixed commitment.
  if (looksSub) return 'subscription';
  return item.amountStable ? 'fixed' : 'habit';
}

function confidenceOf(occurrences: number, regularity: number, active: boolean): number {
  const support = Math.min(1, (occurrences - 1) / 4); // 2→.25, 3→.5, 5+→1
  const recency = active ? 1 : 0.4;
  return round2(0.45 * support + 0.4 * regularity + 0.15 * recency);
}

/** How long a silent pattern stays "live" in the VIEW, by what it IS (the שחר רוזן lesson):
 *  a COMMITMENT is metronomic — one fully missed cycle plus half a cycle of grace means it
 *  ended (a cancelled standing order must not keep showing as money you owe); BEHAVIOUR is
 *  bursty — a habit survives ~2 missed periods + two weeks of human slack (45-day floor),
 *  so a vacation never kills the pizza rhythm. */
function staleAllowanceDays(isCommitment: boolean, intervalDays: number): number {
  return isCommitment
    ? intervalDays + Math.max(14, Math.round(intervalDays / 2))
    : Math.max(45, intervalDays * 2 + 14);
}

/** A projected next date must never sit in the past: roll it forward cycle by cycle until it
 *  reaches today. Monthly+ cadences keep their day-of-month; frequent ones step by interval. */
function rollNextForward(
  nextDate: string, today: string, cadence: Cadence, intervalDays: number, dayOfMonth: number | null,
): string {
  const months = CADENCE_MONTHS[cadence];
  let d = nextDate;
  for (let guard = 0; d < today && guard < 80; guard++) {
    d = months > 0
      ? addMonthsClamped(d, months, dayOfMonth ?? Number(d.slice(8, 10)))
      : addDays(d, Math.max(1, intervalDays));
  }
  return d;
}

/** Build the full pattern view from ALL stored rows. Reuses the (tested) detectRecurring engine for the
 *  rhythm detection, then layers stats + confidence + the nature suggestion + the user's overrides. */
export function spendingPatterns(input: {
  rows: FlaggedTxn[];
  txnMarks: { key: string; mark: TxnMarkValue }[];
  today: string;
  /** Hand-typed recurring charges (cash, an unconnected card) — ride in as confirmed patterns. */
  manual?: ManualRecurringRow[];
}): SpendingPatternsView {
  const { rows, txnMarks, today, manual = [] } = input;
  const items = detectRecurring(rows, { today }).filter(
    (i) => i.kind === 'expense' && i.excludeReason !== 'settlement' && i.excludeReason !== 'partial' && i.excludeReason !== 'future',
  );

  // per-merchant charges (paired date+amount, for regularity/day-of-week/spread/sparkline) + newest row
  interface Group { entries: { date: string; mag: number }[]; newest: FlaggedTxn | null }
  const byMerchant = new Map<string, Group>();
  const monthsSeen = new Set<string>();
  let totalSpend = 0;
  for (const r of rows) {
    if (!isClassifiableExpense(r)) continue;
    const d = localDate(r.date);
    monthsSeen.add(d.slice(0, 7));
    totalSpend += Math.abs(r.amount);
    const k = merchantKey(r.description, r.memo);
    const g = byMerchant.get(k) ?? { entries: [], newest: null };
    g.entries.push({ date: d, mag: Math.abs(r.amount) });
    if (!g.newest || r.date > g.newest.date) g.newest = r;
    byMerchant.set(k, g);
  }
  const marks = deriveMerchantMarks(txnMarks, rows);

  const patterns: SpendingPattern[] = items.map((item) => {
    const g = byMerchant.get(item.merchant) ?? { entries: [{ date: item.lastDate, mag: Math.abs(item.amount) }], newest: null };
    const sorted = [...g.entries].sort((a, b) => a.date.localeCompare(b.date)); // oldest → newest
    const dates = sorted.map((e) => e.date);
    const mags = sorted.map((e) => e.mag);
    const recent = mags.slice(-12); // sparkline: up to the last dozen charges, chronological
    const regularity = round2(regularityScore(dates));
    const typicalMag = round2(median(mags));
    const name = g.newest ? merchantLabel(g.newest.description, g.newest.memo) : merchantLabel(item.sampleDescription, null);
    const suggested = suggestNature(item, typicalMag, name);
    const override = marks.get(item.merchant) ?? null;
    const dismissed = override === 'dismissed';
    const userMarked = override === 'subscription' || override === 'fixed' || override === 'habit';
    const nature: PatternNature = override === 'subscription' || override === 'fixed' || override === 'habit' ? override : suggested;
    const isCommitment = nature === 'subscription' || nature === 'fixed';
    // liveness for the VIEW is nature-aware (see staleAllowanceDays) — the forecast keeps the
    // engine's own strict flag either way.
    const viewActive = item.active
      || daysBetween(item.lastDate, today) <= staleAllowanceDays(isCommitment, item.intervalDays);
    const confidence = confidenceOf(item.occurrences, regularity, viewActive);
    // "מחויב מראש" is a CURATED set: nothing the engine merely detected enters it — only what the
    // user vouched for, plus installment plans (contractually committed the moment they exist; a
    // false positive can still be dismissed). Detections without a verdict stay as quiet proposals.
    const countsAsCommitted = !dismissed && isCommitment && viewActive && (userMarked || item.installmentPlan);
    // Habits obey the same law, with no installment-style exception: nothing is contractually a
    // habit. Until the user says "yes, this is a habit of mine", the ring is a proposal the
    // engine is making — and a proposal is never summed as though it were a verdict.
    const countsAsHabit = !dismissed && nature === 'habit' && viewActive && userMarked;
    const weekly = item.cadence === 'weekly' || item.cadence === 'biweekly';
    return {
      merchant: item.merchant,
      name,
      category: item.category,
      cadence: item.cadence,
      cadenceHe: CADENCE_NAME_HE[item.cadence],
      intervalDays: item.intervalDays,
      regularity,
      occurrences: item.occurrences,
      firstDate: item.firstDate,
      lastDate: item.lastDate,
      // a live pattern never advertises a "next charge" that already passed (the 12-June zombie)
      nextDate: viewActive
        ? rollNextForward(item.nextDate, today, item.cadence, item.intervalDays, item.dayOfMonth)
        : item.nextDate,
      active: viewActive,
      installmentPlan: item.installmentPlan,
      endDate: item.endDate,
      typicalAmount: typicalMag,
      minAmount: round2(Math.min(...mags)),
      maxAmount: round2(Math.max(...mags)),
      amountStable: item.amountStable,
      monthlyAmount: Math.round(Math.abs(item.monthlyAmount)),
      totalToDate: round2(mags.reduce((a, b) => a + b, 0)),
      recent,
      dayOfMonth: CADENCE_MONTHS[item.cadence] > 0 ? item.dayOfMonth : null,
      dayOfWeek: weekly && dates.length ? Math.round(median(dates.map((d) => new Date(`${d}T12:00:00`).getDay()))) : null,
      suggestedNature: suggested,
      nature,
      confidence,
      userMarked,
      dismissed,
      isCommitment,
      countsAsCommitted,
      countsAsHabit,
      source: 'detected' as const,
      installmentsPaid: item.installmentPlan ? item.installmentsPaid ?? null : null,
      installmentsTotal: item.installmentPlan ? item.installmentsTotal ?? null : null,
    };
  });

  // ——— the frequency path: habits the rhythm detector cannot see ———
  // A strong habit (fuel every other week + the Saturday shop at the same station) produces MIXED
  // gaps — no single cadence band ever wins the detector's ⅔ vote, and the monthly fallback demands
  // a steady day-of-month BY DESIGN. Both rules are right for commitments and blind to behaviour.
  // So a merchant with rich, frequent, month-after-month history that the detector rejected still
  // surfaces here — as a habit: insight about the rhythm of your life, never committed money.
  const rhythmMerchants = new Set(items.map((i) => i.merchant));
  for (const [merchant, g] of byMerchant) {
    if (rhythmMerchants.has(merchant)) continue;
    const sorted = [...g.entries].sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length < 6) continue;                              // rich: a real repeating behaviour
    const dates = sorted.map((e) => e.date);
    const monthsWith = new Set(dates.map((d) => d.slice(0, 7)));
    if (monthsWith.size < 3) continue;                            // sustained across months
    const spanMonths = monthSpan(dates[0], dates[dates.length - 1]);
    if (monthsWith.size < Math.ceil(spanMonths * 0.6)) continue;  // month after month, not one burst
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
    const medGap = Math.max(1, Math.round(median(gaps)));
    if (medGap > 45) continue;                                    // frequent: at least ~monthly presence

    const mags = sorted.map((e) => e.mag);
    const typical = round2(median(mags));
    const totalMag = round2(mags.reduce((a, b) => a + b, 0));
    const amountStable = mags.every((m) => Math.abs(m - typical) <= typical * 0.15);
    const regularity = round2(regularityScore(dates));
    const cadence = cadenceFromGaps(dates);
    const weekly = cadence === 'weekly' || cadence === 'biweekly';
    // the day-of-week tell: only when one weekday truly dominates (the Saturday shop, not noise)
    let dayOfWeek: number | null = null;
    if (weekly) {
      const counts = new Map<number, number>();
      for (const d of dates) {
        const dow = new Date(`${d}T12:00:00`).getDay();
        counts.set(dow, (counts.get(dow) ?? 0) + 1);
      }
      const [modeDow, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (modeCount * 2 >= dates.length) dayOfWeek = modeDow;
    }
    const name = g.newest ? merchantLabel(g.newest.description, g.newest.memo) : merchant;
    const suggested = suggestNature(
      { cadence, category: g.newest?.category ?? null, amountStable, sampleDescription: g.newest?.description ?? name },
      typical, name,
    );
    const override = marks.get(merchant) ?? null;
    const dismissed = override === 'dismissed';
    const userMarked = override === 'subscription' || override === 'fixed' || override === 'habit';
    const nature: PatternNature = override === 'subscription' || override === 'fixed' || override === 'habit' ? override : suggested;
    const isCommitment = nature === 'subscription' || nature === 'fixed';
    // nature-aware liveness, same law as the rhythm path
    const active = daysBetween(dates[dates.length - 1], today) <= staleAllowanceDays(isCommitment, medGap);
    const confidence = confidenceOf(sorted.length, regularity, active);
    patterns.push({
      merchant,
      name,
      category: g.newest?.category ?? null,
      cadence,
      cadenceHe: CADENCE_NAME_HE[cadence],
      intervalDays: medGap,
      regularity,
      occurrences: sorted.length,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      nextDate: active
        ? rollNextForward(addDays(dates[dates.length - 1], medGap), today, cadence, medGap, null)
        : addDays(dates[dates.length - 1], medGap),
      active,
      installmentPlan: false,
      endDate: null,
      typicalAmount: typical,
      minAmount: round2(Math.min(...mags)),
      maxAmount: round2(Math.max(...mags)),
      amountStable,
      // bursty by nature, so the honest monthly figure is what it ACTUALLY costs per month
      monthlyAmount: Math.round(totalMag / spanMonths),
      totalToDate: totalMag,
      recent: mags.slice(-12),
      dayOfMonth: null,
      dayOfWeek,
      suggestedNature: suggested,
      nature,
      confidence,
      userMarked,
      dismissed,
      isCommitment,
      // the curated law holds here too: a frequency detection enters "מחויב מראש" only by a user verdict
      countsAsCommitted: !dismissed && isCommitment && active && userMarked,
      countsAsHabit: !dismissed && nature === 'habit' && active && userMarked,
      source: 'detected',
      installmentsPaid: null,
      installmentsTotal: null,
    });
  }

  // hand-typed recurring charges join as confirmed patterns — the user vouched for them by typing
  // them in. A manual row whose name resolves to a merchant the detector already found is skipped
  // (the detected pattern IS that charge; showing both would double-count it).
  const detectedMerchants = new Set(patterns.map((p) => p.merchant));
  for (const row of manual) {
    if (detectedMerchants.has(normalizePattern(row.name))) continue;
    const item = manualToRecurringItem(row, today);
    const mag = Math.abs(item.amount);
    patterns.push({
      merchant: `manual:${row.id}`,
      name: row.name,
      category: row.category,
      cadence: row.cadence,
      cadenceHe: CADENCE_NAME_HE[row.cadence],
      intervalDays: item.intervalDays,
      regularity: 1,
      occurrences: 0,
      firstDate: item.firstDate,
      lastDate: item.lastDate,
      nextDate: item.nextDate,
      active: true,
      installmentPlan: false,
      endDate: null,
      typicalAmount: mag,
      minAmount: mag,
      maxAmount: mag,
      amountStable: true,
      monthlyAmount: Math.round(Math.abs(item.monthlyAmount)),
      totalToDate: 0,
      recent: [],
      dayOfMonth: CADENCE_MONTHS[row.cadence] > 0 ? row.dayOfMonth : null,
      dayOfWeek: null,
      suggestedNature: row.mark,
      nature: row.mark,
      confidence: 1,
      userMarked: true,
      dismissed: false,
      isCommitment: true,
      countsAsCommitted: true,
      // a hand-typed recurring row is always a commitment (מנוי/קבוע) — the form offers no habit
      countsAsHabit: false,
      source: 'manual',
      installmentsPaid: null,
      installmentsTotal: null,
    });
  }

  patterns.sort((a, b) => b.monthlyAmount - a.monthlyAmount);

  const sumWhere = (pred: (p: SpendingPattern) => boolean) =>
    Math.round(patterns.filter(pred).reduce((s, p) => s + p.monthlyAmount, 0));
  const subscriptionMonthly = sumWhere((p) => p.countsAsCommitted && p.nature === 'subscription');
  const fixedMonthly = sumWhere((p) => p.countsAsCommitted && p.nature === 'fixed');
  const habitMonthly = sumWhere((p) => p.countsAsHabit);
  const rhythmMonthly = sumWhere((p) => p.active && !p.dismissed);
  const totalMonthlySpend = Math.round(totalSpend / Math.max(1, monthsSeen.size));

  return {
    patterns,
    summary: {
      total: patterns.length,
      subscriptionMonthly,
      fixedMonthly,
      committedMonthly: subscriptionMonthly + fixedMonthly,
      habitMonthly,
      rhythmMonthly,
      totalMonthlySpend,
      pctOnRhythm: totalMonthlySpend > 0 ? Math.min(100, Math.round((rhythmMonthly / totalMonthlySpend) * 100)) : 0,
    },
  };
}
