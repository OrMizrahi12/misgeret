import { merchantKey } from './categories.js';
import { companyKind, type FlaggedTxn } from './companies.js';

/** Which date decides the month a transaction belongs to:
 *  'purchase' — when you acted (the swipe date). Immediate behavioral feedback, the RiseUp
 *               conception ("סופרת כל הוצאה כאילו היא מחויבת ביום שבו היא בוצעה"). The
 *               default lens used throughout the product.
 *  'charge'   — when the money actually moves (card rows use their debit date). Bank-true;
 *               months reconcile exactly against settlements. */
export type MonthLens = 'charge' | 'purchase';

export interface FlowSettings {
  lens: MonthLens;
  /** Day of month the flow month starts (1 = calendar month). A flow month labeled 2026-07
   *  spans [anchorDay of July, anchorDay of August). RiseUp-style salary/billing anchoring. */
  anchorDay: number;
}

export const DEFAULT_FLOW: FlowSettings = { lens: 'purchase', anchorDay: 1 };

function localDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** The date that positions the row in time under the given lens. */
export function effectiveDate(r: Pick<FlaggedTxn, 'date' | 'processedDate' | 'company'>, lens: MonthLens): string {
  if (lens === 'charge' && companyKind(r.company) === 'card' && r.processedDate) return r.processedDate;
  return r.date;
}

/** Flow month of an ISO date under the NOMINAL anchor: the month whose [anchorDay..anchorDay)
 *  window contains it. anchorDay 1 is a plain calendar month in Israel local time.
 *  Bucketing real transactions goes through a FlowCalendar, which is salary-aware — use this
 *  directly only where the nominal grid itself is the question. */
