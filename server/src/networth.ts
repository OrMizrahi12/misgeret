/**
 * The balance-sheet layer of /api/networth: per-class daily series, monthly change
 * attribution (what you did vs. what happened to you), and gross totals for the
 * identity Sankey (assets = liabilities + equity).
 *
 * Pure — the route feeds pre-localized days; nothing here touches the clock or the DB.
 */
import type { HoldingType } from './account-state.js';
import type { DayBalance } from './balance-history.js';
import { monthsBack } from './flow.js';

/** The economic classes the history decomposes into. Sum over all keys on any day
 *  equals the net-worth series point for that day — that identity is tested.
 *  display attribution and never a layer of their own. */
export type LayerKey =
  | 'checking' | 'card' | 'deposit' | 'securities' | 'pension' | 'realEstate'
  | 'otherAsset' | 'loan' | 'otherLiability';
export const LAYER_KEYS: readonly LayerKey[] = [
  'checking', 'card', 'deposit', 'securities', 'pension', 'realEstate',
  'otherAsset', 'loan', 'otherLiability',
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Which layer a manual holding contributes to. `kind` is consulted only for 'other' —
 *  every typed holding derives its side, same as the arithmetic elsewhere (A7). Real estate
 *  and pension get layers of their own (they dominate Israeli household wealth); a vehicle,
 *  crypto, a business or valuables fold into the shared otherAsset class. */
export function holdingLayer(type: HoldingType, kind: 'asset' | 'liability'): LayerKey {
  if (type === 'loan' || type === 'mortgage') return 'loan';
  if (type === 'deposit') return 'deposit';
  if (type === 'securities') return 'securities';
  if (type === 'pension') return 'pension';
  if (type === 'realEstate') return 'realEstate';
  if (type === 'other') return kind === 'liability' ? 'otherLiability' : 'otherAsset';
  return 'otherAsset';
}

/** Step a value timeline across the daily grid, back-filling the first recorded value into every
 *  earlier day. The back-fill is a DISPLAY CONVENTION for an era we hold no record of — the
 *  holding existed, we just hadn't written it down — and NOT a claim about the past. Starting at
 *  zero instead would be further from the truth and would manufacture a cliff that reads as an
 *  event that never happened; `manualFrom` is what stops the invented era being read as history. */
export function stepTotals(days: string[], perKey: Map<string | number, { day: string; signed: number }[]>): number[] {
  const cursors = new Map<string | number, number>();
  return days.map((day) => {
    let total = 0;
    for (const [key, list] of perKey) {
      let i = cursors.get(key) ?? 0;
      while (i + 1 < list.length && list[i + 1].day <= day) i++;
      cursors.set(key, i);
      total += list[i].signed;
    }
    return total;
  });
}

/**
 * The daily series per class, aligned index-for-index with the bank series' days.
 * Values are UNROUNDED — the route sums them into the history series first (so the
 * combined curve stays bit-identical to the pre-layers arithmetic) and rounds at the JSON edge.
 */
export function buildLayerValues(
  bankSeries: DayBalance[],
  perHolding: Map<number, { day: string; signed: number }[]>,
  layerOf: Map<number, LayerKey>,
  perCard: Map<string, { day: string; signed: number }[]>,
): Record<LayerKey, number[]> {
  const days = bankSeries.map((p) => p.date);
  const byClass = new Map<LayerKey, Map<string | number, { day: string; signed: number }[]>>();
  for (const [assetId, list] of perHolding) {
    const layer = layerOf.get(assetId);
    if (!layer) continue; // a snapshot of a deleted holding — nothing to draw it under
    const m = byClass.get(layer) ?? new Map();
    m.set(assetId, list);
    byClass.set(layer, m);
  }
  const zeroes = () => days.map(() => 0);
  const classSeries = (key: LayerKey) => (byClass.has(key) ? stepTotals(days, byClass.get(key)!) : zeroes());
  return {
    checking: bankSeries.map((p) => p.balance),
    card: perCard.size > 0 ? stepTotals(days, perCard) : zeroes(),
    deposit: classSeries('deposit'),
    securities: classSeries('securities'),
    pension: classSeries('pension'),
    realEstate: classSeries('realEstate'),
    otherAsset: classSeries('otherAsset'),
    loan: classSeries('loan'),
    otherLiability: classSeries('otherLiability'),
  };
}

/**
 * One month of "where did the change come from": flows are what you did (the same
 * income/expenses the month tab shows), revaluation is the residual — what happened
 * to the holdings, PLUS any coverage gap (a blind card, a stale manual balance).
 * That residual honesty is by design and the UI caveats it (spec §4).
 */
export interface AttributionMonth {
  month: string; // flow month 'YYYY-MM'
  /** Inclusive first calendar day of the flow month (the anchor date). */
  from: string;
  /** Exclusive end — the next flow month's anchor date. */
  to: string;
  income: number;
  expenses: number;
  /** Net worth at the end of the day BEFORE `from`; null when history doesn't reach back. */
  open: number | null;
  /** Net worth at the last covered day of the month (or today, for the running month). */
  close: number | null;
  /** (close − open) − (income − expenses); null whenever a boundary is missing. */
  revaluation: number | null;
  /** The running flow month — its numbers are month-to-date, not a verdict. */
  partial: boolean;
}

/**
 * Attribution rows, oldest→newest, ending at the running flow month. Months stop where
 * the combined history can no longer provide an opening balance — a month we can't
 * bound gets no invented numbers. `startOf` is the salary-aware calendar's month start,
 * so the balance windows cut exactly where the summaries' bucketing cut.
 */
export function computeAttribution(
  history: DayBalance[],
  summaries: { month: string; income: number; expenses: number }[],
  startOf: (month: string) => string,
  currentMonth: string,
  maxMonths = 25,
): AttributionMonth[] {
  if (history.length === 0) return [];
  const byMonth = new Map(summaries.map((s) => [s.month, s]));
  /** Balance at the end of the last day strictly before `day`, or null before coverage. */
  const closeBefore = (day: string): number | null => {
    if (history[0].date >= day) return null;
    let lo = 0;
    let hi = history.length - 1;
    while (lo < hi) { // last index with date < day
      const mid = Math.ceil((lo + hi) / 2);
      if (history[mid].date < day) lo = mid; else hi = mid - 1;
    }
    return history[lo].balance;
  };

  const rows: AttributionMonth[] = [];
  for (let back = 0; back < maxMonths; back++) {
    const month = monthsBack(currentMonth, back);
    const from = startOf(month);
    const to = startOf(monthsBack(month, -1));
    const open = closeBefore(from);
    if (open === null) break; // history no longer bounds the month — stop, don't invent
    const partial = month === currentMonth;
    const close = partial ? history[history.length - 1].balance : closeBefore(to);
    const s = byMonth.get(month);
    const income = round2(s?.income ?? 0);
    const expenses = round2(s?.expenses ?? 0);
    rows.push({
      month,
      from,
      to,
      income,
      expenses,
      open: round2(open),
      close: close === null ? null : round2(close),
      revaluation: close === null ? null : round2(close - open - (income - expenses)),
      partial,
    });
  }
  return rows.reverse();
}

/** Both sides of the balance sheet as positive magnitudes. Connected-account balances are
 *  signed (an overdrafted עו"ש or a card debt joins the liabilities side); manual holdings
 *  contribute by kind. gross.assets − gross.liabilities === netWorth by construction. */
export function grossTotals(
  accountBalances: number[],
  assets: { kind: 'asset' | 'liability'; amount: number }[],
): { assets: number; liabilities: number } {
  let assetSide = 0;
  let liabilitySide = 0;
  for (const b of accountBalances) {
    if (b >= 0) assetSide += b;
    else liabilitySide += -b;
  }
  for (const a of assets) {
    if (a.kind === 'asset') assetSide += a.amount;
    else liabilitySide += a.amount;
  }
  return { assets: round2(assetSide), liabilities: round2(liabilitySide) };
}
