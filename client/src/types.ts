export interface Status {
  connectionCount: number;
  lastSyncAt: string | null;
  autoSyncOnOpen: boolean;
}

/** One person's world. Isolation is physical: this id names a database file, not a WHERE clause. */
export interface ProfileSummary {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  lastOpenedAt: string | null;
  order: number;
  /** null when the profile's database could not be read — listing profiles must never throw. */
  connectionCount: number | null;
  lastSyncAt: string | null;
}

export interface ProfilesResponse {
  profiles: ProfileSummary[];
  /** null only when the registry holds no profile at all — there is no world to render. */
  activeId: string | null;
}

/** A breakage on the institution's side that the scraping library has not caught up with. */
export interface CompanyOutage {
  since: string; // YYYY-MM-DD
  noteHe: string;
  issueUrl: string;
}

export interface Company {
  id: string;
  nameHe: string;
  kind: 'bank' | 'card' | 'other';
  loginFields: { name: string; labelHe: string; secret: boolean }[];
  /** Months of history this institution actually delivers — never the window we asked for. */
  historyMonths: number;
  outage: CompanyOutage | null;
}

export interface Connection {
  id: number;
  company: string;
  nameHe: string;
  nickname: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  historyMonths: number;
  outage: CompanyOutage | null;
}

export interface CategoryExpense {
  category: string; // server CategoryId or 'uncategorized'
  expenses: number;
}

export interface MonthlySummary {
  month: string; // 'YYYY-MM'
  income: number;
  expenses: number; // positive magnitude
  net: number;
  byCategory: CategoryExpense[];
}

export interface SummaryResponse {
  months: number;
  summary: MonthlySummary[];
  reviewCount: number;
  topInsight: { month: string; type: string; textHe: string } | null;
}

export interface SearchTxn {
  key: string;
  date: string;
  month: string;
  description: string;
  amount: number;
  company: string;
  connectionLabel: string;
  category: string | null;
  status: 'completed' | 'pending';
  excluded: boolean;
  excludeReason: ExcludeReason | null;
}

export interface SearchResponse {
  total: number;
  txns: SearchTxn[];
}

export interface SyncProgress {
  running: boolean;
  items: { connectionId: number; nameHe: string; nickname: string | null; status: 'pending' | 'running' | 'ok' | 'error' }[];
}

export interface SyncResult {
  connectionId: number;
  company: string;
  nameHe: string;
  nickname: string | null;
  success: boolean;
  added: number;
  errorType?: string;
}

export interface SyncResponse {
  results: SyncResult[];
  lastSyncAt: string | null;
}

/** Mirrors the server's ExcludeReason (companies.ts). Hand-written — the client shares no types
 *  with the server — so every consumer must carry a fallback for a reason it does not know. */
export type ExcludeReason = 'settlement' | 'transfer' | 'future' | 'partial' | 'savings' | 'manual';

export interface MonthTxn {
  key: string;
  date: string;
  description: string;
  amount: number;
  company: string;
  connectionLabel: string;
  status: 'completed' | 'pending';
  excluded: boolean;
  excludeReason: ExcludeReason | null;
  category: string | null;
  categorySource: string | null;
  installments: string | null; // "2/6"
  /** The merchant is a user-confirmed subscription — stamps the "מנוי" tag on the row. */
  subscription?: boolean;
  /** Normalized merchant identity (memo-aware for bank transfers) — what the inline
   *  "מנוי"/"קבוע" toggle applies its mark to, across every charge of this merchant. */
  merchant?: string;
  /** The payee/purpose the bank hid in the memo — present only when it adds meaning over the
   *  description (a generic "העברה דיגיטל" that is really "מנחם פינטו שכר דירה"); else null. */
  merchantName?: string | null;
  /** This merchant's rolled-up classification (subscription | fixed | dismissed), null = unset. */
  mark?: TxnMark | null;
  /** True for a genuine outflow the user may classify inline — the row shows the toggle buttons. */
  classifiable?: boolean;
}

/** A large bank movement still counted as income or expense — the engine naming its own blind spots. */
export interface FlowCandidate {
  pattern: string;
  sampleDescription: string;
  count: number;
  /** Signed net. Says almost nothing on a round-trip, where the two legs cancel — read `inflow`
   *  and `outflow` instead: a renewal is counted as BOTH income and expense, and the harm is the
   *  sum of the two, not the difference. */
  total: number;
  inflow: number;
  /** Negative, or 0. */
  outflow: number;
  lastDate: string;
  /** Only the naive "every positive bank row is income" fallback stands behind it. A ranking signal,
   *  never a filter: a category rule can silence the category while the money keeps counting. */
  weakBasis: boolean;
}

/** What the vocabulary took out of the flows by itself. Shown apart from the candidates feed so
 *  that feed still retires, but shown — a wrong exclusion is money the app hid, and 'תזרים אמיתי'
 *  is the only lever that brings it back. */
export interface SavingsExcludedGroup {
  pattern: string;
  sampleDescription: string;
  count: number;
  total: number;
  inflow: number;
  outflow: number;
  lastDate: string;
}

/** A bank debit shaped like a card settlement whose card the engine cannot name. Actionless on
 *  purpose: settlement is arbitrated per month and per card, and the only class on offer here is
 *  permanent — it would delete real spending in exactly the months that arbitration exists for. */
export interface SettlementSuspect {
  pattern: string;
  sampleDescription: string;
  count: number;
  total: number;
}

export interface FlowCandidatesResponse {
  candidates: FlowCandidate[];
  savingsExcluded: SavingsExcludedGroup[];
  settlementSuspects: SettlementSuspect[];
}

export interface BackupInfo {
  file: string;
  size: number;
  createdAt: string;
}

export interface BalanceRow {
  connectionId: number;
  account: string;
  label: string;
  kind: 'bank' | 'card' | 'other';
  balance: number;
  balanceDate: string | null;
  takenAt: string;
}

