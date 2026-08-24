import { ChartColumnBig, PiggyBank, ShieldCheck, TrendingDown, Waves } from 'lucide-react';
import { CardChip } from './CardChip';
import { useEffect, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { Explain, ExplainH, Formula } from './Explain';
import { CalloutPie, LineAreaChart, NetBars } from './charts';
import type { DayBalance, OverviewKpi, OverviewResponse } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

const RANGES = [
  { months: 3, label: '3 חוד׳' },
  { months: 6, label: '6 חוד׳' },
  { months: 12, label: 'שנה' },
  { months: 24, label: 'שנתיים' },
];

const RANGE_KEY = 'misgeret-overview-months';

function rememberedRange(): number {
  try {
    const n = Number(window.localStorage.getItem(RANGE_KEY));
    return [3, 6, 12, 24].includes(n) ? n : 12;
  } catch {
    return 12;
  }
}

function monthLabel(month: string): string {
  return new Date(`${month}-15T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}


function rangeLabelHe(months: number): string {
  if (months === 3) return 'בשלושת החודשים האחרונים';
  if (months === 6) return 'בחצי השנה האחרונה';
  if (months === 12) return 'בשנה האחרונה';
  return 'בשנתיים האחרונות';
}

/** Stock-ticker line for the balance curve: current, change over the window, high/low with dates. */
function BalanceTicker({ series }: { series: DayBalance[] }) {
  const first = series[0];
  const last = series[series.length - 1];
  const diff = last.balance - first.balance;
  const up = diff >= 0;
  const withYear = (Date.parse(last.date) - Date.parse(first.date)) / 86_400_000 > 300;
  const day = (d: string) =>
    new Date(`${d}T12:00:00`).toLocaleDateString(
      'he-IL',
      withYear ? { day: '2-digit', month: '2-digit', year: '2-digit' } : { day: '2-digit', month: '2-digit' },
    );
  const hi = series.reduce((a, b) => (b.balance > a.balance ? b : a));
  const lo = series.reduce((a, b) => (b.balance < a.balance ? b : a));
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
      <Amount value={last.balance} hero />
      <span className={up ? 'amount-positive' : 'amount-negative'}>
        {up ? '▲' : '▼'} <Amount value={Math.abs(diff)} /> מאז {day(first.date)}
      </span>
      <span className="tag good">שיא <Amount value={hi.balance} /> · {day(hi.date)}</span>
      <span className="tag">שפל <Amount value={lo.balance} /> · {day(lo.date)}</span>
    </div>
  );
}

/**
 * "איך אני בכללי?" — the longitudinal conduct view: direction, consistency, momentum.
 * Spec: docs/2026-07-16-overview-tab-spec.md. The partial current month rides every chart
 * faded/hollow and never enters an aggregate — the server enforces it, the UI honors it.
 */
export function Overview({ onOpenMonth }: { onOpenMonth: (month: string) => void }) {
  const [months, setMonths] = useState<number>(() => rememberedRange());
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [history, setHistory] = useState<DayBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    api.overview(months).then(setData).catch((e) => setError(errorMessageHe(e)));
  }, [months]);

  useEffect(() => {
    api.balanceHistory().then((r) => setHistory(r.series)).catch(() => setHistory([]));
  }, []);

  function pickRange(m: number) {
    setMonths(m);
    try {
      window.localStorage.setItem(RANGE_KEY, String(m));
    } catch {
      // remembering the range is a nicety, never a requirement
    }
  }

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  const { series, completeMonths, verdict, kpis, streaks, minus } = data;
  const complete = series.filter((r) => !r.partial);
  const anchor = String(data.anchorDay).padStart(2, '0');
  const windowStart = complete.length > 0 ? `${complete[0].month}-${anchor}` : null;
  const shownHistory = windowStart ? history.filter((d) => d.date >= windowStart) : history;

  if (completeMonths === 0) {
    return (
      <div>
        <p className="muted">עדיין אין חודש שלם בנתונים — התמונה הכללית תתחיל להצטייר אחרי סוף החודש הראשון. בינתיים, "איך אני החודש?" כבר עובד בשבילך.</p>
      </div>
    );
  }

  const verdictUp = verdict.prevAvgNet !== null ? verdict.avgNet - verdict.prevAvgNet : null;

  // The minus card's PRESENT state — what it wears, not what the window's worst month did.
  // A month or more since the last negative day is a state, not a footnote.
  const cleanMonths = minus.cleanDays !== null ? Math.floor(minus.cleanDays / 30) : 0;
  const minusClear = minus.totalDays === 0 || minus.neverMinus || cleanMonths >= 1;


  return (
    <div>
      {error && <p className="error">{error}</p>}

      {/* the tab's identity, said out loud — the sibling ledger tab says the mirror sentence */}
      <p className="view-identity">
        חודש רגיל שלך: כמה נכנס, כמה יוצא — בדרך כלל.
        {months >= 12 && (
          <button className="link" onClick={() => { window.location.hash = '#/year'; }}>
            לדוח לפי שנים ←
          </button>
        )}
      </p>

      {/* ── הפסק-דין: משפט אחד, מספר אחד ─────────────────────────────────────────── */}
      <div className="card hero">
        <CardChip icon={PiggyBank} />
        <div className="hero-top">
          <div className="label">
            {rangeLabelHe(months)} · בממוצע נשאר לך בצד
            <Explain title="בממוצע נשאר לך בצד">
              <p>הממוצע החודשי של "כמה נשאר ביד" על פני הטווח שבחרת — ורק על <strong>חודשים שלמים</strong>: החודש הרץ לעולם לא נספר, כי חצי חודש מרעיל ממוצעים.</p>
              <ExplainH>הנוסחה</ExplainH>
              <Formula>
                ממוצע( הכנסות החודש − הוצאות החודש ) על כל חודש שלם בטווח
              </Formula>
              <p>העוגה: <strong>במרכז — ממוצע ההכנסות, העוגה כולה</strong>; והיא נחתכת לשניים — ממוצע ההוצאות ומה שנשאר, כל אחד עם חץ, סכום ואחוז. החץ הצבעוני הקטן מתחת לכל סכום משווה לתקופה המקבילה הקודמת. בתקופה ממוצעת שלילית העוגה מתהפכת: במרכז ההוצאות, והפלחים — מה שההכנסות כיסו ומה שנשאר חריגה. עסקאות אחרי ניקוי כפילויות סילוקים והעברות פנימיות.</p>
            </Explain>
          </div>
          <div className="pills" style={{ display: 'inline-flex' }}>
            {RANGES.map((r) => (
              <button
                key={r.months}
                className={r.months === months ? 'pill active' : 'pill'}
                onClick={() => pickRange(r.months)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <Amount value={verdict.avgNet} hero tone={verdict.avgNet >= 0 ? undefined : 'negative'} />
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span className="muted">לחודש · על בסיס {completeMonths} חודשים מלאים</span>
          {verdictUp !== null && Math.abs(verdictUp) >= 1 && (
            <span className={verdictUp >= 0 ? 'amount-positive' : 'amount-negative'}>
              {verdictUp >= 0 ? '▲' : '▼'} {ILS0.format(Math.abs(verdictUp))} מול התקופה הקודמת
            </span>
          )}
          {kpis.savingsRate.value !== null && (
            <span
              className="tag"
              title="החלק מההכנסות שנשאר ביד · משק בית ישראלי רגיל: ~12% מההכנסה נטו · המלצת התכנון המקובלת: 10–20%"
            >
              חיסכון {Math.round(kpis.savingsRate.value * 100)}% · ישראלי רגיל ~12%
            </span>
          )}
        </div>
        {/* החודש הממוצע כעוגה עם חצים, לבקשת המשתמש: העוגה כולה = ממוצע ההכנסות,
            והיא נחתכת להוצאות ולמה שנשאר. בממוצע שלילי העוגה היא ההוצאות,
            והפלחים — מה שההכנסות כיסו ומה שנשאר חריגה. */}
        {(kpis.avgIncome.value ?? 0) >= 1 && (
          verdict.avgNet >= 0 ? (
            <CalloutPie
              ariaLabel="החודש הממוצע: הכנסות שמתחלקות להוצאות ולמה שנשאר"
              total={{
                id: 'income', label: 'ממוצע הכנסות', value: kpis.avgIncome.value ?? 0, color: 'var(--positive)',
                delta: kpis.avgIncome.delta !== null ? { amount: kpis.avgIncome.delta, goodWhenUp: true } : null,
              }}
              slices={[
                {
                  id: 'expenses', label: 'ממוצע הוצאות', value: kpis.avgExpenses.value ?? 0, color: 'var(--negative)',
                  delta: kpis.avgExpenses.delta !== null ? { amount: kpis.avgExpenses.delta, goodWhenUp: false } : null,
                },
                {
                  id: 'net', label: 'ממוצע שנשאר', value: verdict.avgNet, color: 'var(--positive)',
                  delta: kpis.avgNet.delta !== null ? { amount: kpis.avgNet.delta, goodWhenUp: true } : null,
                },
              ]}
            />
          ) : (
            <CalloutPie
              ariaLabel="החודש הממוצע בגירעון: ההוצאות מול מה שההכנסות כיסו"
              total={{
                id: 'expenses', label: 'ממוצע הוצאות', value: kpis.avgExpenses.value ?? 0, color: 'var(--negative)',
                delta: kpis.avgExpenses.delta !== null ? { amount: kpis.avgExpenses.delta, goodWhenUp: false } : null,
              }}
              slices={[
                {
                  id: 'income', label: 'מכוסה בהכנסות', value: kpis.avgIncome.value ?? 0, color: 'var(--positive)',
                  delta: kpis.avgIncome.delta !== null ? { amount: kpis.avgIncome.delta, goodWhenUp: true } : null,
                },
                {
                  id: 'gap', label: 'חריגה ממוצעת', value: -verdict.avgNet, color: 'var(--negative)',
                  delta: kpis.avgNet.delta !== null ? { amount: -kpis.avgNet.delta, goodWhenUp: false } : null,
                },
              ]}
            />
          )
        )}
      </div>

      <div className="grid">
        {/* ── כמה נשאר כל חודש: הלב הרגשי של הטאב ──────────────────────────────────── */}
        <div className="card g12 tone-sky">
          <CardChip icon={ChartColumnBig} />
          <div className="hero-top">
            <div className="label">
              כמה נשאר כל חודש
              <Explain title="כמה נשאר כל חודש">
                <p>לכל חודש שלם: הכנסות (עמודה ירוקה), הוצאות (אדומה), והנטו. קו הממוצע מוצג לרוחב. ירוק מעל אפס = החודש בנה; מתחת = שחק.</p>
                <p>אותם כללי ניקוי כמו בכל האפליקציה: חיוב כרטיס נספר פעם אחת, העברות פנימיות מוחרגות, החודש הרץ מוצג אך לא נספר בממוצע.</p>
              </Explain>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className={streaks.greenMonths >= completeMonths * 0.75 ? 'tag good' : 'tag'}>
                {streaks.greenMonths} מתוך {completeMonths} חודשים בפלוס
              </span>
              {streaks.currentPlusStreak >= 2 && <span className="tag good">רצף נוכחי: {streaks.currentPlusStreak} חודשים</span>}
            </div>
          </div>
          <NetBars
            summary={[...series].reverse().map((r) => ({ month: r.month, income: r.income, expenses: r.expenses, net: r.net, byCategory: [] }))}
            currentMonth={series[series.length - 1]?.partial ? series[series.length - 1].month : undefined}
            average={kpis.avgNet.value ?? undefined}
            onSelect={(m) => onOpenMonth(m)}
          />
          <div className="month-strip" aria-label="אילו חודשים נסגרו בפלוס">
            {complete.map((r) => (
              <i key={r.month} className={r.net > 0 ? 'plus' : 'minus'} title={`${monthLabel(r.month)} · ${ILS0.format(r.net)}`} />
            ))}
          </div>
          <p className="chart-caption">
            {streaks.best && <>החודש הטוב ביותר: {monthLabel(streaks.best.month)} ({ILS0.format(streaks.best.net)})</>}
            {streaks.best && streaks.worst && ' · '}
            {streaks.worst && <>המאתגר ביותר: {monthLabel(streaks.worst.month)} ({ILS0.format(streaks.worst.net)})</>}
            {' · לחיצה על חודש פותחת אותו'}
          </p>
        </div>

        {/* ── העו"ש יום אחרי יום ────────────────────────────────────────────────────────
             שלישי בכוונה, מיד אחרי שני הכרטיסים שמסכמים חודשים: הם אומרים מה יצא בסוף כל
             חודש, וזה מראה איך זה הרגיש בדרך. מה שמחויב מראש בא רק אחרי זה — הוא הסבר
             למספרים, לא מספר בזכות עצמו. */}
        {shownHistory.length > 1 && (
          <div className="card g12 tone-teal">
            <CardChip icon={Waves} />
            <div className="label">
              העו״ש שלך · יום אחרי יום
              <Explain title="העו״ש יום אחרי יום">
                <p>היתרה היומית של חשבון הבנק, משוחזרת אחורה מהיתרה האחרונה שדווחה:</p>
                <Formula>יתרת סוף אתמול = יתרת סוף היום − סך תנועות היום</Formula>
                <p>כך כל נקודה בגרף ניתנת לאימות מול דף החשבון (וכבר אומתה מול דף חשבון אמיתי, יום-ביום). שיא ושפל מסומנים; שים לב שתנועות תוך-יומיות יכולות לחרוג רגעית מיתרת סוף היום.</p>
              </Explain>
            </div>
            <BalanceTicker series={shownHistory} />
            <LineAreaChart series={shownHistory} height={230} plain ariaLabel="יתרת העובר ושב לאורך התקופה" />
          </div>
        )}

        {/* ── פרופיל המינוס: הבידול הישראלי ────────────────────────────────────────── */}
        {minus.covered && (
          <div className={minusClear ? 'card g12 tone-green' : 'card g12 tone-coral'}>
            <CardChip icon={minusClear ? ShieldCheck : TrendingDown} />
            <div className="hero-top">
              <div className="label">
                פרופיל המינוס
                <Explain title="פרופיל המינוס">
                  <p>כמה ימים {rangeLabelHe(months)} היתרה המשוחזרת הייתה מתחת לאפס, כמה עמוק, ומה זה עלה:</p>
                  <Formula>
                    ריבית משוערת ליום במינוס = עומק המינוס × ‎{(minus.rate * 100).toFixed(1)}% ÷ 365
                  </Formula>
                  <p>
                    ‎{(minus.rate * 100).toFixed(1)}% — ריבית החובה הממוצעת על מינוס לפי בנק ישראל. זו הערכה (הריבית האמיתית
                    שלך תלויה בבנק ובמסגרת), אבל היא מסדר הגודל הנכון — והיא מצטברת יום אחרי יום.
                  </p>
                  {/* the surface says one sentence; everything it left out lives here, whole */}
                  <ExplainH>מה עוד יודעים על התקופה</ExplainH>
                  <ul>
                    <li>הימים במינוס נספרים על פני {minus.monthsCovered} חודשים שהיתרה היומית מכסה.</li>
                    {minus.maxDepth && <li>העומק המרבי, {ILS0.format(minus.maxDepth.amount)}, נרשם ב{monthLabel(minus.maxDepth.month)}.</li>}
                    {minus.worstUtilization !== null && (
                      <li>בשיא נוצלו {Math.round(minus.worstUtilization * 100)}% ממסגרת האשראי.</li>
                    )}
                    {minus.totalDays > 0 && (
                      <li>הריבית על כל ימי המינוס בתקופה, יחד: כ-{ILS0.format(minus.interestCost)}.</li>
                    )}
                    <li>ישראל, לשם השוואה: כ-4 מ-10 מבוגרים נמצאים במינוס לאורך זמן (בנק ישראל / דף חדש, 2024).</li>
                  </ul>
                </Explain>
              </div>
              <span className="tag" title="כ-39% מהמבוגרים בישראל נמצאים במינוס לאורך זמן (נתוני בנק ישראל/דף חדש, 2024)">
                מול ישראל: ‎~4 מ-10 במינוס
              </span>
            </div>
            {/*
              The sentence follows the household's current state, not a fixed past.
              A running clean streak is the state; minus days that ended before it are history —
              and history does not get to set this card's colour, its icon, or its loud number.
            */}
            {minus.neverMinus ? (
              <p className="say">
                <b className="amount-positive">מעולם</b> לא היית במינוס
              </p>
            ) : minus.totalDays === 0 ? (
              <p className="say">
                <b className="amount-positive">אפס</b> ימי מינוס {rangeLabelHe(months)}
              </p>
            ) : cleanMonths >= 1 ? (
              <p className="say">
                כבר{' '}
                {cleanMonths >= 3
                  ? <><b className="amount-positive">{cleanMonths}</b> חודשים</>
                  : <b className="amount-positive">{cleanMonths === 1 ? 'חודש' : 'חודשיים'}</b>}
                {' '}בלי מינוס — וממשיך.{' '}
                {/* the past, quiet and clearly closed: in this branch every minus day in the
                    window necessarily precedes the streak, so the claim is safe to make */}
                <span className="say-past">
                  כל {minus.totalDays} ימי המינוס {rangeLabelHe(months)} קרו לפני כן.
                </span>
              </p>
            ) : (
              <p className="say">
                <b className="amount-negative">{minus.totalDays}</b> ימים במינוס {rangeLabelHe(months)}
                {minus.maxDepth && <>, הכי עמוק <b className="amount-negative">{ILS0.format(minus.maxDepth.amount)}</b></>}
                , ובריבית זה עלה בערך{' '}
                <b className="amount-negative" title="אומדן לפי הריבית הממוצעת על מינוס במשקי בית — לא חיוב בפועל">
                  {ILS0.format(minus.interestCost)}
                </b>
              </p>
            )}
          </div>
        )}

        {/* ── שכבת הפאוור-יוזר: הטבלה ──────────────────────────────────────────────── */}
        <div className="card g12 tone-slate">
          <button className="link" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable}>
            {showTable ? 'הסתר' : 'הצג'} את טבלת החודשים
          </button>
          {showTable && (
            <table className="months-table">
              <thead>
                <tr>
                  <th>חודש</th><th>הכנסות</th><th>הוצאות</th><th>נשאר</th><th>ימי מינוס</th>
                </tr>
              </thead>
              <tbody>
                {[...series].reverse().map((r) => (
                  <tr key={r.month} className={r.partial ? 'partial-row' : undefined}>
                    <td>{monthLabel(r.month)}{r.partial ? ' · בתהליך' : ''}</td>
                    <td>{ILS0.format(r.income)}</td>
                    <td>{ILS0.format(r.expenses)}</td>
                    <td className={r.net >= 0 ? 'amount-positive' : 'amount-negative'}>{ILS0.format(r.net)}</td>
                    <td>{r.minusDays ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>ממוצע ({completeMonths} מלאים)</td>
                  <td>{ILS0.format(kpis.avgIncome.value ?? 0)}</td>
                  <td>{ILS0.format(kpis.avgExpenses.value ?? 0)}</td>
                  <td className={(kpis.avgNet.value ?? 0) >= 0 ? 'amount-positive' : 'amount-negative'}>{ILS0.format(kpis.avgNet.value ?? 0)}</td>
                  <td>{minus.covered ? Math.round(minus.totalDays / Math.max(1, minus.monthsCovered)) : '—'}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
