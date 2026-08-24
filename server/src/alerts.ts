/**
 * נוכחות שקטה — the three interruptions worth making.
 *
 * The app's philosophy is that silence is a feature; a Windows notification is the loudest
 * thing it can do. So exactly three events qualify — a suspected double charge (worth real
 * money, worth it TODAY), a price hike on a tracked commitment, and a forecast that dips
 * below the overdraft frame. Everything else waits for the user to open the app.
 *
 * Every alert carries a stable key; the caller persists notified keys so nothing ever
 * fires twice. Keys are built from transaction keys / crossing months — not from wording —
 * so a rephrased insight is still the same fact.
 */

import type { Insight } from './insights.js';

export interface PendingAlert {
  key: string;
  type: 'duplicate-charge' | 'price-hike' | 'forecast-floor';
  titleHe: string;
  bodyHe: string;
  /** Where a click should land the user. */
  target: 'month' | 'future';
}

const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

function dayHe(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
}

/** The two insight types loud enough to interrupt for, keyed by the rows they point at. */
export function alertsFromInsights(insights: Insight[]): PendingAlert[] {
  const out: PendingAlert[] = [];
  for (const insight of insights) {
    if (insight.refs.length === 0) continue;
    if (insight.type === 'duplicate-charge') {
      out.push({
        key: `dup|${[...insight.refs].sort().join('|')}`,
        type: 'duplicate-charge',
        titleHe: 'חיוב כפול אפשרי',
        bodyHe: insight.textHe,
        target: 'month',
      });
    } else if (insight.type === 'price-hike') {
      out.push({
        key: `hike|${insight.refs[0]}`,
        type: 'price-hike',
        titleHe: 'חיוב שהתייקר',
        bodyHe: insight.textHe,
        target: 'month',
      });
    }
  }
  return out;
}

/**
 * The forecast crossing the overdraft frame (or zero, when no frame is set). Keyed by the
 * CROSSING MONTH: the exact date shifts a little every day the forecast recalculates, and
 * re-nagging daily about the same dip is exactly the noise this feature exists to avoid.
 */
export function forecastFloorAlert(
  path: { date: string; balance: number }[],
  overdraftLimit: number,
  today: string,
): PendingAlert | null {
  const floor = -Math.max(0, overdraftLimit);
  const dip = path.find((p) => p.date > today && p.balance < floor);
  if (!dip) return null;
  return {
    key: `floor|${dip.date.slice(0, 7)}`,
    type: 'forecast-floor',
    titleHe: 'התחזית דורשת מבט',
    bodyHe: overdraftLimit > 0
      ? `לפי הקצב הנוכחי, סביב ${dayHe(dip.date)} היתרה צפויה לרדת מתחת למסגרת האשראי (${ILS.format(floor)}).`
      : `לפי הקצב הנוכחי, סביב ${dayHe(dip.date)} היתרה צפויה לרדת מתחת לאפס.`,
    target: 'future',
  };
}