export interface ReviewTxn {
  key: string;
  date: string;
  description: string;
  amount: number;
  issuerCategory: string | null;
  connectionLabel: string;
}

/** Mirror of the server's 14 fixed categories (ids are the API contract). */
export const CATEGORIES: { id: string; nameHe: string }[] = [
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
];

export function categoryNameHe(id: string): string {
  if (id === 'uncategorized') return 'לא סווג';
  return CATEGORIES.find((c) => c.id === id)?.nameHe ?? id;
}

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'bimonthly' | 'yearly';

export const CADENCE_NAME_HE: Record<Cadence, string> = {
  weekly: 'שבועי', biweekly: 'דו-שבועי', monthly: 'חודשי', bimonthly: 'דו-חודשי', yearly: 'שנתי',
};

export interface RecurringItem {
  merchant: string;
  sampleDescription: string;
  company: string;
  connectionId: number;
  category: string | null;
  amount: number;
  lastAmount: number;
  amountStable: boolean;
  /** Signed extremes of the recent occurrences — the forecast band's per-stream edges. */
  amountMin: number;
  amountMax: number;
  cadence: Cadence;
  intervalDays: number;
  monthlyAmount: number;
  dayOfMonth: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  kind: 'income' | 'expense';
  excludedFlow: boolean;
  provisional: boolean;
  forecastEligible: boolean;
  active: boolean;
  installmentPlan: boolean;
  endDate: string | null;
}

/** "דברים שחשוב להגדיר" · ההוצאות שלי — the per-transaction classification the user stamps on a
 *  charge line. The merchant's recurring behavior (forecast, tags) is derived from these. */
export type TxnMark = 'subscription' | 'fixed' | 'habit' | 'dismissed';

export interface ExpenseTxn {
  key: string;
  date: string;
  description: string;
  memo: string | null; // the bank's note — carries the payee for a generic transfer
  merchant: string;
  category: string | null;
  amount: number; // signed (expense negative)
  company: string;
  mark: TxnMark | null;
  detected: boolean; // the detector already reads this merchant as recurring
  excluded: boolean; // the engine kept this out of the flow (transfer/savings/internal)
  excludeReasonHe: string | null; // why, in Hebrew — null when it counts normally
}

/** One merchant, rolled up from its charges — the unit the "לפי תדירות" view shows and ranks.
 *  `count` and `regularity` are the two heat axes the client blends into the weighted score. */
export interface ExpenseMerchant {
  merchant: string;          // normalized key — what apply-merchant matches on
  name: string;              // display description (the most recent charge)
  category: string | null;
  count: number;
  typicalAmount: number;     // signed (negative) — median charge
  totalAmount: number;       // signed (negative) — sum over the window
  monthlyAmount: number;     // positive magnitude
  cadence: Cadence;
  cadenceHe: string;
  regularity: number;        // 0..1 — how even the gaps are
  firstDate: string;
  lastDate: string;
  detected: boolean;
  mark: TxnMark | null;      // merchant verdict (dominant), null = unclassified
  excluded: boolean;         // the engine keeps this merchant's charges out of the flow
  excludeReasonHe: string | null; // why (העברה / חיסכון / …), null when counted normally
  txns: ExpenseTxn[];        // the merchant's charges, newest first
}

export interface ManualSub {
  id: number;
  name: string;
  amount: number;        // signed (negative)
  monthlyAmount: number;
  cadence: Cadence;
  cadenceHe: string;
  dayOfMonth: number | null;
  category: string | null;
  mark: 'subscription' | 'fixed';
}

export interface ExpenseDetailView {
  txns: ExpenseTxn[];
  merchants: ExpenseMerchant[];
  manual: ManualSub[];
  summary: {
    subscriptionCount: number;
    subscriptionMonthly: number;
    fixedCount: number;
    fixedMonthly: number;
    unclassifiedCount: number;
    totalTxns: number;
  };
}

/** One open installment plan (תשלומים) — a finite financed purchase with slices left to pay. */
/** One past charge of a merchant — the atom the history popup plots. */
export interface MerchantCharge {
  date: string;    // local YYYY-MM-DD
  month: string;   // YYYY-MM
  amount: number;  // positive magnitude
}

/** A merchant's full charge history + the pattern read from it (see server merchantHistory). */
export interface MerchantChargeHistory {
  merchant: string;
  name: string;
  category: string | null;
  count: number;
  charges: MerchantCharge[]; // oldest → newest
  typicalAmount: number;     // median magnitude, positive
  minAmount: number;
  maxAmount: number;
  totalAmount: number;
  firstDate: string;
  lastDate: string;
  cadence: Cadence;
  cadenceHe: string;
  regularity: number;        // 0..1
  dayOfMonth: number | null;
  mark: TxnMark | null;
  varied: boolean;           // amounts drift → a variable-price charge
}

/** One of the three "rings" a detected rhythm can mean (see server patterns.ts). */
export type PatternNature = 'subscription' | 'fixed' | 'habit';

export interface SpendingPattern {
  merchant: string;
  name: string;
  category: string | null;
  cadence: Cadence;
  cadenceHe: string;
  intervalDays: number;
  regularity: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  active: boolean;
  installmentPlan: boolean;
  endDate: string | null;
  typicalAmount: number;
  minAmount: number;
  maxAmount: number;
  amountStable: boolean;
  monthlyAmount: number;
  totalToDate: number;
  recent: number[];              // last ≤12 charge magnitudes, oldest→newest — the row sparkline
  dayOfMonth: number | null;
  dayOfWeek: number | null;      // 0=Sun..6=Sat, for weekly/biweekly habits
  suggestedNature: PatternNature;
  nature: PatternNature;
  confidence: number;
  userMarked: boolean;
  dismissed: boolean;
  isCommitment: boolean;
  countsAsCommitted: boolean;
  countsAsHabit: boolean;
  source: 'detected' | 'manual';    // detected from transactions, or hand-typed by the user
  installmentsPaid: number | null;  // k of "k מתוך N" (installment plans only)
  installmentsTotal: number | null; // N (installment plans only)
}

