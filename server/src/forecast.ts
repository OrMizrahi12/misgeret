import type { DayBalance } from './balance-history.js';
import { settlementCompany } from './companies.js';
import { addDays, addMonthsClamped, CADENCE_MONTHS, type RecurringItem } from './recurring.js';

/* ————————————————————————— configuration ————————————————————————— */

/** How the daily variable-spend rate is chosen from the observed 30-day blocks.
 *  median — robust to one crazy month (default); average — includes the crazy months;
 *  p75 — conservative: plans for a spendier-than-typical month; manual — the user's number. */
export type VariableModel = 'median' | 'average' | 'p75' | 'manual';

/** Everything about the forecast the user may tune. Persisted as one JSON settings row —
 *  the engine itself stays deterministic and fully explainable under any configuration. */
export interface ForecastConfig {
  /** How many 30-day blocks of history feed the variable model (3 | 6 | 9 | 12). */
  lookbackBlocks: number;
  variableModel: VariableModel;
  /** ₪/day when variableModel is 'manual'; ignored otherwise. */
  manualDaily: number | null;
  /** Spread the daily variable spend by learned day-of-week weights instead of uniformly. */
  weekdayPattern: boolean;
  /** Compute and show the pessimistic/optimistic envelope around the expected path. */
  showBand: boolean;
  /** Default horizon (where the slider opens), MIN_HORIZON_DAYS..MAX_HORIZON_DAYS (~50y). */
  horizonDays: number;
}

export const FORECAST_LOOKBACK_OPTIONS = [3, 6, 9, 12] as const;
const VARIABLE_MODELS: readonly VariableModel[] = ['median', 'average', 'p75', 'manual'];
export const MIN_HORIZON_DAYS = 7;
// projection is pure math — no data limits it, so the horizon runs to ~50 years; only the slider caps it
export const MAX_HORIZON_DAYS = 18262;
// the history basis, unlike the horizon, IS limited by real data — this is the hard ceiling (5y of
// 30-day blocks); the honest cap for a given user is how much history they actually hold (computed live)
export const MIN_LOOKBACK_BLOCKS = 1;
export const MAX_LOOKBACK_BLOCKS = 60;
const MAX_MANUAL_DAILY = 100_000;

export const DEFAULT_FORECAST_CONFIG: ForecastConfig = {
  lookbackBlocks: 6,
  variableModel: 'median',
  manualDaily: null,
  weekdayPattern: true,
  showBand: true,
  horizonDays: 60,
};

/** Reads a stored config; anything missing/invalid falls back to its default silently —
 *  a hand-edited settings row must never brick the forecast. */
export function parseForecastConfig(raw: string | null): ForecastConfig {
  const cfg = { ...DEFAULT_FORECAST_CONFIG };
  if (!raw) return cfg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return cfg;
  }
  if (typeof parsed !== 'object' || parsed === null) return cfg;
  const p = parsed as Record<string, unknown>;
  if (typeof p.lookbackBlocks === 'number' && Number.isInteger(p.lookbackBlocks) && p.lookbackBlocks >= MIN_LOOKBACK_BLOCKS && p.lookbackBlocks <= MAX_LOOKBACK_BLOCKS) {
    cfg.lookbackBlocks = p.lookbackBlocks;
  }
  if (typeof p.variableModel === 'string' && (VARIABLE_MODELS as readonly string[]).includes(p.variableModel)) {
    cfg.variableModel = p.variableModel as VariableModel;
  }
  if (p.manualDaily === null || (typeof p.manualDaily === 'number' && Number.isFinite(p.manualDaily) && p.manualDaily >= 0 && p.manualDaily <= MAX_MANUAL_DAILY)) {
    cfg.manualDaily = p.manualDaily as number | null;
  }
  if (typeof p.weekdayPattern === 'boolean') cfg.weekdayPattern = p.weekdayPattern;
  if (typeof p.showBand === 'boolean') cfg.showBand = p.showBand;
  if (typeof p.horizonDays === 'number' && Number.isInteger(p.horizonDays) && p.horizonDays >= MIN_HORIZON_DAYS && p.horizonDays <= MAX_HORIZON_DAYS) {
    cfg.horizonDays = p.horizonDays;
  }
  return cfg;
}

