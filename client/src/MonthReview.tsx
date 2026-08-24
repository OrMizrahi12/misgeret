import { ArrowDownUp, Hourglass, ReceiptText } from 'lucide-react';
import { CardChip } from './CardChip';
import { useEffect, useRef, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { MonthTxnTable, type TxnNote, type TxnRank } from './CategoryTxns';
import { Explain, ExplainH } from './Explain';
import type { MonthReview as MonthReviewData, MonthTxn } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/** One tone per observation family: red = act now, orange = look closer, blue = new information. */
function noteTone(type: string): TxnNote['tone'] {
  if (type === 'duplicate-charge') return 'danger';
  if (type === 'new-recurring') return 'info';
  return 'warn';
}

export function MonthReview({ month, onBack, embedded = false, condensed = false, categoryRequest, preloaded, onDataChanged }: {
  month: string;
  onBack?: () => void;
  /** Embedded inside the month tab: no toolbar of its own — the host owns the heading. */
  embedded?: boolean;
  /** The host already draws the headline above, so this component keeps only the category
   *  breakdown that drives its table filter through `categoryRequest`. */
  condensed?: boolean;
  /** A category the host asks to open (a donut-slice click above) — seq re-fires the same id. */
  categoryRequest?: { id: string; seq: number } | null;
  /** Review data the host fetched for its own cards — undefined means "fetch yourself";
   *  null means the host's fetch is still in flight (its state update re-runs the effect). */
  preloaded?: MonthReviewData | null;
  /** Something the user did in the register changed the month's arithmetic (a re-categorisation).
   *  The host owns the figures above this table and has to refetch them. */
  onDataChanged?: () => void | Promise<void>;
}) {
  const [data, setData] = useState<MonthReviewData | null>(null);
  const [txns, setTxns] = useState<MonthTxn[] | null>(null);
  const [selectedCat, setSelectedCat] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tablePanelRef = useRef<HTMLDivElement>(null);
  // seeded with the mount-time seq: a request is a click, not a state to replay on remount
  const requestedSeq = useRef(categoryRequest?.seq ?? 0);

  useEffect(() => {
    setSelectedCat(null);
    if (preloaded !== undefined) {
      if (preloaded && preloaded.month === month) setData(preloaded);
      return;
    }
    api.monthReview(month).then(setData).catch((e) => setError(errorMessageHe(e)));
  }, [month, preloaded]);

  // the register is THE transactions surface now — it loads with the month, not behind a click
  useEffect(() => {
    let gone = false;
    setTxns(null);
    api.monthTxns(month)
      .then((res) => { if (!gone) setTxns(res.txns); })
      .catch((e) => { if (!gone) setError(errorMessageHe(e)); });
    return () => { gone = true; };
  }, [month]);

  async function reloadTxns() {
    try {
      const res = await api.monthTxns(month);
      setTxns(res.txns);
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  useEffect(() => {
    if (!categoryRequest || categoryRequest.seq === requestedSeq.current) return;
    requestedSeq.current = categoryRequest.seq;
    setSelectedCat(categoryRequest.id);
  }, [categoryRequest]);

  // the register sits far below the donut that filtered it — bring it into view
  // (instant on purpose: smooth scrollIntoView silently no-ops in the embedded Chromium)
  useEffect(() => {
    if (selectedCat && txns) tablePanelRef.current?.scrollIntoView({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCat, txns]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  const { current, previous, byCategory, topMerchants, insights, pending } = data;
  const allCategories = byCategory.map((c) => c.category);

  // every observation lands ON its rows; one that maps to no row (fees total, or a ref the
  // month no longer shows) falls through to a line under the table — never silently dropped
  const notes = new Map<string, TxnNote[]>();
  const footNotes: string[] = [];
  for (const ins of insights) {
    const refs = ins.refs ?? [];
    if (ins.type === 'fee' || refs.length === 0) {
      footNotes.push(ins.textHe);
      continue;
    }
    for (const key of refs) {
      const g = notes.get(key) ?? [];
      g.push({ textHe: ins.textHe, tone: noteTone(ins.type) });
      notes.set(key, g);
    }
  }
  const ranks = new Map<string, TxnRank>();
  topMerchants.slice(0, 3).forEach((m, i) => {
    const titleHe = `${m.merchant} — הסוחר מספר ${i + 1} של החודש: ${ILS0.format(m.total)} ב־${m.count} עסקאות`;
    for (const key of m.refs ?? []) ranks.set(key, { n: i + 1, titleHe });
  });

  return (
    <div>
      {!embedded && (
        <div className="toolbar">
          <h2 style={{ margin: 0, flex: 1 }}>סקירת {monthLabel(month)}</h2>
          <button className="link" onClick={() => onBack?.()}>חזרה</button>
        </div>
      )}

      {!condensed && (
        <div className="card hero">
          <CardChip icon={ArrowDownUp} />
          <div className="label">נטו</div>
          <Amount value={current.net} hero tone={current.net >= 0 ? undefined : 'negative'} />
          {previous && (
            <p className="muted" style={{ marginTop: 6 }}>
              {/* every figure names its own month — see the same fix in Month.tsx */}
              ב{monthLabel(month)} נכנסו {ILS0.format(current.income)} ויצאו {ILS0.format(current.expenses)} ·
              מול {monthLabel(previous.month)}: הכנסות {diffText(current.income, previous.income)},
              הוצאות {diffText(current.expenses, previous.expenses)}
            </p>
          )}
        </div>
      )}

      {pending.count > 0 && (
        <p className="muted" role="note">
          {pending.count === 1
            ? <><Hourglass size={12} strokeWidth={2.2} className="ic ic-muted" aria-hidden /> עסקה אחת ממתינה בסך {ILS0.format(pending.net)} — הבנק טרם אישר אותה, ולכן היא עדיין לא נספרת בחודש.</>
            : <><Hourglass size={12} strokeWidth={2.2} className="ic ic-muted" aria-hidden /> {pending.count} עסקאות ממתינות בסך {ILS0.format(pending.net)} — הבנק טרם אישר אותן, ולכן הן עדיין לא נספרות בחודש.</>}
        </p>
      )}

      <div className="card tone-sky" ref={tablePanelRef}>
        <CardChip icon={ReceiptText} />
        <div className="label">
          עסקאות החודש
          {txns && <span className="muted"> · {txns.length}</span>}
          <Explain title="עסקאות החודש">
            <p>
              הרישום המלא של החודש: כל עסקה שהחודש מכיר, בטבלה אחת — כולל ממתינות ומוחרגות,
              כדי ששום כסף לא ייעלם מהעין. כל דבר שראוי לתשומת לב מסומן ליד העסקה עצמה.
            </p>
            <ExplainH>מה נכנס לטבלה</ExplainH>
            <p>
              כל השורות ששויכו לחודש הזה לפי הגדרת תחילת החודש שלך. שורה אפורה = לא
              נספרת בהכנסות/הוצאות: או שהיא ממתינה לאישור הבנק (תגית "ממתין"), או שהיא מוחרגת —
              והתגית שלה אומרת בדיוק למה (חיוב כרטיס שנספר בפירוט, העברה פנימית, תנועה בחיסכון וכו').
            </p>
            <ExplainH>ההערות הצבעוניות — התנאים המדויקים</ExplainH>
            <ul>
              <li><strong style={{ color: 'var(--negative)' }}>אדום — חיוב כפול אפשרי:</strong> אותו סוחר ואותו סכום בדיוק (מ־100 ₪ ומעלה) פעמיים בתוך 48 שעות, ולא תשלומים.</li>
              <li><strong style={{ color: 'var(--warning)' }}>כתום — התייקרות:</strong> חיוב קבוע שעלה יותר מ־8% (ולפחות 10 ₪) מעל הסכום הרגיל שלו.</li>
              <li><strong style={{ color: 'var(--accent)' }}>כחול — חיוב קבוע חדש:</strong> חיוב שחוזר כל חודש וזוהה לראשונה החודש.</li>
            </ul>
            <p>אין כאן ניחושים — כל הערה נובעת מתנאי מספרי, והעסקאות שהיא מצביעה עליהן נמצאות באותה שורה.</p>
            <ExplainH>תגית "מוביל"</ExplainH>
            <p>
              שלושת הסוחרים שהוצאת אצלם הכי הרבה החודש (אחרי נרמול השם — "שופרסל 123" ו"שופרסל 456"
              הם אותו סוחר). כל עסקה שלהם מקבלת "מוביל 1/2/3", וריחוף על התגית מציג את הסכום הכולל
              ומספר העסקאות של אותו סוחר.
            </p>
            <ExplainH>סינון לפי קטגוריה</ExplainH>
            <p>
              לחיצה על קטגוריה בדונאט שלמעלה מסננת את הטבלה לעסקאות שלה — הוצאות שהושלמו ולא
              הוחרגו, בדיוק אלה שמרכיבות את הפרוסה. הסכום שבתגית הסינון שווה תמיד לסכום הקטגוריה.
            </p>
            <ExplainH>קיצור תצוגה</ExplainH>
            <p>
              בחודש ארוך מוצגות 25 השורות הראשונות לפי המיון הנוכחי, ובנוסף — תמיד — כל שורה
              שנושאת הערה צבעונית או תגית "מוביל", כדי שאף סימן לא יוסתר. כפתור בתחתית פותח את
              הרשימה המלאה.
            </p>
            {footNotes.length > 0 && (
              <>
                <ExplainH>השורה שמתחת לטבלה</ExplainH>
                <p>תצפית שנוגעת לכמה עסקאות יחד (למשל סך העמלות) מופיעה כשורה מסכמת מתחת לטבלה במקום להיצמד לעסקה אחת.</p>
              </>
            )}
          </Explain>
        </div>
        {txns ? (
          <>
            <MonthTxnTable
              txns={txns}
              marks={{ notes, ranks }}
              category={selectedCat}
              headCategories={allCategories}
              onClearCategory={() => setSelectedCat(null)}
              onDeleteManual={async (t) => {
                try {
                  await api.deleteTxn(t.key);
                  await reloadTxns();
                } catch (e) {
                  setError(errorMessageHe(e));
                }
              }}
              onMarkMerchant={async (merchant, mark, expectedAmount) => {
                try {
                  await api.applyMerchantMark(merchant, mark, expectedAmount);
                  await reloadTxns();
                } catch (e) {
                  setError(errorMessageHe(e));
                }
              }}
              onSetCategory={async (t, category) => {
                try {
                  if (category === null) await api.clearTxnCategory(t.key);
                  else await api.setTxnCategory(t.key, { category });
                  await reloadTxns();
                  // a category is not cosmetic: it moves money between slices, so whoever owns the
                  // month's totals above this table has to hear about it — the host through the
                  // callback, and this component's own breakdown when nobody preloaded it for us
                  if (preloaded === undefined) setData(await api.monthReview(month));
                  await onDataChanged?.();
                } catch (e) {
                  setError(errorMessageHe(e));
                }
              }}
            />
            {footNotes.map((textHe, i) => (
              <p key={i} className="chart-caption" style={{ marginBottom: 0 }}>{textHe}</p>
            ))}
          </>
        ) : (
          <p className="muted">טוען…</p>
        )}
      </div>
    </div>
  );
}

export function diffText(current: number, previous: number): string {
  if (previous === 0) return '—';
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct === 0 ? 'ללא שינוי' : pct > 0 ? `‎+${pct}%` : `‎${pct}%`;
}
