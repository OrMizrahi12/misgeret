import { useEffect, useState } from 'react';
import { api, errorMessageHe } from './api';
import { Explain, ExplainH } from './Explain';
import { HealthMetricVisual } from './healthVisuals';
import type { Band, HealthReport, Metric } from './types';

const BAND_LABELS: Record<Band, string> = {
  green: 'תקין',
  yellow: 'לתשומת לב',
  red: 'פגיע',
  na: 'אין נתונים',
};

const AXIS_LABELS: Record<Metric['axis'], string> = { level: 'רמה', resilience: 'עמידות' };

/** The user-chosen time basis — "life is dynamic", so the window is theirs to set. */
const BASES = [
  { months: 3, label: '3 חוד׳' },
  { months: 6, label: '6 חוד׳' },
  { months: 12, label: 'שנה' },
  { months: 24, label: 'שנתיים' },
];

const BASE_KEY = 'misgeret-health-months';

/**
 * The bento, tile by tile. Two facts decide a tile's size, in this order:
 *
 * 1. **What the verdict is made of.** The six core metrics carry the פסיקה, so they get the big
 *    tiles; context metrics can pull a grade down and never sink it, so they ride smaller. The
 *    sizes MEAN something — they are not a decorative tessellation.
 * 2. **What the chart needs.** מינוס ומגמת שפל draws a trough line AND a day-count bar row, so it
 *    takes the widest tile in the grid; a bullet needs almost nothing, so עמלות closes the page
 *    on one flush full-width row.
 *
 * Every row adds to exactly 6 columns, so the grid closes flush at both ends.
 */
const CORE_LAYOUT: { id: string; size: string }[] = [
  { id: 'savings-rate', size: 'h-3x2' },
  { id: 'buffer', size: 'h-3x2' },
  // twelve months of ± signs need twelve readable columns: on a 2-wide tile each month got 8px
  // and its label 26px of text, so the labels collided. Measured, not guessed.
  { id: 'surplus-streak', size: 'h-4x2' },
  { id: 'debt-service', size: 'h-2x2' },
  { id: 'fixed-commitments', size: 'h-2x2' },
  { id: 'overdraft', size: 'h-4x2' },
];
const CONTEXT_LAYOUT: { id: string; size: string }[] = [
  { id: 'income-volatility', size: 'h-3x2' },
  { id: 'discretionary-trend', size: 'h-3x2' },
  { id: 'housing', size: 'h-2x2' },
  { id: 'subscriptions', size: 'h-2x2' },
  { id: 'squeeze', size: 'h-2x2' },
  { id: 'fees', size: 'h-6x1' },
];

function rememberedBase(): number {
  try {
    const n = Number(window.localStorage.getItem(BASE_KEY));
    return [3, 6, 12, 24].includes(n) ? n : 12;
  } catch {
    return 12;
  }
}

function AxisOverview({ label, metrics }: { label: string; metrics: Metric[] }) {
  const summary = metrics.map((metric) => `${metric.nameHe}: ${BAND_LABELS[metric.band]}`).join(', ');

  return (
    <div className="health-axis-overview" role="img" aria-label={`${label}. ${summary}`}>
      <span>{label}</span>
      <span className="health-axis-dots" aria-hidden="true">
        {metrics.map((metric) => (
          <i key={metric.id} className={`band-${metric.band}`} />
        ))}
      </span>
    </div>
  );
}

/**
 * One metric, whole. The visual is the card — the arithmetic behind it lives one click away in
 * the `?`, because twelve receipts printed at once is the wall of text the minimalist law exists
 * to prevent. A metric with nothing to measure says WHY on its face instead: that sentence is
 * short, it names what is missing, and it is the one thing worth reading on an empty tile.
 */
function MetricCard({ metric, size, windowMonths }: { metric: Metric; size: string; windowMonths: number }) {
  return (
    <article
      className={`card health-card ${size} band-b-${metric.band}`}
      aria-label={`${metric.nameHe}: ${BAND_LABELS[metric.band]}, ${metric.display}`}
    >
      <header className="health-card-head">
        <span className={`band-dot band-${metric.band}`} aria-hidden="true" />
        <h3 className="health-card-name">{metric.nameHe}</h3>
        <span className="health-card-axis">{AXIS_LABELS[metric.axis]}</span>
        {metric.band !== 'na' && (
          <Explain title={metric.nameHe}>
            <p className="explain-lead">{metric.detailHe}</p>
            <ExplainH>הבסיס</ExplainH>
            <p>מחושב על {windowMonths} החודשים השלמים האחרונים. החודש הרץ לעולם אינו נספר — הוא עוד לא נגמר.</p>
          </Explain>
        )}
      </header>
      <div className="health-card-read">
        <span className={`health-card-value amount band-text-${metric.band}`}>{metric.display}</span>
        {/* the word is the colour-blind fallback, so it reads in plain ink: the dot and the big
            value already carry the band, and at 14px/600 the green failed 4.5:1 on white anyway */}
        <span className="health-card-band">{BAND_LABELS[metric.band]}</span>
      </div>
      <HealthMetricVisual metric={metric} />
    </article>
  );
}

