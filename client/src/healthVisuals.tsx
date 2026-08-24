import type { Metric, MetricVisual, VisualMarker } from './types';

type BulletVisual = Extract<MetricVisual, { kind: 'bullet' }>;
type SegmentsVisual = Extract<MetricVisual, { kind: 'segments' }>;
type TrendVisual = Extract<MetricVisual, { kind: 'trend' }>;
type CompositionVisual = Extract<MetricVisual, { kind: 'composition' }>;
type MonthOutcomesVisual = Extract<MetricVisual, { kind: 'month-outcomes' }>;
type OverdraftVisual = Extract<MetricVisual, { kind: 'overdraft' }>;
type SubscriptionsVisual = Extract<MetricVisual, { kind: 'subscriptions' }>;
type ComparisonVisual = Extract<MetricVisual, { kind: 'comparison' }>;

const ILS = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
});
const ILS_COMPACT = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', notation: 'compact', maximumFractionDigits: 1,
});
const PERCENT = new Intl.NumberFormat('he-IL', {
  style: 'percent', maximumFractionDigits: 1,
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function position(value: number, min: number, max: number): number {
  return ((clamp(value, min, max) - min) / (max - min || 1)) * 100;
}

function shortMonth(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'short' });
}

function markerLabels(markers: VisualMarker[], min: number, max: number) {
  return (
    <div className="metric-scale-labels">
      {markers.map((marker, index) => {
        const markerPosition = position(marker.value, min, max);
        const transform = markerPosition <= 2 ? 'none' : markerPosition >= 98 ? 'translateX(-100%)' : 'translateX(-50%)';
        return (
          <span
            key={`${marker.value}-${index}`}
            className="metric-scale-label"
            style={{ left: `${markerPosition}%`, transform }}
          >
            {marker.labelHe}
          </span>
        );
      })}
    </div>
  );
}

function BulletChart({ visual }: { visual: BulletVisual }) {
  const valuePosition = position(visual.value, visual.min, visual.max);
  const zones = visual.zones.map((zone, index) => (
    <span
      key={`${zone.from}-${index}`}
      className={`bullet-zone metric-zone-${zone.band}`}
      style={{
        left: `${position(zone.from, visual.min, visual.max)}%`,
        width: `${position(zone.to, visual.min, visual.max) - position(zone.from, visual.min, visual.max)}%`,
      }}
    />
  ));

  return (
    <div className="bullet-chart">
      <div className="bullet-track">
        {/* the scale at rest: pale zones — context, not the story */}
        <span className="bullet-zones">{zones}</span>
        {/* the story: the same zones at full strength, cut exactly at the needle —
            the bar reads as FILLED up to where you stand, faded where you are not */}
        <span
          className="bullet-zones bullet-zones-fill"
          style={{ clipPath: `inset(0 ${100 - valuePosition}% 0 0)` }}
        >
          {zones}
        </span>
        {visual.markers.map((marker, index) => (
          <span
            key={`${marker.value}-${index}`}
            className="metric-threshold"
            style={{ left: `${position(marker.value, visual.min, visual.max)}%` }}
          />
        ))}
        <span className="metric-current" style={{ left: `${valuePosition}%` }}>
          <span className="metric-current-dot" />
        </span>
      </div>
      {markerLabels(visual.markers, visual.min, visual.max)}
    </div>
  );
}

function RunwayChart({ visual }: { visual: SegmentsVisual }) {
  const cells = Array.from({ length: visual.max }, (_, index) => {
    const fill = clamp((visual.value - index) * 100, 0, 100);
    return (
      <span className="runway-cell" key={index}>
        <span className="runway-fill" style={{ width: `${fill}%` }} />
        <span className="runway-number">{index + 1}</span>
      </span>
    );
  });

  return (
    <div className="runway-chart">
      <div className="runway-cells">{cells}</div>
      {markerLabels(visual.markers, 0, visual.max)}
    </div>
  );
}

