import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { CategoryExpense, DayBalance, MonthlySummary } from './types';
import { categoryNameHe } from './types';

/* ——— shared formatting ——— */

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/* the balance-sheet charts can speak any primary currency; everyone else stays shekels */
const CCY_FMTS = new Map<string, Intl.NumberFormat>([['ILS', ILS0]]);
function moneyFmt(currency = 'ILS'): Intl.NumberFormat {
  let f = CCY_FMTS.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 0 });
    CCY_FMTS.set(currency, f);
  }
  return f;
}

/** Compact axis money: 12,400 → ‎12.4K‎, kept LTR-safe for SVG plots. */
export function shortILS(v: number): string {
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}${trim1(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trim1(abs / 1_000)}K`;
  return `${sign}${Math.round(abs)}`;
}
function trim1(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function shortMonthHe(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'short' });
}

function fullMonthHe(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

function dayLabelHe(date: string, withYear = false): string {
  return new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString(
    'he-IL',
    withYear ? { day: '2-digit', month: '2-digit', year: '2-digit' } : { day: '2-digit', month: '2-digit' },
  );
}

/** Round gridline steps to friendly numbers so axis labels read cleanly. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const rawStep = span / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? rawStep;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);
  return ticks;
}

/* ——— tooltip plumbing: SVG plots LTR, tooltip content stays RTL Hebrew ——— */

function Tip({ xPct, yPct, children }: { xPct: number; yPct: number; children: React.ReactNode }) {
  return (
    <div className="chart-tip" style={{ left: `${xPct}%`, top: `calc(${yPct}% - 10px)` }}>
      {children}
    </div>
  );
}

/* ——— monthly income/expense bars ——— */

const BAR_COLORS = { income: 'var(--positive)', expense: 'var(--chart-expense)' };

/** Paired income/expense bars per month with gridlines, hover tooltip and click-to-select.
 *  Plot direction stays LTR (time flows left→right); labels are Hebrew. */
export function MonthlyBars({
  summary,
  selected,
  onSelect,
}: {
  summary: MonthlySummary[]; // newest first, as the API returns
  selected: string;
  onSelect: (month: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const months = [...summary].reverse(); // oldest → newest, left → right
  const W = 720;
  const H = 236;
  const PAD_L = 10;
  const PAD_R = 44; // room for ₪ labels on the right
  const PAD_T = 12;
  const PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const max = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses]));
  const ticks = niceTicks(0, max, 3).filter((t) => t > 0);
  const yMax = Math.max(max, ticks.at(-1) ?? 0);
  const y = (v: number) => PAD_T + (1 - v / yMax) * plotH;
  const groupW = plotW / months.length;
  const barW = Math.min(16, groupW * 0.28);

  return (
    <div>
      <div className="chart-legend">
        <span className="legend-item"><span className="legend-dot" style={{ background: BAR_COLORS.income }} /> הכנסות</span>
        <span className="legend-item"><span className="legend-dot" style={{ background: BAR_COLORS.expense }} /> הוצאות</span>
      </div>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="הכנסות מול הוצאות לפי חודש">
          {ticks.map((t) => (
            <g key={t}>
              <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
              <text className="chart-axis-label" x={W - PAD_R + 6} y={y(t) + 3.5}>{shortILS(t)}</text>
            </g>
          ))}
          <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} style={{ strokeOpacity: 0.5 }} />
          {months.map((m, i) => {
            const cx = PAD_L + i * groupW + groupW / 2;
            const dim = hover !== null && hover !== i;
            return (
              <g key={m.month} style={{ opacity: dim ? 0.45 : 1, transition: 'opacity 150ms ease' }}>
                <rect x={cx - barW - 1.5} y={y(m.income)} width={barW} height={y(0) - y(m.income)} rx={3} fill={BAR_COLORS.income} />
                <rect x={cx + 1.5} y={y(m.expenses)} width={barW} height={y(0) - y(m.expenses)} rx={3} fill={BAR_COLORS.expense} />
                <text
                  className={m.month === selected ? 'chart-axis-label selected' : 'chart-axis-label'}
                  x={cx}
                  y={H - 7}
                  textAnchor="middle"
                >
                  {shortMonthHe(m.month)}
                </text>
                <rect
                  className="bar-hit"
                  x={PAD_L + i * groupW}
                  y={0}
                  width={groupW}
                  height={H}
                  onMouseEnter={() => setHover(i)}
                  onClick={() => onSelect(m.month)}
                />
              </g>
            );
          })}
        </svg>
        {hover !== null && months[hover] && (
          <Tip xPct={((PAD_L + hover * groupW + groupW / 2) / W) * 100} yPct={8}>
            <div className="tip-title">{fullMonthHe(months[hover].month)}</div>
            <div className="tip-row"><span>הכנסות</span><span className="amount">{ILS0.format(months[hover].income)}</span></div>
            <div className="tip-row"><span>הוצאות</span><span className="amount">{ILS0.format(months[hover].expenses)}</span></div>
            <div className="tip-row"><span>נטו</span><span className="amount">{ILS0.format(months[hover].net)}</span></div>
          </Tip>
        )}
      </div>
      <p className="chart-caption">ריחוף מציג את המספרים המדויקים · לחיצה על חודש בוחרת אותו למעלה</p>
    </div>
  );
}

/* ——— monthly NET bars (cash-flow surplus/deficit history) ——— */

/** Surplus/deficit per month around a zero axis — the canonical cash-flow history view.
 *  Green above the line, red below; the newest (running) month renders hollow. */
export function NetBars({
  summary,
  currentMonth,
  onSelect,
  average,
  projected = false,
}: {
  summary: MonthlySummary[]; // newest first, as the API returns
  currentMonth?: string; // the still-running flow month — drawn hollow, "בתהליך"
  onSelect?: (month: string) => void;
  /** A dashed personal-average line — the baseline every bar is silently measured against. */
  average?: number;
  /** Every month here is a PROJECTION — all bars draw hollow-dashed, the "not yet real" idiom. */
  projected?: boolean;
}) {
  const uid = useId();
  const [hover, setHover] = useState<number | null>(null);
  const months = [...summary].reverse(); // oldest → newest
  if (months.length === 0) return null;
  const W = 720;
  const H = projected ? 210 : 180;
  const PAD_L = 10;
  const PAD_R = 44;
  const PAD_T = projected ? 32 : 14;
  const PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const groupW = plotW / months.length;
  const barW = Math.min(26, groupW * 0.55);
  // 24 bars cannot all carry labels — thin them out, always keeping the newest
  const labelEvery = Math.ceil(months.length / 12);
  const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + shortILS(Math.abs(v));

  if (projected) {
    // A forecast, not history — so it reads full and confident, never a field of hollow boxes.
    // The y-domain HUGS the data (never the wasted symmetric ±max) but always keeps zero visible,
    // so all-positive months fill from a bottom baseline; a deficit month dips red below zero.
    const nets = months.map((m) => m.net);
    const top = (Math.max(0, ...nets) * 1.16) || 1;
    const bot = Math.min(0, ...nets) * 1.16;
    const span = Math.max(1, top - bot);
    const y = (v: number) => PAD_T + ((top - v) / span) * plotH;
    const yBase = y(0);
    // rounds the tip (the end away from the baseline), leaving the baseline edge flat
    const bar = (x: number, w: number, yb: number, yt: number, r: number) => {
      const rr = Math.min(r, w / 2, Math.max(0.01, Math.abs(yt - yb)));
      return yt <= yb
        ? `M${x} ${yb} L${x} ${yt + rr} Q${x} ${yt} ${x + rr} ${yt} L${x + w - rr} ${yt} Q${x + w} ${yt} ${x + w} ${yt + rr} L${x + w} ${yb} Z`
        : `M${x} ${yb} L${x} ${yt - rr} Q${x} ${yt} ${x + rr} ${yt} L${x + w - rr} ${yt} Q${x + w} ${yt} ${x + w} ${yt - rr} L${x + w} ${yb} Z`;
    };
    const tops = months.map((m, i) => [PAD_L + i * groupW + groupW / 2, y(m.net)] as const);
    const trendD = `M${tops.map(([x, yy]) => `${x} ${yy}`).join(' L')}`;
    return (
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="הנטו החזוי לכל חודש בשנה הקרובה">
          <defs>
            <linearGradient id={`${uid}-pos`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--positive)' }} />
              <stop offset="1" style={{ stopColor: 'var(--positive-deep)' }} />
            </linearGradient>
            <linearGradient id={`${uid}-neg`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--negative)' }} />
              <stop offset="1" style={{ stopColor: 'var(--negative-deep)' }} />
            </linearGradient>
            <pattern id={`${uid}-hatch`} width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--surface)" strokeWidth="2.2" strokeOpacity="0.5" />
            </pattern>
          </defs>
          {/* only the zero waterline — each bar carries its own number, so axis ticks are noise */}
          <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={yBase} y2={yBase} style={{ strokeOpacity: 0.6 }} />
          <text className="chart-axis-label" x={W - PAD_R + 6} y={yBase + 3.5}>0</text>
          <path d={trendD} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeOpacity={0.28} strokeDasharray="1 5" strokeLinecap="round" />
          {months.map((m, i) => {
            const cx = PAD_L + i * groupW + groupW / 2;
            const pos = m.net >= 0;
            const yt = y(m.net);
            const x = cx - barW / 2;
            const dim = hover !== null && hover !== i;
            const grad = pos ? `${uid}-pos` : `${uid}-neg`;
            return (
              <g key={m.month} style={{ opacity: dim ? 0.5 : 1, transition: 'opacity 150ms ease' }}>
                <path d={bar(x, barW, yBase, yt, 6)} fill={`url(#${grad})`} fillOpacity={0.92} />
                <path d={bar(x, barW, yBase, yt, 6)} fill={`url(#${uid}-hatch)`} />
                <text className="netbar-value" x={cx} y={pos ? yt - 8 : yt + 15} textAnchor="middle" style={{ fill: pos ? 'var(--positive-deep)' : 'var(--negative-deep)' }}>{signed(m.net)}</text>
                {(i % labelEvery === 0 || i === months.length - 1) && (
                  <text className="chart-axis-label" x={cx} y={H - 7} textAnchor="middle">{shortMonthHe(m.month)}</text>
                )}
                <rect className="bar-hit" x={PAD_L + i * groupW} y={0} width={groupW} height={H} onMouseEnter={() => setHover(i)} />
              </g>
            );
          })}
          {/* an honest, elegant "this is a projection" badge — the texture, not emptiness, carries it */}
          <g>
            <rect className="netbar-chip-bg" x={PAD_L} y={PAD_T - 26} width="52" height="19" rx="9.5" />
            <text className="netbar-chip" x={PAD_L + 26} y={PAD_T - 13} textAnchor="middle">תחזית</text>
          </g>
        </svg>
        {hover !== null && months[hover] && (
          <Tip xPct={((PAD_L + hover * groupW + groupW / 2) / W) * 100} yPct={6}>
            <div className="tip-title">{fullMonthHe(months[hover].month)} · תחזית</div>
            <div className="tip-row">
              <span>נטו חזוי</span>
              <span className="amount" style={{ color: months[hover].net >= 0 ? 'var(--positive)' : 'var(--negative)' }}>{ILS0.format(months[hover].net)}</span>
            </div>
          </Tip>
        )}
      </div>
    );
  }

  const maxAbs = Math.max(1, ...months.map((m) => Math.abs(m.net)), Math.abs(average ?? 0));
  const y = (v: number) => PAD_T + ((maxAbs - v) / (2 * maxAbs)) * plotH;

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="עודף או גירעון תזרימי לפי חודש">
        {[maxAbs, 0, -maxAbs].map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} style={t === 0 ? { strokeOpacity: 0.55 } : undefined} />
            <text className="chart-axis-label" x={W - PAD_R + 6} y={y(t) + 3.5}>{shortILS(t)}</text>
          </g>
        ))}
        {average !== undefined && (
          <g>
            <line
              x1={PAD_L} x2={W - PAD_R} y1={y(average)} y2={y(average)}
              stroke="var(--accent)" strokeWidth={1.2} strokeDasharray="5 4" opacity={0.75}
            />
            <text className="chart-axis-label" x={PAD_L + 2} y={y(average) - 4} style={{ fill: 'var(--accent)' }}>
              ממוצע {shortILS(average)}
            </text>
          </g>
        )}
        {months.map((m, i) => {
          const cx = PAD_L + i * groupW + groupW / 2;
          const running = projected || m.month === currentMonth;
          const positive = m.net >= 0;
          const barTop = positive ? y(m.net) : y(0);
          const barH = Math.max(1.5, Math.abs(y(m.net) - y(0)));
          const color = positive ? 'var(--positive)' : 'var(--cat-red)';
          const dim = hover !== null && hover !== i;
          return (
            <g key={m.month} style={{ opacity: dim ? 0.45 : 1, transition: 'opacity 150ms ease' }}>
              <rect
                x={cx - barW / 2} y={barTop} width={barW} height={barH} rx={3}
                fill={running ? 'none' : color}
                stroke={running ? color : 'none'}
                strokeWidth={running ? 1.5 : 0}
                strokeDasharray={running ? '4 3' : undefined}
              />
              {(i % labelEvery === 0 || i === months.length - 1) && (
                <text className="chart-axis-label" x={cx} y={H - 7} textAnchor="middle">{shortMonthHe(m.month)}</text>
              )}
              <rect
                className="bar-hit" x={PAD_L + i * groupW} y={0} width={groupW} height={H}
                style={onSelect ? { cursor: 'pointer' } : undefined}
                onMouseEnter={() => setHover(i)}
                onClick={() => onSelect?.(m.month)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && months[hover] && (
        <Tip xPct={((PAD_L + hover * groupW + groupW / 2) / W) * 100} yPct={6}>
          <div className="tip-title">{fullMonthHe(months[hover].month)}{projected ? ' · תחזית' : months[hover].month === currentMonth ? ' · בתהליך' : ''}</div>
          <div className="tip-row"><span>הכנסות</span><span className="amount">{ILS0.format(months[hover].income)}</span></div>
          <div className="tip-row"><span>הוצאות</span><span className="amount">{ILS0.format(months[hover].expenses)}</span></div>
          <div className="tip-row"><span>נטו</span><span className="amount">{ILS0.format(months[hover].net)}</span></div>
        </Tip>
      )}
    </div>
  );
}

/* ——— generic line/area chart (forecast, balance history) ——— */

export function LineAreaChart({
  series,
  height = 190,
  markers = [],
  ariaLabel,
  plain = false,
  dangerLevel,
  splitIndex,
  mutedBeforeIndex,
  mutedBeforeLabel,
  eventsByDate,
  band,
  overlay,
  overlayLabel,
  endValue,
  endLabel,
  levels = false,
  hug = false,
}: {
  series: DayBalance[];
  height?: number;
  markers?: { date: string; danger?: boolean }[];
  ariaLabel: string;
  /** Stock-chart mode: line only (no area fill), y-domain hugs the data instead of anchoring at 0. */
  plain?: boolean;
  /** A horizontal red line (e.g. minus the credit limit) — always kept inside the y-domain. */
  dangerLevel?: number;
  /** series[0..splitIndex] is OBSERVED history; what follows is projection, drawn dashed behind
   *  a "היום" divider. The y-domain hugs the data so real movement stays legible. */
  splitIndex?: number;
  /** The mirror image of splitIndex: series[0..mutedBeforeIndex] PRECEDES the data, rather than
   *  following it. The manual balances are back-filled from their first recorded value, so that era
   *  is a display convention and not history — it is drawn muted so the chart stops presenting an
   *  invented flat era as something that was observed (A5). */
  mutedBeforeIndex?: number;
  /** The boundary's own caption. Required with `mutedBeforeIndex` — an unlabelled divider is a riddle. */
  mutedBeforeLabel?: string;
  /** What moves on each date — hovering a day lists its flows in the tooltip. */
  eventsByDate?: Record<string, { merchant: string; amount: number }[]>;
  /** Pessimistic/optimistic envelope around the projection: low/high are aligned with
   *  series[startIndex..]; drawn as a translucent fan behind the expected line. */
  band?: { startIndex: number; low: number[]; high: number[] };
  /** A second path (a what-if scenario) matched to the main series BY DATE — drawn as an
   *  amber dashed line on top; dates outside the series are skipped. */
  overlay?: DayBalance[];
  overlayLabel?: string;
  /** The hero endpoint: the projected value, drawn as a labelled dot where the line lands. */
  endValue?: string;
  /** A small caption above the endpoint value (e.g. the horizon). */
  endLabel?: string;
  /** Draw a few more round-number horizontal "levels" — the leveled forecast reading. */
  levels?: boolean;
  /** Zoom the y-domain to the data range (stock-chart style) instead of anchoring at 0 —
   *  so small moves on a large balance are visible, not squashed into a flat line. */
  hug?: boolean;
}) {
  const gradId = useId().replace(/:/g, '');
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (series.length < 2) return null;

  const W = 720;
  const H = height;
  const PAD_L = 10;
  const PAD_R = 48;
  const PAD_T = 12;
  const PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const values = series.map((p) => p.balance);
  // the envelope AND the scenario overlay participate in the domain — clipped lines read as bugs
  const domainValues = [
    ...values,
    ...(band ? [...band.low, ...band.high] : []),
    ...(overlay?.map((p) => p.balance) ?? []),
  ];
  const rawMin = Math.min(...domainValues);
  const rawMax = Math.max(...domainValues);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;
  // domain by additive padding only — multiplying signed values inverts min/max the moment
  // the whole series is negative (an overdrafted account rendered a blank chart).
  // Hugging (stock-chart) domain: a balance living around 33K anchored at 0 squashes all
  // real movement into a sliver at the top — a forecast that looks like a flat line with glitches.
  const zoom = plain || splitIndex !== undefined || hug;
  let min = zoom ? rawMin - span * 0.06 : rawMin >= 0 ? 0 : rawMin - span * 0.05;
  const max = zoom ? rawMax + span * 0.06 : Math.max(rawMax, 0) + span * 0.05;
  // the red line joins the domain only when the path actually approaches it — a distant
  // credit limit must not squash the whole plot into an unreadable sliver
  if (dangerLevel !== undefined && dangerLevel < min && rawMin - dangerLevel <= span * 1.5) {
    min = dangerLevel - span * 0.04;
  }
  const x = (i: number) => PAD_L + (i / (series.length - 1)) * plotW;
  const y = (v: number) => PAD_T + ((max - v) / (max - min || 1)) * plotH;
  const ticks = niceTicks(min, max, levels ? 4 : 3);
  // a 50-year horizon holds ~18k daily points — far more than a 720px-wide plot can show. Decimate
  // the DRAWN polyline (never the data: indexing, hover and markers still use the full series, and x()
  // stays index-linear so the time axis is honest) to keep the SVG light and the line smooth.
  const drawStep = Math.max(1, Math.ceil(series.length / 600));
  const pts = (from: number, to: number) => {
    const out: string[] = [];
    let i = from;
    for (; i <= to; i += drawStep) out.push(`${x(i)},${y(series[i].balance)}`);
    if (i - drawStep !== to) out.push(`${x(to)},${y(series[to].balance)}`);
    return out.join(' ');
  };
  const points = pts(0, series.length - 1);
  // clamped, so a boundary at (or past) the last point mutes the whole line instead of vanishing:
  // "every manual balance was recorded today" means the entire manual era really is reconstructed.
  const muteTo = mutedBeforeIndex === undefined ? -1 : Math.min(mutedBeforeIndex, series.length - 1);
  const areaFloor = y(Math.max(min, 0)) > H - PAD_B ? H - PAD_B : y(Math.max(min, 0));
  const area = `${PAD_L},${areaFloor} ${points} ${x(series.length - 1)},${areaFloor}`;
  const zeroVisible = min < 0 && max > 0;
  const xLabelIdx = splitIndex !== undefined && splitIndex > 0 && splitIndex < series.length - 1
    ? [0, splitIndex, series.length - 1]
    : [0, Math.round((series.length - 1) / 2), series.length - 1];
  // over ~10 months, day.month labels are ambiguous (01.08 reads later than 14.07) — add the year
  const withYear = (Date.parse(series[series.length - 1].date) - Date.parse(series[0].date)) / 86_400_000 > 300;

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((vx - PAD_L) / plotW) * (series.length - 1));
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg ref={svgRef} className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseMove={onMove}>
        <defs>
          <linearGradient id={`area-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--chart-flow-a)' }} stopOpacity="0.32" />
            <stop offset="100%" style={{ stopColor: 'var(--chart-flow-a)' }} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`line-${gradId}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--chart-flow-a)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--chart-flow-b)' }} />
          </linearGradient>
          {/* the uncertainty fan deepens as it widens — faint near today, more present far out */}
          <linearGradient id={`band-${gradId}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: 'var(--chart-flow-a)' }} stopOpacity="0.05" />
            <stop offset="100%" style={{ stopColor: 'var(--chart-flow-a)' }} stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
            <text className="chart-axis-label" x={W - PAD_R + 6} y={y(t) + 3.5}>{shortILS(t)}</text>
          </g>
        ))}
        {zeroVisible && <line className="chart-zero" x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} />}
        {dangerLevel !== undefined && dangerLevel >= min && dangerLevel <= max && (
          <g>
            <line className="chart-danger" x1={PAD_L} x2={W - PAD_R} y1={y(dangerLevel)} y2={y(dangerLevel)} />
            <text className="chart-axis-label chart-danger-label" x={PAD_L} y={y(dangerLevel) - 5}>
              קצה המסגרת {shortILS(dangerLevel)}
            </text>
          </g>
        )}
        {!plain && <polygon points={area} fill={`url(#area-${gradId})`} />}
        {band && band.low.length >= 2 && (() => {
          // the uncertainty fan: high edge forward, low edge back — one closed shape, decimated
          const edge = (arr: number[]) => {
            const out: string[] = [];
            let i = 0;
            for (; i < arr.length; i += drawStep) out.push(`${x(band.startIndex + i)},${y(arr[i])}`);
            if (i - drawStep !== arr.length - 1) out.push(`${x(band.startIndex + arr.length - 1)},${y(arr[arr.length - 1])}`);
            return out;
          };
          const upper = edge(band.high);
          const lower = edge(band.low).reverse();
          return <polygon points={[...upper, ...lower].join(' ')} fill={`url(#band-${gradId})`} />;
        })()}
        {muteTo > 0 ? (
          <g>
            {/* the invented era — dashed and dimmed; what was actually recorded — solid */}
            <polyline points={pts(0, muteTo)} fill="none" stroke={`url(#line-${gradId})`} strokeWidth={2} strokeDasharray="4 4" opacity={0.4} strokeLinejoin="round" strokeLinecap="round" />
            {muteTo < series.length - 1 && (
              <polyline points={pts(muteTo, series.length - 1)} fill="none" stroke={`url(#line-${gradId})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            )}
            <line className="chart-grid" x1={x(muteTo)} x2={x(muteTo)} y1={PAD_T} y2={H - PAD_B} style={{ strokeOpacity: 0.7 }} />
            {mutedBeforeLabel && (
              // Pinned top-LEFT (the dashed era it names is the left part) — never at the boundary,
              // which can sit under the right-edge endpoint label when reconstruction runs late.
              <text className="chart-axis-label" x={PAD_L + 4} y={PAD_T + 14} textAnchor="start">
                {mutedBeforeLabel}
              </text>
            )}
          </g>
        ) : splitIndex === undefined || splitIndex <= 0 || splitIndex >= series.length - 1 ? (
          <polyline points={points} fill="none" stroke={`url(#line-${gradId})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ) : (
          <g>
            {/* what actually happened — solid; what we project — dashed, same rhythm continuing */}
            <polyline points={pts(0, splitIndex)} fill="none" stroke={`url(#line-${gradId})`} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <polyline points={pts(splitIndex, series.length - 1)} fill="none" stroke={`url(#line-${gradId})`} strokeWidth={2} strokeDasharray="6 5" opacity={0.85} strokeLinejoin="round" strokeLinecap="round" />
            <line className="chart-grid" x1={x(splitIndex)} x2={x(splitIndex)} y1={PAD_T} y2={H - PAD_B} style={{ strokeOpacity: 0.7 }} />
            <text className="chart-axis-label" x={x(splitIndex)} y={PAD_T + 2} textAnchor="middle">היום</text>
          </g>
        )}
        {overlay && overlay.length >= 2 && (() => {
          const idxByDate = new Map(series.map((p, i) => [p.date, i]));
          const pts2 = overlay
            .filter((p) => idxByDate.has(p.date))
            .map((p) => `${x(idxByDate.get(p.date)!)},${y(p.balance)}`);
          if (pts2.length < 2) return null;
          const lastIdx = idxByDate.get(overlay[overlay.length - 1].date);
          return (
            <g>
              <polyline points={pts2.join(' ')} fill="none" stroke="var(--accent-2)" strokeWidth={2} strokeDasharray="3 4" strokeLinejoin="round" strokeLinecap="round" />
              {overlayLabel && lastIdx !== undefined && (
                <text className="chart-axis-label" x={x(lastIdx)} y={y(overlay[overlay.length - 1].balance) - 8} textAnchor="end" style={{ fill: 'var(--accent-2)' }}>
                  {overlayLabel}
                </text>
              )}
            </g>
          );
        })()}
        {markers.map((m, mi) => {
          const i = series.findIndex((p) => p.date === m.date);
          if (i < 0) return null;
          // two events can land on the same day — the date alone is not a unique key
          return (
            <g key={`${m.date}|${mi}`}>
              {m.danger && <circle className="chart-marker-pulse" cx={x(i)} cy={y(series[i].balance)} r={6} />}
              <circle className={m.danger ? 'chart-marker danger' : 'chart-marker'} cx={x(i)} cy={y(series[i].balance)} r={4} />
            </g>
          );
        })}
        {plain && (() => {
          // a one-day spike among months of data is a hairline — pin the high and the low
          // with explicit labels so they can never be missed (52-week-high style)
          const maxI = values.indexOf(rawMax);
          const minI = values.indexOf(rawMin);
          const anchor = (i: number) => (x(i) > W - PAD_R - 96 ? 'end' : x(i) < PAD_L + 96 ? 'start' : 'middle');
          return (
            <g>
              <circle className="chart-marker" cx={x(maxI)} cy={y(rawMax)} r={3.5} />
              <text className="chart-axis-label" x={x(maxI)} y={y(rawMax) - 8} textAnchor={anchor(maxI)}>
                שיא {ILS0.format(rawMax)} · {dayLabelHe(series[maxI].date, withYear)}
              </text>
              <circle className="chart-marker" cx={x(minI)} cy={y(rawMin)} r={3.5} />
              <text className="chart-axis-label" x={x(minI)} y={y(rawMin) + 15} textAnchor={anchor(minI)}>
                שפל {ILS0.format(rawMin)} · {dayLabelHe(series[minI].date, withYear)}
              </text>
            </g>
          );
        })()}
        {endValue && (() => {
          // the hero endpoint: where the projection lands, labelled so the eye rests on the target
          const li = series.length - 1;
          const ex = x(li), ey = y(series[li].balance);
          const below = ey < H - PAD_B - 40;
          const labY = below ? ey + 14 : ey - 24;
          const valY = below ? ey + 32 : ey - 6;
          return (
            <g>
              <circle cx={ex} cy={ey} r={8} fill="var(--chart-flow-a)" opacity={0.16} />
              <circle cx={ex} cy={ey} r={4.5} fill="var(--chart-flow-a)" stroke="var(--canvas)" strokeWidth={2} />
              {endLabel && <text className="chart-end-label" x={ex - 11} y={labY} textAnchor="end">{endLabel}</text>}
              <text className="chart-end-value" x={ex - 11} y={valY} textAnchor="end">{endValue}</text>
            </g>
          );
        })()}
        {hover !== null && (
          <g>
            <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} />
            <circle className="chart-hover-dot" cx={x(hover)} cy={y(series[hover].balance)} r={4.5} />
          </g>
        )}
        {xLabelIdx.map((i, k) => (
          <text
            key={i}
            className="chart-axis-label"
            x={x(i)}
            y={H - 6}
            textAnchor={k === 0 ? 'start' : k === xLabelIdx.length - 1 ? 'end' : 'middle'}
          >
            {dayLabelHe(series[i].date, withYear)}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <Tip xPct={(x(hover) / W) * 100} yPct={(y(series[hover].balance) / H) * 100}>
          <div className="tip-title">{dayLabelHe(series[hover].date, withYear)}</div>
          <div className="tip-row"><span>יתרה</span><span className="amount">{ILS0.format(series[hover].balance)}</span></div>
          {band && hover > band.startIndex && band.low[hover - band.startIndex] !== undefined && (
            <div className="tip-row">
              <span>טווח</span>
              <span className="amount muted">
                {shortILS(band.low[hover - band.startIndex])}–{shortILS(band.high[hover - band.startIndex])}
              </span>
            </div>
          )}
          {(eventsByDate?.[series[hover].date] ?? []).slice(0, 4).map((e, i) => (
            <div className="tip-row" key={i}>
              <span>{e.merchant}</span>
              <span className="amount" style={{ color: e.amount >= 0 ? 'var(--positive)' : undefined }}>{ILS0.format(e.amount)}</span>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

/* ——— category donut with legend ——— */

/* Same categories, same hues — the ink now comes from tokens.css so each theme
   keeps the charts legible. Dark theme values are the original colors, verbatim. */
const CATEGORY_COLORS: Record<string, string> = {
  groceries: 'var(--cat-mint)',
  restaurants: 'var(--cat-orange)',
  transport: 'var(--cat-blue)',
  housing: 'var(--cat-violet)',
  bills: 'var(--cat-yellow)',
  health: 'var(--cat-pink)',
  shopping: 'var(--cat-magenta)',
  leisure: 'var(--cat-teal)',
  education: 'var(--cat-lime)',
  insurance: 'var(--cat-amber)',
  transfers: 'var(--cat-gray)',
  fees: 'var(--cat-red)',
  income: 'var(--cat-green)',
  other: 'var(--cat-fallback)',
  uncategorized: 'var(--cat-slate)',
  rollup: 'var(--cat-slate)',
};

export function categoryColor(id: string): string {
  return CATEGORY_COLORS[id] ?? 'var(--cat-fallback)';
}

/* ——— sankey: money flowing from a source into its destinations ——— */

export interface SankeyFlow {
  id: string; // category id, 'savings', or any destination key
  label: string;
  value: number;
  color: string;
  /** Full-sentence hover for the ribbon. */
  title?: string;
  /** A small chip under the value (bigValues mode): e.g. the delta vs a baseline. */
  sub?: { text: string; tone?: 'good' | 'bad' };
}

/** Push a column of stacked label Ys apart so none overprints its neighbour — each stays as
 *  close to its ideal as the [minY, maxY] band allows. Top-down enforces the gap, then a
 *  bottom-up pass pulls the tail back in when the cascade overshoots the floor. */
function spreadLabels(ideal: number[], gap: number, minY: number, maxY: number): number[] {
  const y = ideal.map((v) => Math.max(minY, Math.min(maxY, v)));
  for (let i = 1; i < y.length; i++) if (y[i] - y[i - 1] < gap) y[i] = y[i - 1] + gap;
  for (let i = y.length - 1; i >= 0; i--) {
    if (y[i] > maxY) y[i] = maxY;
    if (i > 0 && y[i] - y[i - 1] < gap) y[i - 1] = y[i] - gap;
  }
  return y;
}

/** Hero-ribbon gradient stops: every flow pours out of the green income trunk (left) and takes on
 *  its own colour at its destination (right) — so "spent" reddens through a warm midtone as it
 *  leaves, while "kept" stays green, gaining depth. Colours are read from brand tokens. */
function gradStops(color: string): Array<[string, string]> {
  if (color === 'var(--negative)') return [['0', 'var(--positive)'], ['0.5', 'var(--warning)'], ['1', 'var(--negative)']];
  if (color === 'var(--positive)') return [['0', 'var(--positive)'], ['1', 'var(--positive-deep)']];
  return [['0', 'var(--positive)'], ['1', color]];
}

/**
 * The month's flow, pouring DOWNWARD: income is a bar across the top, and every destination is a
 * column that the river lands in and then fills to the bottom edge of the card.
 *
 * Why a column and not a node-plus-label: the horizontal hero put its numbers in the margin, so a
 * wide card carried a wide strip of nothing beside the ribbons. Here the colour runs to the floor
 * and the figures live INSIDE it, which is what makes the card read as full.
 *
 * Reading order is right-to-left: the first flow lands in the rightmost column, because `.sankey`
 * forces `direction: ltr` on the SVG (coordinates must not flip) while the content is Hebrew.
 */
export function SankeyDown({
  income,
  deficit,
  flows,
  onSelect,
  sourceLabel = 'הכנסות',
  deficitLabel = 'גירעון',
  sourceTitle,
  sourceSub,
  height = 316,
}: {
  income: number;
  deficit: number;
  flows: SankeyFlow[];
  onSelect?: (id: string) => void;
  sourceLabel?: string;
  deficitLabel?: string;
  sourceTitle?: string;
  sourceSub?: { text: string; tone?: 'good' | 'bad' };
  height?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const [hot, setHot] = useState<string | null>(null);
  const W = 640;
  const H = height;
  const PAD = 10;
  const BAR_Y = 46;          // the income bar's top edge
  const BAR_H = 15;
  const COL_Y = 176;         // where the rivers land and the columns begin
  const GAP = 9;             // between columns
  const TUCK = 6;            // ribbons tuck under both bars so no seam shows at the rounded corners
  const fmt = moneyFmt();

  const sourceTotal = income + deficit;
  const total = Math.max(sourceTotal, flows.reduce((s, f) => s + f.value, 0)) || 1;
  const barW = W - PAD * 2;
  const usable = barW - GAP * Math.max(0, flows.length - 1);

  // right-to-left: x is measured from the right edge inward, so flow[0] is the rightmost column
  let srcRight = W - PAD;
  let colRight = W - PAD;
  const laid = flows.map((f) => {
    const wSrc = (f.value / total) * barW;
    const wCol = Math.max(3, (f.value / total) * usable);
    const item = { f, sx1: srcRight, sx0: srcRight - wSrc, cx1: colRight, cx0: colRight - wCol };
    srcRight -= wSrc;
    colRight -= wCol + GAP;
    return item;
  });

  /** Cubic fall from a top span to a bottom span — the vertical twin of the hero's river. */
  const river = (ax0: number, ax1: number, ay: number, bx0: number, bx1: number, by: number) => {
    const m = (ay + by) / 2;
    return `M${ax0},${ay} C${ax0},${m} ${bx0},${m} ${bx0},${by} L${bx1},${by} C${bx1},${m} ${ax1},${m} ${ax1},${ay} Z`;
  };
  /** A column: square shoulders where the river lands, rounded feet on the card's floor. */
  const column = (x0: number, x1: number, y: number, bottom: number) => {
    const r = Math.min(9, (x1 - x0) / 2);
    return `M${x0},${y} L${x1},${y} L${x1},${bottom - r} A${r},${r} 0 0 1 ${x1 - r},${bottom}`
      + ` L${x0 + r},${bottom} A${r},${r} 0 0 1 ${x0},${bottom - r} Z`;
  };

  return (
    <svg className="sankey sankey-down" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${sourceLabel} ${fmt.format(income)}`}>
      <defs>
        {laid.map(({ f }, i) => (
          <linearGradient key={f.id} id={`skd-${uid}-${i}`} x1="0" y1={BAR_Y} x2="0" y2={COL_Y} gradientUnits="userSpaceOnUse">
            {gradStops(f.color).map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
          </linearGradient>
        ))}
        {laid.map(({ f }, i) => (
          // the column itself deepens toward the floor — a flat slab reads as a sticker, a
          // graded one reads as liquid that settled
          <linearGradient key={`c${f.id}`} id={`skc-${uid}-${i}`} x1="0" y1={COL_Y} x2="0" y2={H} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={f.color} />
            <stop offset="1" stopColor={`color-mix(in srgb, ${f.color} 76%, #000)`} />
          </linearGradient>
        ))}
        <linearGradient id={`skin-${uid}`} x1="0" y1={BAR_Y} x2="0" y2={BAR_Y + BAR_H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--positive)" />
          <stop offset="1" stopColor="var(--positive-deep)" />
        </linearGradient>
      </defs>

      {/* the trunk: everything that came in, as one bar across the top */}
      <text className="sankey-label" x={W / 2} y={BAR_Y - 26} textAnchor="middle">{sourceLabel}</text>
      <text className="sankey-value" x={W / 2} y={BAR_Y - 4} textAnchor="middle">
        {fmt.format(income)}
        {sourceTitle && <title>{sourceTitle}</title>}
      </text>
      {sourceSub && (
        <text
          className="sankey-sub" x={W / 2 + 96} y={BAR_Y - 4} textAnchor="start"
          fill={sourceSub.tone === 'good' ? 'var(--positive)' : sourceSub.tone === 'bad' ? 'var(--negative)' : 'var(--ink-subtle)'}
        >
          {sourceSub.text}
        </text>
      )}
      <rect className="sankey-node" x={PAD} y={BAR_Y} width={barW} height={BAR_H} rx={7} fill={`url(#skin-${uid})`} />
      {deficit > 0 && (
        <rect className="sankey-node" x={PAD} y={BAR_Y} width={(deficit / total) * barW} height={BAR_H} rx={7} fill="var(--negative)">
          <title>{deficitLabel}</title>
        </rect>
      )}

      {laid.map(({ f, sx0, sx1, cx0, cx1 }, i) => {
        const w = cx1 - cx0;
        const dim = hot !== null && hot !== f.id;
        const cx = (cx0 + cx1) / 2;
        // a narrow column cannot hold a 24px figure — step the type down rather than clip it,
        // and split the name onto a second line when even that will not fit
        const wide = w >= 132, mid = w >= 86;
        const words = f.label.split(' ');
        const twoLine = !mid && words.length > 1;
        return (
          <g
            key={f.id}
            className={`skd-flow${dim ? ' dim' : ''}`}
            style={onSelect ? { cursor: 'pointer' } : undefined}
            onMouseEnter={() => setHot(f.id)}
            onMouseLeave={() => setHot(null)}
            onClick={() => onSelect?.(f.id)}
          >
            {f.title && <title>{f.title}</title>}
            <path d={river(sx0, sx1, BAR_Y + BAR_H - TUCK, cx0, cx1, COL_Y + TUCK)} fill={`url(#skd-${uid}-${i})`} />
            <path className="skd-col" d={column(cx0, cx1, COL_Y, H - 2)} fill={`url(#skc-${uid}-${i})`} />
            {/* the block is centred in the column's height, not hung from its shoulder — the
                first cut left ~68px of bare colour under every figure */}
            <text className="skd-val" x={cx} y={COL_Y + (wide ? 69 : 63)} textAnchor="middle" fontSize={wide ? 26 : mid ? 20 : 15}>
              {fmt.format(f.value)}
            </text>
            {twoLine ? (
              <text className="skd-name" x={cx} y={COL_Y + 83} textAnchor="middle" fontSize={11.5}>
                <tspan x={cx} dy="0">{words[0]}</tspan>
                <tspan x={cx} dy="13">{words.slice(1).join(' ')}</tspan>
              </text>
            ) : (
              <text className="skd-name" x={cx} y={COL_Y + (wide ? 92 : 83)} textAnchor="middle" fontSize={wide ? 14 : 12}>
                {f.label}
              </text>
            )}
            {f.sub && (
              // inside the column the tone is already carried by the colour it sits on, so the
              // chip stays white — a green delta on a red pillar reads as a contradiction
              <text className="skd-sub" x={cx} y={COL_Y + (wide ? 115 : 105)} textAnchor="middle">
                {f.sub.text}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Rounds a set of shares so the printed numbers add up to what their exact sum rounds to —
 * largest-remainder, the same rule the app's on-screen arithmetic follows everywhere else.
 * Rounding each share on its own printed 30 + 34 + 25 + 12 = 101 beside a whole that was 100.
 * When the parts do NOT fill the whole (an over-spent month) the target is not 100 and must not
 * be: they close on their own true sum.
 */
function sharesTo100(exact: number[]): number[] {
  const target = Math.round(exact.reduce((s, v) => s + v, 0));
  const floors = exact.map(Math.floor);
  let left = target - floors.reduce((s, v) => s + v, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

export interface SplitTile {
  id: string;
  label: string;
  value: number;
  /** The destination's own colour — the same one its Sankey ribbon wears. */
  color: string;
  title?: string;
}

/**
 * הפיצול — one income, and the few places it went, as tiles.
 *
 * A Sankey is a chart for MULTI-STAGE flow. A single one-to-four split does not need curves: the
 * ribbons cost the reader a decoding step and repay nothing. The surface says four numbers plainly,
 * and each tile still carries its share
 * as a measured bar, because four numbers with no relation between them is the opposite mistake.
 *
 * The colour is the destination's identity — the SAME hue its ribbon wore — but it never lands
 * under the text. Per the card identity (brand 4.0): a clean surface, colour as a glow beneath and
 * a stroke around. Text on a tint would need a per-theme mix to clear 4.5:1; text on the surface
 * needs nothing, and reads crisper.
 */
export function SplitTiles({ total, totalLabel, totalTitle, deficit = 0, deficitLabel, tiles }: {
  total: number;
  totalLabel: string;
  totalTitle?: string;
  /** Spending beyond what came in — the tiles then divide income + deficit, like the ribbons did. */
  deficit?: number;
  deficitLabel?: string;
  tiles: SplitTile[];
}) {
  // The share is measured against the INCOME, never against income+deficit. In an over-spent month
  // the wider base would report "יצא עד כה — 100% מההכנסה" and look balanced; against the income it
  // reports 110%, which is the actual news. The BAR clamps at full (it cannot draw past its track);
  // the number beside it is free to say how far past 100 it went.
  const base = Math.max(total, 1);
  const pcts = useMemo(() => sharesTo100(tiles.map((t) => (t.value / base) * 100)), [tiles, base]);
  return (
    <div className="split">
      <div className="split-head">
        <span className="split-head-cap" title={totalTitle}>{totalLabel}</span>
        <span className="split-head-num">{ILS0.format(total)}</span>
        {deficit >= 1 && (
          <span className="split-head-def">+ {ILS0.format(deficit)} {deficitLabel ?? 'מעבר להכנסות'}</span>
        )}
      </div>
      {/* Column count is decided, never discovered: `auto-fit` handed four tiles a 3+1 break — one
          orphan on a second row — the moment the card was a hair too narrow for four. One row,
          one tile per destination; the CSS drops to 2 and then 1 at real breakpoints, never to
          a count that leaves somebody alone at the bottom. */}
      <div className="split-tiles" style={{ '--cols': Math.min(tiles.length, 4) } as CSSProperties}>
        {tiles.map((t, i) => {
          const pct = pcts[i];
          return (
            <div key={t.id} className="split-tile" style={{ '--tt': t.color } as CSSProperties} title={t.title}>
              <span className="split-tile-cap">{t.label}</span>
              <span className="split-tile-num">{ILS0.format(t.value)}</span>
              {/* the share, measured — a floor of 3% only so a real-but-tiny slice still draws
                  something the eye can catch; the % beside it is the exact truth */}
              <span className="split-tile-track">
                <span className="split-tile-fill" style={{ width: `${Math.max(3, Math.min(100, pct))}%` }} />
              </span>
              <span className="split-tile-pct">{pct}% מההכנסה</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Two-column Sankey: money-in on the left flows into its destinations on the right.
 *  A deficit adds a red source segment — the missing money came from somewhere.
 *  The canonical flow visual of the app; clicking a ribbon drills in when onSelect is given. */
export function Sankey({
  income,
  deficit,
  flows,
  onSelect,
  sourceLabel = 'הכנסות',
  deficitLabel = 'גירעון',
  sourceTitle,
  sourceSub,
  bigValues = false,
}: {
  income: number;
  deficit: number;
  flows: SankeyFlow[];
  onSelect?: (id: string) => void;
  sourceLabel?: string;
  deficitLabel?: string;
  sourceTitle?: string;
  /** A small chip under the source value (bigValues mode). */
  sourceSub?: { text: string; tone?: 'good' | 'bad' };
  /** Hero mode for few fat ribbons: small name, BIG value — numbers first. */
  bigValues?: boolean;
}) {
  const W = 640;
  // hero mode carries big stacked numbers beside each ribbon, so it needs more vertical room;
  // category mode packs many thin ribbons — 27px each keeps a 12-category month compact enough
  // to live on one screen (the CSS also caps its rendered width, so it reads as a composed
  // figure instead of a wall). 268 (was 232) is the "שמנה" pass: same form, fatter rivers.
  const H = Math.max(bigValues ? 268 : 190, flows.length * (bigValues ? 40 : 27));
  const NODE_W = bigValues ? 16 : 10;
  // hero ribbons tuck a few px UNDER both node bars (drawn after them), so every river sits
  // flush on its tongue without a visible seam around the rounded node corners
  const TUCK = bigValues ? 5 : 0;
  // hero mode forks one source into a few fat ribbons — a wide gap makes the split read as a
  // fork in a river; category mode keeps thin ribbons close together so many fit.
  const GAP = bigValues ? 36 : 6;
  const padV = bigValues ? 8 : 0;
  const leftTotal = income + deficit;
  const total = Math.max(leftTotal, flows.reduce((s, f) => s + f.value, 0)) || 1;
  const usable = H - padV * 2 - GAP * (flows.length - 1);
  const scale = (v: number) => Math.max(2, (v / total) * usable);

  // hero mode centres the fanned-out right stack (ribbons + wide gaps) in the padded canvas, so the
  // fork sits symmetric around the trunk; category mode keeps its original top-aligned stack.
  const rightStackH = flows.reduce((s, f) => s + scale(f.value), 0) + GAP * Math.max(0, flows.length - 1);
  let rightY = bigValues ? padV + Math.max(0, (H - padV * 2 - rightStackH) / 2) : 0;
  const leftY = (H - scale(leftTotal)) / 2;
  // hero mode reserves a label column left of the source node, so its text never sits on a ribbon
  const leftX = bigValues ? 150 : 20;
  // hero's RIGHT column is wider than the left: it must seat the longest ribbon name
  // ("פנוי להוצאות משתנות") in full without clipping at the canvas edge
  const rightX = W - (bigValues ? 164 : 150);
  const ribbons: {
    d: string; h: number; id: string; label: string; value: number; y: number; color: string;
    title?: string; sub?: SankeyFlow['sub'];
  }[] = [];
  let leftOffset = leftY;
  for (const f of flows) {
    const h = scale(f.value);
    const y0 = leftOffset;
    const y1 = rightY;
    const midX = (leftX + NODE_W + rightX) / 2;
    // x-extents tuck under the node bars (both drawn later), so the river and its tongue meet
    // with zero visible seam
    const x0 = leftX + NODE_W - TUCK;
    const x1 = rightX + TUCK;
    ribbons.push({
      d: `M ${x0} ${y0} C ${midX} ${y0}, ${midX} ${y1}, ${x1} ${y1}
          L ${x1} ${y1 + h} C ${midX} ${y1 + h}, ${midX} ${y0 + h}, ${x0} ${y0 + h} Z`,
      h,
      id: f.id,
      label: f.label,
      value: f.value,
      y: y1,
      color: f.color,
      title: f.title,
      sub: f.sub,
    });
    leftOffset += h;
    rightY += h + GAP;
  }

  const labelX = rightX + NODE_W + 6;
  const sourceCy = Math.min(H - 28, Math.max(30, leftY + scale(income) / 2));
  // single-line labels (category mode) are spread apart so thin, adjacent ribbons never overprint
  const idealLabelY = ribbons.map((r) => Math.min(H - 5, r.y + Math.min(r.h / 2 + 4, r.h + 10)));
  const labelYs = bigValues ? idealLabelY : spreadLabels(idealLabelY, 19, 12, H - 4);
  // hero mode with more than one ribbon anchors each label to the outer edge its ribbon lands on
  // (top ribbon → top, bottom ribbon → bottom), framing the chart instead of floating mid-ribbon.
  const edgeAnchor = bigValues && flows.length > 1;
  return (
    <svg className={bigValues ? 'sankey' : 'sankey sankey-cat'} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="זרימת הכסף">
      <defs>
        {ribbons.map((r) => (
          <linearGradient key={r.id} id={`sankey-grad-${r.id}`} gradientUnits="userSpaceOnUse" x1={leftX + NODE_W} y1="0" x2={rightX} y2="0">
            {gradStops(r.color).map(([off, col]) => (
              <stop key={off} offset={off} style={{ stopColor: col }} />
            ))}
          </linearGradient>
        ))}
        {/* the tongues deepen top-to-bottom instead of sitting flat: a slab of one colour reads
            as a sticker, a graded one reads as something with body. Hero only — category mode's
            10px nodes are too thin for a gradient to register. */}
        {bigValues && ribbons.map((r) => (
          <linearGradient key={`n-${r.id}`} id={`sankey-node-${r.id}`} gradientUnits="userSpaceOnUse" x1="0" y1={r.y} x2="0" y2={r.y + r.h}>
            <stop offset="0" style={{ stopColor: r.color }} />
            <stop offset="1" style={{ stopColor: `color-mix(in srgb, ${r.color} 72%, #000)` }} />
          </linearGradient>
        ))}
        {bigValues && (
          <linearGradient id="sankey-node-source" gradientUnits="userSpaceOnUse" x1="0" y1={leftY} x2="0" y2={leftY + scale(income)}>
            {/* same darkening as the destination tongues, NOT --positive-deep: in the dark theme
                that token is LIGHTER than --positive, so the trunk would glow upward instead of
                gaining depth, and the two ends of the river would disagree */}
            <stop offset="0" style={{ stopColor: 'var(--positive)' }} />
            <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--positive) 72%, #000)' }} />
          </linearGradient>
        )}
      </defs>
      {ribbons.map((r, idx) => {
        const cy = r.y + r.h / 2;
        // hero mode always renders numbers-first at full size — a thin ribbon (e.g. a small
        // "remaining") keeps the SAME value type size as a fat one, so it never becomes unreadable.
        const stacked = bigValues;
        // spread label Y (category mode), kept inside the viewBox
        const labelY = labelYs[idx];
        // the stacked block hangs above and below its center; clamp the center so a thin ribbon
        // at the very top or bottom keeps the whole name+value block on-canvas.
        const stackY = Math.min(H - (r.sub ? 36 : 28), Math.max(r.sub ? 34 : 30, cy));
        // edge-anchored (hero): hug the top edge for a top-half ribbon, the bottom edge for a
        // bottom-half one, so the numbers frame the chart from its corners.
        const topHalf = cy < H / 2;
        const nameY = edgeAnchor
          ? (topHalf ? r.y + 17 : (r.y + r.h) - (r.sub ? 46 : 24))
          : stackY - (r.sub ? 22 : 16);
        const valueY = edgeAnchor ? nameY + 24 : stackY + (r.sub ? 9 : 20);
        const subY = edgeAnchor ? valueY + 20 : stackY + 34;
        return (
          <g
            key={r.id}
            style={onSelect && r.id !== 'savings' ? { cursor: 'pointer' } : undefined}
            onClick={() => r.id !== 'savings' && onSelect?.(r.id)}
          >
            {r.title && <title>{r.title}</title>}
            <path
              d={r.d}
              fill={`url(#sankey-grad-${r.id})`}
              className={bigValues ? 'sankey-river' : undefined}
              // the "עסיסית" pass: denser ink and a firmer outline — the rivers read as
              // rivers, not as watercolor washes. 0.88 (was 0.68) is the second pass: at 0.68
              // the card colour still showed through and the gradient looked chalky.
              fillOpacity={bigValues ? 0.88 : 0.45}
              stroke={r.color}
              strokeOpacity={bigValues ? 0.7 : 0.3}
              strokeWidth={bigValues ? 1.2 : 0.75}
            />
            <rect x={rightX} y={r.y} width={NODE_W} height={r.h} rx={bigValues ? 6 : 3} fill={bigValues ? `url(#sankey-node-${r.id})` : r.color} className={bigValues ? 'sankey-node' : undefined} />
            {stacked ? (
              <>
                <text x={labelX} y={nameY} className="bar-label sankey-name">{r.label}</text>
                <text x={labelX} y={valueY} className="sankey-value">{ILS0.format(r.value)}</text>
                {r.sub && (
                  <text x={labelX} y={subY} className="sankey-sub" fill={r.sub.tone === 'good' ? 'var(--positive)' : r.sub.tone === 'bad' ? 'var(--negative)' : 'var(--ink-subtle)'}>
                    {r.sub.text}
                  </text>
                )}
              </>
            ) : (
              <>
                {Math.abs(labelY - cy) > 5 && (
                  <line className="sankey-leader" x1={rightX + NODE_W + 1} y1={cy} x2={labelX - 1} y2={labelY - 4} />
                )}
                <text x={labelX} y={labelY} className="bar-label sankey-label">
                  {r.label} · {ILS0.format(r.value)}
                </text>
              </>
            )}
          </g>
        );
      })}
      {/* source and deficit are drawn AFTER the ribbons so their text never sits under a ribbon */}
      <g>
        {sourceTitle && <title>{sourceTitle}</title>}
        <rect
          x={leftX} y={leftY} width={NODE_W} height={scale(income)} rx={bigValues ? 6 : 2}
          className={bigValues ? 'sankey-income sankey-node' : 'sankey-income'}
          // inline style, not a fill attribute: .sankey-income sets fill in CSS and would win
          {...(bigValues ? { style: { fill: 'url(#sankey-node-source)' } } : {})}
        />
        {bigValues ? (
          <>
            <text x={leftX - 8} y={sourceCy - (sourceSub ? 22 : 16)} textAnchor="end" className="bar-label sankey-name">{sourceLabel}</text>
            <text x={leftX - 8} y={sourceCy + (sourceSub ? 9 : 20)} textAnchor="end" className="sankey-value">{ILS0.format(income)}</text>
            {sourceSub && (
              <text x={leftX - 8} y={sourceCy + 34} textAnchor="end" className="sankey-sub" fill={sourceSub.tone === 'good' ? 'var(--positive)' : sourceSub.tone === 'bad' ? 'var(--negative)' : 'var(--ink-subtle)'}>
                {sourceSub.text}
              </text>
            )}
          </>
        ) : (
          <text x={leftX} y={Math.max(12, leftY - 6)} className="bar-label">
            {sourceLabel} · {ILS0.format(income)}
          </text>
        )}
      </g>
      {deficit > 0 && (
        <g>
          <rect x={leftX} y={leftY + scale(income)} width={NODE_W} height={scale(deficit)} rx={bigValues ? 5 : 2} fill="var(--negative)" />
          <text
            x={bigValues ? leftX - 8 : leftX}
            y={Math.min(H - 4, leftY + scale(leftTotal) + 14)}
            textAnchor={bigValues ? 'end' : undefined}
            className="bar-label"
            fill="var(--negative)"
          >
            {deficitLabel} · {ILS0.format(deficit)}
          </text>
        </g>
      )}
    </svg>
  );
}

/* ——— month trail: the month as a walked path, one block per day ——— */

/** Parse a CSS color (#rgb, #rrggbb, or rgb(...)) to [r,g,b]; falls back if unreadable. */
function parseRGB(s: string, fallback: [number, number, number]): [number, number, number] {
  const v = s.trim();
  if (v.startsWith('#')) {
    let h = v.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = Number.parseInt(h, 16);
    if (Number.isFinite(n) && h.length === 6) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = v.match(/[\d.]+/g);
  if (m && m.length >= 3) return [Number(m[0]), Number(m[1]), Number(m[2])];
  return fallback;
}

/** A mid-stride walking figure, facing the month's leftward flow — marks "you are here".
 *  It stands ABOVE today's block (not on it) so the legs read against the card, not the tile. */
function TrailWalker({ x, y }: { x: number; y: number }) {
  return (
    <g className="trail-walker" transform={`translate(${x}, ${y})`} aria-hidden="true">
      <circle cx="-1" cy="-19" r="3.7" />
      <path
        d="M-1 -15 L0.5 -5 M-1 -12 L-7.5 -9.5 M-1 -12 L5.5 -10.5 M0.5 -5 L-6.5 6 M0.5 -5 L6 6.5"
        fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </g>
  );
}

/** The month as a trail you walk: one equal-size block per day, coloured as a heat-map of
 *  that day's real variable spend — green when you stayed under the daily allowance, red when
 *  you blew past it (so a single blow-out day no longer distorts the whole picture). The walker
 *  stands on today; the days ahead are empty grey slots; a flag marks the projected close.
 *  Hover any day for its exact spend and the split by category. */
export function MonthTrail({
  byDay, daysElapsed, daysInMonth, allowance, leftToSpend, paceEndOfMonth, perDayPace, monthStart,
}: {
  byDay: Array<{ total: number; cats: Array<{ cat: string; amount: number }> }>;
  daysElapsed: number;
  daysInMonth: number;
  allowance: number;
  leftToSpend: number;
  paceEndOfMonth: number;
  perDayPace: number;
  monthStart: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (daysInMonth <= 0) return null;
  const today = Math.min(Math.max(1, daysElapsed), daysInMonth);
  const W = 720, H = 118;
  const padR = 14, padL = 44;
  // a two-line "cell header" sits above each day — weekday initial, then the date —
  // so every column reads like a torn-off wall-calendar cell.
  const dowY = 13;              // weekday-initial baseline
  const numY = 28;              // day-number baseline
  const tileH = 46;
  const tileTop = 36;           // tiles hang just under the header, walker still clears above
  const baseline = tileTop + tileH;
  const colW = (W - padR - padL) / daysInMonth;
  const tileW = Math.min(17, Math.max(4, colW - 3));
  const HE_DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']; // Sun…Sat, by getDay()
  // RTL: day 1 sits on the right, the month walks leftward toward its end
  const cx = (d: number) => (W - padR) - (d - 0.5) * colW;

  // heat: the day's spend vs the daily allowance, on the brand's own green→amber→red —
  // read live so it tracks the active theme. ratio² keeps comfortable days firmly green.
  const css = getComputedStyle(document.documentElement);
  const cGreen = parseRGB(css.getPropertyValue('--positive'), [18, 161, 80]);
  const cAmber = parseRGB(css.getPropertyValue('--warning'), [239, 159, 39]);
  const cRed = parseRGB(css.getPropertyValue('--negative'), [226, 75, 74]);
  const mix = (a: number[], b: number[], t: number) =>
    `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ${Math.round(a[2] + (b[2] - a[2]) * t)})`;
  const heat = (ratio: number) => {
    const r = Math.max(0, Math.min(2, ratio));
    return r <= 1 ? mix(cGreen, cAmber, r * r) : mix(cAmber, cRed, r - 1);
  };

  // over-pace only: at today's daily burn, the day the safe-to-spend runs dry. Measured on
  // `leftToSpend` (the budget) rather than on the cash projection — the two answer different
  // questions since the target arrived, and this marker is about the budget.
  const runway = perDayPace > 0 ? leftToSpend / perDayPace : Infinity;
  const runOutDay = Number.isFinite(runway) && today + runway <= daysInMonth
    ? Math.floor(today + runway)
    : null;

  const dayFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long' });
  const dowFmt = new Intl.DateTimeFormat('he-IL', { weekday: 'long' });
  const dateOf = (d: number) => {
    const t = new Date(`${monthStart}T00:00:00`);
    t.setDate(t.getDate() + (d - 1));
    return t;
  };
  // per-day calendar facts: which weekday it falls on, weekend (Fri–Sat), week start (Sun).
  // `dayNum` is the REAL calendar day — a flow month anchored on the 10th runs 10…31, 1…9,
  // and the cells must say so. (`d` stays the 1-based
  // position inside the flow month — geometry, heat and today-math run on position, never on
  // the calendar number.)
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const date = dateOf(i + 1);
    const dow = date.getDay();
    return {
      i, d: i + 1, dow,
      dayNum: date.getDate(),
      monthStart2: date.getDate() === 1, // the calendar flips here — worth a stronger mark
      weekend: dow === 5 || dow === 6,
      sunday: dow === 0,
    };
  });
  const flagX = padL - 6;
  const flagGood = paceEndOfMonth >= 0;

  return (
    <div className="trail">
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg
          className="trail-svg" viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`מסלול החודש: היום יום ${today} מתוך ${daysInMonth}. ${
            flagGood ? `צפי סגירה עם ${ILS0.format(paceEndOfMonth)} ביד` : `בקצב הזה החודש ייסגר ב־${ILS0.format(paceEndOfMonth)}`
          }.`}
        >
          {/* calendar underlay — weekend shading + week dividers, behind the day tiles */}
          <g className="trail-cal-bg" aria-hidden="true">
            {days.map((day) => day.weekend ? (
              <rect
                key={`wk${day.d}`} className="trail-weekend"
                x={cx(day.d) - colW / 2 + 0.5} y={dowY - 10}
                width={colW - 1} height={baseline - (dowY - 10)} rx="4"
              />
            ) : null)}
            {days.map((day) => (day.sunday && day.d !== 1) ? (
              <line
                key={`wd${day.d}`} className="trail-weekgrid"
                x1={cx(day.d) + colW / 2} x2={cx(day.d) + colW / 2}
                y1={dowY - 8} y2={baseline}
              />
            ) : null)}
          </g>
          {Array.from({ length: daysInMonth }, (_, i) => {
            const d = i + 1;
            const isToday = d === today;
            const isFuture = d > today;
            const info = byDay[i] ?? { total: 0, cats: [] };
            const runOut = runOutDay != null && d >= runOutDay && isFuture;
            const cls = `trail-tile${isFuture ? (runOut ? ' t-runout' : ' t-future') : ''}${isToday ? ' t-today' : ''}`;
            const fill = isToday
              ? 'var(--accent)'
              : isFuture
                ? (runOut ? 'var(--negative)' : 'var(--ink-subtle)')
                : heat(info.total / (allowance || 1));
            return (
              <rect
                key={d} className={cls}
                x={cx(d) - tileW / 2} y={tileTop} width={tileW} height={tileH}
                rx="3.5" fill={fill} style={{ ['--i' as string]: String(i) }}
                onMouseEnter={() => setHover(i)}
              />
            );
          })}
          {/* cell headers — weekday initial + date over each day; the walker marks today instead */}
          <g className="trail-cal-labels" aria-hidden="true">
            {days.map((day) => day.d === today ? null : (
              <g key={`lbl${day.d}`}>
                <text className={`trail-dow${day.weekend ? ' wknd' : ''}`} x={cx(day.d)} y={dowY} textAnchor="middle">{HE_DOW[day.dow]}</text>
                <text className={`trail-daynum${day.weekend ? ' wknd' : ''}${day.monthStart2 ? ' newmonth' : ''}`} x={cx(day.d)} y={numY} textAnchor="middle">{day.dayNum}</text>
              </g>
            ))}
          </g>
          <TrailWalker x={cx(today)} y={tileTop - 8} />
          <g className="trail-flag">
            <line className="trail-flagpole" x1={flagX} x2={flagX} y1={baseline} y2={tileTop - 6} />
            <path className={flagGood ? 'trail-flagcloth good' : 'trail-flagcloth bad'} d={`M ${flagX} ${tileTop - 6} l -15 4.5 l 15 4.5 z`} />
          </g>
          <g className="trail-arrow" aria-hidden="true">
            <line x1={W - padR - 22} x2={padL + 46} y1={baseline + 16} y2={baseline + 16} />
            <polygon points={`${padL + 30},${baseline + 16} ${padL + 47},${baseline + 10} ${padL + 47},${baseline + 22}`} />
          </g>
          <text className="trail-axis-label" x={W - padR} y={H - 6} textAnchor="end">{dayFmt.format(dateOf(1))}</text>
          <text className="trail-axis-label" x={padL - 4} y={H - 6} textAnchor="start">{dayFmt.format(dateOf(daysInMonth))}</text>
        </svg>
        {hover !== null && (() => {
          const day = hover + 1;
          const info = byDay[hover] ?? { total: 0, cats: [] };
          const isFuture = day > today;
          return (
            <Tip xPct={(cx(day) / W) * 100} yPct={(tileTop / H) * 100}>
              <div className="tip-title">{dowFmt.format(dateOf(day))} · {dayFmt.format(dateOf(day))}{day === today ? ' · היום' : ''}</div>
              {isFuture ? (
                <div className="tip-row"><span>פנוי לבזבוז</span><span className="amount">{ILS0.format(allowance)}</span></div>
              ) : info.total <= 0 ? (
                <div className="tip-row"><span className="muted">לא הוצאת ביום הזה</span></div>
              ) : (
                <>
                  <div className="tip-row"><span>סה״כ</span><span className="amount">{ILS0.format(info.total)}</span></div>
                  {info.cats.slice(0, 6).map((c) => (
                    <div className="tip-row" key={c.cat}>
                      <span><i className="tip-dot" style={{ background: CATEGORY_COLORS[c.cat] ?? 'var(--ink-subtle)' }} />{categoryNameHe(c.cat)}</span>
                      <span className="amount">{ILS0.format(c.amount)}</span>
                    </div>
                  ))}
                </>
              )}
            </Tip>
          );
        })()}
      </div>
      <div className="trail-legend">
        <span className="tl-heat"><i className="tl-heat-bar" />ירוק = חסכת · אדום = חרגת</span>
        <span className="tl-walk"><span className="tl-walk-dot" />היום</span>
        <span><i className="tl-dot future" />עוד לא מולא · ≈{ILS0.format(allowance)}/יום</span>
      </div>
    </div>
  );
}

/** Goal progress as a ring — the donut grammar applied to a single number. */
export function ProgressRing({ value, target, color, size = 112 }: {
  value: number;
  target: number | null;
  color: string;
  size?: number;
}) {
  const R = 44;
  const CIRC = 2 * Math.PI * R;
  const frac = target && target > 0 ? Math.min(1, Math.max(0, value / target)) : 1;
  const pct = target && target > 0 ? Math.round((value / target) * 100) : null;
  return (
    <svg width={size} height={size} viewBox="0 0 110 110" role="img" aria-label="התקדמות החיסכון">
      <circle cx="55" cy="55" r={R} fill="none" stroke="var(--hairline)" strokeWidth="10" />
      <circle
        cx="55" cy="55" r={R} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
        strokeDasharray={`${frac * CIRC} ${CIRC}`} transform="rotate(-90 55 55)"
        opacity={pct === null ? 0.55 : 1}
        style={{ transition: 'stroke-dasharray .6s ease' }}
      />
      {pct !== null && <text x="55" y="62" textAnchor="middle" className="ring-value">{pct}%</text>}
    </svg>
  );
}

const MAX_LEGEND_ROWS = 8;

export interface DonutItem {
  id: string;
  label: string;
  color: string;
  value: number;
}

/** Donut with legend over any labeled composition; hover highlights the slice and its
 *  legend row, onSelect (slice or legend click) drills in. Extracted from CategoryDonut
 *  so the balance sheet can draw asset classes in the exact same grammar — CategoryDonut
 *  delegates here and stays pixel-identical. */
export function Donut({ items, centerLabel, emptyText, rollupLabel = 'שאר הפריטים', ariaLabel, onSelect, currency }: {
  items: DonutItem[];
  /** The idle center caption (a hovered slice takes over both center lines). */
  centerLabel: string;
  emptyText?: string;
  rollupLabel?: string;
  ariaLabel?: string;
  onSelect?: (id: string) => void;
  currency?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const fmt = moneyFmt(currency);
  if (items.length === 0) return emptyText ? <p className="muted">{emptyText}</p> : null;

  let rows = items;
  if (rows.length > MAX_LEGEND_ROWS) {
    const head = rows.slice(0, MAX_LEGEND_ROWS - 1);
    const rest = rows.slice(MAX_LEGEND_ROWS - 1).reduce((s, c) => s + c.value, 0);
    rows = [...head, { id: 'rollup', label: rollupLabel, color: 'var(--cat-slate)', value: Math.round(rest * 100) / 100 }];
  }
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;

  const R = 56;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;
  const slices = rows.map((r) => {
    const frac = r.value / total;
    const slice = { ...r, frac, offset: acc };
    acc += frac;
    return slice;
  });
  const hovered = slices.find((s) => s.id === hover);

  return (
    <div className="donut-wrap">
      <svg className="donut-svg" width="150" height="150" viewBox="0 0 150 150" role="img" aria-label={ariaLabel ?? centerLabel}>
        <g transform="rotate(-90 75 75)">
          {slices.map((s) => (
            <circle
              key={s.id}
              className="donut-slice"
              style={onSelect ? { cursor: 'pointer' } : undefined}
              cx="75" cy="75" r={R}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === s.id ? 17 : 13}
              strokeDasharray={`${Math.max(0.5, s.frac * CIRC - 2)} ${CIRC}`}
              strokeDashoffset={-s.offset * CIRC}
              opacity={hover && hover !== s.id ? 0.35 : 1}
              onMouseEnter={() => setHover(s.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(s.id)}
            />
          ))}
        </g>
        <text className="donut-center-label" x="75" y="60" textAnchor="middle">
          {hovered ? hovered.label : centerLabel}
        </text>
        <text className="donut-center-value" x="75" y="94" textAnchor="middle">
          {fmt.format(hovered ? hovered.value : total)}
        </text>
      </svg>
      <div className="cat-legend">
        {slices.map((s) => (
          <div
            key={s.id}
            className={hover && hover !== s.id ? 'cat-row dim' : 'cat-row'}
            // the row IS the colour: --rowc feeds both the full-width base and the brighter
            // proportional block, and the CSS darkens each so white text clears 4.5:1 on both
            style={{ ['--rowc' as string]: s.color, ...(onSelect ? { cursor: 'pointer' } : {}) }}
            onMouseEnter={() => setHover(s.id)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(s.id)}
          >
            <span className="cat-head">
              <span className="cat-name">{s.label}</span>
              <span className="cat-pct">{Math.round(s.frac * 100)}%</span>
              <span className="cat-amount amount">{fmt.format(s.value)}</span>
            </span>
            {/* The track is the WHOLE total and the fill is this category's true share of it —
                36% draws 36% of the width. (It used to be normalised to the largest slice, so
                the top category filled the row edge-to-edge and read as 100%.) It gets its own
                line because the legend column can be under 200px, and a bar sharing a line with
                three text lanes collapses to its min-width and stops meaning anything. */}
            <span className="cat-track" aria-hidden>
              <span className="cat-fill" style={{ width: `${s.frac * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Donut of one month's expenses by category; hover highlights the slice and its legend row.
 *  onSelect (slice or legend click) opens the category's transactions — the basic analytical
 *  move: "what IS this 4,200 ₪?". */
export function CategoryDonut({ byCategory, onSelect }: { byCategory: CategoryExpense[]; onSelect?: (category: string) => void }) {
  return (
    <Donut
      items={byCategory.map((c) => ({
        id: c.category,
        label: categoryNameHe(c.category),
        color: categoryColor(c.category),
        value: c.expenses,
      }))}
      centerLabel="סה״כ הוצאות"
      ariaLabel="הוצאות לפי קטגוריה"
      emptyText='אין הוצאות מסווגות החודש. סיווג עסקאות בתיבת "לבדיקה" יאיר את הגרף הזה.'
      rollupLabel="שאר הקטגוריות"
      onSelect={onSelect}
    />
  );
}

/** One month's expenses as a heat grid: AREA is the money, so the card is full of colour edge to
 *  edge and a 1% category is visibly 1%. Replaced the donut-plus-legend in the month tab — that
 *  layout drew eight near-empty tracks in a tall column, which read as hollow and left the card
 *  beside it stretched to its height with nothing in it. Clicking a tile drills into the category,
 *  exactly as a donut slice used to. */
export function CategoryTreemap({ byCategory, onSelect, height = 232 }: {
  byCategory: CategoryExpense[];
  onSelect?: (category: string) => void;
  height?: number;
}) {
  const fmt = moneyFmt();
  const total = byCategory.reduce((s, c) => s + c.expenses, 0) || 1;
  const items: TreemapDatum[] = byCategory
    .filter((c) => c.expenses > 0)
    .map((c) => ({
      id: c.category,
      label: categoryNameHe(c.category),
      value: c.expenses,
      color: categoryColor(c.category),
      amountHe: fmt.format(c.expenses),
      tip: <div className="tm-tip-row">{Math.round((c.expenses / total) * 100)}% מההוצאות · {fmt.format(total)} סה״כ</div>,
    }));
  return <Treemap items={items} height={height} ariaLabel="הוצאות לפי קטגוריה" onSelect={onSelect} />;
}

/* ——— treemap: area ∝ value, an S&P-500-style heat grid ——— */

interface TmRect { x: number; y: number; w: number; h: number; }
/** The squarified "worst aspect ratio" of a candidate row laid along a side of length `side`. */
function tmWorst(row: number[], side: number): number {
  if (row.length === 0) return Infinity;
  const sum = row.reduce((a, b) => a + b, 0);
  const mx = Math.max(...row), mn = Math.min(...row);
  const s2 = sum * sum, side2 = side * side;
  return Math.max((side2 * mx) / s2, s2 / (side2 * mn));
}
/** Squarified treemap (Bruls/Huizing/van Wijk): tiles as near-square as possible, area ∝ value.
 *  Input values must be sorted descending. Returns one rect per value, in the same order. */
function squarify(values: number[], W: number, H: number): TmRect[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0 || W <= 0 || H <= 0) return values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const areas = values.map((v) => (v * (W * H)) / total);
  const rects: TmRect[] = [];
  let x = 0, y = 0, w = W, h = H, start = 0;
  while (start < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let best = Infinity, i = start;
    while (i < areas.length) {
      const cand = tmWorst([...row, areas[i]], side);
      if (row.length > 0 && cand > best) break;
      row.push(areas[i]); best = cand; i++;
    }
    const thickness = row.reduce((a, b) => a + b, 0) / side;
    if (w >= h) {
      let cy = y;
      for (const a of row) { const ch = a / thickness; rects.push({ x, y: cy, w: thickness, h: ch }); cy += ch; }
      x += thickness; w -= thickness;
    } else {
      let cx = x;
      for (const a of row) { const cw = a / thickness; rects.push({ x: cx, y, w: cw, h: thickness }); cx += cw; }
      y += thickness; h -= thickness;
    }
    start = i;
  }
  return rects;
}

export interface TreemapDatum {
  id: string;
  label: string;   // merchant name
  value: number;   // positive magnitude — drives the tile area
  color: string;   // fill (opaque; tiles carry light text)
  amountHe: string; // the ₪ figure, pre-formatted
  tip?: ReactNode; // extra detail rows for the hover card
}

/* ——— per-tile type size: the biggest each tile can hold, measured ————————————————————————
 *
 * One fixed size for every tile is the same lie the staircase's floor was invented to kill: a
 * category twelve times another's carried identical 14.5px type, so the big tile spent 500×330
 * of screen on a whisper. A tile's size IS information; the type inside it should say so.
 *
 * THE RULE. Each tile gets the largest size that still satisfies both standards, and the
 * stricter of the two wins:
 *   • WIDTH — the name fits on ONE line, whole. Never wrapped, never broken mid-word.
 *   • HEIGHT — both lines fit between the paddings.
 * Rounded DOWN, always: rounding up is exactly how half a pixel of overflow is born.
 *
 * WHY MEASURED, NOT ESTIMATED. Glyph width is a property of the face, not of the character
 * count — "מזון" and "העברות" are 4 and 6 letters and nothing about that predicts their width in
 * Assistant. So each string is measured once at a reference size and scaled: text width is
 * linear in font-size for a fixed face, so one measurement is exact at every size.
 *
 * WHY A DOM PROBE AND NOT A CANVAS. A canvas cannot apply `font-variant-numeric`, and measured
 * here it was 3.6% wide on the amounts — enough to cost a whole size step on the tight tiles.
 * The probe wears the very classes the tile wears, so the measurement includes everything: the
 * resolved weight, the figure variant, and the direction marks inside a formatted ₪ string.
 */

/** Measure once at this size, scale to any other. */
const TM_REF = 100;
/** Chrome a tile spends before a glyph — must match `.tm-tile` / `.tm-tile.sm` in the CSS. */
const TM_PAD_X = 20, TM_PAD_Y = 18;      // padding 8px 10px, plus the 2px gap between the two lines
const TM_SM_PAD_X = 14, TM_SM_PAD_Y = 8; // `.tm-tile.sm` — padding 4px 7px, one line, no gap
/** line-height of `.tm-tile-name` / `.tm-tile-val`. */
const TM_LH_NAME = 1.15, TM_LH_VAL = 1.25;
/** The amount always sits a step under the name, so the hierarchy inside a tile can never flip. */
const TM_VAL_RATIO = 0.88;
/** A 500px-tall tile could carry 190px type by the arithmetic — and stop being a chart label.
 *  34 keeps the map a map: under the card's own hero figures, over everything else on it. */
const TM_MAX = 34;
/** The app's 14px microcopy floor, expressed for each line. A name may not go under 16, because
 *  16 × 0.88 is the 14 its amount still owes that floor. Below it the tile drops the name
 *  entirely rather than whispering — the hover card carries it back, whole. */
const TM_BOTH_MIN = 16, TM_VAL_MIN = 14;
/** A tile that shows the amount alone is a small tile by definition; let it be bold, not huge. */
const TM_VAL_ONLY_MAX = 26;
/** Sub-pixel layout rounding — the probe measures in fractions, the tile lays out on the grid. */
const TM_SLACK = 1;

interface TmFit { mode: 'both' | 'val' | 'none'; name: number; val: number; }
/** Width of `text` at {@link TM_REF}px, rendered with the given tile class. */
type TmMeasure = (text: string, cls: 'tm-tile-name' | 'tm-tile-val') => number;

/** The three tiers, now derived from the tile's own box instead of guessed at round pixel counts:
 *  name + amount as large as they fit, else the amount alone, else nothing but the hover card. */
function tmFit(label: string, amountHe: string, W: number, H: number, measure: TmMeasure): TmFit {
  const bothW = W - TM_PAD_X - TM_SLACK, bothH = H - TM_PAD_Y;
  if (bothW > 0 && bothH > 0) {
    const byHeight = bothH / (TM_LH_NAME + TM_VAL_RATIO * TM_LH_VAL);
    const byName = (bothW / measure(label, 'tm-tile-name')) * TM_REF;
    // the amount rides at TM_VAL_RATIO of the name, so its own limit is divided back up
    const byVal = ((bothW / measure(amountHe, 'tm-tile-val')) * TM_REF) / TM_VAL_RATIO;
    const name = Math.floor(Math.min(byHeight, byName, byVal, TM_MAX));
    if (name >= TM_BOTH_MIN) return { mode: 'both', name, val: Math.floor(name * TM_VAL_RATIO) };
  }
  const smW = W - TM_SM_PAD_X - TM_SLACK, smH = H - TM_SM_PAD_Y;
  if (smW > 0 && smH > 0) {
    const byHeight = smH / TM_LH_VAL;
    const byWidth = (smW / measure(amountHe, 'tm-tile-val')) * TM_REF;
    const val = Math.floor(Math.min(byHeight, byWidth, TM_VAL_ONLY_MAX));
    if (val >= TM_VAL_MIN) return { mode: 'val', name: 0, val };
  }
  return { mode: 'none', name: 0, val: 0 };
}

/** A squarified treemap with a cursor-following detail card. Tiles too small for an inline label
 *  still reveal everything on hover — the S&P-heatmap idiom. Re-tiles on resize. RTL: x maps to
 *  `right`, so the biggest tile sits top-right where the eye starts. */
export function Treemap({ items, height = 280, ariaLabel, onSelect }: {
  items: TreemapDatum[];
  height?: number;
  ariaLabel?: string;
  /** Tile click — the drill-in the donut's slices used to own (opens that category's rows). */
  onSelect?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [fontRev, setFontRev] = useState(0);
  const [fits, setFits] = useState<TmFit[]>([]);
  const [hi, setHi] = useState<number | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Both, for the same reason the staircase watches both: a non-painting window can starve
    // observer callbacks, and a stale measurement here is a clipped word.
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Assistant arrives asynchronously. Sizes measured against the fallback face are wrong the
  // instant it lands, so the whole map re-measures once the real face is in.
  useEffect(() => {
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) setFontRev((v) => v + 1); });
    return () => { alive = false; };
  }, []);

  const sorted = useMemo(() => [...items].sort((a, b) => b.value - a.value), [items]);
  const rects = useMemo(() => (w > 0 ? squarify(sorted.map((d) => d.value), w, height) : []), [sorted, w, height]);

  // Sizing runs in a layout effect, not in render: it writes to the probe and reads its box back,
  // and touching the DOM during render is how a measurement ends up one frame stale.
  useLayoutEffect(() => {
    const probe = probeRef.current;
    if (!probe || rects.length === 0) { setFits([]); return; }
    const seen = new Map<string, number>();
    const measure: TmMeasure = (text, cls) => {
      const key = `${cls}|${text}`;
      let px = seen.get(key);
      if (px === undefined) {
        probe.className = `tm-probe ${cls}`;
        probe.textContent = text;
        px = probe.getBoundingClientRect().width;
        seen.set(key, px);
      }
      return px;
    };
    // The rendered box, not the raw rect: tiles are inset 1.5px per side, and sizing type against
    // 3px it does not have is how a name that "fits" arrives clipped.
    setFits(rects.map((r, i) => tmFit(
      sorted[i].label, sorted[i].amountHe, Math.max(0, r.w - 3), Math.max(0, r.h - 3), measure,
    )));
    probe.textContent = '';
  }, [rects, sorted, fontRev]);

  if (items.length === 0) return null;

  const tip = hi !== null ? sorted[hi] : null;
  return (
    <div
      className="tm-map" ref={ref} style={{ height }} role="img" aria-label={ariaLabel}
      onMouseLeave={() => setHi(null)}
      onMouseMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
    >
      {rects.map((r, i) => {
        const d = sorted[i];
        // Every tile carries the largest type its own box can hold — see tmFit. The tiers are the
        // same three as before (name+amount · amount alone · hover only), but a tile now falls to
        // the next one because the measurement said so, not because it missed a round number.
        const fit = fits[i] ?? { mode: 'none' as const, name: 0, val: 0 };
        return (
          <div
            key={d.id}
            className={`tm-tile${fit.mode === 'both' ? '' : ' sm'}${hi === i ? ' hot' : ''}`}
            style={{
              // inset by 1.5px each side so the card background shows through as a thin gap
              right: `${r.x + 1.5}px`, top: `${r.y + 1.5}px`,
              width: `${Math.max(0, r.w - 3)}px`, height: `${Math.max(0, r.h - 3)}px`, background: d.color,
              ...(onSelect ? { cursor: 'pointer' } : {}),
            }}
            onMouseEnter={() => setHi(i)}
            onClick={onSelect ? () => onSelect(d.id) : undefined}
            aria-label={`${d.label}: ${d.amountHe}`}
          >
            {fit.mode === 'both' && (
              <>
                <b className="tm-tile-name" style={{ fontSize: fit.name }}>{d.label}</b>
                <span className="tm-tile-val" style={{ fontSize: fit.val }}>{d.amountHe}</span>
              </>
            )}
            {fit.mode === 'val' && <span className="tm-tile-val" style={{ fontSize: fit.val }}>{d.amountHe}</span>}
          </div>
        );
      })}
      {/* the ruler: same font, same weight, same figure variant as a tile's own text, so what it
          measures is exactly what will be drawn. Empty except during a measurement. */}
      <div className="tm-probe" ref={probeRef} aria-hidden />
      {tip && (
        <div className="tm-tip" style={{ left: `${Math.max(8, Math.min(w - 8, pos.x))}px`, top: `${pos.y + 18}px` }}>
          <div className="tm-tip-name">{tip.label}</div>
          <div className="tm-tip-amt">{tip.amountHe} <span>לחודש</span></div>
          {tip.tip}
        </div>
      )}
    </div>
  );
}

/* ——— KPI bars: a few aggregates as thick horizontal bars over their previous-period ghosts ——— */

export interface KpiBarRow {
  label: string;
  value: number;
  /** The previous equal period's value — drawn as a thin ghost bar under the main one. */
  prev: number | null;
  color: string;
  /** Flips the delta tone: an expenses rise is bad. */
  goodWhenUp?: boolean;
}

export function KpiBars({ rows }: { rows: KpiBarRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.value), Math.abs(r.prev ?? 0)]));
  return (
    <div className="kpi-bars">
      {rows.map((r) => {
        const delta = r.prev !== null ? r.value - r.prev : null;
        const up = delta !== null && delta > 0;
        const good = delta !== null && up === (r.goodWhenUp ?? true);
        return (
          <div className="kpi-bar-row" key={r.label}>
            <span className="kpi-bar-label">{r.label}</span>
            <span className="kpi-bar-track">
              <i
                className="kpi-bar-fill"
                style={{ width: `${(Math.abs(r.value) / max) * 100}%`, background: r.value < 0 ? 'var(--negative)' : r.color }}
                title={r.prev !== null ? `התקופה הקודמת: ${ILS0.format(r.prev)}` : undefined}
              />
              {r.prev !== null && (
                <i
                  className={r.prev < 0 ? 'kpi-bar-ghost negative' : 'kpi-bar-ghost'}
                  style={{ width: `${(Math.abs(r.prev) / max) * 100}%` }}
                  title={`התקופה הקודמת: ${ILS0.format(r.prev)}${r.prev < 0 ? ' — במינוס' : ''}`}
                />
              )}
            </span>
            <span className="kpi-bar-value amount">{ILS0.format(r.value)}</span>
            <span className="kpi-bar-delta">
              {delta !== null && Math.abs(delta) >= 1 && (
                <span className={good ? 'tag good' : 'tag warn'} title="מול התקופה המקבילה הקודמת">
                  {up ? '▲' : '▼'} {ILS0.format(Math.abs(delta))}
                </span>
              )}
            </span>
          </div>
        );
      })}
      <p className="chart-caption">בר מלא = התקופה הנוכחית · הקו הדק מתחת = התקופה המקבילה הקודמת (אדום = הייתה במינוס)</p>
    </div>
  );
}

/* ——— layered area: the net-worth history decomposed by economic class ——— */

export interface AreaLayer {
  key: string;
  label: string;
  color: string;
  /** Aligned with `dates`; negatives (liabilities, card debt) stack below the zero line. */
  values: number[];
}

/** Stacked classes above zero, liabilities below, and the net line over everything —
 *  the sum of the layers IS the net line, so the chart cannot disagree with itself.
 *  Time flows left→right like every series chart; the era before `mutedBeforeIndex`
 *  is the back-filled manual convention and draws dimmed with a dashed net line (A5). */
export function LayeredArea({ dates, layers, height = 240, ariaLabel, mutedBeforeIndex, mutedBeforeLabel, netLabel = 'הון עצמי', currency }: {
  dates: string[];
  layers: AreaLayer[];
  height?: number;
  ariaLabel: string;
  mutedBeforeIndex?: number;
  mutedBeforeLabel?: string;
  netLabel?: string;
  currency?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const fmt = moneyFmt(currency);
  const n = dates.length;
  if (n < 2) return null;

  const visible = layers.filter((l) => l.values.some((v) => Math.abs(v) >= 0.01));
  const net = dates.map((_, i) => layers.reduce((s, l) => s + (l.values[i] ?? 0), 0));

  // stack positives up and negatives down, layer by layer, per index — a class that
  // flips sign mid-series (an overdrafted עו"ש) simply switches side on that day
  const upBase = dates.map(() => 0);
  const downBase = dates.map(() => 0);
  const bands = visible.map((l) => {
    const from = l.values.map((v, i) => (v >= 0 ? upBase[i] : downBase[i]));
    const to = l.values.map((v, i) => {
      if (v >= 0) { const t = upBase[i] + v; upBase[i] = t; return t; }
      const t = downBase[i] + v; downBase[i] = t; return t;
    });
    return { ...l, from, to };
  });

  const rawMax = Math.max(...upBase, 0);
  const rawMin = Math.min(...downBase, 0);
  const span = rawMax - rawMin || Math.abs(rawMax) || 1;
  const min = rawMin - span * 0.04;
  const max = rawMax + span * 0.06;

  const W = 720;
  const H = height;
  const PAD_L = 10;
  const PAD_R = 48;
  const PAD_T = 14;
  const PAD_B = 22;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (i / (n - 1)) * plotW;
  const y = (v: number) => PAD_T + ((max - v) / (max - min || 1)) * plotH;
  const ticks = niceTicks(min, max, 4);
  const muteTo = mutedBeforeIndex === undefined ? -1 : Math.min(mutedBeforeIndex, n - 1);

  const bandPoly = (b: { from: number[]; to: number[] }, i0: number, i1: number) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let i = i0; i <= i1; i++) {
      top.push(`${x(i)},${y(b.to[i])}`);
      bottom.unshift(`${x(i)},${y(b.from[i])}`);
    }
    return [...top, ...bottom].join(' ');
  };
  const netPts = (i0: number, i1: number) => {
    const pts: string[] = [];
    for (let i = i0; i <= i1; i++) pts.push(`${x(i)},${y(net[i])}`);
    return pts.join(' ');
  };
  const withYear = (Date.parse(dates[n - 1]) - Date.parse(dates[0])) / 86_400_000 > 300;
  const xLabelIdx = [0, Math.round((n - 1) / 2), n - 1];

  function onMove(e: React.MouseEvent) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((vx - PAD_L) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg ref={svgRef} className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseMove={onMove}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
            <text className="chart-axis-label" x={W - PAD_R + 6} y={y(t) + 3.5}>{shortILS(t)}</text>
          </g>
        ))}
        {bands.map((b) => (
          <g key={b.key}>
            {muteTo > 0 && (
              <polygon points={bandPoly(b, 0, muteTo)} fill={b.color} opacity={0.28} stroke="var(--surface)" strokeWidth={1.5} />
            )}
            <polygon
              points={bandPoly(b, Math.max(0, muteTo), n - 1)}
              fill={b.color} opacity={0.72} stroke="var(--surface)" strokeWidth={1.5}
            />
          </g>
        ))}
        <line className="chart-zero" x1={PAD_L} x2={W - PAD_R} y1={y(0)} y2={y(0)} />
        {/* the net line rides a surface halo so it stays crisp over the tinted bands */}
        {muteTo > 0 && (
          <polyline points={netPts(0, muteTo)} fill="none" stroke="var(--surface)" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" opacity={0.7} />
        )}
        <polyline points={netPts(Math.max(0, muteTo), n - 1)} fill="none" stroke="var(--surface)" strokeWidth={5} strokeLinejoin="round" strokeLinecap="round" />
        {muteTo > 0 && (
          <polyline points={netPts(0, muteTo)} fill="none" style={{ stroke: 'var(--ink)' }} strokeWidth={2.5} strokeDasharray="4 4" opacity={0.45} strokeLinejoin="round" strokeLinecap="round" />
        )}
        <polyline points={netPts(Math.max(0, muteTo), n - 1)} fill="none" style={{ stroke: 'var(--ink)' }} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {muteTo > 0 && (
          <g>
            <line className="chart-grid" x1={x(muteTo)} x2={x(muteTo)} y1={PAD_T} y2={H - PAD_B} style={{ strokeOpacity: 0.7 }} />
            {mutedBeforeLabel && (
              <text
                className="chart-axis-label"
                x={x(muteTo) > PAD_L + 150 ? x(muteTo) - 5 : x(muteTo) + 5}
                y={PAD_T + 4}
                textAnchor={x(muteTo) > PAD_L + 150 ? 'end' : 'start'}
              >
                {mutedBeforeLabel}
              </text>
            )}
          </g>
        )}
        <circle cx={x(n - 1)} cy={y(net[n - 1])} r={4} style={{ fill: 'var(--ink)', stroke: 'var(--surface)', strokeWidth: 2 }} />
        <text
          className="chart-axis-label" x={x(n - 1) - 8} y={Math.max(PAD_T + 10, y(net[n - 1]) - 10)}
          textAnchor="end" style={{ fill: 'var(--ink)', fontWeight: 650 }}
        >
          {netLabel} {shortILS(net[n - 1])}
        </text>
        {hover !== null && (
          <g>
            <line className="chart-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} />
            <circle className="chart-hover-dot" cx={x(hover)} cy={y(net[hover])} r={4.5} />
          </g>
        )}
        {xLabelIdx.map((i, k) => (
          <text
            key={i}
            className="chart-axis-label"
            x={x(i)}
            y={H - 6}
            textAnchor={k === 0 ? 'start' : k === xLabelIdx.length - 1 ? 'end' : 'middle'}
          >
            {dayLabelHe(dates[i], withYear)}
          </text>
        ))}
      </svg>
      <div className="chart-inline-legend">
        {[...visible].reverse().map((l) => (
          <span key={l.key}><i style={{ background: l.color }} /> {l.label}</span>
        ))}
        <span><i style={{ background: 'var(--ink)' }} /> {netLabel}</span>
      </div>
      {hover !== null && (
        <Tip xPct={(x(hover) / W) * 100} yPct={(y(net[hover]) / H) * 100}>
          <div className="tip-title">{dayLabelHe(dates[hover], withYear)}</div>
          <div className="tip-row"><span>{netLabel}</span><span className="amount">{fmt.format(net[hover])}</span></div>
          {visible.map((l) => (
            Math.abs(l.values[hover]) >= 0.01 ? (
              <div className="tip-row" key={l.key}>
                <span>{l.label}</span>
                <span className="amount" style={{ color: l.values[hover] < 0 ? 'var(--negative)' : undefined }}>{fmt.format(l.values[hover])}</span>
              </div>
            ) : null
          ))}
        </Tip>
      )}
    </div>
  );
}

/* ——— balance sheet: two equal columns that make Assets = Liabilities + Equity obvious ——— */

/** The accounting identity, drawn: a right column of assets (stacked by class) and a left column of
 *  the SAME total split into liabilities (red, below) + equity (green, above). Equal heights, always
 *  — that's the law — with a dashed "=" bridging their tops. Reads far clearer than two thin bars. */
export function BalanceColumns({ assets, assetsTotal, liabilities, netWorth, format }: {
  assets: Array<{ id: string; label: string; color: string; value: number }>;
  assetsTotal: number;
  liabilities: number;
  netWorth: number;
  format: (v: number) => string;
}) {
  if (assetsTotal < 1) return null;
  const W = 720;
  const H = 300;
  const topY = 62;
  const botY = 268;
  const colH = botY - topY;
  const colW = 116;
  const rcx = 452; // assets column centre (right, RTL-first)
  const lcx = 268; // liabilities + equity column centre (left)
  const scale = colH / assetsTotal;

  type Seg = { label: string; value: number; color: string; tone?: 'pos' | 'neg' };
  // assets biggest-first so the dominant holding anchors the base of the stack
  const rightSegs: Seg[] = assets.map((a) => ({ label: a.label, value: a.value, color: a.color })).sort((a, b) => b.value - a.value);
  // liabilities at the base, equity above — the conventional balance-sheet order
  const leftSegs: Seg[] = [
    ...(liabilities >= 1 ? [{ label: 'התחייבויות', value: liabilities, color: 'var(--negative)', tone: 'neg' as const }] : []),
    ...(netWorth >= 1 ? [{ label: 'הון עצמי', value: netWorth, color: 'var(--positive)', tone: 'pos' as const }] : []),
  ];

  const col = (cx: number, segs: Seg[], side: 'right' | 'left') => {
    const x = cx - colW / 2;
    // stack from the baseline up — the first segment sits at the bottom
    let yy = botY;
    const laid = segs.map((s) => {
      const h = s.value * scale;
      yy -= h;
      return { s, y: yy, h, cy: yy + h / 2 };
    });
    // spread labels in top→bottom order (independent of stack direction) so slivers never overprint
    const order = laid.map((l, i) => ({ i, cy: l.cy })).sort((a, b) => a.cy - b.cy);
    const spread = spreadLabels(order.map((o) => o.cy), 30, topY + 8, botY);
    const labelY: number[] = [];
    order.forEach((o, k) => { labelY[o.i] = spread[k]; });
    const labelX = side === 'right' ? x + colW + 10 : x - 10;
    const edgeX = side === 'right' ? x + colW : x;
    const anchor = side === 'right' ? 'start' : 'end';
    return (
      <g>
        {laid.map((l, i) => (
          <rect key={`r${i}`} x={x} y={l.y} width={colW} height={Math.max(1, l.h - 1.5)} rx={3} fill={l.s.color}>
            <title>{`${l.s.label} · ${format(l.s.value)}`}</title>
          </rect>
        ))}
        {laid.map((l, i) => (
          <g key={`l${i}`}>
            {Math.abs(labelY[i] - l.cy) > 4 && (
              <line className="sankey-leader" x1={edgeX} y1={l.cy} x2={labelX + (side === 'right' ? -1 : 1)} y2={labelY[i] - 4} />
            )}
            <text
              className="bal-name"
              x={labelX}
              y={labelY[i] - 3}
              textAnchor={anchor}
              style={l.s.tone === 'pos' ? { fill: 'var(--positive)' } : l.s.tone === 'neg' ? { fill: 'var(--negative)' } : undefined}
            >
              {l.s.label}
            </text>
            <text className="bal-value" x={labelX} y={labelY[i] + 13} textAnchor={anchor}>{format(l.s.value)}</text>
          </g>
        ))}
      </g>
    );
  };

  return (
    <div className="chart-wrap">
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="נכסים מול התחייבויות והון עצמי">
        {/* equal-height bridge across the tops — the whole point: the two sides always match */}
        <line x1={lcx} x2={rcx} y1={topY} y2={topY} stroke="var(--ink-subtle)" strokeWidth={1.4} strokeDasharray="2 4" opacity={0.6} />
        <text className="bal-eq" x={(lcx + rcx) / 2} y={topY - 5} textAnchor="middle">=</text>
        <text className="bal-total" x={rcx} y={topY - 9} textAnchor="middle">{format(assetsTotal)}</text>
        <text className="bal-total" x={lcx} y={topY - 9} textAnchor="middle">{format(assetsTotal)}</text>
        {col(rcx, rightSegs, 'right')}
        {col(lcx, leftSegs, 'left')}
        <line x1={40} x2={W - 40} y1={botY + 0.5} y2={botY + 0.5} className="chart-grid" style={{ strokeOpacity: 0.5 }} />
        <text className="bal-cap" x={rcx} y={botY + 20} textAnchor="middle">נכסים</text>
        <text className="bal-cap" x={lcx} y={botY + 20} textAnchor="middle">{liabilities >= 1 ? 'התחייבויות + הון' : 'הון עצמי'}</text>
      </svg>
    </div>
  );
}

/* ——— waterfall: where the change in equity came from ——— */

export interface WaterfallStep {
  key: string;
  label: string;
  value: number;
  /** totals anchor to the axis floor; deltas float from the running level. */
  kind: 'total' | 'delta';
}

/** The change bridge: opening equity, money in, money out, revaluation, closing equity.
 *  Drawn right→left — the story starts in the past, and in Hebrew the past sits on the right.
 *  The axis floats just under the smallest level to magnify the bridge; the caller's caption
 *  must say so (an unlabeled truncated axis is a lie). */
export function Waterfall({ steps, height = 230, ariaLabel, currency }: {
  steps: WaterfallStep[];
  height?: number;
  ariaLabel: string;
  currency?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const fmt = moneyFmt(currency);
  if (steps.length < 2) return null;

  // running levels: each delta bar spans [level, level+value]
  let level = 0;
  const spans = steps.map((s) => {
    if (s.kind === 'total') { level = s.value; return { lo: Math.min(s.value, 0), hi: Math.max(s.value, 0), start: 0, end: s.value }; }
    const start = level;
    level += s.value;
    return { lo: Math.min(start, level), hi: Math.max(start, level), start, end: level };
  });
  const rawMin = Math.min(...spans.map((s) => s.lo));
  const rawMax = Math.max(...spans.map((s) => s.hi));
  const span = rawMax - rawMin || 1;
  const floor = rawMin - span * 0.1;
  const top = rawMax + span * 0.12;

  const W = 720;
  const H = height;
  const PAD_L = 10;
  const PAD_R = 48;
  const PAD_T = 14;
  const PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const groupW = plotW / steps.length;
  const barW = Math.min(84, groupW * 0.62);
  // RTL story: step 0 sits on the RIGHT
  const cx = (i: number) => W - PAD_R - (i + 0.5) * groupW;
  const y = (v: number) => PAD_T + ((top - v) / (top - floor || 1)) * plotH;
  const ticks = niceTicks(floor, top, 3);

  const fill = (s: WaterfallStep) =>
    s.kind === 'total' ? 'var(--accent)' : s.value >= 0 ? 'var(--positive)' : 'var(--negative)';

  return (
    <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} />
            <text className="chart-axis-label" x={W - PAD_R + 6} y={y(t) + 3.5}>{shortILS(t)}</text>
          </g>
        ))}
        {steps.map((s, i) => {
          if (i === 0) return null;
          // connector: the running level carries from the previous bar to this one
          const lvl = spans[i - 1].end;
          return (
            <line
              key={`c-${s.key}`}
              x1={cx(i - 1) - barW / 2} x2={cx(i) + barW / 2}
              y1={y(lvl)} y2={y(lvl)}
              className="chart-grid" strokeDasharray="3 3" style={{ strokeOpacity: 0.9 }}
            />
          );
        })}
        {steps.map((s, i) => {
          const sp = spans[i];
          const rectTop = s.kind === 'total' ? y(sp.end) : y(sp.hi);
          const h = Math.max(2, (s.kind === 'total' ? y(floor) : y(sp.lo)) - rectTop);
          const dim = hover !== null && hover !== i;
          return (
            <g key={s.key} style={{ opacity: dim ? 0.5 : 1, transition: 'opacity 150ms ease' }}>
              <rect x={cx(i) - barW / 2} y={rectTop} width={barW} height={h} rx={3.5} fill={fill(s)} opacity={s.kind === 'total' ? 0.88 : 0.82} />
              <text
                className="chart-axis-label"
                x={cx(i)} y={Math.max(PAD_T + 8, rectTop - 6)}
                textAnchor="middle" style={{ fill: 'var(--ink)', fontWeight: 650 }}
              >
                {s.kind === 'delta' && s.value >= 0 ? `+${shortILS(s.value)}` : shortILS(s.value)}
              </text>
              <text className="chart-axis-label" x={cx(i)} y={H - 8} textAnchor="middle">{s.label}</text>
              <rect
                className="bar-hit" x={cx(i) - groupW / 2} y={0} width={groupW} height={H}
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {hover !== null && steps[hover] && (
        <Tip xPct={(cx(hover) / W) * 100} yPct={8}>
          <div className="tip-title">{steps[hover].label}</div>
          <div className="tip-row">
            <span>{steps[hover].kind === 'total' ? 'הון עצמי' : 'שינוי'}</span>
            <span className="amount">{fmt.format(steps[hover].value)}</span>
          </div>
          {steps[hover].kind === 'delta' && (
            <div className="tip-row"><span>רמה אחרי</span><span className="amount muted">{fmt.format(spans[hover].end)}</span></div>
          )}
        </Tip>
      )}
    </div>
  );
}

/* ——— callout pie: a whole split into labeled parts, each with its arrow ——— */

export interface PieCallout {
  id: string;
  label: string;
  value: number;
  color: string;
  /** vs the previous equal period; `goodWhenUp` decides the chip's tone (an expense rise is bad). */
  delta?: { amount: number; goodWhenUp: boolean } | null;
}

/** The pie the user asked for, with explaining arrows: each slice gets a leader-line
 *  arrow to its label, and the TOTAL sits in the pie's center hole — "the whole cake"
 *  needs no arrow when it is literally written inside the cake. Familiar, zero decoding. */
export function CalloutPie({ total, slices, ariaLabel, currency }: {
  total: PieCallout;
  slices: PieCallout[];
  ariaLabel: string;
  currency?: string;
}) {
  const markerId = useId().replace(/:/g, '');
  const [hover, setHover] = useState<string | null>(null);
  const fmt = moneyFmt(currency);
  const shown = slices.filter((s) => s.value >= 1);
  const totalValue = Math.max(total.value, shown.reduce((s, x) => s + x.value, 0)) || 1;
  if (shown.length === 0) return null;

  const W = 720;
  const H = 300;
  const CX = 360;
  const CY = 152;
  const R = 112;
  const HOLE = 66; // the center carries the total — the hole is its stage
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const pt = (deg: number, r: number) => ({ x: CX + r * Math.cos(rad(deg)), y: CY + r * Math.sin(rad(deg)) });

  // wedges start at the top and run clockwise; each remembers its mid-angle for the arrow
  let acc = -90;
  const wedges = shown.map((s) => {
    const sweep = (s.value / totalValue) * 360;
    const start = acc;
    const end = acc + sweep;
    acc = end;
    const mid = (start + end) / 2;
    const a = pt(start, R);
    const b = pt(end, R);
    const path = sweep >= 359.9
      ? `M ${CX - R},${CY} A ${R},${R} 0 1 1 ${CX + R},${CY} A ${R},${R} 0 1 1 ${CX - R},${CY} Z`
      : `M ${CX},${CY} L ${a.x},${a.y} A ${R},${R} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x},${b.y} Z`;
    return { ...s, path, mid, share: Math.round((s.value / totalValue) * 100) };
  });

  /** A slice's callout: rim → elbow on its own angle → a horizontal run to the side column.
   *  The label block clamps vertically so its three lines (name, value, delta chip) always
   *  fit inside the viewBox — a slice pointing straight down must not push its chip off-canvas. */
  const callout = (w: (typeof wedges)[number]) => {
    const right = Math.cos(rad(w.mid)) >= 0;
    const rim = pt(w.mid, R - 4);
    const raw = pt(w.mid, R + 24);
    const elbow = { x: raw.x, y: Math.max(30, Math.min(H - 34, raw.y)) };
    const endX = right ? CX + R + 74 : CX - R - 74;
    const textX = right ? endX + 8 : endX - 8;
    const anchor = right ? 'start' : 'end';
    const chip = w.delta && Math.abs(w.delta.amount) >= 1
      ? { text: `${w.delta.amount >= 0 ? '▲' : '▼'} ${fmt.format(Math.abs(w.delta.amount))}`, good: w.delta.amount >= 0 === w.delta.goodWhenUp }
      : null;
    return (
      <g key={w.id} style={{ opacity: hover && hover !== w.id ? 0.45 : 1, transition: 'opacity 150ms ease' }}>
        <path
          d={`M ${textX - (right ? 4 : -4)},${elbow.y} L ${elbow.x},${elbow.y} L ${rim.x},${rim.y}`}
          fill="none" stroke="var(--ink-subtle)" strokeWidth={1.3} markerEnd={`url(#arr-${markerId})`}
        />
        <text className="chart-axis-label" x={textX} y={elbow.y - 8} textAnchor={anchor}>{w.label}</text>
        <text x={textX} y={elbow.y + 10} textAnchor={anchor} style={{ fill: 'var(--ink)', fontWeight: 700, fontSize: 17 }}>
          {fmt.format(w.value)} · {w.share}%
        </text>
        {chip && (
          <text x={textX} y={elbow.y + 26} textAnchor={anchor} style={{ fill: chip.good ? 'var(--positive)' : 'var(--negative)', fontSize: 14 }}>
            {chip.text}
          </text>
        )}
      </g>
    );
  };

  const totalChip = total.delta && Math.abs(total.delta.amount) >= 1
    ? { text: `${total.delta.amount >= 0 ? '▲' : '▼'} ${fmt.format(Math.abs(total.delta.amount))}`, good: total.delta.amount >= 0 === total.delta.goodWhenUp }
    : null;

  return (
    <div className="chart-wrap" dir="ltr" onMouseLeave={() => setHover(null)}>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        <defs>
          <marker id={`arr-${markerId}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-subtle)" />
          </marker>
        </defs>
        {wedges.map((w) => (
          <path
            key={w.id}
            d={w.path}
            fill={w.color}
            opacity={hover && hover !== w.id ? 0.4 : 0.9}
            stroke="var(--surface)"
            strokeWidth={2}
            style={{ transition: 'opacity 150ms ease', cursor: 'default' }}
            onMouseEnter={() => setHover(w.id)}
          >
            <title>{`${w.label}: ${fmt.format(w.value)} — ${w.share}% מתוך ${total.label}`}</title>
          </path>
        ))}
        {/* the whole cake, written inside the cake: the center hole carries the total —
            an arrow at the rim reads as pointing at a slice, so no arrow at all */}
        <circle cx={CX} cy={CY} r={HOLE} fill="var(--surface)" />
        <text className="chart-axis-label" x={CX} y={CY - 22} textAnchor="middle">{total.label}</text>
        <text x={CX} y={CY + 4} textAnchor="middle" style={{ fill: 'var(--ink)', fontWeight: 750, fontSize: 21 }}>
          {fmt.format(total.value)}
        </text>
        {totalChip && (
          <text x={CX} y={CY + 26} textAnchor="middle" style={{ fill: totalChip.good ? 'var(--positive)' : 'var(--negative)', fontSize: 14 }}>
            {totalChip.text}
          </text>
        )}
        {wedges.map(callout)}
      </svg>
    </div>
  );
}

/* ——— sparkline: a holding's value timeline in a table row ——— */

export function Sparkline({ values, color = 'var(--accent)', width = 64, height = 18 }: {
  values: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${2 + (i / (values.length - 1)) * (width - 4)},${height - 3 - ((v - min) / span) * (height - 6)}`)
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
    </svg>
  );
}