function MetricGrid({ layout, byId, windowMonths }: {
  layout: { id: string; size: string }[];
  byId: Record<string, Metric>;
  windowMonths: number;
}) {
  return (
    <div className="health-grid">
      {layout.map(({ id, size }) => {
        const metric = byId[id];
        return metric ? <MetricCard key={id} metric={metric} size={size} windowMonths={windowMonths} /> : null;
      })}
    </div>
  );
}

/** Twelve metrics shown together as a bento of deliberately unequal tiles. */
export function Health() {
  const [months, setMonths] = useState<number>(() => rememberedBase());
  const [report, setReport] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health(months).then(setReport).catch((e) => setError(errorMessageHe(e)));
  }, [months]);

  function pickBase(m: number) {
    setMonths(m);
    try {
      window.localStorage.setItem(BASE_KEY, String(m));
    } catch {
      // remembering the basis is a nicety, never a requirement
    }
  }

  if (error && !report) return <p className="error">{error}</p>;
  if (!report) return <p className="muted">טוען…</p>;

  const byId = Object.fromEntries([...report.level, ...report.resilience].map((m) => [m.id, m]));

  return (
    <div className="health-page">
      <div className="card hero health-hero">
        <div className="health-hero-copy">
          <div className="label">
            מצב כללי
            <Explain title="המצב הכללי">
              <p>הפסיקה נקבעת על ידי <strong>מדדי הליבה</strong> בלבד — אלה שמודדים אם הכסף מספיק: שיעור חיסכון, כרית חירום, ימי מינוס, רצף חודשים חיוביים, שירות חוב, ועומס מחויבויות.</p>
              <ExplainH>הכלל</ExplainH>
              <ul>
                <li><strong>אדום</strong> — לפחות שני מדדי ליבה אדומים, או אחד אדום + שניים צהובים.</li>
                <li><strong>צהוב</strong> — מדד ליבה אדום אחד, או שני צהובים, או מדד הקשר אדום.</li>
                <li><strong>ירוק</strong> — כל השאר.</li>
              </ul>
              <p>מדדי הֶקשר (תנודתיות, הוצאה מותרת, עמלות, מנויים…) יכולים להוריד דרגה אחת — לעולם לא להפיל לבד. נדרשים לפחות 6 מדדים מדידים כדי לפסוק בכלל, והסיבה המלאה תמיד מודפסת מתחת לפסיקה — אין ציונים סודיים. כל מדד מציג את החשבון שלו במלואו ב-<strong>?</strong> שעל הכרטיס.</p>
            </Explain>
          </div>
          <div className={`health-status band-text-${report.overall.band}`}>{report.overall.statusHe}</div>
          <p className="muted" style={{ fontWeight: 550 }}>{report.overall.reasonHe}</p>
          <p className="muted">
            12 מדדים, כולם כאן. <strong>הליבה</strong> קובעת את הפסיקה; <strong>ההקשר</strong> יכול להוריד דרגה,
            לא להפיל. כל מדד שייך גם לציר: <strong>רמה</strong> = כמה טוב החודש הממוצע שלך,
            <strong> עמידות</strong> = מה קורה כשמשהו משתבש.
          </p>
          <div className="health-basis-row">
            <span className="muted">בסיס החישוב:</span>
            <div className="pills" style={{ display: 'inline-flex' }}>
              {BASES.map((b) => (
                <button
                  key={b.months}
                  className={b.months === months ? 'pill active' : 'pill'}
                  onClick={() => pickBase(b.months)}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <span className="muted" title="החודש הנוכחי (החלקי) לעולם לא נספר">
              {report.windowMonths} החודשים השלמים האחרונים
            </span>
          </div>
        </div>
        <div className="health-overview-panel">
          <div className="health-overview-title">מפת המדדים</div>
          <AxisOverview label="רמה" metrics={report.level} />
          <AxisOverview label="עמידות" metrics={report.resilience} />
          <div className="health-overview-key" aria-hidden="true">
            <span><i className="band-green" />תקין</span>
            <span><i className="band-yellow" />לתשומת לב</span>
            <span><i className="band-red" />פגיע</span>
            <span><i className="band-na" />אין נתונים</span>
          </div>
        </div>
      </div>

      <div className="health-section-head">
        <h2>מדדי הליבה</h2>
        <span className="muted">אלה שקובעים את הפסיקה</span>
      </div>
      <MetricGrid layout={CORE_LAYOUT} byId={byId} windowMonths={report.windowMonths} />

      <div className="health-section-head">
        <h2>מדדי הֶקשר</h2>
        <span className="muted">יכולים להוריד דרגה — לעולם לא להפיל לבד</span>
      </div>
      <MetricGrid layout={CONTEXT_LAYOUT} byId={byId} windowMonths={report.windowMonths} />

      <p className="muted health-disclaimer">
        כלי חינוכי המבוסס על הנתונים שלך בלבד — לא ייעוץ השקעות, פנסיוני או ביטוחי.
        חשבונות ונכסים שלא חוברו או הוזנו אינם נספרים; נכס ידני שסומן "נזיל" נספר גם בכרית החירום.
        מה שקבוע ומה שמנוי נספר לפי מה שאישרת ב"מה יורד לי כל חודש?" — לא לפי ניחוש של המנוע.
      </p>
    </div>
  );
}