function TrendChart({ visual, metricId }: { visual: TrendVisual; metricId: string }) {
  if (visual.points.length === 0) return null;

  const W = 420;
  const H = 116;
  const padX = 10;
  const padTop = 9;
  const padBottom = 20;
  const values = [...visual.points.map((point) => point.value), ...visual.references.map((ref) => ref.value)];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rawSpan = rawMax - rawMin;
  const padding = rawSpan > 0 ? rawSpan * 0.12 : Math.max(Math.abs(rawMax) * 0.08, 1);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const plotW = W - padX * 2;
  const plotH = H - padTop - padBottom;
  const x = (index: number) => padX + (index / Math.max(1, visual.points.length - 1)) * plotW;
  const y = (value: number) => padTop + ((max - value) / (max - min || 1)) * plotH;
  const line = visual.points.map((point, index) => `${x(index)},${y(point.value)}`).join(' ');
  const dangerReference = visual.references.find((ref) => ref.tone === 'danger');
  const recentStart = Math.max(0, visual.points.length - 3);
  const shadeX = visual.points.length > 1 ? Math.max(padX, x(recentStart) - plotW / visual.points.length / 2) : padX;

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {metricId === 'discretionary-trend' && (
          <rect className="trend-recent" x={shadeX} y={padTop} width={W - padX - shadeX} height={plotH} rx={6} />
        )}
        {visual.references.map((ref, index) => (
          <line
            key={`${ref.value}-${index}`}
            className={ref.tone === 'danger' ? 'trend-reference danger' : 'trend-reference'}
            x1={padX}
            x2={W - padX}
            y1={y(ref.value)}
            y2={y(ref.value)}
          />
        ))}
        <polyline className="health-trend-line" points={line} />
        {visual.points.map((point, index) => {
          const isDanger = dangerReference !== undefined && (
            dangerReference.dangerDirection === 'above'
              ? point.value > dangerReference.value
              : point.value < dangerReference.value
          );
          return isDanger ? (
            <rect
              key={point.label}
              className="health-trend-dip"
              x={x(index) - 3.2}
              y={y(point.value) - 3.2}
              width={6.4}
              height={6.4}
              transform={`rotate(45 ${x(index)} ${y(point.value)})`}
            />
          ) : (
            <circle key={point.label} className="health-trend-point" cx={x(index)} cy={y(point.value)} r={2.8} />
          );
        })}
        <text className="health-chart-label" x={padX} y={H - 4} textAnchor="start">
          {shortMonth(visual.points[0].label)}
        </text>
        <text className="health-chart-label" x={W - padX} y={H - 4} textAnchor="end">
          {shortMonth(visual.points.at(-1)!.label)}
        </text>
      </svg>
      <div className="health-reference-legend">
        {visual.references.map((ref, index) => (
          <span key={`${ref.labelHe}-${index}`}>
            <i className={ref.tone === 'danger' ? 'reference-swatch danger' : 'reference-swatch'} />
            {ref.labelHe} <b className="amount">{ILS_COMPACT.format(ref.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function CompositionChart({ visual }: { visual: CompositionVisual }) {
  const usedPct = clamp(visual.ratio * 100, 0, 100);
  const remainder = Math.max(0, visual.total - visual.used);

  return (
    <div className="composition-chart">
      <div className="composition-track">
        <span className="composition-used" style={{ width: `${usedPct}%` }} />
        <span className="composition-rest" style={{ width: `${100 - usedPct}%` }} />
        {visual.markers.map((marker, index) => (
          <span
            key={`${marker.value}-${index}`}
            className="metric-threshold"
            style={{ left: `${clamp(marker.value * 100, 0, 100)}%` }}
          />
        ))}
      </div>
      {markerLabels(visual.markers, 0, 1)}
      <div className="composition-legend">
        <span><i className="composition-dot used" />{visual.usedLabelHe} <b className="amount">{ILS.format(visual.used)}</b></span>
        <span><i className="composition-dot rest" />{visual.remainderLabelHe} <b className="amount">{ILS.format(remainder)}</b></span>
        {visual.ratio > 1 && <span className="composition-overflow">חריגה {PERCENT.format(visual.ratio - 1)}</span>}
      </div>
    </div>
  );
}

/** Twelve labels fit a wide tile; twenty-four never will — on the שנתיים basis each column is
 *  22px and "אוק׳" wants 26, so every label clipped. Past the density the strip keeps its SPAN
 *  (first and last) and drops the rest, which is all a ± strip is read for anyway. The dropped
 *  ones still render a non-breaking space, so the row keeps its height and the bars stay aligned. */
const MONTH_LABEL_ALL_UP_TO = 8;

function MonthOutcomesChart({ visual }: { visual: MonthOutcomesVisual }) {
  const max = Math.max(1, ...visual.points.map((point) => Math.abs(point.value)));
  const sparse = visual.points.length > MONTH_LABEL_ALL_UP_TO;
  const labelled = (index: number) => !sparse || index === 0 || index === visual.points.length - 1;

  return (
    <div className="month-outcomes" style={{ gridTemplateColumns: `repeat(${visual.points.length}, minmax(0, 1fr))` }}>
      {visual.points.map((point, index) => {
        const positive = point.value > 0;
        const neutral = point.value === 0;
        const height = neutral ? 0 : Math.max(5, (Math.abs(point.value) / max) * 42);
        return (
          <span className="month-outcome" key={point.label}>
            <span className="month-outcome-plot">
              <i className="month-zero" />
              {!neutral && (
                <i
                  className={positive ? 'month-net positive' : 'month-net negative'}
                  style={positive ? { height: `${height}%`, bottom: '50%' } : { height: `${height}%`, top: '50%' }}
                />
              )}
              <b className={neutral ? 'month-sign neutral' : positive ? 'month-sign positive' : 'month-sign negative'}>
                {neutral ? '0' : positive ? '+' : '−'}
              </b>
            </span>
            {/* sparse: the two survivors may spill into the blank cells beside them — on a phone a
                column is 11px and the month name wants 16, and clipping it helps nobody */}
            <span className={sparse ? 'month-label spill' : 'month-label'}>
              {labelled(index) ? shortMonth(point.label) : ' '}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function OverdraftChart({ visual }: { visual: OverdraftVisual }) {
  if (visual.points.length === 0) return null;

  // A wider viewBox than the other charts on purpose: this one owns the widest tile in the bento
  // (h-4x2), and an aspect of 420:132 would render 195px tall inside a 619px-wide card — taller
  // than the tile. 560:132 lands at 146px and fills the width edge to edge, with no letterboxing
  // and no clipping. The geometry below is all derived from W, so nothing else moves.
  const W = 560;
  const H = 132;
  const padX = 10;
  const topY = 8;
  const lineH = 68;
  const barsTop = 88;
  const barsH = 26;
  const plotW = W - padX * 2;
  const balances = [...visual.points.map((point) => point.minBalance), 0];
  const rawMin = Math.min(...balances);
  const rawMax = Math.max(...balances);
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax), 1);
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;
  const x = (index: number) => padX + (index / Math.max(1, visual.points.length - 1)) * plotW;
  const y = (value: number) => topY + ((max - value) / (max - min || 1)) * lineH;
  const maxDays = Math.max(1, ...visual.points.map((point) => point.daysBelowZero));
  const line = visual.points.map((point, index) => `${x(index)},${y(point.minBalance)}`).join(' ');
  const barW = Math.min(20, plotW / visual.points.length * 0.5);

  return (
    <div className="overdraft-chart">
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <line className="overdraft-zero" x1={padX} x2={W - padX} y1={y(0)} y2={y(0)} />
        <polyline className="health-trend-line" points={line} />
        {visual.points.map((point, index) => (
          <g key={point.label}>
            <circle className={point.minBalance < 0 ? 'health-trend-point danger' : 'health-trend-point'} cx={x(index)} cy={y(point.minBalance)} r={3} />
            <rect
              className={point.daysBelowZero > 0 ? 'overdraft-days active' : 'overdraft-days'}
              x={x(index) - barW / 2}
              y={barsTop + barsH - (point.daysBelowZero / maxDays) * barsH}
              width={barW}
              height={(point.daysBelowZero / maxDays) * barsH}
              rx={2}
            />
          </g>
        ))}
        <line className="overdraft-bars-base" x1={padX} x2={W - padX} y1={barsTop + barsH} y2={barsTop + barsH} />
        {visual.points.length === 1 ? (
          <text className="health-chart-label" x={W / 2} y={H - 3} textAnchor="middle">{shortMonth(visual.points[0].label)}</text>
        ) : (
          <>
            <text className="health-chart-label" x={padX} y={H - 3} textAnchor="start">{shortMonth(visual.points[0].label)}</text>
            <text className="health-chart-label" x={W - padX} y={H - 3} textAnchor="end">{shortMonth(visual.points.at(-1)!.label)}</text>
          </>
        )}
      </svg>
      <div className="overdraft-legend">
        <span><i className="line-swatch" />שפל חודשי</span>
        <span><i className="bar-swatch" />ימי מינוס</span>
        <span className={visual.slope !== null && visual.slope < visual.declineThreshold ? 'danger-text amount' : 'amount'}>
          מגמה: {visual.slope === null ? '—' : `${ILS.format(visual.slope)}/חודש`}
        </span>
      </div>
    </div>
  );
}

function SubscriptionsChart({ visual }: { visual: SubscriptionsVisual }) {
  const scaleMax = Math.max(0.15, Math.ceil(visual.share * 20) / 20);
  const maxItem = Math.max(1, ...visual.items.map((item) => item.value));
  const zones: BulletVisual['zones'] = [
    { from: 0, to: 0.05, band: 'green' },
    { from: 0.05, to: 0.1, band: 'yellow' },
    { from: 0.1, to: scaleMax, band: 'red' },
  ];

  return (
    <div className="subscriptions-chart">
      <BulletChart visual={{ kind: 'bullet', value: visual.share, min: 0, max: scaleMax, format: 'percent', zones, markers: visual.markers }} />
      {/* never empty: the metric renders a visual only when the household marked at least one מנוי,
          and goes 'na' — with no visual at all — when it did not */}
      <div className="subscription-items">
        {visual.items.slice(0, 3).map((item) => (
          <div className="subscription-item" key={item.label}>
            <span className="subscription-name" title={item.label}>{item.label}</span>
            <span className="subscription-bar"><i style={{ width: `${(item.value / maxItem) * 100}%` }} /></span>
            <b className="amount">{ILS.format(item.value)}</b>
          </div>
        ))}
        {visual.items.length > 3 && <div className="subscriptions-more">ועוד {visual.items.length - 3}</div>}
      </div>
    </div>
  );
}

function ComparisonChart({ visual }: { visual: ComparisonVisual }) {
  const max = Math.max(1, visual.primary, visual.reference) * 1.08;
  const ratioMax = Math.max(1.2, Math.ceil(visual.ratio * 10) / 10);

  return (
    <div className="comparison-chart">
      <div className="comparison-row">
        <span>{visual.referenceLabelHe}</span>
        <span className="comparison-bar"><i className="reference" style={{ width: `${(visual.reference / max) * 100}%` }} /></span>
        <b className="amount">{ILS.format(visual.reference)}</b>
      </div>
      <div className="comparison-row">
        <span>{visual.primaryLabelHe}</span>
        <span className="comparison-bar"><i className="primary" style={{ width: `${(visual.primary / max) * 100}%` }} /></span>
        <b className="amount">{ILS.format(visual.primary)}</b>
      </div>
      <div className="ratio-scale">
        <span className="ratio-fill" style={{ width: `${position(visual.ratio, 0, ratioMax)}%` }} />
        {visual.markers.map((marker, index) => (
          <span key={`${marker.value}-${index}`} className="metric-threshold" style={{ left: `${position(marker.value, 0, ratioMax)}%` }} />
        ))}
      </div>
      {markerLabels(visual.markers, 0, ratioMax)}
    </div>
  );
}

export function HealthMetricVisual({ metric }: { metric: Metric }) {
  if (!metric.visual) {
    // The tile says WHY on its face. "אין מספיק נתונים להצגה" was true and useless; the metric's
    // own reason names the missing thing — and half of them are one click of his away from being
    // measurable ("חיוב אחד נראה כמו מנוי ומחכה להחלטה שלך").
    return (
      <div className="metric-visual metric-visual-empty">
        <span className="empty-visual-rail" aria-hidden="true"><i /><i /><i /><i /><i /><i /></span>
        <span className="empty-visual-why">{metric.detailHe}</span>
      </div>
    );
  }

  const visual = metric.visual;
  let content;
  switch (visual.kind) {
    case 'bullet': content = <BulletChart visual={visual} />; break;
    case 'segments': content = <RunwayChart visual={visual} />; break;
    case 'trend': content = <TrendChart visual={visual} metricId={metric.id} />; break;
    case 'composition': content = <CompositionChart visual={visual} />; break;
    case 'month-outcomes': content = <MonthOutcomesChart visual={visual} />; break;
    case 'overdraft': content = <OverdraftChart visual={visual} />; break;
    case 'subscriptions': content = <SubscriptionsChart visual={visual} />; break;
    case 'comparison': content = <ComparisonChart visual={visual} />; break;
  }

  return (
    <div className={`metric-visual visual-band-${metric.band}`} aria-hidden="true">
      {content}
    </div>
  );
}
