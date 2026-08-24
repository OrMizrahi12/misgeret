import { Flag, GitCompareArrows, Milestone, SlidersHorizontal, Target, Telescope, TrendingUp, TriangleAlert } from 'lucide-react';
import { CardChip } from './CardChip';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { Explain } from './Explain';
import { LineAreaChart, NetBars } from './charts';
import type {
  CashflowResponse, DayBalance, Forecast, ForecastAccuracyEntry, ForecastConfig, ScenarioParams,
  VariableAnalysis, VariableModel,
} from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Rounded to the nearest 100 — a projected shekel is false precision (the research's one law). */
const ILS_ROUGH = (n: number) => `‏~${ILS0.format(Math.round(n / 100) * 100)}`;

// horizon meter stops — friendly landing points from a month to fifty years (projection is pure math)
const HORIZON_STOPS: { days: number; label: string }[] = [
  { days: 30, label: 'חודש' }, { days: 61, label: 'חודשיים' }, { days: 91, label: '3 חודשים' },
  { days: 182, label: 'חצי שנה' }, { days: 274, label: '9 חודשים' }, { days: 365, label: 'שנה' },
  { days: 548, label: 'שנה וחצי' }, { days: 730, label: 'שנתיים' }, { days: 1095, label: '3 שנים' },
  { days: 1461, label: '4 שנים' }, { days: 1826, label: '5 שנים' }, { days: 3652, label: '10 שנים' },
  { days: 5479, label: '15 שנה' }, { days: 7305, label: '20 שנה' }, { days: 10957, label: '30 שנה' },
  { days: 14610, label: '40 שנה' }, { days: 16436, label: '45 שנה' }, { days: 18262, label: '50 שנה' },
];
const HORIZON_STOP_DAYS = HORIZON_STOPS.map((s) => s.days);

// history-basis meter stops (in 30-day blocks ≈ months) — filtered live to how much data exists
const BASIS_STOPS = [1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48, 60];

const MODEL_OPTIONS: { value: VariableModel; label: string; hint: string }[] = [
  { value: 'median', label: 'חודש רגיל (מומלץ)', hint: 'החודש האמצעי — חודש חריג אחד (רהיט, טיסה) לא מטה את כל התחזית' },
  { value: 'average', label: 'ממוצע', hint: 'כל החודשים נספרים, כולל החריגים — תחזית שמרנית יותר אם היו קניות גדולות' },
  { value: 'p75', label: 'זהיר (חודש יקר)', hint: 'מתכנן לפי חודש בזבזני-מהרגיל — טוב כשחשוב לא להיות מופתע לרעה' },
  { value: 'manual', label: 'ידני', hint: 'אתה קובע את הקצב היומי בעצמך — המערכת רק מציגה מה ההיסטוריה אומרת' },
];

function modelNameHe(m: VariableModel): string {
  return MODEL_OPTIONS.find((o) => o.value === m)?.label ?? m;
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

function monthLabelHe(month: string): string {
  return new Date(`${month}-15T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

function horizonLabelHe(days: number): string {
  const stop = HORIZON_STOPS.reduce((best, s) => (Math.abs(s.days - days) < Math.abs(best.days - days) ? s : best));
  if (Math.abs(stop.days - days) <= 20) return stop.label;
  if (days < 365) return `${Math.round(days / 30.4)} חודשים`;
  return `${Math.round((days / 365.25) * 10) / 10} שנים`;
}

/** History-basis label from a block count (30-day blocks ≈ months). */
function basisLabelHe(blocks: number): string {
  if (blocks < 12) return blocks === 1 ? 'חודש' : blocks === 2 ? 'חודשיים' : `${blocks} חודשים`;
  if (blocks === 12) return 'שנה';
  if (blocks === 18) return 'שנה וחצי';
  if (blocks === 24) return 'שנתיים';
  return `${Math.round((blocks / 12) * 10) / 10} שנים`;
}

/** A meter that lands only on friendly stops — the rail is filled up to the knob (never a bare dot). */
function StopSlider({ stops, value, onChange, label, green }: {
  stops: number[]; value: number; onChange: (v: number) => void; label: (v: number) => string; green?: boolean;
}) {
  let i = 0;
  let best = Infinity;
  stops.forEach((s, k) => { const d = Math.abs(s - value); if (d < best) { best = d; i = k; } });
  const pct = stops.length > 1 ? (i / (stops.length - 1)) * 100 : 0;
  return (
    <div className="mrange-wrap">
      <input
        type="range"
        className={green ? 'mrange green' : 'mrange'}
        min={0}
        max={stops.length - 1}
        step={1}
        value={i}
        style={{ '--p': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(stops[Number(e.target.value)])}
        aria-label={label(stops[i])}
      />
      <div className="mrange-ends"><span>{label(stops[0])}</span><span>{label(stops[stops.length - 1])}</span></div>
    </div>
  );
}

/** A short observed run-up before the projection — anchors the dashed line in reality. */
const HISTORY_DAYS = 14;

const WEEKDAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']; // Sun..Sat

/** The learned day-of-week shape of variable spending, as seven small bars (mean = 1). */
function WeekdayBars({ factors }: { factors: number[] }) {
  const max = Math.max(...factors, 1);
  return (
    <div className="wk-bars" role="img" aria-label="פיזור ההוצאה לפי ימי שבוע">
      {factors.map((f, i) => (
        <div className="wk-bar" key={i} title={`יום ${WEEKDAY_LETTERS[i]}׳ · פקטור ${f.toFixed(2)}`}>
          <div className="wk-fill" style={{ height: `${(f / max) * 100}%` }} />
          <span>{WEEKDAY_LETTERS[i]}</span>
        </div>
      ))}
    </div>
  );
}

/** What the observed history alone says — shown next to a manual override. */
function historyDaily(v: VariableAnalysis): number {
  const rates = v.blocks.filter((b) => b.used).map((b) => b.daily).sort((a, b) => a - b);
  if (rates.length === 0) return v.daily;
  const mid = Math.floor(rates.length / 2);
  return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
}

function basisHe(v: VariableAnalysis): string {
  switch (v.basis) {
    case 'blocks': {
      const used = v.blocks.filter((b) => b.used).length;
      return `${modelNameHe(v.model)} על ${used} חלונות מלאים של 30 יום`;
    }
    case 'partial':
      return `פחות מ-30 יום של נתונים — הקצב חושב על ${v.observedDays} הימים שנצפו בפועל`;
    case 'lumpy-average':
      return 'ההוצאה מגיעה בפרצים — רוב הזמן שקט ואז קנייה גדולה — ולכן נלקח ממוצע התקופה';
    case 'manual':
      return 'נקבע ידנית — ההיסטוריה מוצגת להשוואה בלבד';
    case 'no-data':
      return 'אין עדיין הוצאות משתנות בנתונים';
  }
}

/** The full "how is this computed" panel renders every number the engine used verbatim. */
function ForecastExplainView({ forecast }: { forecast: Forecast }) {
  const { explain } = forecast;
  const v = explain.variable;
  const cal = explain.calibration;
  const counts = { recurring: 0, known: 0, pending: 0 };
  for (const e of forecast.events) counts[e.source]++;
  const maxDaily = Math.max(...v.blocks.map((b) => b.daily), 1);
  const rangeLabel = (from: string, to: string) => `${dayLabel(from)}–${dayLabel(to)}`;
  const maxNet = cal ? Math.max(...cal.months.map((m) => Math.abs(m.net)), 1) : 1;

  return (
    <div className="forecast-explain">
      <p className="muted" style={{ margin: '0 0 10px' }}>
        המשוואה גלויה כולה: <strong>יתרה נוכחית + כל אירוע מתוזמן − הוצאה משתנה יומית + תנועות לא-קבועות</strong>,
        יום אחרי יום עד סוף האופק. אין כאן ניחוש קסם — כל רכיב מפורט למטה, וכל שינוי בהגדרות משנה את החישוב מיד.
      </p>

      <div className="label">1 · נקודת הפתיחה</div>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        <Amount value={explain.start.balance} /> — יתרת העו"ש מצילום ה-{dayLabel(explain.start.snapshotDate)}
        {Math.abs(explain.start.movementsSince) >= 1 && (
          <> ועליה תנועות בנק שהושלמו מאז ({ILS0.format(explain.start.movementsSince)})</>
        )}.
      </p>

      <div className="label">2 · אירועים מתוזמנים</div>
      <p className="muted" style={{ margin: '4px 0 12px' }}>
        {counts.recurring} מופעים של הכנסות והוצאות קבועות (מהזיהוי שבניהול החיובים הקבועים בהגדרות — מה שסימנת "לא חוזר" לא נספר)
        {counts.known > 0 && <> · {counts.known} חיובי כרטיס ידועים מהמחזור שנמסר מראש (סכום אמיתי, לא הערכה)</>}
        {counts.pending > 0 && <> · {counts.pending} תנועות ממתינות/תרחיש</>}
        . ריחוף על הגרף מציג את האירועים של כל יום.
      </p>

      <div className="label">3 · הוצאה משתנה — {ILS0.format(v.daily)} ליום</div>
      <p className="muted" style={{ margin: '4px 0 6px' }}>
        כל מה שלא קבוע, מקובץ לתקופות של 30 יום. הבסיס: {basisHe(v)}.
      </p>
      {v.blocks.length > 0 && (
        <div className="explain-blocks">
          {v.blocks.map((b) => (
            <div className={b.used ? 'explain-block' : 'explain-block dim'} key={b.to}>
              <span className="num">{rangeLabel(b.from, b.to)}</span>
              <span className="explain-bar"><i style={{ width: `${(b.daily / maxDaily) * 100}%` }} /></span>
              <span className="num">{ILS0.format(b.total)}</span>
              <span className="num">{ILS0.format(b.daily)}/יום{b.used ? '' : ` · חלקי (${b.observedDays} ימים) — לא משוקלל`}</span>
            </div>
          ))}
        </div>
      )}
      {v.weekdayFactors && (
        <>
          <p className="muted" style={{ margin: '10px 0 0' }}>
            פיזור שבועי שנלמד מההיסטוריה — הקצב היומי מוכפל בפקטור של אותו יום:
          </p>
          <WeekdayBars factors={v.weekdayFactors} />
        </>
      )}

      {cal && (
        <>
          <div className="label" style={{ marginTop: 12 }}>4 · יישור מול המציאות — {ILS0.format(cal.driftDaily)} ליום</div>
          <p className="muted" style={{ margin: '4px 0 6px' }}>
            הלוח נותן את הצורה; את הגובה קובעת המציאות. האירועים המתוזמנים והקניות מסבירים יחד{' '}
            <strong>{ILS0.format(cal.impliedMonthly)}</strong> לחודש, אבל בחודש רגיל (האמצעי מבין{' '}
            {cal.months.length} החודשים המלאים שבבסיס) העו"ש זז <strong>{ILS0.format(cal.medianNet)}</strong> —
            כי יש גם תנועות בלי מקצב קבוע: העברות ביט, שיקים, מזומן, זיכויים. ההפרש מוקרן כתנועה יומית אחידה.
            אלה החודשים שהצביעו:
          </p>
          <div className="explain-blocks">
            {cal.months.map((m) => (
              <div className="explain-block" key={m.month}>
                <span className="num">{monthLabelHe(m.month)}</span>
                <span className="explain-bar"><i style={{ width: `${(Math.abs(m.net) / maxNet) * 100}%`, background: m.net < 0 ? 'var(--negative, #c0504d)' : undefined }} /></span>
                <span className="num"><Amount value={m.net} /></span>
                <span className="num" />
              </div>
            ))}
          </div>
        </>
      )}

      {forecast.bands && (
        <>
          <div className="label" style={{ marginTop: 12 }}>{cal ? 5 : 4} · רצועת התרחישים</div>
          {cal && cal.p25Net !== null && cal.p75Net !== null ? (
            <p className="muted" style={{ margin: '4px 0 0' }}>
              הרצועה סביב הקו אינה סטטיסטיקה אלא שני מסלולים מחושבים עד הסוף מתוך החודשים שנצפו בפועל:{' '}
              <strong>תרחיש חסכוני</strong> — כל חודש קדימה מתנהג כמו החודש החזק שבבסיס (נטו {ILS0.format(cal.p75Net)});{' '}
              <strong>תרחיש בזבזני</strong> — כמו החודש החלש (נטו {ILS0.format(cal.p25Net)}). חיוב כרטיס שעוד מתמלא
              שומר גם הוא את הטווח שלו. המסלול הצפוי תמיד בפנים.
            </p>
          ) : (
            <p className="muted" style={{ margin: '4px 0 0' }}>
              הרצועה סביב הקו אינה סטטיסטיקה אלא שני מסלולים מחושבים עד הסוף: <strong>תרחיש חסכוני</strong> — הוצאה יומית
              כמו בחודש החסכוני שנצפה ({ILS0.format(v.p25Daily)}/יום); <strong>תרחיש בזבזני</strong> — כמו בחודש
              הבזבזני ({ILS0.format(v.p75Daily)}/יום). המסלול הצפוי תמיד בפנים.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The forecast's tuning panel — the knobs the engine actually honors, nothing decorative.
 *  (The lookback knob moved to the tab header — the user asked for X front and center.) */
function ForecastConfigPanel({
  config, variableDaily, onChange, saved,
}: {
  config: ForecastConfig;
  variableDaily: number;
  onChange: (patch: Partial<ForecastConfig>) => void;
  saved: boolean;
}) {
  const [manualDraft, setManualDraft] = useState<string>(String(config.manualDaily ?? Math.round(variableDaily)));
  const manualActive = config.variableModel === 'manual';

  return (
    <div className="forecast-config">
      <p className="muted" style={{ margin: '0 0 10px' }}>
        הגדרות התחזית — כל שינוי נשמר ומחושב מחדש מיד. {saved && <span className="amount-positive">נשמר ✓</span>}
      </p>

      <div className="config-row">
        <span className="config-name" title="איך נבחר הקצב היומי מתוך החלונות שנצפו">מודל ההוצאה המשתנה</span>
        <div className="pills" style={{ display: 'inline-flex', flexWrap: 'wrap' }}>
          {MODEL_OPTIONS.map((m) => (
            <button
              key={m.value}
              className={m.value === config.variableModel ? 'pill active' : 'pill'}
              title={m.hint}
              onClick={() => {
                if (m.value === 'manual') onChange({ variableModel: 'manual', manualDaily: Number(manualDraft) || Math.round(variableDaily) });
                else onChange({ variableModel: m.value });
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {manualActive && (
        <div className="config-row">
          <span className="config-name">קצב ידני (₪ ליום)</span>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <input
              dir="ltr"
              inputMode="numeric"
              style={{ width: 90, textAlign: 'end' }}
              value={manualDraft}
              onChange={(e) => setManualDraft(e.target.value)}
            />
            <button
              className="primary"
              onClick={() => {
                const n = Number(manualDraft);
                if (Number.isFinite(n) && n >= 0) onChange({ manualDaily: n });
              }}
            >
              שמירה
            </button>
            <span className="muted">ההיסטוריה אומרת ≈ {ILS0.format(variableDaily)}</span>
          </span>
        </div>
      )}

      <label className="config-row config-toggle">
        <input
          type="checkbox"
          checked={config.weekdayPattern}
          onChange={(e) => onChange({ weekdayPattern: e.target.checked })}
        />
        פיזור לפי ימי שבוע — הקו יורד חזק בימים שבהם אתה באמת מוציא, במקום בקו ישר
      </label>

      <label className="config-row config-toggle">
        <input
          type="checkbox"
          checked={config.showBand}
          onChange={(e) => onChange({ showBand: e.target.checked })}
        />
        רצועת תרחישים — חסכוני ובזבזני סביב המסלול הצפוי
      </label>
    </div>
  );
}

interface Milestone {
  date: string;
  textHe: string;
}

/** Milestones straight from the projected path: round-number crossings, escaping the minus. */
function pathMilestones(path: DayBalance[]): Milestone[] {
  if (path.length < 2) return [];
  const out: Milestone[] = [];
  const start = path[0].balance;
  if (start < 0) {
    const escape = path.find((p) => p.balance >= 0);
    if (escape) out.push({ date: escape.date, textHe: `יציאה מהמינוס — ${dayLabel(escape.date)}` });
  }
  // the next nice round levels above the starting balance, scaled to its magnitude
  const maxBal = Math.max(...path.map((p) => p.balance));
  const step = maxBal >= 150_000 ? 50_000 : maxBal >= 40_000 ? 25_000 : maxBal >= 15_000 ? 10_000 : 5_000;
  let level = (Math.floor(Math.max(start, 0) / step) + 1) * step;
  while (out.length < 3 && level <= maxBal) {
    const cross = path.find((p, i) => i > 0 && path[i - 1].balance < level && p.balance >= level);
    if (cross) out.push({ date: cross.date, textHe: `חוצה ${ILS0.format(level)} — ${dayLabel(cross.date)}` });
    level += step;
  }
  return out.slice(0, 4);
}

/**
 * "ומה לגבי העתיד?" — X months of history projected Y months forward, honestly.
 * Spec: docs/2026-07-16-future-tab-spec.md. Deterministic engine, scenario band as computed
 * paths (not statistics), rounded projections, what-ifs run server-side, and the audit
 * nobody ships: what we predicted vs what actually happened.
 */
export function Future() {
  const [data, setData] = useState<CashflowResponse | null>(null);
  const [history, setHistory] = useState<DayBalance[]>([]);
  const [days, setDays] = useState<number | null>(null); // null = the configured default
  const [scenario, setScenario] = useState<ScenarioParams | null>(null);
  const [accuracy, setAccuracy] = useState<ForecastAccuracyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showExplain, setShowExplain] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  // scenario drafts
  const [extraDraft, setExtraDraft] = useState('');
  const [oneOffAmountDraft, setOneOffAmountDraft] = useState('');
  const [oneOffMonthDraft, setOneOffMonthDraft] = useState('');

  // meter drafts: reflect the knob instantly while dragging; the (heavy) refetch commits on settle
  const [horizonDraft, setHorizonDraft] = useState<number | null>(null);
  const [basisDraft, setBasisDraft] = useState<number | null>(null);
  const horizonTimer = useRef<number | undefined>(undefined);
  const basisTimer = useRef<number | undefined>(undefined);

  // request ordering: switching horizons fast must not let a slower reply win the chart
  const requestSeq = useRef(0);
  const load = useCallback((d: number | null, sc: ScenarioParams | null) => {
    const seq = ++requestSeq.current;
    api.cashflow(d ?? undefined, sc ?? undefined)
      .then((r) => { if (requestSeq.current === seq) setData(r); })
      .catch((e) => { if (requestSeq.current === seq) setError(errorMessageHe(e)); });
  }, []);

  useEffect(() => {
    load(days, scenario);
  }, [days, scenario, load]);

  // the history basis can never exceed the data actually held — filter the stops to that live ceiling,
  // and always include the exact ceiling so the user can reach it.
  const basisStops = useMemo(() => {
    const cap = data?.maxLookbackBlocks ?? 12;
    const s = BASIS_STOPS.filter((b) => b <= cap);
    if (cap >= 1 && s[s.length - 1] !== cap) s.push(cap);
    return s.length ? s : [1];
  }, [data]);

  // debounced commits: dragging a meter must not fire a fetch (a 50-year path is heavy) on every step
  const onHorizonChange = useCallback((d: number) => {
    setHorizonDraft(d);
    if (horizonTimer.current) window.clearTimeout(horizonTimer.current);
    horizonTimer.current = window.setTimeout(() => {
      setDays(d);
      void api.updateForecastConfig({ horizonDays: d }).catch(() => {});
    }, 240);
  }, []);
  const onBasisChange = useCallback((b: number) => {
    setBasisDraft(b);
    if (basisTimer.current) window.clearTimeout(basisTimer.current);
    basisTimer.current = window.setTimeout(() => { void api.updateForecastConfig({ lookbackBlocks: b }).then(() => load(days, scenario)).catch(() => {}); }, 240);
  }, [days, scenario, load]);
  // drop each draft once the server's answer matches it — no thumb flicker back to the old value
  useEffect(() => { if (horizonDraft !== null && data?.days === horizonDraft) setHorizonDraft(null); }, [data, horizonDraft]);
  useEffect(() => { if (basisDraft !== null && data?.config.lookbackBlocks === basisDraft) setBasisDraft(null); }, [data, basisDraft]);

  useEffect(() => {
    api.balanceHistory().then((r) => setHistory(r.series)).catch(() => setHistory([]));
    api.forecastAccuracy().then((r) => setAccuracy(r.entries)).catch(() => setAccuracy([]));
  }, []);

  // a short observed run-up stitched before the projection: [past 14 days solid] → [forecast dashed]
  const combined = useMemo(() => {
    const forecast = data?.forecast;
    if (!forecast) return { series: [] as DayBalance[], splitIndex: undefined as number | undefined };
    const todayDate = forecast.path[0].date;
    const cutoff = new Date(Date.parse(todayDate) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
    const past = history.filter((p) => p.date >= cutoff && p.date < todayDate);
    if (past.length < 2) return { series: forecast.path, splitIndex: undefined };
    return { series: [...past, ...forecast.path], splitIndex: past.length };
  }, [data, history]);

  // hovering a forecast day lists what moves on it — the events ARE the tooltip
  const eventsByDate = useMemo(() => {
    const map: Record<string, { merchant: string; amount: number }[]> = {};
    for (const e of data?.forecast?.events ?? []) (map[e.date] ??= []).push({ merchant: e.merchant, amount: e.amount });
    return map;
  }, [data]);

  const milestones = useMemo(() => (data?.forecast ? pathMilestones(data.forecast.path) : []), [data]);

  // month-by-month projected nets, derived from the path's end-of-month balances
  const projectedMonths = useMemo(() => {
    const path = data?.forecast?.path;
    if (!path || path.length < 28) return [];
    const lastOfMonth = new Map<string, DayBalance>();
    for (const p of path) lastOfMonth.set(p.date.slice(0, 7), p);
    const entries = [...lastOfMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const out: { month: string; income: number; expenses: number; net: number; byCategory: [] }[] = [];
    let prevBalance = path[0].balance;
    for (const [month, point] of entries) {
      const net = Math.round((point.balance - prevBalance) * 100) / 100;
      prevBalance = point.balance;
      // a month whose last projected day isn't its true end is a stub — skip the tail stub
      if (point.date !== path[path.length - 1].date || entries.length === 1 || point.date.slice(8) >= '28') {
        out.push({ month, income: 0, expenses: 0, net, byCategory: [] });
      }
    }
    return out.slice(0, 12);
  }, [data]);

  // the emotional bottom line of the forecast: sum of the projected monthly nets over the horizon
  const horizonNet = useMemo(() => projectedMonths.reduce((s, m) => s + m.net, 0), [projectedMonths]);

  async function changeConfig(patch: Partial<ForecastConfig>) {
    setError(null);
    setConfigSaved(false);
    try {
      await api.updateForecastConfig(patch);
      setConfigSaved(true);
      load(days, scenario);
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  function applyScenario() {
    const extra = Number(extraDraft);
    const amount = Number(oneOffAmountDraft);
    const next: ScenarioParams = {};
    if (extraDraft.trim() !== '' && Number.isFinite(extra) && extra !== 0) next.extraMonthly = extra;
    if (oneOffAmountDraft.trim() !== '' && Number.isFinite(amount) && amount > 0 && oneOffMonthDraft) {
      next.oneOffAmount = amount;
      next.oneOffMonth = oneOffMonthDraft;
    }
    setScenario(Object.keys(next).length > 0 ? next : null);
  }

  function clearScenario() {
    setScenario(null);
    setExtraDraft('');
    setOneOffAmountDraft('');
    setOneOffMonthDraft('');
  }

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  const { forecast, overdraftLimit, config } = data;
  const redLine = -overdraftLimit;
  const breached = forecast !== null && forecast.trough.balance < redLine;
  const bandBreached = forecast !== null && !breached && forecast.troughLow !== null && forecast.troughLow.balance < redLine;
  const band = forecast?.bands
    ? {
        startIndex: combined.splitIndex ?? 0,
        low: forecast.bands.low.map((p) => p.balance),
        high: forecast.bands.high.map((p) => p.balance),
      }
    : undefined;
  const endPoint = forecast ? forecast.path[forecast.path.length - 1] : null;
  const scenarioEnd = data.scenario ? data.scenario.path[data.scenario.path.length - 1] : null;

  // next 12 months for the one-off picker
  const monthOptions: string[] = [];
  {
    const d = new Date();
    for (let i = 1; i <= 12; i++) {
      const m = new Date(d.getFullYear(), d.getMonth() + i, 15);
      monthOptions.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
    }
  }

  if (!forecast) {
    return <p className="muted">אין יתרת בנק — סנכרן חיבור בנק כדי לקבל תחזית.</p>;
  }

  return (
    <div>
      {error && <p className="error">{error}</p>}

      {/* ── פסק-הדין: לאן אתה מגיע, ומה בדרך ─────────────────────────────────────── */}
      <div className="card hero">
        <CardChip icon={Telescope} />
        <div className="hero-top">
          <div className="label">
            בעוד {horizonLabelHe(data.days)} · צפי יתרה
            <Explain title="צפי היתרה">
              <p>לאן העו״ש צפוי להגיע, בארבעה רכיבים שקופים:</p>
              <ul>
                <li><strong>נקודת פתיחה</strong> — היתרה האחרונה שדווחה מהבנק.</li>
                <li><strong>אירועים מתוזמנים</strong> — המשכורת, הקבועות וחיובי הכרטיס, כל אחד ביום החודש הקבוע שלו; כשחברת הכרטיס כבר מסרה את סכום החיוב הבא — משתמשים בו במקום בהערכה.</li>
                <li><strong>הוצאה משתנה יומית</strong> — תקופה רגילה (האמצעית) מבין תקופות של 30 יום בהיסטוריה שלך.</li>
                <li><strong>יישור</strong> — התאמה יומית קטנה כדי שהתחזית תיפגש עם מה שקרה בפועל בחודשים האחרונים.</li>
              </ul>
              <p>המספר מוצג מעוגל בכוונה — תחזית אינה מדויקת לשקל (הסכום המדויק ב-hover). הפירוק המלא, שלב-אחר-שלב עם המספרים שלך — בכפתור ההסבר שבתחתית הטאב.</p>
            </Explain>
          </div>
          <button
            className={showConfig ? 'pill active' : 'pill'}
            onClick={() => setShowConfig((v) => !v)}
            title="הגדרות התחזית: מודל, פיזור שבועי, רצועה"
            aria-expanded={showConfig}
          >
            <SlidersHorizontal size={13} strokeWidth={2.2} className="ic" aria-hidden /> הגדרות
          </button>
        </div>
        {endPoint && (
          <div className="kpi-value" style={{ fontSize: 30 }} title={`הערך המדויק שהמנוע חישב: ${ILS0.format(endPoint.balance)} — מוצג מעוגל, כי דיוק של אגורות בעתיד הוא דיוק מדומה`}>
            {ILS_ROUGH(endPoint.balance)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 0' }}>
          {scenarioEnd && endPoint && (
            <span className="tag" style={{ borderColor: 'var(--accent-2)' }}>
              בתרחיש: {ILS_ROUGH(scenarioEnd.balance)} ({scenarioEnd.balance >= endPoint.balance ? '+' : '−'}{ILS0.format(Math.abs(scenarioEnd.balance - endPoint.balance))})
            </span>
          )}
          <span
            className={breached ? 'tag warn' : 'tag'}
            title={forecast.troughLow
              ? `בתרחיש הבזבזני: ${ILS0.format(forecast.troughLow.balance)} ב-${dayLabel(forecast.troughLow.date)}`
              : undefined}
          >
            נקודת השפל {ILS_ROUGH(forecast.trough.balance)} · {dayLabel(forecast.trough.date)}
          </span>
          {forecast.explain.calibration ? (
            <button
              className="tag tag-button"
              onClick={() => setShowExplain((v) => !v)}
              title={`הלוח (קבועות, משכורות, חיובים) מסביר ${ILS0.format(forecast.explain.calibration.impliedMonthly)} לחודש; השאר — ביט, שיקים, מזומן — מיושר מול מה שקרה בפועל. לחיצה פותחת את פירוט החישוב המלא`}
            >
              חודש רגיל אצלך {forecast.explain.calibration.medianNet >= 0 ? '+' : '−'}{ILS0.format(Math.abs(forecast.explain.calibration.medianNet))}
            </button>
          ) : (
            <button
              className="tag tag-button"
              onClick={() => setShowExplain((v) => !v)}
              title={`${basisHe(forecast.explain.variable)} · לחיצה פותחת את פירוט החישוב המלא`}
            >
              משתנות ≈ {ILS0.format(forecast.variableDaily)}/יום
            </button>
          )}
          {forecast.known.map((k) => {
            const applied = k.appliedAmount ?? k.amount;
            const stillFilling = Math.abs(applied - k.amount) >= 1;
            return (
              <span
                key={`${k.company}|${k.date}`}
                className="tag good"
                title={stillFilling
                  ? 'המחזור עוד מתמלא — בתחזית הוצב הגבוה מבין הידוע והמוערך'
                  : 'הסכום מהמחזור בפועל, לא הערכה'}
              >
                חיוב {k.merchant} · {dayLabel(k.date)} · {ILS0.format(-applied)}{stillFilling ? '' : ' ✓'}
              </span>
            );
          })}
        </div>
        <div className="forecast-meters">
          <div>
            <div className="mrange-head">
              <span>כמה רחוק להסתכל קדימה</span>
              <b style={{ color: 'var(--accent)' }}>{horizonLabelHe(horizonDraft ?? data.days)}</b>
            </div>
            <StopSlider stops={HORIZON_STOP_DAYS} value={horizonDraft ?? data.days} onChange={onHorizonChange} label={horizonLabelHe} />
          </div>
          <div>
            <div className="mrange-head">
              <span>על בסיס כמה היסטוריה לחשב</span>
              <b style={{ color: 'var(--positive)' }}>{basisLabelHe(basisDraft ?? config.lookbackBlocks)}</b>
            </div>
            <StopSlider stops={basisStops} value={basisDraft ?? config.lookbackBlocks} onChange={onBasisChange} label={basisLabelHe} green />
          </div>
        </div>
        <p className="muted" style={{ margin: '4px 2px 0', fontSize: 13, lineHeight: 1.5 }}>
          הבסיס עד כמה שיש לך — {basisLabelHe(data.maxLookbackBlocks)} של נתונים · אי אפשר לחשב על מה שעוד לא קרה. הקבועות והמשכורות נותנות את הצורה; הגובה מיושר מול מה שקרה בפועל.
        </p>
        {showConfig && (
          <ForecastConfigPanel
            config={config}
            variableDaily={forecast.explain.variable.basis === 'manual'
              ? historyDaily(forecast.explain.variable)
              : forecast.variableDaily}
            onChange={changeConfig}
            saved={configSaved}
          />
        )}

        {/* ── הגרף: אותו כרטיס, ישר מתחת להגדרות ─────────────────────────────────── */}
        <div className="label" style={{ marginTop: 18 }}>
          העו"ש קדימה · {data.days} יום
          <Explain title="העו״ש קדימה">
            <p><strong>קו מלא</strong> — העבר שקרה בפועל (היתרה המשוחזרת). <strong>קו מקווקו</strong> — התחזית, מחוברת באותו ציר. הרצועה השקופה — טווח תרחישים: אותו מסלול עם קצב הוצאה של חודש חסכן מול חודש בזבזני מההיסטוריה שלך.</p>
            <p>נקודת השפל והיעד מסומנים על הקו; הקו האדום = קצה מסגרת האשראי שהגדרת. ריחוף על יום מציג את התנועות הצפויות בו.</p>
          </Explain>
        </div>
        <LineAreaChart
          series={combined.series}
          splitIndex={combined.splitIndex}
          eventsByDate={eventsByDate}
          band={band}
          overlay={data.scenario?.path}
          overlayLabel="תרחיש"
          markers={[{ date: forecast.trough.date, danger: breached }]}
          dangerLevel={overdraftLimit > 0 ? redLine : undefined}
          endValue={endPoint ? ILS_ROUGH(endPoint.balance) : undefined}
          endLabel={endPoint ? horizonLabelHe(data.days) : undefined}
          levels
          ariaLabel={`יתרה חזויה ${data.days} יום`}
        />
        {data.days > 91 && (
          <p className="chart-caption">ההמשך = אם תמשיך כמו היום · הרצועה = הטווח בין חודש טוב לחודש קשה</p>
        )}
        {breached && (
          <p className="error" style={{ marginTop: 10 }}>
            {overdraftLimit > 0
              ? `במסלול הנוכחי היתרה צפויה לפרוץ את מסגרת האשראי (${ILS0.format(redLine)}) ב-${dayLabel(forecast.trough.date)}. שקול הזזת תאריך חיוב או דחיית הוצאה.`
              : `במסלול הנוכחי היתרה צפויה לרדת מתחת לאפס ב-${dayLabel(forecast.trough.date)}. שקול הזזת תאריך חיוב או דחיית הוצאה.`}
          </p>
        )}
        {bandBreached && forecast.troughLow && (
          <p className="muted" style={{ marginTop: 10 }}>
            <TriangleAlert size={13} strokeWidth={2.2} className="ic ic-warn" aria-hidden /> המסלול הצפוי מחזיק, אבל בתרחיש הבזבזני היתרה עלולה להגיע ל-{ILS0.format(forecast.troughLow.balance)} ב-{dayLabel(forecast.troughLow.date)} — שווה עין.
          </p>
        )}
      </div>

      <div className="grid">
        {/* ── מה-אם: המנוע האמיתי, קלט שלך ──────────────────────────────────────────── */}
        <div className="card g6 tone-teal">
          <CardChip icon={SlidersHorizontal} />
          <div className="hero-top">
            <div className="label">
              מה אם…
              <Explain title="מה אם">
                <p>תרחיש נבנה מחדש בשרת עם השינויים שלך — תוספת/קיצוץ חודשי, הוצאה חד-פעמית בחודש נתון, או מקדם על ההוצאה המשתנה — ומצויר כקו ענבר מקווקו מעל התחזית הרגילה. הבסיס לא משתנה: אפשר להשוות עין-בעין.</p>
              </Explain>
            </div>
            {scenario && <button className="link" onClick={clearScenario}>נקה תרחיש ✕</button>}
          </div>
          <div className="config-row" style={{ marginTop: 8 }}>
            <span className="config-name">ההכנסה תשתנה ב-(₪/חודש)</span>
            <input dir="ltr" inputMode="numeric" style={{ width: 100, textAlign: 'end' }} placeholder="+1,000"
              value={extraDraft} onChange={(e) => setExtraDraft(e.target.value)} />
          </div>
          <div className="config-row">
            <span className="config-name">הוצאה חד-פעמית של</span>
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input dir="ltr" inputMode="numeric" style={{ width: 100, textAlign: 'end' }} placeholder="8,000"
                value={oneOffAmountDraft} onChange={(e) => setOneOffAmountDraft(e.target.value)} />
              <span className="muted">ב-</span>
              <select value={oneOffMonthDraft} onChange={(e) => setOneOffMonthDraft(e.target.value)}>
                <option value="">בחר חודש</option>
                {monthOptions.map((m) => (
                  <option key={m} value={m}>{monthLabelHe(m)}</option>
                ))}
              </select>
            </span>
          </div>
          <div className="config-row">
            <button className="primary" onClick={applyScenario}>הרץ תרחיש</button>
            {data.scenario && scenarioEnd && endPoint && (
              <span className="muted">
                הקו הענברי בגרף · שפל התרחיש: {ILS_ROUGH(data.scenario.trough.balance)}
              </span>
            )}
          </div>
          <p className="chart-caption">התרחיש מחושב באותו מנוע בשרת — לא הדמיה מזויפת</p>
        </div>

        {/* ── אבני דרך: מתי מגיעים לאן ─────────────────────────────────────────────── */}
        <div className="card g6 tone-amber">
          <CardChip icon={Milestone} />
          <div className="label">
            אבני דרך בדרך
            <Explain title="אבני דרך">
              <p>הימים שבהם המסלול החזוי חוצה רמות עגולות (10K, 20K…), יוצא מהמינוס או נכנס אליו, ומגיע ליעדי חיסכון. הכל נגזר מאותו מסלול חזוי — אין חישוב נפרד.</p>
            </Explain>
          </div>
          {milestones.length === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>אין חציות סף באופק הנוכחי — נסה אופק ארוך יותר.</p>
          ) : (
            <ul className="txns">
              {milestones.map((m) => (
                <li className="txn" key={m.date + m.textHe}>
                  <span className="txn-desc"><Flag size={13} strokeWidth={2.2} className="ic ic-muted" aria-hidden /> {m.textHe}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="chart-caption">נגזר מאותו מסלול חזוי · על הגרף למעלה מסומנים השפל והיעד</p>
        </div>

        {/* ── חודש-חודש: הנטו החזוי של כל חודש באופק ──────────────────────────────── */}
        {projectedMonths.length > 1 && (
          <div className="card g12 tone-green">
            <CardChip icon={TrendingUp} />
            <div className="label">
              הנטו החזוי · חודש אחרי חודש
              <Explain title="הנטו החזוי">
                <p>הכנסות פחות הוצאות לכל חודש עתידי, מאותו לוח אירועים של התחזית: משכורות צפויות − קבועות צפויות − ההוצאה המשתנה היומית × ימי החודש. עמודות עם מרקם מקווקו = תחזית, להבדיל מהעבר המלא.</p>
              </Explain>
            </div>
            <p className="card-sub">
              לפי הקצב הזה — {projectedMonths.length >= 12 ? 'עוד כשנה' : `ב־${projectedMonths.length} החודשים הקרובים`}{' '}
              {horizonNet >= 0 ? 'ייצבר' : 'ייגרע'} בערך{' '}
              <b style={{ color: horizonNet >= 0 ? 'var(--positive)' : 'var(--negative)', fontWeight: 800 }}>
                {ILS_ROUGH(Math.abs(horizonNet))}
              </b>
            </p>
            <NetBars summary={[...projectedMonths].reverse()} projected />
            <p className="chart-caption">מרקם מקווקו = תחזית, לא מציאות · נגזר מהמסלול היומי שלמעלה</p>
          </div>
        )}

        {/* ── תחזית מול מציאות: הקבלות ────────────────────────────────────────────── */}
        <div className="card g12 tone-sky">
          <CardChip icon={GitCompareArrows} />
          <div className="label">
          תחזית מול מציאות
          <Explain title="תחזית מול מציאות">
            <p>בכל סנכרון נשמרת "קבלה": מה חזינו, לאיזה תאריך, ומתי. כשהתאריך מגיע — משווים את התחזית ליתרה שקרתה בפועל ומציגים את הטעות. תחזית שלא עומדת מול המציאות היא שמועה — זה המנגנון שמונע מזה לקרות כאן.</p>
          </Explain>
        </div>
          {accuracy === null ? (
            <p className="muted">טוען…</p>
          ) : accuracy.length === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>
              מהיום, כל סנכרון שומר קבלה: מה חזינו ל-30 ו-90 יום קדימה. כשהתאריכים יגיעו — נשווה כאן
              את התחזית למה שקרה באמת, בלי לייפות. חזור בעוד חודש.
            </p>
          ) : (
            <table className="months-table">
              <thead>
                <tr>
                  <th>נחזה ב-</th><th>אופק</th><th>ליום</th><th>חזינו</th><th>קרה</th><th>סטייה</th>
                </tr>
              </thead>
              <tbody>
                {accuracy.slice(0, 12).map((e) => (
                  <tr key={`${e.takenOn}-${e.horizonDays}`}>
                    <td>{dayLabel(e.takenOn)}</td>
                    <td>{e.horizonDays} יום</td>
                    <td>{dayLabel(e.targetDate)}</td>
                    <td>{ILS0.format(e.predicted)}</td>
                    <td>{ILS0.format(e.actual)}</td>
                    <td className={Math.abs(e.error) <= Math.max(500, Math.abs(e.actual) * 0.1) ? 'amount-positive' : 'amount-negative'}>
                      {e.error >= 0 ? '+' : ''}{ILS0.format(e.error)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── איך זה מחושב: עוגן האמון ─────────────────────────────────────────────── */}
        <div className="card g12 tone-slate">
          <button className="link" onClick={() => setShowExplain((v) => !v)} aria-expanded={showExplain}>
            {showExplain ? 'הסתר את החישוב' : 'איך זה מחושב?'}
          </button>
          {showExplain && <ForecastExplainView forecast={forecast} />}
        </div>
      </div>
    </div>
  );
}