export function flowMonthOf(iso: string, anchorDay: number): string {
  const local = localDate(iso); // YYYY-MM-DD
  let y = Number(local.slice(0, 4));
  let m = Number(local.slice(5, 7));
  const day = Number(local.slice(8, 10));
  if (anchorDay > 1 && day < anchorDay) {
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/* ——— the flow calendar: purchase-date month semantics ————————————————————————————————
 *
 * The window is HARD and nominal — "יולי" is [10.7 .. 9.8), full stop — with exactly one
 * exception, taken verbatim from RiseUp's own rulebook (intercom article 8135407):
 *
 *   "אם המשכורת נכנסת בדרך כלל ב-9 בחודש, אז תזרים חודש יולי (שמתחיל ב-10 ביולי) מושך אליו
 *    את המשכורת שנכנסה לבנק ב-9 ביולי... גם אם המשכורת נכנסת ב-1 ביולי או אפילו ב-30 ביוני,
 *    עדיין אלה משכורות שימתינו וייכנסו לחישוב של תזרים יולי."
 *
 * A RECURRING main income landing before the anchor waits for the month it funds; everything
 * else — every expense, every one-off income — obeys the hard window ("סופרת כל הוצאה כאילו
 * היא מחויבת בבנק ביום שבו היא בוצעה"). Rent paid on the 9th belongs to the month that ENDS
 * on the 9th; the rent of the new month is the one expected on the NEXT 9th. The month flips
 * on the nominal anchor day, never on the salary's arrival — a salary that landed yesterday
 * simply waits, excluded as 'future', until its month opens tomorrow.
 *
 * Why a hard boundary for the salary alone breaks without this: one month shows two salaries
 * ("נכנסו 20,335"), the next shows income 666 ₪ — the bug that started all of this. */

/** How far before the anchor a recurring main income may arrive and still wait for the month
 *  it funds. RiseUp: "הכנסות קבועות שנכנסו לפני יום תחילת התזרים ועד לשבוע האחרון של החודש"
 *  — for an anchor on the 10th that is roughly the 24th of the previous month onward. */
const PULL_DAYS = 16;
/** A pulled income must be a MAIN income: at least this share of the median "largest single
 *  bank income of a month", with an absolute floor — a refund or a friend's transfer landing
 *  on the 8th must never change months. */
const MAIN_INCOME_SHARE = 0.25;
const MAIN_INCOME_FLOOR = 1000;
/**
 * ...and it must be a FIXED income (הכנסה קבועה), not merely a repeating one. RiseUp defines
 * those as "ההכנסות שהתזרים מצפה שיחזרו על עצמן כמעט באופן מדויק מחודש לחודש", and the
 * distinction is load-bearing: a ביט transfer of 2,740 ₪ that landed on the 8th is variable
 * income belonging to the month still running, while the salary that landed the same day
 * funds the month about to open. Treating the transfer as a salary put 2,727 ₪ in the wrong
 * month — the entire gap against RiseUp's June figure came from that one row.
 *
 * So the test is FREQUENCY over the recent window: his salary shows up in 24 of 24 months,
 * the ביט transfers in 4. Counting occurrences instead ("once a month, like a salary") looked
 * right and was not: two of those 24 months happen to hold two payslips, and one exception in
 * two years must not disqualify the most obviously fixed income a household has.
 */
const FIXED_INCOME_WINDOW = 12;
const FIXED_INCOME_MIN_SHARE = 0.6;
const RECURRING_MIN_MONTHS = 2;

export interface FlowCalendar {
  readonly settings: FlowSettings;
  /** Flow month of an ISO date — the nominal hard window. The current month flips here. */
  monthOf(iso: string): string;
  /** First local day (YYYY-MM-DD) of a flow month — always the nominal anchor. */
  startOf(month: string): string;
  /** Last local day of a flow month — the day before the next anchor. */
  endOf(month: string): string;
  /** Flow month of a transaction ROW: the hard window, except a recurring main income in the
   *  waiting zone before an anchor, which belongs to the month that anchor opens. */
  monthOfRow(r: FlaggedTxn): string;
  /** True when an income of this size on this local day inside `month`'s tail would WAIT for
   *  the month after it. Used to keep the next salary out of this month's expected income —
   *  projecting it here counts the same shekels in two months. */
  opensNext(month: string, localDay: string, amount: number): boolean;
}

function addDaysIso(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Build the calendar from the FULL flagged row set — a threshold or recurrence fact derived
 *  from a subset would let two endpoints bucket the same transaction into different months. */
export function buildFlowCalendar(rows: FlaggedTxn[], settings: FlowSettings): FlowCalendar {
  const { anchorDay, lens } = settings;
  const pad = String(anchorDay).padStart(2, '0');
  const nominalStart = (month: string) => `${month}-${pad}`;
  let mainIncomeFloor: number | null = null;
  // merchants whose income repeats across months — the "הכנסה קבועה" set
  const recurringIncomeMerchants = new Set<string>();
  if (anchorDay > 1) {
    const maxByMonth = new Map<string, number>();
    const bankIncomes: { mk: string; month: string; amount: number }[] = [];
    for (const r of rows) {
      // main income arrives at the bank; card credits/refunds can never change months
      if (r.amount <= 0 || r.excluded || r.status !== 'completed' || companyKind(r.company) !== 'bank') continue;
      const m = flowMonthOf(localDate(effectiveDate(r, lens)), anchorDay);
      maxByMonth.set(m, Math.max(maxByMonth.get(m) ?? 0, r.amount));
      bankIncomes.push({ mk: merchantKey(r.description, r.memo), month: m, amount: r.amount });
    }
    // median of per-month largest incomes: one bonus month cannot distort the bar the way
    // a mean would, and a fresh install simply uses the only month it has
    const maxes = [...maxByMonth.values()].sort((a, b) => a - b);
    if (maxes.length > 0) {
      const mid = Math.floor(maxes.length / 2);
      const floor = Math.max(
        MAIN_INCOME_FLOOR,
        MAIN_INCOME_SHARE * (maxes.length % 2 ? maxes[mid] : (maxes[mid - 1] + maxes[mid]) / 2),
      );
      mainIncomeFloor = floor;
      // only incomes big enough to be a main income vote: a 200 ₪ transfer from the same
      // sender neither qualifies a merchant nor disqualifies one
      const big = bankIncomes.filter((i) => i.amount >= floor);
      const newest = big.reduce<string | null>((a, i) => (a === null || i.month > a ? i.month : a), null);
      if (newest !== null) {
        // the recent window, measured in flow months — a merchant that stopped paying a year
        // ago is history, not a standing income
        const window = new Set<string>();
        for (let n = 0; n < FIXED_INCOME_WINDOW; n++) window.add(monthsBack(newest, n));
        const monthsWithData = new Set(bankIncomes.map((i) => i.month).filter((m) => window.has(m)));
        const need = Math.max(RECURRING_MIN_MONTHS, Math.ceil(monthsWithData.size * FIXED_INCOME_MIN_SHARE));
        const monthsByMerchant = new Map<string, Set<string>>();
        for (const i of big) {
          if (!window.has(i.month)) continue;
          (monthsByMerchant.get(i.mk) ?? monthsByMerchant.set(i.mk, new Set()).get(i.mk)!).add(i.month);
        }
        for (const [mk, months] of monthsByMerchant) {
          if (months.size >= need) recurringIncomeMerchants.add(mk);
        }
      }
    }
  }
  const monthOf = (iso: string) => flowMonthOf(localDate(iso), anchorDay);
  return {
    settings,
    monthOf,
    startOf: nominalStart,
    endOf: (month: string) => addDaysIso(nominalStart(monthsBack(month, -1)), -1),
    monthOfRow(r: FlaggedTxn): string {
      const day = localDate(effectiveDate(r, lens));
      const nominal = flowMonthOf(day, anchorDay);
      if (
        anchorDay > 1 && mainIncomeFloor !== null &&
        r.amount >= mainIncomeFloor && r.status === 'completed' && !r.excluded &&
        companyKind(r.company) === 'bank' &&
        recurringIncomeMerchants.has(merchantKey(r.description, r.memo))
      ) {
        // the anchor this income precedes — inside the waiting zone it funds THAT month
        const funds = monthsBack(nominal, -1);
        if (day >= addDaysIso(nominalStart(funds), -PULL_DAYS)) return funds;
      }
      return nominal;
    },
    opensNext(month: string, localDay: string, amount: number): boolean {
      if (anchorDay <= 1 || mainIncomeFloor === null || amount < mainIncomeFloor) return false;
      return localDay >= addDaysIso(nominalStart(monthsBack(month, -1)), -PULL_DAYS);
    },
  };
}

/** Re-buckets months under the lens+calendar and flags rows landing beyond the current flow
 *  month as excluded 'future'. Two kinds of row live there: upcoming card cycles the scrapers
 *  deliver in advance, and a just-arrived early salary WAITING for its month to open (RiseUp's
 *  "ימתינו וייכנסו לחישוב" — it surfaces the day the anchor arrives). Settlement/transfer
 *  exclusions from flagExcluded are reality-based and never touched. Pass the calendar built
 *  from the FULL row set when `rows` is a subset — the default only sees what it is given. */
export function applyLens(
  rows: FlaggedTxn[],
  settings: FlowSettings,
  todayIso: string,
  calendar: FlowCalendar = buildFlowCalendar(rows, settings),
): FlaggedTxn[] {
  const currentFlowMonth = calendar.monthOf(todayIso);
  const identity = settings.lens === 'charge' && settings.anchorDay === 1;
  return rows.map((r) => {
    const month = identity ? r.month : calendar.monthOfRow(r);
    if (!r.excluded && r.status === 'completed' && month > currentFlowMonth) {
      return { ...r, month, excluded: true, excludeReason: 'future' };
    }
    return month === r.month ? r : { ...r, month };
  });
}

/** N flow months back from `month` (both 'YYYY-MM'). Negative n walks forward. */
export function monthsBack(month: string, n: number): string {
  let y = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7)) - n;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}
