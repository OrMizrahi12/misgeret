import { EyeOff, History } from 'lucide-react';
import { Sparkline } from './charts';
import type { PatternNature, SpendingPattern, TxnMark } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
export type NatureColor = Record<PatternNature, string>;

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** "כל חודש" / "כל שבוע" … — the cycle, in words. */
function cycleHe(c: string): string {
  return { weekly: 'כל שבוע', biweekly: 'כל שבועיים', monthly: 'כל חודש', bimonthly: 'כל חודשיים', yearly: 'כל שנה' }[c] ?? 'חוזר';
}

/** When in the cycle it lands, in words — "ב-9 בחודש", "בימי ראשון", or just the next date. */
const DOW_FULL = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function whenHe(p: SpendingPattern): string {
  if (p.dayOfWeek != null) return `בימי ${DOW_FULL[p.dayOfWeek]}`;
  if (p.dayOfMonth != null) return `ב-${p.dayOfMonth} בחודש`;
  return '';
}
function nextHe(nextDate: string): string {
  return new Date(`${nextDate.slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
}

/** How far through the CURRENT cycle we are, 0..1 — the arc that fills toward the next charge. */
function cycleProgress(p: SpendingPattern): number {
  const last = new Date(`${p.lastDate.slice(0, 10)}T12:00:00`).getTime();
  const next = new Date(`${p.nextDate.slice(0, 10)}T12:00:00`).getTime();
  const now = Date.now();
  const span = next - last;
  if (span <= 0) return 1;
  return Math.max(0.02, Math.min(1, (now - last) / span));
}

/** The cycle, as a circle: a faint ring for the whole period, an arc that fills clockwise toward the
 *  next charge (a dot marks the charge point at 12 o'clock), and the monthly cost in the middle. A
 *  circle IS a cycle — one revolution = one period — so this reads as "recurring" at a glance. */
function CycleRing({ p, color }: { p: SpendingPattern; color: string }) {
  const SZ = 78, R = 31, C = 2 * Math.PI * R;
  const prog = cycleProgress(p);
  const big = p.monthlyAmount >= 10000;
  return (
    <svg className="cyc-ring" width={SZ} height={SZ} viewBox={`0 0 ${SZ} ${SZ}`} role="img" aria-label={`${cycleHe(p.cadence)} · ${ILS0.format(p.monthlyAmount)} לחודש`}>
      <circle className="cyc-ring-bg" cx={SZ / 2} cy={SZ / 2} r={R} />
      <circle
        className="cyc-ring-arc" cx={SZ / 2} cy={SZ / 2} r={R} stroke={color}
        strokeDasharray={`${(prog * C).toFixed(1)} ${C.toFixed(1)}`}
        transform={`rotate(-90 ${SZ / 2} ${SZ / 2})`}
      />
      <circle cx={SZ / 2} cy={SZ / 2 - R} r={3.6} fill={color} />
      <text className={big ? 'cyc-ring-num sm' : 'cyc-ring-num'} x={SZ / 2} y={SZ / 2 + 1}>{ILS0.format(p.monthlyAmount)}</text>
      <text className="cyc-ring-sub" x={SZ / 2} y={SZ / 2 + 14}>/ח׳</text>
    </svg>
  );
}

/** One recurring charge as a visual card: the cycle ring + who/what, its cadence-and-when in words,
 *  the price trend, and one-click classify. Each card is self-contained — meaningful with 3 patterns
 *  or 30, and never dominated by one big charge the way an aggregate chart is. */
export function PatternCard({ p, color, busy, onMark, onHistory }: {
  p: SpendingPattern;
  color: string;
  busy: boolean;
  onMark: (mark: TxnMark | null) => void;
  onHistory: () => void;
}) {
  const manual = p.source === 'manual';
  const isSub = p.userMarked && p.nature === 'subscription';
  const isFixed = p.userMarked && p.nature === 'fixed';
  const isHabit = p.userMarked && p.nature === 'habit';
  // The engine's guess, still waiting for confirmation — true for every ring, habits included.
  const proposed = !manual && !p.userMarked && p.active && !p.dismissed;
  // the ring being proposed is drawn as an outline, never a fill — a guess must not wear a verdict's clothes
  const guessed = (n: PatternNature) => proposed && p.nature === n;
  const markClass = (on: boolean, n: PatternNature, onClass: string) =>
    on ? `txn-mark ${onClass}` : guessed(n) ? 'txn-mark guess' : 'txn-mark';
  const med = median(p.recent);
  const last = p.recent[p.recent.length - 1] ?? 0;
  const trend = p.recent.length >= 3 && med > 0 ? (last - med) / med : 0;
  const rising = trend > 0.08, falling = trend < -0.08;

  return (
    <div className={p.active ? 'pcard' : 'pcard pcard-inactive'} style={{ ['--nat' as string]: color }}>
      <CycleRing p={p} color={color} />
      <div className="pcard-body">
        <div className="pcard-name-line">
          <span className="pcard-name" title={p.name}>{p.name}</span>
          {p.installmentPlan && <span className="pat-tag">תשלומים</span>}
          {manual && <span className="pat-tag">ידני</span>}
          {proposed && <span className="pat-tag proposed">מוצע</span>}
        </div>
        <div className="pcard-when">
          <span className="pcard-cad">{cycleHe(p.cadence)}</span>
          {whenHe(p) && <> · {whenHe(p)}</>}
          {p.active ? <> · הבא {nextHe(p.nextDate)}</> : <> · לא פעיל</>}
        </div>
        <div className="pcard-foot">
          {p.recent.length > 1 && <span className="pcard-spark"><Sparkline values={p.recent} color={color} width={54} height={16} /></span>}
          {(rising || falling) && (
            <span className={rising ? 'pcard-trend up' : 'pcard-trend down'}>
              {rising ? '▲' : '▼'} {Math.abs(Math.round(trend * 100))}%
            </span>
          )}
          {!manual && (
            <span className="pcard-actions">
              <button type="button" className="txn-mark txn-history" title="היסטוריה ודפוס" aria-label={`היסטוריה · ${p.name}`} onClick={onHistory}>
                <History size={14} strokeWidth={2} aria-hidden />
              </button>
              <button type="button" className={markClass(isSub, 'subscription', 'on-sub')} disabled={busy} aria-pressed={isSub} onClick={() => onMark(isSub ? null : 'subscription')}>מנוי</button>
              <button type="button" className={markClass(isFixed, 'fixed', 'on-fixed')} disabled={busy} aria-pressed={isFixed} onClick={() => onMark(isFixed ? null : 'fixed')}>קבוע</button>
              <button type="button" className={markClass(isHabit, 'habit', 'on-habit')} disabled={busy} aria-pressed={isHabit} onClick={() => onMark(isHabit ? null : 'habit')}>הרגל</button>
              <button
                type="button" className="txn-mark txn-dismiss" disabled={busy}
                title="הסתר — לא דפוס אמיתי" aria-label={`הסתר · ${p.name}`}
                onClick={() => onMark('dismissed')}
              >
                <EyeOff size={14} strokeWidth={2} aria-hidden />
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