export interface SpendingPatternsView {
  patterns: SpendingPattern[];
  summary: {
    total: number;
    subscriptionMonthly: number;
    fixedMonthly: number;
    committedMonthly: number;
    habitMonthly: number;
    rhythmMonthly: number;
    totalMonthlySpend: number;
    pctOnRhythm: number;
  };
}

export interface InstallmentPlan {
  merchant: string;
  name: string;
  category: string | null;
  paid: number;             // slices charged (k)
  total: number;            // plan length (N)
  remaining: number;        // slices left (N − k)
  sliceAmount: number;      // one monthly slice, positive
  remainingAmount: number;  // still owed = remaining × slice, positive
  nextDate: string;
  endDate: string | null;   // when the last slice lands — when it frees up
}

export interface DayBalance {
  date: string;
  balance: number;
}

export interface KnownCharge {
  company: string;
  merchant: string;
  date: string;
  amount: number;
  /** What the forecast actually placed on the date — projected history while the cycle fills. */
  appliedAmount?: number;
}

/** How the daily variable-spend rate is chosen from the observed 30-day blocks. */
export type VariableModel = 'median' | 'average' | 'p75' | 'manual';

/** The forecast's user-tunable knobs — mirrors the server's ForecastConfig. */
export interface ForecastConfig {
  lookbackBlocks: number; // 1..60 (30-day blocks), capped live by how much history exists
  variableModel: VariableModel;
  manualDaily: number | null;
  weekdayPattern: boolean;
  showBand: boolean;
  horizonDays: number; // 7..18262 (~50y)
}

/** One observed 30-day block of variable spending — a row in the "how" table. */
export interface VariableBlock {
  from: string;
  to: string;
  total: number;
  daily: number;
  observedDays: number;
  used: boolean;
}

/** The variable model's full math, rendered verbatim — no hidden numbers. */
export interface VariableAnalysis {
  daily: number;
  model: VariableModel;
  basis: 'blocks' | 'partial' | 'lumpy-average' | 'manual' | 'no-data';
  blocks: VariableBlock[];
  p25Daily: number;
  p75Daily: number;
  weekdayFactors: number[] | null; // Sun..Sat, mean 1
  observedDays: number;
}

export interface CalibrationMonth {
  month: string;
  net: number;
}

/** "Shape from the calendar, level from history" — the calibration's full audit trail. */
export interface DriftCalibration {
  months: CalibrationMonth[];
  windowMonths: number;
  medianNet: number;
  p25Net: number | null;
  p75Net: number | null;
  impliedMonthly: number;
  driftDaily: number;
  driftLow: number | null;
  driftHigh: number | null;
}

export interface ForecastExplain {
  start: { balance: number; snapshotDate: string; movementsSince: number };
  variable: VariableAnalysis;
  calibration: DriftCalibration | null;
}

export type ForecastEventSource = 'recurring' | 'known' | 'pending';

export interface ForecastEvent {
  date: string;
  merchant: string;
  amount: number;
  source: ForecastEventSource;
  low?: number;
  high?: number;
}

export interface Forecast {
  path: DayBalance[];
  events: ForecastEvent[];
  trough: DayBalance;
  endOfMonth: DayBalance;
  variableDaily: number;
  driftDaily: number;
  known: KnownCharge[];
  /** Pessimistic/optimistic envelope (aligned to path) — null when switched off. */
  bands: { low: DayBalance[]; high: DayBalance[] } | null;
  troughLow: DayBalance | null;
  weekdayFactors: number[] | null;
  explain: ForecastExplain;
}

export interface PlanEvent {
  date: string;
  merchant: string;
  amount: number;
}

/**
 * היעד שלי — the one thing the household declares, and everything it implies.
 *
 * One question a person can actually answer ("with what share of your income do you want to
 * close each month?"), and the ceiling for variable spending falls out of it. `observedRate`
 * is what the household does today and `maxRate` is what its structure can carry — a target
 * set without either is a wish.
 */
