import { CalendarRange, ChartColumnBig, Gem, Layers, Store } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { CardChip } from './CardChip';
import { CategoryHistoryModal } from './CategoryHistory';
import { MonthlyBars, categoryColor } from './charts';
import { Explain, ExplainH, Formula } from './Explain';
import { MerchantHistoryModal } from './MerchantHistory';
import { Staircase, type StaircaseRow } from './Staircase';
import type { TxnMark, YearReport } from './types';
import { categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** A calendar day is read in the app's timezone, never sliced off the stored instant. */
function dayMonthHe(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', timeZone: 'Asia/Jerusalem' });
}

/** A spend delta speaks the polarity law: more spending = red, less = green. Beside a coloured bar
 *  a filled pill would fight it for attention, so the delta is bare ink and an arrow. */
/**
 * The three staircases are ONE picture drawn three times, so they must agree down to their chrome:
 * same card width, same reserved button column, same tail slot. Give any of them a different track
 * and the same component draws a different chart — which is what a full-width ranking beside a
 * five-column one looked like: the wide card a staircase, the narrow one a wall.
 *
 * 106px is the tail's worst case anywhere in the tab — "3 בדצמ׳ · 12 תש׳" — and every card pays it,
 * so the three cards' columns line up down the page.
 */
const STAIR = { tailWidth: 106, reserveOpen: true } as const;

/** Said once, shown in all three cards: three identical pictures owe the reader one explanation. */
function ScaleNote() {
  return (
    <>
      <ExplainH>למה הפס הקצר לא זעיר</ExplainH>
      <p>
        הסולם נמתח כך שהשורה הקטנה ביותר עדיין מחזיקה את <strong>הסכום</strong> שלה בתוך הפס — פס
        שהמספר בו נחתך לא שווה כלום. לכן <strong>אורך הפס אינו יחס מדויק</strong>: הוא מדרג,
        והמספר שבתוכו הוא האמת המלאה. שם ארוך מתקצר בשלוש נקודות (ריחוף מחזיר אותו), כדי ששם אחד
        לא ישטח את כל המדרגה.
      </p>
    </>
  );
}

function Delta({ pct, prevYear }: { pct: number; prevYear: string }) {
  const up = pct > 0;
  return (
    <span className={up ? 'year-cat-delta up' : 'year-cat-delta down'} title={`מול ${prevYear}`}>
      {up ? '▲' : '▼'}{Math.abs(pct)}%
    </span>
  );
}


/**
 * "איך עברה השנה?" — the annual statement: the December question, answerable all year long.
 * Twelve flow months of one calendar year; every comparison to the previous year runs over
 * the SAME month numbers in both years (an honest YoY), and says how many months that is.
 */
export function Year() {
  const [report, setReport] = useState<YearReport | null>(null);
  const [year, setYear] = useState<string | null>(null); // null = the server's current flow year
  const [error, setError] = useState<string | null>(null);

  const [catHistory, setCatHistory] = useState<string | null>(null);
  const [merchHistory, setMerchHistory] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.year(year ?? undefined).then(setReport).catch((e) => setError(errorMessageHe(e)));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  // Hooks before the early returns: the staircases measure themselves, and a measurement hook may
  // not appear and disappear with the data.
  const prevYear = report ? String(Number(report.year) - 1) : '';
  const catRows = useMemo<StaircaseRow[]>(() => (report?.byCategory ?? []).slice(0, 10).map((c) => ({
    id: c.category,
    name: categoryNameHe(c.category),
    amountHe: ILS0.format(c.total),
    value: c.total,
    color: categoryColor(c.category),
    openLabel: `היסטוריית התשלומים · ${categoryNameHe(c.category)}`,
    onOpen: () => setCatHistory(c.category),
    tail: c.deltaPct !== null ? <Delta pct={c.deltaPct} prevYear={prevYear} /> : null,
  })), [report, prevYear]);

  // A merchant wears its category's colour: the ranking then says not only how much left, but into
  // which world it went — the one thing a list of names cannot tell you.
  const merchRows = useMemo<StaircaseRow[]>(() => (report?.topMerchants ?? []).map((m) => ({
    id: m.merchant,
    name: m.name,
    amountHe: ILS0.format(m.total),
    value: m.total,
    color: categoryColor(m.category ?? 'other'),
    openLabel: `היסטוריה ודפוס · ${m.name}`,
    onOpen: m.drillable ? () => setMerchHistory(m.merchant) : undefined,
    tail: <span className="stair-count">{m.count} חיובים</span>,
  })), [report]);

  // The same staircase a third time — one purchase per bar. Its tail is the date: for a one-off
  // event, WHEN is the fact a ranking cannot carry.
  const bigRows = useMemo<StaircaseRow[]>(() => (report?.biggest ?? []).map((e) => ({
    id: e.key,
    name: e.description,
    amountHe: ILS0.format(e.amount),
    value: e.amount,
    color: categoryColor(e.category ?? 'other'),
    tail: (
      <span className="stair-count">
        {dayMonthHe(e.date)}
        {e.installments > 1 && <> · {e.installments} תש׳</>}
      </span>
    ),
  })), [report]);

  if (error) return <p className="error">{error}</p>;
  if (!report) return <p className="muted">טוען…</p>;

  if (report.monthsWithData === 0 && report.years.length === 0) {
    return (
      <div className="empty-note">
        <p className="muted">אין עדיין נתונים לשנה. אחרי הסנכרון הראשון — השנה תתחיל להיכתב כאן.</p>
      </div>
    );
  }

  const sm = report.sameMonths;
  const partial = report.months.some((m) => m.partial && m.hasData);
  const monthsForBars = report.months.filter((m) => m.hasData);
  const merchant = report.topMerchants.find((m) => m.merchant === merchHistory) ?? null;

  /** Classifying from the year tab writes the same merchant-wide verdict as everywhere else, then
   *  reloads — the mark shown in the popup must be the stored one, not an optimistic guess. */
  async function markMerchant(key: string, mark: TxnMark | null, anchor: number) {
    setBusy(key);
    try {
      const withAnchor = mark === 'subscription' || mark === 'fixed';
      await api.applyMerchantMark(key, mark, withAnchor ? anchor : undefined);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {/* the tab's identity, said out loud — the sibling diagnosis tab says the mirror sentence */}
      <p className="view-identity">
        מה קרה השנה — חודש-חודש, מול שנה שעברה.
        <button className="link" onClick={() => { window.location.hash = '#/overview'; }}>
          ואיך אתה מתנהל בדרך כלל? ←
        </button>
      </p>

      {/* year picker — every year that holds data, newest first */}
      {report.years.length > 1 && (
        <div className="toolbar" style={{ alignItems: 'center', gap: 8 }}>
          {report.years.map((y) => (
            <button
              key={y}
              className={y === report.year ? 'pill active' : 'pill'}
              onClick={() => setYear(y)}
              aria-pressed={y === report.year}
            >
              {y}
            </button>
          ))}
        </div>
      )}

      <div className="grid">
        {/* ── השנה במספר אחד ──────────────────────────────────────────────────────────── */}
        <div className="card hero g12 tone-violet">
          <CardChip icon={CalendarRange} />
          <div className="hero-top">
            <div className="label">
              {report.year} · השורה התחתונה
              <Explain title="השורה התחתונה של השנה">
                <p>כל חודשי {report.year} שיש להם נתונים, מסוכמים יחד — אותו חישוב בדיוק כמו של חודש בודד, על השנה כולה.</p>
                <Formula>
                  נכנס השנה {ILS0.format(report.totals.income)}
                  <br />− יצא השנה {ILS0.format(report.totals.expenses)}
                  <br />= <strong>{ILS0.format(report.totals.net)}</strong>
                </Formula>
                <ExplainH>ההשוואה לשנה הקודמת</ExplainH>
                <p>
                  שנה שרצה עכשיו לעולם לא מושווית לשנה קודמת שלמה. ההשוואה נעשית על <strong>אותם חודשים
                  בדיוק</strong> שיש בהם נתונים בשתי השנים — והכיתוב אומר כמה חודשים זה.
                </p>
              </Explain>
            </div>
            <span className="tag">
              {report.monthsWithData} חודשים{partial ? ' · כולל חודש רץ' : ''}
            </span>
          </div>
          {/* No year-total hero: it repeated, figure for figure, the current-year row of the
              comparison below it. The comparison row IS the bottom line now — the past year
              stays small beside it. Only a first year, with nothing to compare against, still
              needs the standalone total. */}
          {!sm && (
            <Amount value={report.totals.net} hero tone={report.totals.net >= 0 ? undefined : 'negative'} />
          )}
          {sm && (
            /* Two years never share a sentence: each gets its own labelled row, and the header
               names the basis. The old one-liner read as if the current year's net belonged to
               last year's income and expenses — and its "השנה" figure (shared months) silently
               disagreed with the hero above it (full year) whenever the two spans differed. */
            <div className="year-vs">
              <div className="year-vs-head">
                {sm.count} החודשים שיש נתונים עליהם בשתי השנים
                {sm.count !== report.monthsWithData &&
                  ` — ולכן לא כל ${report.year}, שיש בה ${report.monthsWithData} חודשים עם נתונים`}
              </div>
              {[
                { year: sm.prevYear, figures: sm.prev, now: false },
                { year: report.year, figures: sm.current, now: true },
              ].map((row) => (
                <div key={row.year} className={row.now ? 'year-vs-row now' : 'year-vs-row'}>
                  <span className="year-vs-year">{row.year}</span>
                  <span className="year-vs-cell">נכנסו {ILS0.format(row.figures.income)}</span>
                  <span className="year-vs-cell">יצאו {ILS0.format(row.figures.expenses)}</span>
                  <span className={row.figures.net >= 0 ? 'year-vs-net amount-positive' : 'year-vs-net amount-negative'}>
                    נשארו {ILS0.format(row.figures.net)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── חודש אחר חודש ───────────────────────────────────────────────────────────── */}
        <div className="card g12 tone-sky">
          <CardChip icon={ChartColumnBig} />
          <div className="label">
            חודש אחר חודש
            <Explain title="חודש אחר חודש">
              <p>הכנסות מול הוצאות בכל חודש של {report.year}. לחיצה על חודש פותחת אותו בטאב "איך אני החודש?".</p>
            </Explain>
          </div>
          <MonthlyBars
            summary={[...monthsForBars].reverse().map((m) => ({ month: m.month, income: m.income, expenses: m.expenses, net: m.net, byCategory: [] }))}
            selected=""
            onSelect={(m) => { window.location.hash = `#/month/${m}`; }}
          />
        </div>

        {/* ── הקטגוריות של השנה ───────────────────────────────────────────────────────── */}
        {report.byCategory.length > 0 && (
          <div className="card g12 tone-gold">
            <CardChip icon={Layers} />
            <div className="label">
              הקטגוריות של השנה
              <Explain title="הקטגוריות של השנה">
                <p>סך ההוצאה השנתית בכל קטגוריה. אורך הפס אומר מי גדול ממי, והמספר בתוך הפס אומר בכמה.</p>
                <ScaleNote />
                <ExplainH>ההשוואה לשנה הקודמת</ExplainH>
                <p>
                  נעשית רק על החודשים שקיימים בשתי השנים, ורק כשלקטגוריה היה בסיס אמיתי בשנה הקודמת
                  (לפחות ‏100 ₪) — אחוז על בסיס זעיר הוא מספר ליצן. אדום = הוצאתם יותר, ירוק = פחות.
                </p>
              </Explain>
            </div>
            <Staircase rows={catRows} {...STAIR} />
          </div>
        )}

        {/* ── הספקים של השנה ──────────────────────────────────────────────────────────── */}
        {report.topMerchants.length > 0 && (
          <div className="card g12 tone-teal">
            <CardChip icon={Store} />
            <div className="label">
              לאן הלך הכי הרבה
              <Explain title="לאן הלך הכי הרבה">
                <p>הספקים שקיבלו הכי הרבה כסף השנה — סך כל החיובים שלהם ומספרם.</p>
                <ExplainH>הצבע</ExplainH>
                <p>
                  כל פס לובש את <strong>הקטגוריה</strong> של העסק, כך שהרשימה אומרת לא רק כמה יצא —
                  אלא לאיזה עולם.
                </p>
                <ScaleNote />
                <ExplainH>הכפתור</ExplainH>
                <p>פותח את היסטוריית החיובים של אותו עסק, ומשם אפשר גם לסווג אותו (מנוי / קבוע / הרגל).</p>
              </Explain>
            </div>
            <Staircase rows={merchRows} {...STAIR} />
          </div>
        )}

        {/* ── הרכישות הגדולות ─────────────────────────────────────────────────────────── */}
        {report.biggest.length > 0 && (
          <div className="card g12 tone-coral">
            <CardChip icon={Gem} />
            <div className="label">
              הרכישות הגדולות של {report.year}
              <Explain title="הרכישות הגדולות">
                <p>
                  ההוצאות הבודדות הגדולות של השנה. אורך הפס מדרג, המספר שבתוכו הוא הסכום המלא,
                  והצבע הוא הקטגוריה. בקצה — התאריך.
                </p>
                <ScaleNote />
                <ExplainH>תשלומים</ExplainH>
                <p>
                  רכישה שנפרסה לתשלומים מורכבת מחדש ומתמודדת כרכישה אחת — לא כשנים-עשר חיובים קטנים —
                  ונושאת את מועד החיוב הראשון שלה השנה.
                </p>
              </Explain>
            </div>
            <Staircase rows={bigRows} {...STAIR} />
          </div>
        )}
      </div>

      {catHistory && (
        <CategoryHistoryModal category={catHistory} onClose={() => setCatHistory(null)} />
      )}
      {merchant && (
        <MerchantHistoryModal
          merchant={merchant.merchant}
          title={merchant.name}
          mark={merchant.mark}
          busy={busy === merchant.merchant}
          onMark={(m) => void markMerchant(merchant.merchant, m, Math.round(merchant.total / Math.max(1, merchant.count)))}
          onClose={() => setMerchHistory(null)}
        />
      )}
    </div>
  );
}