/** Merges a user PATCH into the current config. Unlike parse, a bad field here is the user's
 *  active mistake — rejected loudly, nothing saved. */
export function applyForecastConfigPatch(
  current: ForecastConfig,
  patch: unknown,
): { ok: true; config: ForecastConfig } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'body must be an object' };
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    switch (key) {
      case 'lookbackBlocks':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_LOOKBACK_BLOCKS || value > MAX_LOOKBACK_BLOCKS) {
          return { ok: false, error: `lookbackBlocks must be an integer in ${MIN_LOOKBACK_BLOCKS}..${MAX_LOOKBACK_BLOCKS}` };
        }
        next.lookbackBlocks = value;
        break;
      case 'variableModel':
        if (typeof value !== 'string' || !(VARIABLE_MODELS as readonly string[]).includes(value)) {
          return { ok: false, error: `variableModel must be one of ${VARIABLE_MODELS.join(', ')}` };
        }
        next.variableModel = value as VariableModel;
        break;
      case 'manualDaily':
        if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MANUAL_DAILY)) {
          return { ok: false, error: `manualDaily must be null or a number in 0..${MAX_MANUAL_DAILY}` };
        }
        next.manualDaily = value as number | null;
        break;
      case 'weekdayPattern':
      case 'showBand':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} must be boolean` };
        next[key] = value;
        break;
      case 'horizonDays':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_HORIZON_DAYS || value > MAX_HORIZON_DAYS) {
          return { ok: false, error: `horizonDays must be an integer in ${MIN_HORIZON_DAYS}..${MAX_HORIZON_DAYS}` };
        }
        next.horizonDays = value;
        break;
      default:
        return { ok: false, error: `unknown field: ${key}` };
    }
  }
  if (next.variableModel === 'manual' && next.manualDaily === null) {
    return { ok: false, error: 'manualDaily is required when variableModel is manual' };
  }
  return { ok: true, config: next };
}

/* ————————————————————————— event model ————————————————————————— */

/** Where a projected event comes from — the transparency backbone: every shekel on the
 *  path traces to a recurring stream, a delivered card cycle, or a pending bank row. */
export type EventSource = 'recurring' | 'known' | 'pending';

export interface ForecastEvent {
  date: string; // local YYYY-MM-DD
  merchant: string;
  amount: number;
  source: EventSource;
  /** Pessimistic/optimistic readings of this event (default: amount). Unstable streams span
   *  their recently-seen extremes; a still-filling card cycle spans known-floor..history. */
  low?: number;
  high?: number;
}

/** An upcoming card debit we KNOW, not guess: the scrapers deliver the next billing cycle
 *  in advance, so its exact sum and debit date are already in the data. */
export interface KnownCharge {
  company: string; // card CompanyTypes id
  merchant: string; // display name for the event
  date: string; // local YYYY-MM-DD debit date
  amount: number; // negative
  /** What the forecast actually placed on that date. While the cycle is still filling the
   *  known sum is only a floor, so the projected history total may be used instead — the UI
   *  must never claim "actual, not an estimate" when this differs from `amount`. */
  appliedAmount?: number;
}

export interface Forecast {
  path: DayBalance[]; // projected end-of-day balance, today..horizon
  events: ForecastEvent[];
  trough: DayBalance;
  endOfMonth: DayBalance;
  variableDaily: number; // robust daily variable spend applied
  /** Daily calibration drift applied on top of the calendar (0 = no calibration). */
  driftDaily: number;
  known: KnownCharge[]; // real next-cycle debits used instead of historical medians
  /** The uncertainty envelope (config.showBand): low = every unstable component at its
   *  recently-seen worst, high = at its best. The expected path always lies inside. */
  bands: { low: DayBalance[]; high: DayBalance[] } | null;
  /** The pessimistic path's trough — "even in a spendy month, this is the deepest point". */
  troughLow: DayBalance | null;
  /** Day-of-week factors the path applied (Sun..Sat, mean 1), null = uniform. */
  weekdayFactors: number[] | null;
}

/* ————————————————————————— small math ————————————————————————— */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated percentile over a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Day of week of a local date (0=Sunday..6=Saturday), timezone-proof via noon UTC. */
function dowOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/* ————————————————————————— recurring calendar ————————————————————————— */

/** The next occurrence after `d`: month-anchored cadences step by day-of-month (a salary on
 *  the 1st stays on the 1st), day cadences step by their median interval. */
function nextOccurrence(f: RecurringItem, d: string): string {
  const months = CADENCE_MONTHS[f.cadence];
  return months > 0 ? addMonthsClamped(d, months, f.dayOfMonth) : addDays(d, Math.max(1, f.intervalDays));
}

/** Projects each forecast-eligible recurring flow's occurrences inside [from..to].
 *  Stable flows project their LAST amount (a price hike propagates immediately);
 *  variable flows project the median, and carry their recent extremes as the band. */
export function projectEvents(flows: RecurringItem[], from: string, to: string): ForecastEvent[] {
  const events: ForecastEvent[] = [];
  for (const f of flows) {
    if (!f.forecastEligible) continue;
    const amount = f.amountStable ? f.lastAmount : f.amount;
    // signed extremes work for both kinds: an expense's low is its most negative recent
    // charge, an income's low is its leanest recent deposit
    const low = f.amountStable ? amount : Math.min(f.amountMin ?? amount, amount);
    const high = f.amountStable ? amount : Math.max(f.amountMax ?? amount, amount);
    let d = f.nextDate;
    // catch up if nextDate is already in the past relative to `from`
    let guard = 0;
    while (d < from && guard++ < 60) d = nextOccurrence(f, d);
    // finite plans (installments) stop dead at their last expected slice
    while (d <= to && (f.endDate === null || d <= f.endDate)) {
      events.push({ date: d, merchant: f.merchant, amount, source: 'recurring', low, high });
      d = nextOccurrence(f, d);
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/* ————————————————————————— variable spend ————————————————————————— */

/** One 30-day block of observed variable spending — a row in the "how is this computed" table. */
export interface VariableBlock {
  from: string; // local YYYY-MM-DD, oldest observed day of the block
  to: string; // local YYYY-MM-DD, newest day of the block
  total: number; // magnitude spent in the observed part
  daily: number; // total / observedDays
  observedDays: number; // 30 for fully observed blocks
  /** Full blocks vote in the model; a partial block is displayed but never voted on —
   *  12 observed days say little about a 30-day rhythm. */
  used: boolean;
}

/** The full, explainable output of the variable-spend model: the chosen rate plus every
 *  number that produced it. The UI renders this verbatim — no hidden math. */
export interface VariableAnalysis {
  daily: number; // the rate the expected path applies
  model: VariableModel;
  /** blocks — the configured model over fully observed blocks; partial — under 30 days of
   *  history, rate over the days actually observed; lumpy-average — zero median but real
   *  spending (cash every couple of months), average used; manual — the user's number;
   *  no-data — nothing observed yet. */
  basis: 'blocks' | 'partial' | 'lumpy-average' | 'manual' | 'no-data';
  blocks: VariableBlock[]; // newest first, only blocks with at least one observed day
  p25Daily: number; // frugal-month rate — feeds the optimistic band edge
  p75Daily: number; // spendy-month rate — feeds the pessimistic band edge
  weekdayFactors: number[] | null; // Sun..Sat, mean 1; null = disabled or insufficient data
  observedDays: number; // how much history actually fed the model
}

export interface VariableSpendConfig {
  lookbackBlocks: number;
  variableModel: VariableModel;
  manualDaily: number | null;
  weekdayPattern: boolean;
}

const WEEKDAY_FACTOR_MIN = 0.3; // one crazy Saturday must not triple every future Saturday
const WEEKDAY_FACTOR_MAX = 2.5;
const WEEKDAY_MIN_DAYS = 28; // below four full weeks the per-day-of-week signal is noise

/** Robust daily variable (non-recurring) spend with its full explanation: expenses summed
 *  per 30-day block, the configured model applied over the fully observed blocks. A single
 *  crazy month (furniture, flights) no longer inflates the whole forecast the way a plain
 *  90-day mean did — and every block that voted is reported back for display. */
export function analyzeVariableSpend(
  rows: { amount: number; status: string; localDay: string; description: string; memo?: string | null }[],
  recurringMerchants: ReadonlySet<string>,
  keyOf: (r: { description: string; memo?: string | null }) => string,
  today: string, // local YYYY-MM-DD
  config: VariableSpendConfig,
  earliestDay?: string, // local YYYY-MM-DD of the oldest held row — blocks outside it are not "quiet", they are unobserved
): VariableAnalysis {
  const blocks = Math.max(1, config.lookbackBlocks);
  const totals = new Array(blocks).fill(0) as number[];
  const eligible: { magnitude: number; age: number; dow: number }[] = [];
  for (const r of rows) {
    if (r.status !== 'completed' || r.amount >= 0) continue;
    if (recurringMerchants.has(keyOf(r))) continue;
    const age = Math.floor((Date.parse(today) - Date.parse(r.localDay)) / 86_400_000);
    if (age < 0 || age >= blocks * 30) continue;
    totals[Math.floor(age / 30)] += -r.amount;
    eligible.push({ magnitude: -r.amount, age, dow: dowOf(r.localDay) });
  }

  // a fresh account has empty blocks by lack of history, not by frugality — medianing zeros
  // in would understate the burn rate (often all the way to 0)
  const dataDays = earliestDay
    ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(earliestDay)) / 86_400_000)) + 1
    : blocks * 30;
  const covered = Math.min(blocks, Math.floor(dataDays / 30));
  const observedDays = Math.min(Math.max(0, dataDays), blocks * 30);

  const blockRows: VariableBlock[] = [];
  for (let i = 0; i < blocks; i++) {
    const od = i < covered ? 30 : i === covered ? Math.min(30, Math.max(0, dataDays - covered * 30)) : 0;
    if (od === 0) continue;
    blockRows.push({
      from: addDays(today, -(i * 30 + od - 1)),
      to: addDays(today, -(i * 30)),
      total: round2(totals[i]),
      daily: round2(totals[i] / od),
      observedDays: od,
      used: i < covered,
    });
  }

  const fullRates = blockRows.filter((b) => b.used).map((b) => b.daily);
  const sortedRates = [...fullRates].sort((a, b) => a - b);

  let basis: VariableAnalysis['basis'];
  let daily: number;
  if (config.variableModel === 'manual' && config.manualDaily !== null) {
    basis = 'manual';
    daily = round2(config.manualDaily);
  } else if (covered === 0) {
    basis = totals[0] > 0 ? 'partial' : 'no-data';
    daily = round2(totals[0] / Math.max(1, Math.min(dataDays, 30)));
  } else if (config.variableModel === 'average') {
    basis = 'blocks';
    daily = round2(fullRates.reduce((a, b) => a + b, 0) / fullRates.length);
  } else if (config.variableModel === 'p75') {
    basis = 'blocks';
    daily = round2(percentile(sortedRates, 0.75));
  } else {
    const med = median(fullRates);
    if (med > 0) {
      basis = 'blocks';
      daily = round2(med);
    } else {
      // lumpy spending — cash withdrawals every couple of months — has a zero median but is
      // still real money leaving the account; report the observed average, never a flat zero
      const total = fullRates.reduce((a, b) => a + b, 0);
      basis = total > 0 ? 'lumpy-average' : 'blocks';
      daily = round2(total / fullRates.length);
    }
  }

  // the band edges come from the frugal/spendy observed months, never inverted around daily
  const p25Daily = sortedRates.length >= 2 ? round2(percentile(sortedRates, 0.25)) : daily;
  const p75Daily = sortedRates.length >= 2 ? round2(percentile(sortedRates, 0.75)) : daily;

  // day-of-week shape: Fridays are not Tuesdays. rate per weekday ÷ overall rate, clamped
  // and re-normalized to mean 1 so a full week still sums to daily×7
  let weekdayFactors: number[] | null = null;
  if (config.weekdayPattern && observedDays >= WEEKDAY_MIN_DAYS) {
    const spendByDow = new Array(7).fill(0) as number[];
    for (const e of eligible) if (e.age < observedDays) spendByDow[e.dow] += e.magnitude;
    const countByDow = new Array(7).fill(0) as number[];
    for (let i = 0; i < observedDays; i++) countByDow[dowOf(addDays(today, -i))]++;
    const total = spendByDow.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const overall = total / observedDays;
      const raw = spendByDow.map((s, d) =>
        Math.min(WEEKDAY_FACTOR_MAX, Math.max(WEEKDAY_FACTOR_MIN, s / Math.max(1, countByDow[d]) / overall)),
      );
      const mean = raw.reduce((a, b) => a + b, 0) / 7;
      weekdayFactors = raw.map((f) => round2(f / mean));
    }
  }

  return { daily, model: config.variableModel, basis, blocks: blockRows, p25Daily, p75Daily, weekdayFactors, observedDays };
}

/** Back-compat single-number view of the analysis (median model, uniform days). */
export function variableDailySpend(
  rows: { amount: number; status: string; localDay: string; description: string; memo?: string | null }[],
  recurringMerchants: ReadonlySet<string>,
  keyOf: (r: { description: string; memo?: string | null }) => string,
  today: string, // local YYYY-MM-DD
  blocks = 3,
  earliestDay?: string,
): number {
  return analyzeVariableSpend(
    rows,
    recurringMerchants,
    keyOf,
    today,
    { lookbackBlocks: blocks, variableModel: 'median', manualDaily: null, weekdayPattern: false },
    earliestDay,
  ).daily;
}

/* ————————————————————————— calibration: level from history ————————————————————————— */

export const DAYS_PER_MONTH = 30.44;

export interface CalibrationMonth {
  month: string; // flow month, YYYY-MM
  net: number; // observed bank net of that complete month (signed)
}

/** The calibration's full audit trail — rendered verbatim by "איך זה מחושב". */
export interface DriftCalibration {
  months: CalibrationMonth[]; // the complete months that voted, newest first
  windowMonths: number; // the window the user asked for (months actually found may be fewer)
  medianNet: number; // a typical observed month
  p25Net: number | null; // frugal-month net (null under 2 months of history)
  p75Net: number | null; // spendy-month net
  impliedMonthly: number; // what the event calendar + variable model explain per month
  driftDaily: number; // (medianNet − impliedMonthly) / DAYS_PER_MONTH
  driftLow: number | null; // drift at the frugal-month percentile
  driftHigh: number | null; // drift at the spendy-month percentile
}

/** What the projected calendar adds up to in a typical month — MUST mirror projectEvents:
 *  stable streams count their last amount, variable streams their median, only
 *  forecast-eligible flows count at all. Finite plans (installments) count while alive;
 *  the implied net is an average-month statement, not a per-month schedule. */
export function impliedMonthlyNet(flows: RecurringItem[], variableDaily: number): number {
  const events = flows.filter((f) => f.forecastEligible).reduce((s, f) => {
    const amount = f.amountStable ? f.lastAmount : f.amount;
    const months = CADENCE_MONTHS[f.cadence];
    return s + (months > 0 ? amount / months : amount * (DAYS_PER_MONTH / Math.max(1, f.intervalDays)));
  }, 0);
  return round2(events - variableDaily * DAYS_PER_MONTH);
}

/** "Shape from the calendar, level from history." The event calendar knows salary, fixed
 *  bills and card settlements — but irregular flows (ביט, checks, cash, one-off transfers)
 *  have no rhythm to detect, and an account can live on them. Over complete months the
 *  observed net IS the truth; whatever gap the calendar leaves unexplained is projected as
 *  a uniform daily drift, and the frugal/spendy month percentiles become the envelope.
 *  Without this, a bottom-up forecast silently loses every shekel it cannot itemize. */
export function calibrateDrift(
  months: CalibrationMonth[],
  windowMonths: number,
  impliedMonthly: number,
): DriftCalibration | null {
  if (months.length === 0) return null;
  const nets = months.map((m) => m.net);
  const sorted = [...nets].sort((a, b) => a - b);
  const med = median(nets);
  const spread = months.length >= 2;
  const p25 = spread ? round2(percentile(sorted, 0.25)) : null;
  const p75 = spread ? round2(percentile(sorted, 0.75)) : null;
  return {
    months,
    windowMonths,
    medianNet: round2(med),
    p25Net: p25,
    p75Net: p75,
    impliedMonthly: round2(impliedMonthly),
    driftDaily: round2((med - impliedMonthly) / DAYS_PER_MONTH),
    driftLow: p25 === null ? null : round2((p25 - impliedMonthly) / DAYS_PER_MONTH),
    driftHigh: p75 === null ? null : round2((p75 - impliedMonthly) / DAYS_PER_MONTH),
  };
}

/* ————————————————————————— the balance path ————————————————————————— */

function dayDiff(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

export interface ForecastPathOptions {
  /** Sun..Sat factors (mean 1) shaping the daily variable spend; null/absent = uniform. */
  weekdayFactors?: number[] | null;
  /** Frugal-month daily rate — the optimistic edge (defaults to variableDaily). */
  p25Daily?: number;
  /** Spendy-month daily rate — the pessimistic edge (defaults to variableDaily). */
  p75Daily?: number;
  /** Compute the low/high envelope paths. */
  band?: boolean;
  /** Uniform daily calibration drift — the observed-net gap the calendar cannot explain. */
  driftDaily?: number;
  /** Drift at the frugal/spendy observed-month percentiles. When BOTH are given, the band
   *  walks switch to net-distribution mode: recurring events at their expected amounts and
   *  the variable spend at its chosen rate — the observed monthly nets already contain
   *  those variances, and stacking both would double-count the same uncertainty. Known
   *  charges keep their spread: a still-filling cycle is information about THIS month,
   *  not month-level variance. */
  driftLow?: number;
  driftHigh?: number;
}

/** Balance path: currentBalance + recurring calendar − daily variable spend, for `days` days ahead.
 *  knownCharges are exact upcoming card debits from the data — each replaces the nearest projected
 *  settlement occurrence of its company (real number beats historical median); with no history to
 *  match, it becomes its own event, so the forecast works from the very first card sync.
 *  extraEvents are dated near-certainties (pending bank rows). endOfMonthDate makes "end of month"
 *  anchor-aware — the user's flow month, not the calendar's.
 *  With opts.band, two more walks run in parallel: every unstable component at its recently-seen
 *  worst (low) and best (high) — a deterministic envelope, not a simulation. */
export function forecastBalance(
  currentBalance: number,
  flows: RecurringItem[],
  variableDaily: number,
  today: string, // local YYYY-MM-DD
  days = 60,
  knownCharges: KnownCharge[] = [],
  endOfMonthDate?: string,
  extraEvents: ForecastEvent[] = [],
  opts: ForecastPathOptions = {},
): Forecast {
  const horizon = addDays(today, days);
  const events = projectEvents(flows, addDays(today, 1), horizon);

  const known: KnownCharge[] = [];
  for (const kc of knownCharges) {
    if (kc.date <= today || kc.date > horizon) continue;
    // consume EVERY projected settlement of this company in the same billing window — a card
    // can settle under two bank names (Max: "מקס"/"לאומי ויזה"), and replacing only the nearest
    // event would leave the other to double count
    const matched: ForecastEvent[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (settlementCompany(e.merchant) === kc.company && dayDiff(e.date, kc.date) <= 7) {
        matched.push(e);
        events.splice(i, 1);
      }
    }
    if (matched.length > 0) {
      // the delivered next cycle only ever GROWS until its debit date, so the known sum is a
      // floor, not the final number — project the more cautious of known vs. history, and let
      // the band span the two readings of the still-filling cycle
      const projected = matched.reduce((s, e) => s + e.amount, 0);
      const applied = round2(Math.min(kc.amount, projected));
      events.push({
        date: kc.date,
        merchant: kc.merchant,
        amount: applied,
        source: 'known',
        low: applied,
        high: round2(Math.max(kc.amount, projected)),
      });
      known.push({ ...kc, appliedAmount: applied });
    } else {
      events.push({ date: kc.date, merchant: kc.merchant, amount: kc.amount, source: 'known', low: kc.amount, high: kc.amount });
      known.push({ ...kc, appliedAmount: kc.amount });
    }
  }
  for (const e of extraEvents) {
    if (e.date <= today || e.date > horizon) continue;
    events.push({ ...e, low: e.low ?? e.amount, high: e.high ?? e.amount });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  const drift = opts.driftDaily ?? 0;
  const driftBand = opts.driftLow !== undefined && opts.driftHigh !== undefined;

  const eventsByDay = new Map<string, { amount: number; low: number; high: number }>();
  for (const e of events) {
    const d = eventsByDay.get(e.date) ?? { amount: 0, low: 0, high: 0 };
    d.amount += e.amount;
    // net-distribution band mode: month-level variance lives in the drift edges, so only
    // known charges (this-cycle information) keep their spread — see ForecastPathOptions
    const collapse = driftBand && e.source !== 'known';
    d.low += collapse ? e.amount : e.low ?? e.amount;
    d.high += collapse ? e.amount : e.high ?? e.amount;
    eventsByDay.set(e.date, d);
  }

  const factors = opts.weekdayFactors ?? null;
  // the envelope must contain the expected path even when the chosen model IS one of its edges
  const lowRate = driftBand ? variableDaily : Math.max(opts.p75Daily ?? variableDaily, variableDaily);
  const highRate = driftBand ? variableDaily : Math.min(opts.p25Daily ?? variableDaily, variableDaily);
  const driftLow = driftBand ? Math.min(opts.driftLow as number, drift) : drift;
  const driftHigh = driftBand ? Math.max(opts.driftHigh as number, drift) : drift;
  const withBand = opts.band === true;

  const start: DayBalance = { date: today, balance: round2(currentBalance) };
  const path: DayBalance[] = [start];
  const bandLow: DayBalance[] = [start];
  const bandHigh: DayBalance[] = [start];
  let bal = currentBalance;
  let balLow = currentBalance;
  let balHigh = currentBalance;
  let day = today;
  let trough: DayBalance = start;
  let troughLow: DayBalance = start;
  const endOfThisMonth = endOfMonthDate ?? `${today.slice(0, 7)}-31`;
  let endOfMonth: DayBalance = start;

  for (let i = 0; i < days; i++) {
    day = addDays(day, 1);
    const f = factors ? factors[dowOf(day)] : 1;
    const ev = eventsByDay.get(day);
    bal += (ev?.amount ?? 0) - variableDaily * f + drift;
    const point = { date: day, balance: round2(bal) };
    path.push(point);
    if (point.balance < trough.balance) trough = point;
    if (day <= endOfThisMonth) endOfMonth = point;
    if (withBand) {
      balLow += (ev?.low ?? 0) - lowRate * f + driftLow;
      balHigh += (ev?.high ?? 0) - highRate * f + driftHigh;
      const lowPoint = { date: day, balance: round2(balLow) };
      bandLow.push(lowPoint);
      bandHigh.push({ date: day, balance: round2(balHigh) });
      if (lowPoint.balance < troughLow.balance) troughLow = lowPoint;
    }
  }
  return {
    path,
    events,
    trough,
    endOfMonth,
    variableDaily,
    driftDaily: drift,
    known,
    bands: withBand ? { low: bandLow, high: bandHigh } : null,
    troughLow: withBand ? troughLow : null,
    weekdayFactors: factors,
  };
}

/* ————————————————————————— explainability ————————————————————————— */

/** The full "how is this computed" payload — assembled by the route (it owns the snapshot
 *  context) and rendered verbatim by the client. */
export interface ForecastExplain {
  start: {
    balance: number; // the path's starting balance
    snapshotDate: string; // local date of the bank snapshot it came from
    movementsSince: number; // completed bank movements applied on top of the snapshot
  };
  variable: VariableAnalysis;
  /** Level-from-history calibration, null when no complete month exists yet. */
  calibration: DriftCalibration | null;
}
