import { History, Settings2 } from 'lucide-react';
import { useMemo, useState, type CSSProperties } from 'react';
import { Amount } from './Amount';
import { categoryColor } from './charts';
import { MerchantHistoryModal } from './MerchantHistory';
import type { MonthTxn, TxnMark } from './types';
import { CATEGORIES, categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Why a row is real money that moved, yet counts as neither income nor expense. This is the only
 *  place the user can audit that decision, so an unknown reason must still say so — hence the
 *  fallback: a reason added on the server can never render an unexplained grey row again.
 *  'savings' and 'manual' are distinct on purpose — what the engine knew vs. what the user taught. */
const EXCLUDE_TAGS: Record<string, { textHe: string; warn?: boolean }> = {
  settlement: { textHe: 'חיוב כרטיס — מוחרג' },
  transfer: { textHe: 'העברה פנימית — מוחרג' },
  future: { textHe: 'חיוב עתידי — מוחרג', warn: true },
  partial: { textHe: 'פירוט חלקי — נספר החיוב מהבנק', warn: true },
  savings: { textHe: 'תנועה בחיסכון — מוחרג' },
  manual: { textHe: 'סווג ידנית כתנועה פנימית — מוחרג' },
};

/** Exported so the dashboard's search results explain an exclusion in the same words as the
 *  month drill-down. Two maps would drift, and a row the user cannot ask "why" about is money
 *  the app hid. The fallback is the point: a reason added server-side can never render bare. */
export function ExcludeTag({ reason }: { reason: string }) {
  const tag = EXCLUDE_TAGS[reason];
  if (!tag) return <span className="tag">מוחרג</span>;
  return <span className={tag.warn ? 'tag warn' : 'tag'}>{tag.textHe}</span>;
}

/** The category chip, wearing its own chart color — the exact hue the Sankey ribbon and
 *  donut slice give this category, so table and charts speak one identity language. */
export function CategoryTag({ id, labelHe }: { id: string; labelHe?: string }) {
  return (
    <span className="tag cat" style={{ '--cat': categoryColor(id) } as CSSProperties}>
      {labelHe ?? categoryNameHe(id)}
    </span>
  );
}

/** A colored remark beside one row — the month's observations live ON the transactions now,
 *  not in boxes of their own. */
export interface TxnNote { textHe: string; tone: 'danger' | 'warn' | 'info' }
/** Top-merchant rank chip: n is 1–3, titleHe carries the merchant's month total on hover. */
export interface TxnRank { n: number; titleHe: string }
export interface TxnMarks { notes: Map<string, TxnNote[]>; ranks: Map<string, TxnRank> }

/** Long months collapse to this many rows — but a row carrying a note is a signal,
 *  and a signal below the fold is a signal lost, so noted rows always stay visible. */
const CAP = 25;

/** THE month register: every transaction of the month in one table — searchable, sortable,
 *  and tagged in place (category, installments, pending, exclusions, observations, top
 *  merchants). A Sankey-ribbon click narrows it to that slice via the `category` chip. */
export function MonthTxnTable({ txns, marks, category, headCategories = [], onClearCategory, onDeleteManual, onMarkMerchant, onSetCategory }: {
  txns: MonthTxn[];
  marks?: TxnMarks;
  /** Active category filter — the table narrows to the rows behind that Sankey ribbon. */
  category?: string | null;
  /** The month's head categories, needed to resolve the 'rollup' slice like the Sankey does. */
  headCategories?: string[];
  onClearCategory?: () => void;
  onDeleteManual?: (t: MonthTxn) => void;
  /** Classify a whole merchant (every one of its charges) from a single row — the inline way to
   *  teach the app "this is a subscription / a recurring charge". null clears the verdict.
   *  `expectedAmount` is THIS charge's amount — the anchor for "the amount I marked IS the amount". */
  onMarkMerchant?: (merchant: string, mark: TxnMark | null, expectedAmount?: number) => Promise<void>;
  /** Set (or clear, with null) THIS transaction's category. The engine guesses; this is where the
   *  user overrules it — including declaring an income row "הכנסה". */
  onSetCategory?: (t: MonthTxn, category: string | null) => Promise<void>;
}) {
  const [q, setQ] = useState('');
  const [sortBy, setSortBy] = useState<'date' | 'amount'>('date');
  const [expanded, setExpanded] = useState(false);
  /** The merchant whose mark is being written right now — disables its buttons across every row. */
  const [busyMerchant, setBusyMerchant] = useState<string | null>(null);
  /** The transaction whose "היסטוריה ודפוס" popup is open (null = closed). */
  const [historyFor, setHistoryFor] = useState<MonthTxn | null>(null);
  /** The ONE row whose settings panel is open. Four buttons per row turned the register into a
   *  wall of controls; they live behind this row's gear now, and only one row opens at a time. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** The row whose category is being written — its picker greys out until the server answers. */
  const [busyCat, setBusyCat] = useState<string | null>(null);

  async function pickCategory(t: MonthTxn, next: string | null) {
    if (!onSetCategory) return;
    setBusyCat(t.key);
    try {
      await onSetCategory(t, next);
    } finally {
      setBusyCat(null);
    }
  }

  /** Toggle a merchant's classification: clicking the active verdict clears it, else sets it.
   *  Applies to every charge of the merchant, so future occurrences are recognized too. */
  async function toggleMark(t: MonthTxn, next: TxnMark) {
    if (!t.merchant || !onMarkMerchant) return;
    const target: TxnMark | null = t.mark === next ? null : next;
    setBusyMerchant(t.merchant);
    try {
      // when SETTING a commitment verdict, this row's amount becomes the anchored cost —
      // a habit is behaviour, it has no expected amount to anchor
      const anchor = target === 'subscription' || target === 'fixed' ? Math.abs(t.amount) : undefined;
      await onMarkMerchant(t.merchant, target, anchor);
    } finally {
      setBusyMerchant(null);
    }
  }

  /** Classify straight from the history popup — same effect as the row buttons, anchored to the
   *  charge the popup was opened from. `target` is the new verdict (null clears it). */
  async function markFromHistory(t: MonthTxn, target: TxnMark | null) {
    if (!t.merchant || !onMarkMerchant) return;
    setBusyMerchant(t.merchant);
    try {
      const anchor = target === 'subscription' || target === 'fixed' ? Math.abs(t.amount) : undefined;
      await onMarkMerchant(t.merchant, target, anchor);
    } finally {
      setBusyMerchant(null);
    }
  }
  const base = useMemo(
    () => (category ? categoryFilter(txns, category, headCategories) : txns),
    [txns, category, headCategories],
  );
  const shown = useMemo(() => {
    const needle = q.trim();
    const list = needle ? base.filter((t) => t.description.includes(needle)) : base;
    return [...list].sort((a, b) => (sortBy === 'date' ? b.date.localeCompare(a.date) : a.amount - b.amount));
  }, [base, q, sortBy]);
  // the cap yields once the user narrows (search/category) — a filtered view is already short on purpose
  const capActive = !expanded && !q.trim() && !category && shown.length > CAP + 5;
  const visible = capActive
    ? shown.filter((t, i) => i < CAP || marks?.notes.has(t.key) || marks?.ranks.has(t.key))
    : shown;
  const catTotal = category ? base.reduce((s, t) => s + -t.amount, 0) : 0;

  return (
    <div>
      {category && (
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <span className="tag cat" style={{ '--cat': categoryColor(category) } as CSSProperties}>
            {categoryTitleHe(category)} · {ILS0.format(catTotal)} · {base.length} עסקאות
          </span>
          <button className="link" onClick={onClearCategory}>הצגת כל העסקאות ✕</button>
        </div>
      )}
      {txns.length > 8 && (
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <input placeholder="סינון לפי תיאור…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 220 }} />
          {q.trim() && <span className="muted">{shown.length} מתוך {base.length}</span>}
        </div>
      )}
      {category && base.length === 0 && <p className="muted">אין עסקאות מוצגות בקטגוריה הזו החודש.</p>}
      {/* the transactions TABLE: fixed columns, so every date, tag, amount and action sits on
          the same vertical line in every row — no more tags drifting with the sentence length.
          The date/amount headers are the sort controls. */}
      <div className="txnt" role="table" aria-label="עסקאות החודש">
        <div className="txnt-head" role="row">
          <button
            type="button"
            className={sortBy === 'date' ? 'txnt-h txnt-sort on' : 'txnt-h txnt-sort'}
            aria-sort={sortBy === 'date' ? 'descending' : undefined}
            onClick={() => setSortBy('date')}
          >תאריך{sortBy === 'date' ? ' ▾' : ''}</button>
          <span className="txnt-h">תיאור</span>
          <span className="txnt-h txnt-h-tags">תגיות</span>
          <button
            type="button"
            className={sortBy === 'amount' ? 'txnt-h txnt-sort txnt-h-amount on' : 'txnt-h txnt-sort txnt-h-amount'}
            aria-sort={sortBy === 'amount' ? 'descending' : undefined}
            onClick={() => setSortBy('amount')}
          >סכום{sortBy === 'amount' ? ' ▾' : ''}</button>
          <span className="txnt-h txnt-h-actions">הגדרות</span>
        </div>
        {visible.map((t) => {
          const rank = marks?.ranks.get(t.key);
          const notes = marks?.notes.get(t.key);
          const canMark = Boolean(t.classifiable && t.merchant && onMarkMerchant);
          const canCategorize = Boolean(onSetCategory);
          const canDelete = Boolean(onDeleteManual && t.company === 'manual');
          const hasPanel = canMark || canCategorize || canDelete;
          const open = openKey === t.key;
          const rowKey = `${t.date}|${t.description}|${t.amount}|${t.company}`;
          return (
            <div key={rowKey} className={open ? 'txnt-group open' : 'txnt-group'}>
            <div
              className={t.excluded || t.status === 'pending' ? 'txnt-row muted-row' : 'txnt-row'}
              role="row"
            >
              <span className="txnt-date">
                {new Date(t.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', timeZone: 'Asia/Jerusalem' })}
              </span>
              <span className="txnt-desc" title={`${t.description}${t.merchantName ? ` · ${t.merchantName}` : ''} · ${t.connectionLabel}`}>
                {t.description}
                {t.merchantName && <span className="txn-payee"> · {t.merchantName}</span>}
                <span className="txnt-conn"> · {t.connectionLabel}</span>
              </span>
              <span className="txnt-tags">
                {t.category && <CategoryTag id={t.category} />}
                {t.installments && <span className="tag">תשלום {t.installments}</span>}
                {t.status === 'pending' && <span className="tag">ממתין</span>}
                {t.excludeReason && <ExcludeTag reason={t.excludeReason} />}
                {rank && <span className="tag rank" title={rank.titleHe}>מוביל {rank.n}</span>}
                {notes?.map((n, i) => (
                  <span key={i} className={`txn-note ${n.tone}`}>{n.textHe}</span>
                ))}
              </span>
              <span className="txnt-amount"><Amount value={t.amount} tone={t.amount >= 0 ? 'positive' : undefined} /></span>
              <span className="txnt-actions">
                {hasPanel && (
                  <button
                    type="button"
                    className={open ? 'txnt-gear on' : 'txnt-gear'}
                    aria-expanded={open}
                    aria-controls={`txnp-${t.key}`}
                    aria-label={`הגדרות העסקה · ${t.merchantName ?? t.description}`}
                    title="קטגוריה, סיווג הסוחר, והיסטוריה"
                    onClick={() => setOpenKey(open ? null : t.key)}
                  ><Settings2 size={16} strokeWidth={2} aria-hidden /></button>
                )}
              </span>
            </div>
            {/* One row's controls, opened on demand. A panel BELOW the row rather than a floating
                popover: the table is a grid inside a card with `overflow: hidden`, and anything
                that floats out of it gets clipped — a menu you cannot read is worse than a click. */}
            {open && hasPanel && (
              <div className="txnt-panel" id={`txnp-${t.key}`}>
                {canCategorize && (
                  <div className="txnp-sec">
                    <span className="txnp-cap">
                      הקטגוריה של העסקה הזאת
                      {t.category === null && <span className="txnp-hint"> · עדיין לא סווגה</span>}
                    </span>
                    <div className="txnp-cats">
                      {CATEGORIES.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className={t.category === c.id ? 'txnp-cat on' : 'txnp-cat'}
                          style={{ '--cat': categoryColor(c.id) } as CSSProperties}
                          disabled={busyCat === t.key}
                          aria-pressed={t.category === c.id}
                          onClick={() => void pickCategory(t, t.category === c.id ? null : c.id)}
                        >{c.nameHe}</button>
                      ))}
                    </div>
                    <p className="txnp-note">
                      חל על העסקה הזאת בלבד. לחיצה על הקטגוריה שכבר מסומנת מנקה אותה, והמערכת תנחש שוב.
                    </p>
                  </div>
                )}
                {canMark && (
                  <div className="txnp-sec">
                    <span className="txnp-cap">מה {t.merchantName ?? t.description} מבחינתך</span>
                    <span className="txn-classify" role="group" aria-label={`סיווג ${t.merchantName ?? t.description}`}>
                      <button
                        type="button"
                        className={t.mark === 'subscription' ? 'txn-mark on-sub' : 'txn-mark'}
                        disabled={busyMerchant === t.merchant}
                        aria-pressed={t.mark === 'subscription'}
                        title="מנוי חודשי קבוע — נטפליקס, ספוטיפיי, חדר כושר. הסימון חל על כל החיובים של הסוחר ונכנס לתחזית."
                        onClick={() => void toggleMark(t, 'subscription')}
                      >מנוי</button>
                      <button
                        type="button"
                        className={t.mark === 'fixed' ? 'txn-mark on-fixed' : 'txn-mark'}
                        disabled={busyMerchant === t.merchant}
                        aria-pressed={t.mark === 'fixed'}
                        title="חיוב קבוע שיורד כל חודש בערך באותו תאריך — שכר דירה, ארנונה, ביטוח. הסימון חל על כל החיובים של הסוחר ונכנס לתחזית."
                        onClick={() => void toggleMark(t, 'fixed')}
                      >קבוע</button>
                      <button
                        type="button"
                        className={t.mark === 'habit' ? 'txn-mark on-habit' : 'txn-mark'}
                        disabled={busyMerchant === t.merchant}
                        aria-pressed={t.mark === 'habit'}
                        title="הרגל — התנהגות שחוזרת בקצב אבל בשליטתך: הדלק, הסופר, המסעדות. נספר כתובנה בדפוסים, לעולם לא כהתחייבות."
                        onClick={() => void toggleMark(t, 'habit')}
                      >הרגל</button>
                      <button
                        type="button"
                        className="txn-mark txn-history"
                        title="היסטוריה ודפוס — גרף של חיובי העבר, ומשם אפשר גם לסווג"
                        onClick={() => setHistoryFor(t)}
                      ><History size={15} strokeWidth={2} aria-hidden /> היסטוריה</button>
                    </span>
                    <p className="txnp-note">
                      הסימון חל על <strong>כל</strong> החיובים של הסוחר, גם העתידיים — להבדיל מהקטגוריה למעלה.
                    </p>
                  </div>
                )}
                {canDelete && (
                  <div className="txnp-sec">
                    <button className="link danger" onClick={() => onDeleteManual!(t)}>מחיקת העסקה הידנית</button>
                  </div>
                )}
              </div>
            )}
            </div>
          );
        })}
      </div>
      {capActive && (
        <button className="link" style={{ marginTop: 8 }} onClick={() => setExpanded(true)}>
          הצגת כל {shown.length} העסקאות
        </button>
      )}
      {historyFor?.merchant && (
        <MerchantHistoryModal
          merchant={historyFor.merchant}
          title={historyFor.merchantName ?? historyFor.description}
          mark={(txns.find((t) => t.merchant === historyFor.merchant)?.mark ?? historyFor.mark) ?? null}
          busy={busyMerchant === historyFor.merchant}
          onMark={(m) => void markFromHistory(historyFor, m)}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}

/** The transactions behind one slice of a month's category breakdown.
 *  Mirrors toCategoryBreakdown's counting: completed, non-excluded expenses only. */
export function categoryFilter(txns: MonthTxn[], category: string, headCategories: string[]): MonthTxn[] {
  const spend = txns.filter((t) => t.status === 'completed' && !t.excluded && t.amount < 0);
  if (category === 'uncategorized') return spend.filter((t) => t.category === null);
  if (category === 'rollup') return spend.filter((t) => t.category !== null && !headCategories.includes(t.category));
  return spend.filter((t) => t.category === category);
}

export function categoryTitleHe(category: string): string {
  return category === 'rollup' ? 'שאר הקטגוריות' : categoryNameHe(category);
}
