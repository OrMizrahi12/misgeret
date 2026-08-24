import type { FlaggedTxn } from './companies.js';
import { merchantKey, normalizePattern } from './categories.js';
import { flowMonthOf } from './flow.js';
import type { RecurringItem } from './recurring.js';

export interface Insight {
  type: 'price-hike' | 'new-recurring' | 'fee' | 'duplicate-charge';
  textHe: string;
  amount: number;
  /** Keys of the month's rows this observation points at, so the client can tag them in place. */
  refs: string[];
}

function dayHe(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' });
}

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Calm, factual observations for one month. Fires rarely by design — silence is a feature.
 *  `month` is a FLOW month; `monthOf` must be the same calendar that bucketed `rows`, so
 *  first-seen comparisons land in the same month as the rows themselves. */
export function monthInsights(
  month: string,
  rows: FlaggedTxn[],
  recurring: RecurringItem[],
  monthOf: (iso: string) => string = (iso) => flowMonthOf(iso, 1),
): Insight[] {
  const insights: Insight[] = [];
  const monthRows = rows.filter((r) => r.month === month && r.status === 'completed' && !r.excluded);

  // price hike: this month's charge of a stable recurring is >8% above its median
  for (const item of recurring) {
    if (item.kind !== 'expense' || !item.amountStable || item.excludedFlow) continue;
    const hit = monthRows.find((r) => merchantKey(r.description, r.memo) === item.merchant && r.amount < 0);
    if (!hit) continue;
    const jump = -hit.amount - -item.amount;
    if (jump > Math.abs(item.amount) * 0.08 && jump >= 10) {
      insights.push({
        type: 'price-hike',
        textHe: `‏${item.merchant} התייקר: ${ILS.format(-hit.amount)} החודש לעומת ${ILS.format(-item.amount)} בדרך כלל.`,
        amount: jump,
        refs: [hit.key],
      });
    }
  }

  // new recurring that first appeared this month (flow-month bucketing, like `month` itself)
  for (const item of recurring) {
    if (monthOf(item.firstDate) === month && !item.excludedFlow) {
      insights.push({
        type: 'new-recurring',
        textHe: `חיוב חדש שחוזר כל חודש: ${item.merchant} (${ILS.format(Math.abs(item.amount))} לחודש).`,
        amount: Math.abs(item.amount),
        refs: monthRows.filter((r) => merchantKey(r.description, r.memo) === item.merchant).map((r) => r.key),
      });
    }
  }

  // Do not emit a generic "הוצאה חריגה" for an expense ≥3× its category's usual size. The rule fires
  // correctly and still said nothing true: a category is a bag of unrelated amounts, so a single
  // fuel fill-up read as "פי 6.4 מהרגיל" beside a hundred small ones. A comparison whose base is
  // not a comparable thing is not a warning, it is noise — and the register earns its calm by
  // staying silent. Nothing else derived from it, so the category-median scaffolding went too.

  // possible double charge: same merchant, same exact amount (≥ 100 ₪), within 48 hours.
  // The classic double-swipe / merchant error — worth real money to catch.
  const byMerchantAmount = new Map<string, FlaggedTxn[]>();
  for (const r of monthRows) {
    if (r.amount > -100 || r.type === 'installments') continue;
    const k = `${normalizePattern(r.description)}|${r.amount}`;
    const g = byMerchantAmount.get(k) ?? [];
    g.push(r);
    byMerchantAmount.set(k, g);
  }
  for (const g of byMerchantAmount.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i++) {
      const gapHours = (new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / 3_600_000;
      if (gapHours <= 48) {
        insights.push({
          type: 'duplicate-charge',
          textHe: `חיוב כפול אפשרי: ${sorted[i].description} — ${ILS.format(-sorted[i].amount)} פעמיים בתוך יומיים (${dayHe(sorted[i - 1].date)} ו-${dayHe(sorted[i].date)}). שווה בדיקה מול בית העסק.`,
          amount: -sorted[i].amount,
          refs: [sorted[i - 1].key, sorted[i].key],
        });
        break; // one alert per merchant+amount group is enough
      }
    }
  }

  // fees are always worth naming
  const fees = monthRows.filter((r) => r.category === 'fees' && r.amount < 0);
  const feesTotal = fees.reduce((s, r) => s + -r.amount, 0);
  if (feesTotal > 0) {
    insights.push({
      type: 'fee',
      textHe: `עמלות וריביות החודש: ${ILS.format(feesTotal)} (${fees.length === 1 ? 'חיוב אחד' : `${fees.length} חיובים`}).`,
      amount: feesTotal,
      refs: fees.map((r) => r.key),
    });
  }

  return insights.sort((a, b) => b.amount - a.amount).slice(0, 6);
}

/** Top merchants of a month by spend (expenses only, excluded rows skipped).
 *  refs carry the merchant's row keys — the client marks them instead of listing merchants apart. */
export function topMerchants(month: string, rows: FlaggedTxn[], limit = 8): { merchant: string; total: number; count: number; refs: string[] }[] {
  const byMerchant = new Map<string, { total: number; count: number; refs: string[] }>();
  for (const r of rows) {
    if (r.month !== month || r.status !== 'completed' || r.excluded || r.amount >= 0) continue;
    const m = normalizePattern(r.description) || r.description;
    const g = byMerchant.get(m) ?? { total: 0, count: 0, refs: [] };
    g.total += -r.amount;
    g.count += 1;
    g.refs.push(r.key);
    byMerchant.set(m, g);
  }
  return [...byMerchant.entries()]
    .map(([merchant, g]) => ({ merchant, total: Math.round(g.total * 100) / 100, count: g.count, refs: g.refs }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