export interface SavingsTarget {
  /** False when there is too little history to say what a rate MEANS in shekels. The declared
   *  rate still binds — it needs no history to apply. */
  available: boolean;
  reasonHe: string;
  completeMonths: number;
  /** What the household declared. null = nothing declared, nothing held back. */
  rate: number | null;
  suggestedRate: number;
  suggestionHe: string;
  /** rate ?? suggestedRate — what the figures below are computed at. */
  effectiveRate: number;
  /** The median share of income the household actually closed its months with. */
  observedRate: number | null;
  /** The level reached in 3 of 4 months — never the median. */
  reliableIncome: number;
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

/** The monthly spending plan — expected income − fixed commitments − variable spent = left. */
export interface CashflowPlan {
  month: string;
  monthStart: string;
  monthEnd: string;
  daysElapsed: number;
  daysLeft: number;
  daysInMonth: number;
  income: { soFar: number; expectedRemaining: PlanEvent[]; expectedTotal: number };
  fixed: { soFar: number; expectedRemaining: PlanEvent[]; total: number };
  /** byDay: real variable spend for each calendar day of the flow month (index 0 = day 1),
   *  with that day's category breakdown for the hover card. */
  variable: {
    soFar: number;
    perDayPace: number;
    byDay: Array<{ total: number; cats: Array<{ cat: string; amount: number }> }>;
  };
  /** Card debits that hit the bank inside this flow month. Real cash, deliberately outside
   *  every figure above because the purchases were counted on their own dates. */
  cardSettlements?: { amount: number; count: number };
  /** The card's own ledger for this month — what already left the bank, and what the issuer
   *  has already scheduled to take next. Both outside every figure above, both exact. */
  cardOutlook?: CardOutlook;
  /** "יצא עד כה" split by instrument — card purchases vs everything else. card + other always
   *  equals the spent figure; the ledger uses it to point at the chart's own number. */
  spendSplit?: { card: number; other: number };
  /** What the month is expected to COST: every bucket at max(already spent, typical size).
   *  The bottom line stands on this, never on month-to-date alone. */
  expectation?: MonthExpectation;
  /** The target and everything it implies. */
  target?: SavingsTarget;
  /** What the target holds back from THIS month. `applied` is what actually binds:
   *  max(savings.committed, target) — the two are never summed. */
  keep?: { rate: number | null; target: number; applied: number };
  leftToSpend: number;
  /** Cash still available this month BEFORE the target is protected — the bridge between
   *  "נותר ביד" and "נשאר להוציא בבטחה". */
  leftBeforeTarget?: number;
  leftPerDay: number;
  /** Where the month lands IN CASH at the current pace. Never target-net: a missed goal is
   *  not an overdraft, and this sentence is the one everyone reads as money in the bank. */
  paceEndOfMonth: number;
  /** The same pace measured against the declared target. null when no target is binding. */
  paceVsTarget?: number | null;
  /** המסגרת החודשית — the declared variable-spending ceiling, measured with the plan's own
   *  fixed-vs-variable split. null until the household declares one. */
  frame: PlanFrame | null;
  /** What the data would recommend — the app never asks for the number cold. */
  proposal?: FrameProposal;
  history: MonthlySummary[];
}

export interface ExpectationRow {
  key: string;
  labelHe: string;
  kind: 'fixed' | 'variable';
  /** Already out this month. */
  spent: number;
  /** The typical month's size for this bucket — 0 when history cannot say. */
  typical: number;
  /** max(spent, typical). */
  expected: number;
  /** expected − spent: the part still ahead. */
  ahead: number;
}

/** Part of a scheduled card debit, and the flow month that already counted it as spending. */
export interface CardChargeSlice {
  month: string;
  amount: number;
}

/** A debit the card company has already scheduled for purchases already made. Not a forecast:
 *  the money is spent and the date is fixed by the issuer. */
export interface UpcomingCardCharge {
  day: string;
  company: string;
  companyHe: string;
  amount: number;
  count: number;
  countedIn: CardChargeSlice[];
}

export interface CardOutlook {
  settled: { amount: number; count: number; days: string[]; countedIn: CardChargeSlice[] };
  upcoming: UpcomingCardCharge[];
  upcomingTotal: number;
}

export interface MonthExpectation {
  /** Σ expected — what the whole month is expected to cost. CERTAINTIES only. */
  total: number;
  /** Σ ahead — what is still CERTAIN to go out before the month ends. */
  ahead: number;
  /** Σ spent — month-to-date. */
  spent: number;
  fixed: { spent: number; expected: number; ahead: number };
  variable: { spent: number; expected: number; ahead: number };
  rows: ExpectationRow[];
  /** What a typical month still spends on habits from here. An ESTIMATE — displayed beside
   *  the certainties, never added to them. */
  habitEstimate?: number;
  /** Detected charges the household has not vouched for. They reserve nothing. */
  unconfirmed?: Array<{ merchant: string; monthlyAmount: number }>;
}

export interface PlanFrame {
  amount: number;
  spent: number;
  /** amount − spent; negative = over the frame. */
  left: number;
  /** The allowed daily pace from today, following whichever constraint actually binds. */
  perDayAllowed: number;
  /** current daily pace × days in month — where the month lands if nothing changes. */
  projectedSpend: number;
  /** Present only when THIS month cannot afford the standing frame — a month that earned less
   *  than the typical one the frame was built on. The smaller number binds. */
  reality?: FrameReality | null;
  /** The frame broken into the categories that actually carry it, each paced on its own. */
  split: FrameSplitProgress[];
}

/** The month overruling the standing decision. Both figures are right; the smaller one binds. */
export interface FrameReality {
  /** expected income − fixed − variable so far − savings: what is actually safe today. */
  safeLeft: number;
  /** What this month will have earned in total. */
  monthIncome: number;
  /** The income level the frame was sized for — the one reached in 3 of 4 months. */
  typicalIncome: number;
  /** Why the two disagree — 'thin-month' is a different problem from 'over-declared', and the
   *  app must not assert the first when the second is true. */
  cause: 'thin-month' | 'over-declared';
}

/* ——— המסגרת המוצעת: the app's own recommendation ——— */

export type FrameStanceId = 'tight' | 'recommended' | 'comfortable';

export interface FrameStance {
  id: FrameStanceId;
  nameHe: string;
  amount: number;
  meaningHe: string;
}

export interface FrameDerivationRow {
  labelHe: string;
  amount: number;
  sign: 'plus' | 'minus' | 'total';
}

export interface FrameSplitRow {
  category: string;
  nameHe: string;
  amount: number;
  /** The household's own median for this category — what the share was derived from. */
  medianSpend: number;
}

export interface FrameSplitProgress extends FrameSplitRow {
  spent: number;
  /** Spend projected to the end of the month at the pace walked so far. */
  projected: number;
  over: boolean;
}

/** Reality against the declaration: three consecutive months that agree mean the NUMBER was
 *  wrong, not that the household failed three times. */
export interface FrameDrift {
  months: { month: string; frame: number; spent: number }[];
  direction: 'over' | 'under';
  gap: number;
  /** What reality says the frame actually is. */
  honestAmount: number;
}

export interface FrameProposal {
  available: boolean;
  /** Why there is no proposal, when there is none. */
  reasonHe: string;
  completeMonths: number;
  stances: FrameStance[];
  recommended: number;
  /** The specific thing the recommendation is trying to fix. */
  rationaleHe: string;
  derivation: FrameDerivationRow[];
  split: FrameSplitRow[];
  /** What the frame guarantees, at an income the household actually reaches. A ceiling with
   *  no promise attached is just a number. */
  promise: FramePromise | null;
  observed: {
    medianVariable: number;
    essentialFloor: number;
    /** Reliable income − commitments − what is set aside. */
    freeSpace: number;
    /** The middle month. Context only — the frame is NOT built on it. */
    typicalIncome: number;
    /** The income reached in 3 of 4 months — what the frame IS built on. */
    reliableIncome: number;
    /** Protected every month before a shekel of variable spending. */
    setAside: number;
  };
  drift: FrameDrift | null;
}

export interface FramePromise {
  /** The income the promise is made at. */
  atIncome: number;
  setAside: number;
  /** What is still left over at the ceiling; negative means the promise cannot be kept. */
  leftOver: number;
  kept: boolean;
}

/** "התוכנית שלי" — the decision surface. One declaration; everything else derives from it. */
export interface PlanResponse {
  month: string;
  target: SavingsTarget;
  daysLeft: number;
  /** The RUNNING month's actual figures — every shekel the target card shows is computed on
   *  these, never on a typical month. The percent is the plan; the shekels are elastic. */
  thisMonth?: {
    /** Income that actually arrived plus what the recurring calendar still expects. */
    income: number;
    /** The month's fixed CERTAINTIES: what already went down + every vouched commitment
     *  still ahead — the same base as the month tab's "צפוי לצאת". */
    fixed: number;
    keep: { rate: number | null; target: number; applied: number };
    variableSoFar: number;
    leftToSpend: number;
  };
}

/* ——— שכבת השנה: the annual statement ——— */

export interface YearMonthRow {
  month: string;
  income: number;
  expenses: number;
  net: number;
  hasData: boolean;
  partial: boolean;
}

export interface YearCategoryRow {
  category: string;
  total: number;
  /** 12 slots, January..December. */
  byMonth: number[];
  /** Δ% vs the previous year over the shared months — null when there is no honest base. */
  deltaPct: number | null;
}

export interface YearBigExpense {
  key: string;
  date: string;
  description: string;
  amount: number;
  category: string | null;
  /** >1 = a financed purchase re-assembled from its installment charges this year. */
  installments: number;
}

export interface YearReport {
  year: string;
  months: YearMonthRow[];
  totals: { income: number; expenses: number; net: number };
  monthsWithData: number;
  /** Both years summed over the same month numbers — the only honest YoY. */
  sameMonths: {
    count: number;
    prevYear: string;
    prev: { income: number; expenses: number; net: number };
    current: { income: number; expenses: number; net: number };
  } | null;
  byCategory: YearCategoryRow[];
  topMerchants: RankedMerchant[];
  biggest: YearBigExpense[];
  fees: number;
  years: string[];
}

/** One plotted point of a category's history — a whole month, shaped like a merchant charge so the
 *  same chart component draws both. */
export interface CategoryMonthPoint {
  date: string;
  month: string;
  amount: number;
}

export interface RankedMerchant {
  merchant: string;
  name: string;
  total: number;
  count: number;
  /** The category of its most recent charge — what paints its bar. */
  category: string | null;
  mark: TxnMark | null;
  /** false = this merchant has no charge the merchant popup can read; no drill-through offered. */
  drillable: boolean;
}

/** One category's month-by-month spending over ALL stored months — the "היסטוריית התשלומים" popup. */
export interface CategoryHistory {
  category: string;
  /** Oldest → newest, zero-filled across gaps. */
  charges: CategoryMonthPoint[];
  count: number;       // months plotted
  chargeCount: number; // charges behind them
  typicalAmount: number;
  minAmount: number;
  maxAmount: number;
  totalAmount: number;
  varied: boolean;
  firstMonth: string;
  lastMonth: string;
  topMerchants: RankedMerchant[];
}

export interface SavingsEntry {
  id: number;
  date: string;
  amount: number; // positive = deposit, negative = withdrawal
  note: string | null;
}

export interface SavingsGoal {
  id: number;
  name: string;
  targetAmount: number | null;
  monthlyAmount: number | null;
  color: string | null;
  createdAt: string;
  saved: number;
  /** true ⇒ the money lives OUTSIDE the checking account and counts in net worth. */
  external: boolean;
  entries: SavingsEntry[];
}

export interface SavingsResponse {
  goals: SavingsGoal[];
  totals: { saved: number; monthlyPlanned: number; depositedThisMonth: number };
}

export interface DashboardAction {
  id: string;
  severity: 'red' | 'yellow' | 'info';
  textHe: string;
  target: string; // 'cashflow' | 'settings' | 'review' | 'monthreview' | 'sync' | 'month'
  /** Present on a subscription price-change alert — carries what's needed to resolve it inline
   *  ("עדכן ל-₪X" re-anchors, "התעלם" silences the one-off). */
  resolve?: { kind: 'price-change'; merchant: string; oldAmount: number; newAmount: number; month: string };
}

/** The financial situation room — see docs/2026-07-14-dashboard-vision.md. */
export interface DashboardResponse {
  pulse: {
    bankBalance: number | null;
    upcomingCharge: { date: string; amount: number } | null;
    afterCharge: number | null;
    overdraftLimit: number;
    lastSyncAt: string | null;
    syncAgeHours: number | null;
  };
  month: Omit<CashflowPlan, 'history'> & {
    triple: { income: number; expenses: number; net: number };
    prevTriple: { income: number; expenses: number; net: number };
  };
  actions: DashboardAction[];
  trend: {
    ytdDelta: number | null;
    greenStreak: number;
    savingsRate3m: number | null;
    monthsNet: MonthlySummary[];
  };
  composition: {
    categories: { category: string; spent: number; median3m: number; deltaPct: number | null }[];
    topMerchant: { merchant: string; total: number; count: number } | null;
  };
}

export type MonthLens = 'charge' | 'purchase';

export interface AppSettings {
  months: number;
  monthLens: MonthLens;
  monthStartDay: number;
  overdraftLimit: number;
  autoSyncOnOpen: boolean;
  /** The currency the balance sheet is expressed in. Bank/flow data stays ILS as reported. */
  primaryCurrency: string;
  suggestedAnchorDay: number | null;
}

export interface BalanceHistoryResponse {
  latestBankBalance: number | null;
  series: DayBalance[];
}

/** What-if adjustments — computed by the same server engine, never faked client-side. */
export interface ScenarioParams {
  extraMonthly?: number;
  oneOffAmount?: number;
  oneOffMonth?: string; // YYYY-MM
  variableFactor?: number;
}

export interface CashflowResponse {
  recurring: RecurringItem[];
  muted: RecurringItem[];
  forecast: Forecast | null;
  latestBankBalance: number | null;
  overdraftLimit: number;
  days: number;
  config: ForecastConfig;
  /** The honest ceiling for the history-basis slider: how many 30-day blocks of real data exist. */
  maxLookbackBlocks: number;
  /** Present when scenario params were sent — the adjusted path beside the untouched baseline. */
  scenario: { path: DayBalance[]; trough: DayBalance; endOfMonth: DayBalance } | null;
}

/** One matured forecast receipt: what we predicted vs what actually happened. */
export interface ForecastAccuracyEntry {
  takenOn: string;
  horizonDays: number;
  targetDate: string;
  predicted: number;
  actual: number;
  error: number;
}

export interface ForecastAccuracyResponse {
  entries: ForecastAccuracyEntry[];
}

export type Band = 'green' | 'yellow' | 'red' | 'na';

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

export interface Metric {
  id: string;
  nameHe: string;
  axis: 'level' | 'resilience';
  band: Band;
  display: string;
  detailHe: string;
  visual: MetricVisual | null;
}

export interface HealthReport {
  overall: { statusHe: string; band: Band; reasonHe: string };
  level: Metric[];
  resilience: Metric[];
  /** The user-chosen time basis the whole report was computed on. */
  windowMonths: number;
}

/** What a holding IS. `kind` stays the arithmetic truth and is derived from this on write. */
export type HoldingType =
  | 'deposit' | 'securities' | 'pension' | 'realEstate' | 'vehicle' | 'crypto' | 'business' | 'valuable'
  | 'loan' | 'mortgage' | 'other';

/** The bank's five lines. NOT the same union as HoldingType: 'checking'/'card' are never holdings. */
export type AccountStateLine = 'checking' | 'card' | 'deposit' | 'loan' | 'securities';

/** The only three lines an apply may touch — עו"ש and אשראי are scraped truth (A1/A7). */
export type ApplicableLine = 'deposit' | 'loan' | 'securities';

/** 'readonly' is terminal: the two scraped lines prove the paste parsed, and are never applied. */
export type PreviewAction = 'create' | 'update' | 'unchanged' | 'ambiguous' | 'readonly';

/** What apply accepts. Narrower than PreviewAction on purpose: the client cannot post the other two. */
export type ApplyAction = 'create' | 'update' | 'unchanged';

/** Everything the typed form needs to speak each type's own language — the word for its
 *  value, the word for its free-text context line, name/liquidity defaults and the hint
 *  that keeps the number honest. One table drives the whole professional form. */
export interface HoldingTypeMeta {
  id: HoldingType;
  nameHe: string;
  /** Which optgroup the select shows it under; 'other' asks the user via the kind select. */
  side: 'asset' | 'liability' | 'either';
  /** Suggested name when the type is picked into an empty/auto-named draft. */
  defaultName: string;
  amountLabelHe: string;
  amountHintHe: string;
  /** The free-text context line (institution column): bank, address, model, wallet… */
  contextLabelHe: string;
  liquidDefault: boolean;
  /** loan/mortgage carry a display-only monthly payment. */
  hasPayment: boolean;
}

export const HOLDING_TYPES: HoldingTypeMeta[] = [
  {
    id: 'deposit', nameHe: 'פקדון / חיסכון בנקאי', side: 'asset', defaultName: 'פקדונות וחסכונות',
    amountLabelHe: 'יתרה', amountHintHe: 'כפי שהבנק מציג — אפשר לרענן גם בהדבקת מצב חשבון.',
    contextLabelHe: 'בנק / מוסד', liquidDefault: true, hasPayment: false,
  },
  {
    id: 'securities', nameHe: 'תיק ניירות ערך', side: 'asset', defaultName: 'תיק ניירות ערך',
    amountLabelHe: 'שווי התיק', amountHintHe: 'השווי העדכני מהבנק או מבית ההשקעות.',
    contextLabelHe: 'בנק / בית השקעות', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'pension', nameHe: 'פנסיה / השתלמות / גמל', side: 'asset', defaultName: 'קרן השתלמות',
    amountLabelHe: 'צבירה נוכחית', amountHintHe: 'מהדוח הרבעוני או מהאזור האישי של הקרן. קרן השתלמות נזילה (אחרי 6 שנים) אפשר לסמן "נזיל".',
    contextLabelHe: 'הגוף המנהל', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'realEstate', nameHe: 'נדל״ן', side: 'asset', defaultName: 'דירת מגורים',
    amountLabelHe: 'שווי מוערך', amountHintHe: 'הערכה שלך לפי מחירי השוק — לא חייב דיוק, חייב עדכון כשמשהו משתנה. משכנתא נרשמת בנפרד כהתחייבות.',
    contextLabelHe: 'כתובת / תיאור', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'vehicle', nameHe: 'רכב', side: 'asset', defaultName: 'הרכב שלי',
    amountLabelHe: 'שווי מוערך', amountHintHe: 'לפי מחירון — רכב מאבד ערך, שווה לרענן כל כמה חודשים.',
    contextLabelHe: 'דגם ושנה', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'crypto', nameHe: 'קריפטו', side: 'asset', defaultName: 'תיק קריפטו',
    amountLabelHe: 'שווי נוכחי', amountHintHe: 'שווי תנודתי — הרישום כאן ידני, והתמונה מזדקנת מהר.',
    contextLabelHe: 'בורסה / ארנק', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'business', nameHe: 'עסק', side: 'asset', defaultName: 'העסק שלי',
    amountLabelHe: 'שווי חלקך', amountHintHe: 'הערכה שמרנית של החלק שלך — שווי עסק הוא דעה, לא עובדה.',
    contextLabelHe: 'שם העסק / תיאור', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'valuable', nameHe: 'חפצי ערך', side: 'asset', defaultName: '',
    amountLabelHe: 'שווי מוערך', amountHintHe: 'תכשיטים, אומנות, אספנות — לפי מה שסביר לקבל במכירה, לא מחיר הקנייה.',
    contextLabelHe: 'תיאור', liquidDefault: false, hasPayment: false,
  },
  {
    id: 'loan', nameHe: 'הלוואה', side: 'liability', defaultName: 'הלוואות',
    amountLabelHe: 'יתרת החוב', amountHintHe: 'כמה עוד נשאר להחזיר, כפי שהמלווה מציג.',
    contextLabelHe: 'הגוף המלווה', liquidDefault: false, hasPayment: true,
  },
  {
    id: 'mortgage', nameHe: 'משכנתא', side: 'liability', defaultName: 'משכנתא',
    amountLabelHe: 'יתרת המשכנתא', amountHintHe: 'היתרה לסילוק מהדוח השנתי או מהאזור האישי של הבנק.',
    contextLabelHe: 'הבנק', liquidDefault: false, hasPayment: true,
  },
  {
    id: 'other', nameHe: 'אחר', side: 'either', defaultName: '',
    amountLabelHe: 'סכום', amountHintHe: 'כל דבר שלא נכנס לקטגוריות — אתה קובע אם נכס או התחייבות.',
    contextLabelHe: 'מוסד / תיאור', liquidDefault: false, hasPayment: false,
  },
];

export function holdingTypeMeta(type: HoldingType): HoldingTypeMeta {
  return HOLDING_TYPES.find((t) => t.id === type) ?? HOLDING_TYPES[HOLDING_TYPES.length - 1];
}

export function holdingTypeNameHe(type: HoldingType): string {
  return holdingTypeMeta(type).nameHe;
}

export interface Asset {
  id: number;
  name: string;
  kind: 'asset' | 'liability';
  /** Always the magnitude the bank prints, non-negative. `kind` alone carries the sign (A8). */
  amount: number;
  liquid: boolean;
  type: HoldingType;
  institution: string | null;
  /** Display-only. Never feeds the forecast or the plan's fixed commitments — the payment is
   *  already a transaction and the recurring engine already detects it. */
  monthlyPayment: number | null;
  /** ISO 4217. `amount` is denominated in it; the server converts at read time. */
  currency: string;
  /** "Last touched or confirmed" — a paste that changes nothing still moves it (A11). */
  updatedAt: string;
}

export interface ExchangeRate {
  currency: string;
  /** Shekels per one unit. */
  rate: number;
  fetchedAt: string;
}

export interface CurrencyInfo {
  code: string;
  nameHe: string;
  symbol: string;
}

export interface RatesResponse {
  primaryCurrency: string;
  currencies: CurrencyInfo[];
  rates: ExchangeRate[];
}

/** One of the bank's five lines, as the panel prints it. Mirrors the server's AccountStateRow —
 *  the labels, the notes and the loan bound are computed there so there is exactly one wording. */
export interface AccountStateRow {
  line: AccountStateLine;
  labelHe: string;
  /** The row's contribution to netBank, sign included. `null` MUST render `אין נתון` — never 0. */
  signedAmount: number | null;
  source: 'scraped' | 'manual' | 'none';
  /** The single holding behind the row, or null when there are none or more than one. */
  assetId: number | null;
  holdingCount: number;
  /** Oldest touch/confirm across the row's holdings — the weakest link is the honest one. */
  updatedAt: string | null;
  stale: boolean;
  ambiguous: boolean;
  monthlyPayment: number | null;
  /** The bound AND its caveat as one string: the number alone would be a flattering lie (A2). */
  remainingPaymentsHe: string | null;
  noteHe: string | null;
}

export interface AccountState {
  rows: AccountStateRow[];
  /** The sum of the panel's five rows only — the bank picture, NOT net worth. Labelled `נטו בבנק`. */
  netBank: number;
}

/** The economic classes the net-worth history decomposes into. On every day the series
 *  sum back to `history` — the decomposed chart can never disagree with the headline.
 *  `savingsExternal` = savings plans whose money lives outside the checking account. */
export type NetWorthLayerKey = 'checking' | 'card' | 'deposit' | 'securities' | 'pension' | 'realEstate' | 'otherAsset' | 'loan' | 'otherLiability';

/** One flow month of "where did the change come from": flows are what you did (the month
 *  tab's own income/expenses), revaluation is the residual — value changes PLUS any coverage
 *  gap (blind card, stale manual balance), which is why the UI caveats it. */
export interface NetWorthAttributionMonth {
  month: string;
  from: string; // inclusive anchor day
  to: string;   // exclusive next anchor
  income: number;
  expenses: number;
  open: number | null;
  close: number | null;
  revaluation: number | null;
  partial: boolean;
}

export interface NetWorthResponse {
  netWorth: number;
  bankTotal: number;
  cardTotal: number;
  accountState: AccountState;
  /** false ⇒ no card snapshot exists at all, so `cardTotal` is not a figure we have. */
  cardBalanceAvailable: boolean;
  /** The connected cards reporting no יתרה לחיוב, by display name. Non-empty ⇒ `netWorth` is
   *  knowingly missing their debit and must not be presented as complete (A1). Derived from the
   *  connections, so `cardBalanceAvailable` being true does not mean the picture is complete: a
   *  Cal + Max user has a card figure that covers Cal only. */
  cardsMissingBalance: string[];
  /** A manual holding is older than its cadence allows — the manual layer of `history` is a
   *  fabricated flat line until it is refreshed (A4). */
  manualStale: boolean;
  /** Earliest local day on which any manual balance was recorded. Everything before it is a
   *  display convention for an unknown era, not history (A5). */
  manualFrom: string | null;
  accounts: (BalanceRow & { kind: string; label: string })[];
  /** `amount` is raw in the holding's own currency; `value` is the primary-currency figure. */
  assets: (Asset & { value: number })[];
  assetsTotal: number;
  liabilitiesTotal: number;
  history: DayBalance[];
  /** Aligned index-for-index with `history`. */
  layers: Record<NetWorthLayerKey, number[]>;
  /** Oldest→newest, ending at the running flow month (marked partial). */
  attribution: NetWorthAttributionMonth[];
  /** Both balance-sheet sides as magnitudes; assets − liabilities === netWorth. */
  gross: { assets: number; liabilities: number };
  /** Value timeline per manual holding — the sparklines' data. `value` is converted. */
  assetHistories: Record<number, { date: string; amount: number; value: number }[]>;
  /** The currency EVERY monetary figure in this response is expressed in (the primary,
   *  falling back to ILS when its rate is unavailable — see missingRates). */
  currency: string;
  rates: ExchangeRate[];
  /** Foreign currencies we hold but have no rate for — those holdings are EXCLUDED, not 1:1. */
  missingRates: string[];
  anchorDay: number;
}

/* ——— הדבקת מצב חשבון: paste → preview → review → apply ——— */

export interface AccountStatePreviewRow {
  line: AccountStateLine;
  /** The bank's own label, verbatim. */
  labelHe: string;
  /** Magnitude, >= 0 (A8). The display layer adds the minus. */
  amount: number;
  /** The sign the bank printed. Only `checking` consults it: an overdraft is real and normal, and
   *  a line that is not a holding has no `kind` to carry its sign. Every other line's sign is
   *  semantic (a loan is a debt whether or not the bank printed a minus). */
  printedSign: 1 | -1;
  action: PreviewAction;
  /** The holding this row resolved against, at preview time. Echoed back so apply can enforce it. */
  assetId: number | null;
  /** The app's own figure for comparison; null renders אין נתון. */
  current: number | null;
  noteHe: string | null;
}

export interface AccountStatePreviewResponse {
  rows: AccountStatePreviewRow[];
  understood: number;
  ignored: number;
}

/** Echoes the preview's resolution so the server can enforce exactly what the user reviewed. */
export interface AccountStateApplyRow {
  line: ApplicableLine;
  action: ApplyAction;
  assetId: number | null;
  amount: number;
  /** The bank's own label, verbatim — becomes a created holding's name (A12). */
  labelHe?: string;
}

export interface AccountStateApplyResponse {
  applied: number;
  created: number;
  updated: number;
  confirmed: number;
}

/* ——— "איך אני בכללי?" — the longitudinal conduct view ——— */

export interface OverviewMonthRow {
  month: string;
  income: number;
  expenses: number;
  net: number;
  savingsRate: number | null;
  minusDays: number | null;
  minDepth: number | null;
  fixed: number;
  variable: number;
  saved: number;
  partial: boolean;
}

export interface OverviewKpi {
  value: number | null;
  delta: number | null;
}

export interface OverviewResponse {
  monthsRequested: number;
  anchorDay: number;
  series: OverviewMonthRow[];
  completeMonths: number;
  verdict: { avgNet: number; prevAvgNet: number | null };
  kpis: {
    avgIncome: OverviewKpi;
    avgExpenses: OverviewKpi;
    avgNet: OverviewKpi;
    savingsRate: OverviewKpi;
  };
  streaks: {
    greenMonths: number;
    currentPlusStreak: number;
    best: { month: string; net: number } | null;
    worst: { month: string; net: number } | null;
  };
  minus: {
    covered: boolean;
    totalDays: number;
    monthsClean: number;
    monthsCovered: number;
    interestCost: number;
    rate: number;
    maxDepth: { month: string; amount: number } | null;
    worstUtilization: number | null;
    cleanDays: number | null;
    neverMinus: boolean;
  };
}

export interface MonthReview {
  month: string;
  current: MonthlySummary;
  previous: MonthlySummary | null;
  byCategory: CategoryExpense[];
  /** refs = keys of the merchant's rows that month — the unified table tags them in place. */
  topMerchants: { merchant: string; total: number; count: number; refs: string[] }[];
  /** refs = keys of the rows each observation points at; empty when it maps to no single row. */
  insights: { type: string; textHe: string; amount: number; refs: string[] }[];
  /** המסגרת in force for THIS month vs its variable spend — null when none governed it.
   *  The split is built from the months BEFORE this one: a finished month is never re-shaped
   *  by habits formed after it ended. */
  frame: { amount: number; spent: number; left: number; split?: FrameSplitProgress[] } | null;
  /** Reality against the declaration over the last three judged months, up to this one. */
  drift?: FrameDrift | null;
  /** Bank rows still clearing — outside every figure above, named so the month never feels "short". */
  pending: { count: number; net: number };
}
