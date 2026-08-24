import { Banknote, CalendarDays, ChartPie, ChevronLeft, ChevronRight, Search, Share2, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Amount } from './Amount';
import { CardChip } from './CardChip';
import { DetailButton, DetailModal } from './Detail';
import { api, errorMessageHe } from './api';
import { CategoryTreemap, MonthTrail, Sankey, SplitTiles, type SplitTile } from './charts';
import { CategoryTag, ExcludeTag } from './CategoryTxns';
import { Explain, ExplainH, Formula } from './Explain';
import { diffText, MonthReview } from './MonthReview';
import { PosterModal, type PosterData } from './MonthPoster';
import type {
  CardChargeSlice, CardOutlook, DashboardResponse,
  MonthReview as MonthReviewData, SearchResponse,
} from './types';
import { CATEGORIES, categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

function monthLabel(month: string): string {
  // noon avoids any timezone edge shifting the label to an adjacent month
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' });
}

/** ±1 month on a 'YYYY-MM' key. Day 15 keeps every timezone far from a month edge. */
function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Show both card-settlement facts: the debit that reached the bank and the debit already
 * scheduled. Neither joins a total because every purchase is counted on its purchase date;
 * adding its settlement would count the same spending twice.
 */
function CardLedger({ outlook, month, spent, split }: {
  outlook?: CardOutlook;
  /** the flow month on screen — a slice of this month says "inside יצא עד כה", never a month name */
  month: string;
  /** the chart's own "יצא עד כה" figure, so the anchor line quotes it exactly */
  spent: number;
  split?: { card: number; other: number };
}) {
  if (!outlook) return null;
  const settled = outlook.settled.amount >= 100 ? outlook.settled : null;
  const upcoming = outlook.upcoming.filter((u) => u.amount >= 100);
  if (!settled && upcoming.length === 0) return null;

  /* Every slice points at the screen, not at a calendar. "3,247 ₪ ביולי 2026" next to
     "יצא עד כה 3,308" reads as two numbers that should match and don't — he circled exactly
     that. A slice of the month you are looking at is INSIDE the figure above, and says so
     in that figure's own words; only a slice of another month names the month. */
  const where = (slices: CardChargeSlice[]) =>
    slices.map((s) =>
      s.month === month
        ? `${ILS0.format(s.amount)} כבר בתוך "יצא עד כה" שלמעלה`
        : `${ILS0.format(s.amount)} נספרו ב${monthLabel(s.month)}`,
    ).join(' · ');

  /* Neutral ink on both amounts, on purpose. The first ledger dressed 8,958 in the chart's
     red and 3,273 in its orange — the polarity colours of "יצא עד כה" and "צפוי לצאת" — and
     the eye paired each with its chart twin and read a contradiction. These are memo figures
     outside the count; they may not wear the count's colours. */
  const row = (key: string, label: string, when: string, amount: number, note: string) => (
    <div key={key} className="card-ledger-row">
      <div>
        <div className="card-ledger-label">
          {label} <span className="card-ledger-when">· {when}</span>
        </div>
        {note && <div className="card-ledger-note">{note}</div>}
      </div>
      <div className="card-ledger-amount">{ILS0.format(amount)}</div>
    </div>
  );

  // the anchor: the chart's number, restated as its composition — always true by construction
  const anchor = split
    ? split.other < 1
      ? `כל "יצא עד כה" (${ILS0.format(spent)}) הוא קניות בכרטיס, כל אחת נספרה ביום שבוצעה.`
      : `"יצא עד כה" (${ILS0.format(spent)}) = ${ILS0.format(split.card)} קניות בכרטיס + ${ILS0.format(split.other)} מהחשבון.`
    : null;

  return (
    <div className="card-ledger">
      <div className="card-ledger-title">האשראי שלך בחודש הזה</div>
      {anchor && <p className="card-ledger-anchor">{anchor}</p>}
      {settled && row(
        'settled',
        'ירד מהעו״ש',
        // small direct charges can add several dates; the first carries the money, and a
        // four-date list buries it
        settled.days.length <= 2
          ? settled.days.map(dayLabel).join(', ')
          : `${dayLabel(settled.days[0])} ועוד ${settled.days.length - 1} חיובים`,
        settled.amount,
        settled.countedIn.length > 0 ? `שילם על קניות: ${where(settled.countedIn)}` : '',
      )}
      {upcoming.map((u) => row(
        `${u.day}|${u.company}`,
        `צפוי לרדת · ${u.companyHe}`,
        dayLabel(u.day),
        u.amount,
        u.countedIn.length > 0 ? `ישלם על קניות: ${where(u.countedIn)}` : 'קניות שטרם נספרו בחודש כלשהו',
      ))}
      <p className="card-ledger-law">
        הסכומים האלה <strong>לא</strong> מצטרפים למספרים שלמעלה, בכוונה: כל קנייה נספרה פעם
        אחת — ביום שקנית — והחיוב רק משלם עליה. פעמיים לא סופרים ✓
      </p>
    </div>
  );
}

/** Cash the scrapers can never see — a minimal manual-entry form. */
function ManualTxnForm({ onSaved, onClose }: { onSaved: () => Promise<void>; onClose: () => void }) {
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA'));
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const value = Number(amount);
    if (!description.trim() || description.trim().length < 2 || !Number.isFinite(value) || value <= 0) {
      setError('נדרשים תיאור (2+ תווים) וסכום חיובי.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.addManualTxn({
        date,
        description: description.trim(),
        amount: direction === 'expense' ? -value : value,
        ...(category ? { category } : {}),
      });
      await onSaved();
      onClose();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <CardChip icon={Banknote} />
      <div className="hero-top">
        <div className="label">עסקה ידנית (מזומן, צ׳ק, החזר מחבר)</div>
        <button className="link" onClick={onClose}>סגירה ✕</button>
      </div>
      <p className="muted" style={{ margin: '4px 0 10px' }}>
        נספרת בחודש ובקטגוריות כמו כל עסקה, אך לא נוגעת ביתרת הבנק — הבנק לא ראה אותה.
      </p>
      <div className="toolbar" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
        <input type="date" dir="ltr" value={date} onChange={(e) => setDate(e.target.value)} />
        <input placeholder="תיאור (למשל שוק, בייביסיטר…)" value={description} onChange={(e) => setDescription(e.target.value)} style={{ minWidth: 180 }} />
        <select value={direction} onChange={(e) => setDirection(e.target.value as 'expense' | 'income')}>
          <option value="expense">הוצאה</option>
          <option value="income">הכנסה</option>
        </select>
        <input placeholder="סכום" dir="ltr" inputMode="decimal" style={{ width: 100, textAlign: 'end' }} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">ללא קטגוריה</option>
          {CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>{c.nameHe}</option>
          ))}
        </select>
        <button className="primary" onClick={save} disabled={busy}>{busy ? 'שומר…' : 'הוספה'}</button>
      </div>
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

/**
 * "איך אני החודש?" — everything about the running month in one place: what came in, what went
 * out and where, what is still on its way, and how much is safe to spend until the month ends.
 * Older months keep the SAME shape — hero Sankey, category donut, bottom-line hero — just in
 * past tense; walking history must never feel like switching apps. Arrows walk the trend range.
 */
/** Sync freshness in words — an hours figure tells you nothing at a glance. */
function syncAgoHe(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return 'לפני פחות משעה';
  if (hours < 1.5) return 'לפני שעה';
  if (hours < 24) return `לפני ${Math.round(hours)} שעות`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'לפני יום' : `לפני ${days} ימים`;
}

export function Month({ month, onNavigate, onOpenReview }: {
  /** null = the running month. The server decides where months begin (monthStartDay). */
  month: string | null;
  onNavigate: (month: string) => void;
  onOpenReview: () => void;
}) {
  const [dash, setDash] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  // המהפכה המינימליסטית: which card's full-story popup is open (null = the clean surface)
  const [detail, setDetail] = useState<'flow' | 'safe' | null>(null);
  const [catRequest, setCatRequest] = useState<{ id: string; seq: number } | null>(null);
  /** Bumped after a manual transaction so the embedded review refetches the month. */
  const [reloadSeq, setReloadSeq] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  /** Review data for a navigated month — feeds the past-tense mirror of the hero cards,
   *  then flows down into the embedded review so the month isn't fetched twice. */
  const [review, setReview] = useState<MonthReviewData | null>(null);

  async function load() {
    setDash(await api.dashboard());
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessageHe(e)));
  }, []);

  useEffect(() => {
    setReview(null);
    setPosterOpen(false);
    if (!month) return;
    api.monthReview(month).then(setReview).catch((e) => setError(errorMessageHe(e)));
  }, [month, reloadSeq]);

  // global search — "where did I pay for that?" — across everything we hold (ex-dashboard)
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      api.search(q).then(setResults).catch(() => setResults(null));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  if (error && !dash) return <p className="error">{error}</p>;
  if (!dash) return <p className="muted">טוען…</p>;

  const { month: plan, trend, composition } = dash;
  const currentMonth = plan.month;
  const shownMonth = month ?? currentMonth;
  const isCurrent = shownMonth === currentMonth;
  const hasData = trend.monthsNet.length > 0;

  if (!hasData) {
    return (
      <div className="empty-note">
        <p className="muted">היי, טוב שבאת. אין עדיין נתונים — לחץ על "סנכרון" למעלה כדי למשוך עסקאות.</p>
      </div>
    );
  }

  // the trend bars are the months we can actually show — the arrows walk the same range
  const oldestMonth = trend.monthsNet.length > 0 ? trend.monthsNet[trend.monthsNet.length - 1].month : currentMonth;
  const canBack = shownMonth > oldestMonth;
  const canForward = shownMonth < currentMonth;

  const incomeAhead = plan.income.expectedRemaining.reduce((s, e) => s + e.amount, 0);
  const fixedAhead = plan.fixed.expectedRemaining.reduce((s, e) => s + -e.amount, 0);
  /** The declared target is the amount held back before anything is called spendable. */
  const keepLabelHe = plan.keep?.rate != null
    ? `יעד החיסכון שלך (${Math.round(plan.keep.rate * 100)}% מההכנסה)`
    : 'הפרשה לחיסכון';

  /**
   * The running month's remainder, split into what is already owed and what is genuinely free.
   *
   * A two-way fork ("יצא 3,243" against a fat green "9,710") says one thing to the eye, and it
   * is the wrong thing: *"אני יכול להוציא 9,700"*. The rent, the standing charges and a normal
   * month's habits are inside that green river. They get their own ribbon, in the warning
   * tone, so the picture stops lying before anyone reads the caption.
   */
  const aheadRaw = plan.expectation?.ahead ?? 0;
  const remainingNow = Math.max(0, plan.triple.net);
  // the ribbons must always sum to what actually came in — a chart may not draw more money
  // than the month holds, so an over-committed month shows zero free rather than a negative one
  const committedAhead = Math.min(aheadRaw, remainingNow);
  const afterCommit = Math.max(0, remainingNow - committedAhead);
  const overCommitted = Math.max(0, aheadRaw - remainingNow);
  /**
   * The target gets its own ribbon so the free remainder stays unambiguous.
   *
   * Only a DECLARED intention earns a ribbon — the 29% proposal reserves nothing until he
   * clicks it (the curated law). Once declared, the green must be the SAME number as
   * "נשאר להוציא בבטחה" on the plan tab — one truth, three surfaces. Clamped like the
   * commitments: a month too thin to carry the whole target shows the slice it can.
   */
  const keepApplied = plan.keep?.applied ?? 0;
  const targetSlice = Math.min(keepApplied, afterCommit);
  const freeLeft = Math.max(0, afterCommit - targetSlice);
  // Name what the money is, not the mechanism that reserved it.
  const targetRibbonLabelHe = plan.keep?.rate != null
    ? `חיסכון · ${Math.round(plan.keep.rate * 100)}%`
    : 'חיסכון';
  // Use the same name for the same shekels on the receipt, plan blocks and ribbon.
  const freeLabelHe = aheadRaw >= 1 || targetSlice >= 1 ? 'פנוי לבזבז' : 'עודף עד כה';

  /** The month's income and where it went — ONE definition, drawn twice: as tiles on the surface
   *  and as ribbons inside "פירוט מלא". Two arrays would drift, and a card that disagrees with
   *  its own detail popup is worse than either version alone. */
  const flowSplit: SplitTile[] = [
    {
      id: 'spent',
      label: 'יצא עד כה',
      value: plan.triple.expenses,
      color: 'var(--negative)',
      title: `באותה נקודה בחודש שעבר יצאו ${ILS0.format(plan.prevTriple.expenses)}`,
    },
    /**
     * The ribbon that had to exist. A two-way fork — "יצא 3,243" against "עודף
     * 9,710" — draws a fat green river and invites exactly one reading: *"I can
     * spend 9,700."* The money still owed this month is not a
     * footnote under the picture; it is a third of the river, and it gets a third
     * ribbon so the eye sees the truth before the caption explains it.
     */
    ...(committedAhead >= 1
      ? [{
          id: 'ahead',
          label: 'צפוי לצאת',
          value: committedAhead,
          color: 'var(--warning)',
          title: 'רק מה שאתה אישרת: שכר דירה, מנויים וקבועים שעוד ירדו החודש. בלי ניחושים.',
        }]
      : []),
    /**
     * The declared intention gets its own ribbon. Accent violet on
     * purpose: not red (it did not leave), not orange (it is not owed to anyone),
     * not green (it is not spendable) — it is money he told the app to guard.
     * Appears only once a target/savings plan is DECLARED; a proposal reserves
     * nothing. With it, the green below is the SAME figure as "נשאר להוציא
     * בבטחה" — one truth on every surface.
     */
    ...(targetSlice >= 1
      ? [{
          id: 'target',
          label: targetRibbonLabelHe,
          value: targetSlice,
          color: 'var(--accent)',
          title: 'הכסף שביקשת לחסוך — שמור בצד לפני שמחשבים מה פנוי',
        }]
      : []),
    ...(freeLeft >= 1
      ? [{
          id: 'savings',
          // NOT "נותר ביד", and no longer the whole remainder either: this is the
          // part that is genuinely free once everything owed AND the declared
          // intention are set aside.
          label: freeLabelHe,
          value: freeLeft,
          color: 'var(--positive)',
          title: `אחרי כל מה שהחודש עוד צפוי לעלות${targetSlice >= 1 ? ' ואחרי החיסכון' : ''} · ≈ ${ILS0.format(plan.leftPerDay)} ליום ל-${plan.daysLeft} הימים שנותרו`,
        }]
      : []),
  ];

  // עמוד לשותף: the running month speaks from the live plan, a finished month from its review
  const posterData: PosterData | null = isCurrent
    ? {
        month: currentMonth,
        income: plan.triple.income,
        expenses: plan.triple.expenses,
        net: plan.triple.net,
        categories: composition.categories.map((c) => ({ category: c.category, expenses: c.spent })),
        partial: true,
      }
    : review && review.month === shownMonth
      ? {
          month: shownMonth,
          income: review.current.income,
          expenses: review.current.expenses,
          net: review.current.net,
          categories: review.byCategory.map((c) => ({ category: c.category, expenses: c.expenses })),
          partial: false,
        }
      : null;

  // categories whose spend-so-far ALREADY beats a typical full month — mid-month this can
  // never false-positive, which is exactly why the milder "on pace to exceed" is left out
  const unusualCategories = composition.categories
    .filter((c) => c.deltaPct !== null && c.deltaPct >= 25 && c.spent >= 250)
    .sort((a, b) => (b.deltaPct ?? 0) - (a.deltaPct ?? 0))
    .slice(0, 3);

  return (
    <div>
      {error && <p className="error">{error}</p>}

      {/* ── הדופק: מספר אחד, סופר ברור — כמה יש בעובר ושב עכשיו ────────────────────── */}
      {dash.pulse.bankBalance !== null && (
        <div className="card hero balance-strip tone-teal">
          <div>
            <div className="label">
              יש לך בעובר ושב
              <Explain title="יש לך בעובר ושב">
                <p>המספר שהבנק עצמו מציג: סכום היתרות העדכניות של כל חשבונות הבנק המחוברים, כפי שנמשכו בסנכרון האחרון.</p>
                <Formula>יתרת עו״ש = סכום יתרות חשבונות הבנק מהסנכרון האחרון</Formula>
                <p>מתעדכן בכל סנכרון — תג הזמן אומר מתי נמשך; תנועות שקרו מאז עדיין לא בפנים. זה מצב הרגע, לא שיפוט החודש — השיפוט בכרטיסים שלמטה.</p>
              </Explain>
            </div>
            <Amount value={dash.pulse.bankBalance} hero tone={dash.pulse.bankBalance < 0 ? 'negative' : undefined} />
          </div>
          {syncAgoHe(dash.pulse.syncAgeHours) && (
            <span className="tag" title="הרגע שבו נמשכה היתרה מהבנק — סנכרון מרענן אותה">
              נכון לסנכרון · {syncAgoHe(dash.pulse.syncAgeHours)}
            </span>
          )}
        </div>
      )}

      {/* ── ניווט חודשים: בחודש הרץ חיים, אחורה מבקרים ─────────────────────────────── */}
      <div className="toolbar" style={{ alignItems: 'center' }}>
        {/* RTL: the past sits to the right, so "older" points right and "newer" points left */}
        <button
          className="pill"
          onClick={() => onNavigate(shiftMonth(shownMonth, -1))}
          disabled={!canBack}
          aria-label="החודש הקודם"
          title={canBack ? `אל ${monthLabel(shiftMonth(shownMonth, -1))}` : 'אין נתונים מוקדמים יותר בתצוגה'}
        >
          <ChevronRight size={15} strokeWidth={2} style={{ display: 'block' }} />
        </button>
        <h2 style={{ margin: 0 }}>{monthLabel(shownMonth)}</h2>
        <button
          className="pill"
          onClick={() => onNavigate(shiftMonth(shownMonth, 1))}
          disabled={!canForward}
          aria-label="החודש הבא"
          title={canForward ? `אל ${monthLabel(shiftMonth(shownMonth, 1))}` : 'זה החודש הנוכחי'}
        >
          <ChevronLeft size={15} strokeWidth={2} style={{ display: 'block' }} />
        </button>
        {!isCurrent && (
          <button className="link" onClick={() => onNavigate(currentMonth)}>חזרה לחודש הנוכחי</button>
        )}
        <span style={{ flex: 1 }} />
        {posterData && (
          <button className="pill" onClick={() => setPosterOpen(true)} title="החודש בעמוד אחד — להעתקה או לשמירה כתמונה">
            <Share2 size={14} strokeWidth={2.2} className="ic" aria-hidden /> עמוד לשותף
          </button>
        )}
        <button className="pill" onClick={() => setManualOpen((v) => !v)}>+ עסקה ידנית</button>
        <span className="search-field">
          <Search size={14} strokeWidth={2.2} className="ic" aria-hidden />
          <input
            placeholder="חיפוש בכל העסקאות…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
      </div>

      {results && (
        <div className="card">
          <CardChip icon={Search} />
          <div className="hero-top">
            <div className="label">
              תוצאות חיפוש · {results.total}{results.total > results.txns.length ? ` (מוצגות ${results.txns.length})` : ''}
            </div>
            <button className="link" onClick={() => setQuery('')}>ניקוי ✕</button>
          </div>
          {results.txns.length === 0 && <p className="muted">לא נמצאו עסקאות.</p>}
          <ul className="txns">
            {results.txns.map((t) => (
              <li className="txn" key={t.key}>
                <span className="txn-date">
                  {new Date(t.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Asia/Jerusalem' })}
                </span>
                <span className="txn-desc">
                  {t.description}
                  <span className="muted"> · {t.connectionLabel}</span>
                  {t.category && <CategoryTag id={t.category} />}
                  {t.excluded && <ExcludeTag reason={t.excludeReason ?? ''} />}
                  {t.status === 'pending' && <span className="tag">ממתין</span>}
                </span>
                <Amount value={t.amount} tone={t.amount >= 0 ? 'positive' : undefined} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {manualOpen && (
        <ManualTxnForm
          onSaved={async () => { await load(); setReloadSeq((s) => s + 1); }}
          onClose={() => setManualOpen(false)}
        />
      )}

      {isCurrent && (
        <div className="grid">
          {/* ── מה קרה עד כה: הזרימה שקרתה בפועל — ולאן זה הלך ──────────────────────── */}
          <div className="card hero g12">
            <CardChip icon={CalendarDays} />
            <div className="hero-top">
              <div className="label">
                החודש עד כה · {monthLabel(currentMonth)}
                <Explain title="החודש עד כה">
                  <p>כל מה שקרה בפועל מתחילת החודש: כמה נכנס, כמה יצא, ומה העודף בין השניים.</p>
                  <ExplainH>הנוסחה</ExplainH>
                  <Formula>
                    נכנס = סכום כל העסקאות החיוביות שהושלמו החודש
                    <br />יצא = סכום כל העסקאות השליליות שהושלמו החודש
                    <br />עודף עד כה = נכנס − יצא
                  </Formula>
                  <ExplainH>למה "עודף" ולא "נותר ביד"</ExplainH>
                  <p>
                    זהו חיסור של אמצע-חודש, לא סכום פנוי. שכר הדירה שעוד לא יצא, הקבועות שעוד
                    ירדו והקניות שעוד תעשה — כולם עדיין לפניך, וכבר תפוסים. הסכום שבאמת פנוי
                    להוצאה נמצא בכרטיס <strong>"נשאר להוציא בבטחה"</strong>, שמחשב גם את מה
                    שהחודש עוד צפוי לעלות.
                  </p>
                  <ExplainH>מקור הנתונים</ExplainH>
                  <p>
                    העסקאות שנמשכו מהבנק ומהכרטיסים, אחרי ניקוי כפילויות: חיוב כרטיס שמופיע גם כפירוט
                    עסקאות וגם כירידה אחת בבנק נספר <strong>פעם אחת בלבד</strong>, והעברות בין החשבונות
                    שלך לא נספרות כלל. "החודש" נמדד לפי היום שבו החודש שלך מתחיל (בהגדרות).
                  </p>
                  <ExplainH>ההשוואה לחודש שעבר</ExplainH>
                  <p>
                    "באותה נקודה בחודש שעבר" משווה למספר <strong>הימים הזהה</strong> מתחילת החודש הקודם —
                    לא לחודש שעבר כולו — כדי שההשוואה תהיה הוגנת גם באמצע חודש.
                  </p>
                </Explain>
              </div>
            </div>
            {/* A one-to-four split is clearest as tiles; the complete Sankey remains behind
                "פירוט מלא". One flows array feeds both surfaces so they cannot disagree. */}
            <SplitTiles
              total={plan.triple.income}
              totalLabel="נכנס עד כה"
              totalTitle={`באותה נקודה בחודש שעבר נכנסו ${ILS0.format(plan.prevTriple.income)}`}
              deficit={Math.max(0, -plan.triple.net)}
              deficitLabel="מעבר להכנסות"
              tiles={flowSplit}
            />
            <DetailButton onClick={() => setDetail('flow')} />
            {detail === 'flow' && (
              <DetailModal title={`החודש עד כה · ${monthLabel(currentMonth)}`} onClose={() => setDetail(null)}>
                <Sankey
                  income={plan.triple.income}
                  deficit={Math.max(0, -plan.triple.net)}
                  flows={flowSplit}
                  sourceLabel="נכנס עד כה"
                  sourceTitle={`באותה נקודה בחודש שעבר נכנסו ${ILS0.format(plan.prevTriple.income)}`}
                  deficitLabel="מעבר להכנסות"
                  bigValues
                />
                <div className="detail-divider" />
                {aheadRaw >= 1 && (
                  <p className="chart-caption" style={{ fontWeight: 600 }}>
                    {overCommitted >= 1 ? (
                      <>
                        כל מה שנשאר החודש כבר תפוס בהתחייבויות שאישרת — ועוד {ILS0.format(overCommitted)} מעבר לזה.
                      </>
                    ) : (
                      <>
                        מתוך העודף, {ILS0.format(committedAhead)} כבר תפוסים בהתחייבויות שאישרת
                        {targetSlice >= 1 && <> ועוד {ILS0.format(targetSlice)} שמורים לחיסכון</>}.
                        {' '}פנוי באמת: {ILS0.format(freeLeft)}
                        {plan.daysLeft >= 1 && ` · ≈ ${ILS0.format(freeLeft / plan.daysLeft)} ליום`}
                      </>
                    )}
                  </p>
                )}
                {/* the estimate, and its distance from the certainties is the whole point: it
                    sits outside every total, saying out loud that it is not a bill */}
                {(plan.expectation?.habitEstimate ?? 0) >= 100 && (
                  <p className="chart-caption">
                    בחודש רגיל יוצאים מכאן עוד בערך {ILS0.format(plan.expectation!.habitEstimate!)} על
                    סופר, דלק ומסעדות. זו <strong>הערכה — לא חשבון לתשלום</strong>, ולכן היא לא
                    נספרת בשום מקום.
                  </p>
                )}
                {/* the card ledger — the month's biggest cash movement, with the months that
                    counted each shekel, so "נספר פעם אחת" stays checkable */}
                <CardLedger
                  outlook={plan.cardOutlook}
                  month={currentMonth}
                  spent={plan.triple.expenses}
                  split={plan.spendSplit}
                />
                {!plan.cardOutlook && (plan.cardSettlements?.amount ?? 0) >= 100 && (
                  <p className="chart-caption">
                    בנוסף ירדו מהעו״ש {ILS0.format(plan.cardSettlements!.amount)} חיובי אשראי — והם
                    לא נספרים שוב, בכוונה: כל קנייה כבר נספרה ביום שקנית, והחיוב רק משלם עליה.
                    פעמיים לא סופרים ✓
                  </p>
                )}
                {(plan.expectation?.unconfirmed?.length ?? 0) > 0 && (
                  <p className="chart-caption">
                    זיהינו {plan.expectation!.unconfirmed!.length} חיובים שחוזרים כל חודש
                    (בערך {ILS0.format(plan.expectation!.unconfirmed!.reduce((s, u) => s + u.monthlyAmount, 0))} לחודש) —
                    אבל עוד לא אישרת אותם, ולכן הם לא נספרים כאן. לאשר: בטאב "מה יורד לי כל חודש?".
                  </p>
                )}
                <p className="chart-caption">
                  באותה נקודה ב{monthLabel(shiftMonth(currentMonth, -1))}: נכנסו {ILS0.format(plan.prevTriple.income)} ·
                  יצאו {ILS0.format(plan.prevTriple.expenses)} · עודף {ILS0.format(plan.prevTriple.net)}
                </p>
              </DetailModal>
            )}
          </div>

          {composition.categories.length > 0 && (
            <div className="card g12 tone-gold">
              <CardChip icon={ChartPie} />
              <div className="label">
                לאן הכסף הולך החודש
                <Explain title="לאן הכסף הולך החודש">
                  <p>ההוצאות שהושלמו החודש, מקובצות לפי קטגוריה. כל עסקה מסווגת אוטומטית (חוקים ← מגזר הסולק ← זיהוי מילים) — וסיווג ידני שלך תמיד גובר.</p>
                  <ExplainH>תגיות "חריגה" ליד הדונאט</ExplainH>
                  <Formula>
                    קטגוריה מסומנת כאשר: ההוצאה עד כה ≥ ‏250 ₪
                    <br />וגם: לפחות ‎25%+ מעל חודש רגיל (החודש האמצעי מבין 3 האחרונים שהסתיימו)
                  </Formula>
                  <p>ההשוואה היא מול <strong>חודשים שלמים</strong> — לכן באמצע חודש תגית יכולה רק להצביע על חריגה אמיתית, לא על "עוד לא הוצאת מספיק".</p>
                  <p>לחיצה על מלבן פותחת את העסקאות של אותה קטגוריה בסקירה למטה.</p>
                </Explain>
              </div>
              <CategoryTreemap
                byCategory={composition.categories.map((c) => ({ category: c.category, expenses: c.spent }))}
                onSelect={(cat) => setCatRequest((r) => ({ id: cat, seq: (r?.seq ?? 0) + 1 }))}
                height={330}
              />
              <p className="card-sub" style={{ marginTop: 8 }}>
                שטח = כסף · סה״כ {ILS0.format(composition.categories.reduce((s, c) => s + c.spent, 0))}
              </p>
              {unusualCategories.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {unusualCategories.map((c) => (
                    <span
                      key={c.category}
                      className="tag warn"
                      title={`חודש רגיל: ${ILS0.format(c.median3m)} · החודש עד כה: ${ILS0.format(c.spent)}`}
                    >
                      {categoryNameHe(c.category)} — {c.median3m > 0 && c.spent / c.median3m >= 2
                        ? `כבר פי ${(c.spent / c.median3m).toFixed(1)} מחודש רגיל`
                        : `כבר +${c.deltaPct}% מעל חודש רגיל`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── מה עוד יקרה: ההוצאות שבדרך, וכמה מותר עד סוף החודש ──────────────────── */}
          <div className="card hero g12 tone-green">
            <CardChip icon={ShieldCheck} />
            <div className="hero-top">
              <div className="label">
                עד סוף החודש · נשאר להוציא בבטחה
                <Explain title="נשאר להוציא בבטחה">
                  <p>כמה באמת פנוי עד סוף החודש — אחרי שכל מה שהחודש צפוי לעלות כבר מנוכה, ואחרי שהחיסכון שלך נשמר.</p>
                  <ExplainH>הנוסחה, עם המספרים שלך עכשיו</ExplainH>
                  <Formula>
                    צפי הכנסות {ILS0.format(plan.income.expectedTotal)}
                    <br />− מה שהחודש צפוי לעלות {ILS0.format(plan.expectation?.total ?? plan.fixed.total + plan.variable.soFar)}
                    <br />− {keepLabelHe} {ILS0.format(plan.keep?.applied ?? 0)}
                    <br />= <strong>{ILS0.format(plan.leftToSpend)}</strong> · חלקי {plan.daysLeft} ימים ≈ {ILS0.format(plan.leftPerDay)} ליום
                  </Formula>
                  {plan.expectation && (
                    <>
                      <ExplainH>מה נכנס ל"צפוי לצאת" — ומה לא</ExplainH>
                      <p>
                        <strong>רק ודאויות.</strong> חיוב נכנס לכאן אך ורק אם אישרת אותו בעצמך:
                        סימנת אותו "מנוי" או "קבוע" ב<strong>"מה יורד לי כל חודש?"</strong>, הזנת אותו ידנית,
                        או שהוא תשלום בעסקה שכבר חתמת עליה. זיהוי שהמערכת עשתה ואתה לא אישרת הוא
                        הצעה — והוא לא תופס כאן שקל.
                      </p>
                      <Formula>
                        יצא עד כה {ILS0.format(plan.expectation.spent)}
                        <br />+ התחייבויות שטרם ירדו {ILS0.format(plan.expectation.ahead)}
                        <br />= <strong>{ILS0.format(plan.expectation.total)}</strong>
                      </Formula>
                      <p>
                        <strong>הרגלים אינם נכנסים.</strong> כמה תוציא החודש בסופר או על דלק זו
                        הערכה מההיסטוריה, ולהערכה אין רשות להפריש כסף. היא מוצגת בנפרד, מסומנת
                        כהערכה, ומחוץ לכל חישוב.
                      </p>
                      <p>
                        חיוב אשראי קרוב גם הוא לא מופיע כאן בנפרד: כל קנייה כבר נספרה ביום שבוצעה,
                        וספירת החיוב המרוכז שיורד בבנק הייתה מחייבת אותך פעמיים על אותה קנייה.
                      </p>
                    </>
                  )}
                  {plan.keep?.rate != null && (
                    <>
                      <ExplainH>מאיפה ההפרשה לחיסכון</ExplainH>
                      <Formula>
                        {Math.round(plan.keep.rate * 100)}% × הכנסת החודש {ILS0.format(plan.income.expectedTotal)} = <strong>{ILS0.format(plan.keep.target)}</strong>
                      </Formula>
                      <p>
                        יעד החיסכון נמדד מול ההכנסה של <strong>החודש הזה</strong>, לא מול חודש רגיל — ולכן הסכום
                        כאן שונה מהסכום שמופיע ליד אותו אחוז ב"התוכנית שלי". בחודש רזה נשמרים פחות שקלים
                        באותו אחוז בדיוק, וזה בכוונה. תוכניות חיסכון שהגדרת הן רצפה: אם הן מפרישות יותר
                        מהיעד, הן גוברות.
                      </p>
                    </>
                  )}
                  <ExplainH>צפי הסגירה</ExplainH>
                  {/* the projection is CASH, and is computed before the target is protected. A
                      target is an intention, not a bill — a household that misses it still has
                      the money in the bank, and calling that a deficit is simply false. */}
                  <Formula>
                    צפי הכנסות {ILS0.format(plan.income.expectedTotal)}
                    <br />− מה שהחודש צפוי לעלות {ILS0.format(plan.expectation?.total ?? plan.fixed.total + plan.variable.soFar)}
                    <br />= <strong>{ILS0.format(plan.paceEndOfMonth)}</strong>
                  </Formula>
                  <p>
                    זהו כסף אמיתי, לפני שמורידים ממנו את החיסכון — יעד החיסכון הוא כוונה, לא חשבון לתשלום.
                  </p>
                  {plan.paceVsTarget != null && (
                    <p>
                      צפי הסגירה הוא כמה כסף יישאר בפועל, לפני שמורידים ממנו את החיסכון. כמה מתוכו
                      הולך לחיסכון וכמה באמת פנוי — זה בדיוק מה שהשורות שמתחת למספר הגדול מספרות.
                    </p>
                  )}
                  <ExplainH>מקור הנתונים</ExplainH>
                  <p>
                    "קבועות בדרך" ו"הכנסות בדרך" — החיובים הקבועים שזוהו מההיסטוריה שלך (משכורת,
                    שכ״ד, מנויים <strong>חיים</strong> בלבד; מנוי שהסתיים לא נספר), כשכל אירוע צפוי ביום
                    החודש הקבוע שלו. השאר — עסקאות אמיתיות שכבר קרו.
                  </p>
                  <ExplainH>מה חשוב לדעת</ExplainH>
                  <p>
                    צפי הסגירה אינו נבואה: ההנחה היחידה היא שההוצאה המשתנה תימשך באותו קצב יומי ממוצע.
                    קנייה גדולה חד-פעמית בתחילת החודש מנפחת את הקצב; הוצאות שעוד לפניך יגרמו לו להיראות
                    ורוד מדי. תחזית היתרה המלאה, המכוילת מול המציאות — בטאב "ומה לגבי העתיד?".
                  </p>
                </Explain>
              </div>
              {plan.leftToSpend > 0 && (
                <span className="tag">≈ {ILS0.format(plan.leftPerDay)} ליום · {plan.daysLeft} ימים</span>
              )}
            </div>
            {/* הקבלה — the derivation as a receipt: BIG numbers, three-word labels, zero
                sentences. The sentence version lasted one day ("למה טקסט קטן? למה הרבה
                מילים?"). The rows wear the SAME names and colours as the plan tab's blocks
                (יצא ותפוס / לחיסכון / פנוי לבזבז) — one mental model on every surface. The
                on-screen arithmetic still closes to the shekel: the payments figure is derived
                from the other rounded figures, never rounded on its own. */}
            {(() => {
              const left = Math.round(plan.leftToSpend);
              const reserve = Math.round(Math.max(0, plan.keep?.applied ?? 0));
              const income = Math.round(plan.income.expectedTotal);
              const payments = income - reserve - left;
              const pct = plan.keep?.rate != null ? Math.round(plan.keep.rate * 100) : null;
              const hand = left + reserve;
              // a missed target is not an overdraft: the bottom row says WHICH thing is short
              const bottom = left >= 0
                ? { label: 'פנוי לבזבז', cls: 'good' }
                : hand >= 0
                  ? { label: 'חסר ליעד החיסכון', cls: 'warn' }
                  : { label: 'חסרים', cls: 'bad' };
              return (
                <div className="safe-why">
                  <div className="safe-why-row" title="כל ההכנסות של החודש — מה שנכנס בפועל ומה שעוד בדרך">
                    <span className="safe-why-label">נכנס החודש</span>
                    <strong className="amount safe-why-amt">{ILS0.format(income)}</strong>
                  </div>
                  <div className="safe-why-row" title="כל מה שכבר יצא + כל התחייבות שאישרת ועוד תרד עד סוף החודש">
                    <span className="safe-why-label">יצא ותפוס</span>
                    <strong className="amount safe-why-amt out">− {ILS0.format(payments)}</strong>
                  </div>
                  {reserve >= 1 && (
                    <div className="safe-why-row" title={pct != null ? `יעד החיסכון שהגדרת — ${pct}% מהכנסת החודש הזה` : 'ההפרשה לחיסכון'}>
                      <span className="safe-why-label">לחיסכון{pct != null ? ` · ${pct}%` : ''}</span>
                      <strong className="amount safe-why-amt keep">− {ILS0.format(reserve)}</strong>
                    </div>
                  )}
                  <div className={`safe-why-row total ${bottom.cls}`}>
                    <span className="safe-why-label">{bottom.label}</span>
                    <strong className="amount safe-why-amt">= {ILS0.format(left)}</strong>
                  </div>
                  {left < 0 && (
                    <div className="safe-why-cap">
                      {hand >= 0 ? 'היעד גדול ממה שהחודש הזה יכול לשאת' : 'התשלומים גדולים מההכנסה'}
                    </div>
                  )}
                </div>
              );
            })()}
            <MonthTrail
              byDay={plan.variable.byDay}
              daysElapsed={plan.daysElapsed}
              daysInMonth={plan.daysInMonth}
              allowance={plan.leftPerDay}
              leftToSpend={plan.leftToSpend}
              paceEndOfMonth={plan.paceEndOfMonth}
              perDayPace={plan.variable.perDayPace}
              monthStart={plan.monthStart}
            />
            {/* המהפכה המינימליסטית: number, verdict, trail — that is the whole surface. The
                bridges, the plan tags and the upcoming-charges list moved behind the button. */}
            <DetailButton onClick={() => setDetail('safe')} />
            {detail === 'safe' && (
              <DetailModal title="נשאר להוציא בבטחה · פירוט" onClose={() => setDetail(null)}>
                {/* The closing projection is in CASH. It never nets the target out. */}
                <div className={plan.paceEndOfMonth >= 0 ? 'hero-compare amount-positive' : 'hero-compare amount-negative'}>
                  {plan.paceEndOfMonth >= 0
                    ? `✓ צפי סגירת החודש: ${ILS0.format(plan.paceEndOfMonth)} ביד${
                        plan.income.expectedTotal >= 1
                          ? ` — ${Math.round((plan.paceEndOfMonth / plan.income.expectedTotal) * 100)}% מהכנסת החודש הזה`
                          : ''
                      }, לפני הפרשת החיסכון`
                    : <><TriangleAlert size={13} strokeWidth={2.2} className="ic" aria-hidden /> בקצב הנוכחי החודש ייסגר ב־{ILS0.format(plan.paceEndOfMonth)}</>}
                </div>
                {/* THE bridge — the three numbers in the order a person actually asks them */}
                {plan.expectation && plan.expectation.ahead >= 1 && (
                  <div className="hero-compare">
                    נכנס החודש <strong>{ILS0.format(plan.income.expectedTotal)}</strong> · יצא עד כה{' '}
                    <strong>{ILS0.format(plan.expectation.spent)}</strong> · ועוד{' '}
                    <strong>{ILS0.format(plan.expectation.ahead)}</strong> צפויים לצאת עד סוף החודש.
                  </div>
                )}
                {/* the bridge between "נותר ביד" and the safe number: one is cash held today,
                    the other is cash minus the charges still due minus what the target protects */}
                {plan.keep && plan.keep.applied > 0 && plan.leftBeforeTarget != null && (() => {
                  const forTarget = plan.keep.rate != null;
                  // the definite article rides with the preposition, never glued in front of it:
                  // "שמורים להיעד" is what you get from ל + היעד, and it is not Hebrew
                  const whatHe = forTarget ? `יעד החיסכון (${Math.round(plan.keep.rate! * 100)}% מהכנסת החודש)` : 'החיסכון';
                  const toHe = forTarget ? `ליעד החיסכון (${Math.round(plan.keep.rate! * 100)}% מהכנסת החודש)` : 'לחיסכון';
                  // "מתוך X, Y שמורים" is only a sentence while Y ≤ X
                  return plan.keep.applied <= plan.leftBeforeTarget ? (
                    <div className="hero-compare">
                      מתוך <strong>{ILS0.format(plan.leftBeforeTarget)}</strong> שנשארו החודש אחרי כל ההתחייבויות,
                      {' '}<strong>{ILS0.format(plan.keep.applied)}</strong> שמורים {toHe}.
                    </div>
                  ) : (
                    <div className="hero-compare frame-warn">
                      {whatHe} דורש <strong>{ILS0.format(plan.keep.applied)}</strong> החודש — יותר מ־
                      <strong>{ILS0.format(plan.leftBeforeTarget)}</strong> שנשארו אחרי כל ההתחייבויות. החודש הזה
                      לא יכול לשאת אותו במלואו.
                    </div>
                  );
                })()}
                {/* the plan's facts as compact tags */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 0' }}>
                  <span className="tag" title="סך ההכנסות הצפויות החודש — מה שנכנס בפועל ומה שעוד בדרך">
                    צפי הכנסות {ILS0.format(plan.income.expectedTotal)}
                  </span>
                  {incomeAhead >= 1 && <span className="tag good">הכנסות בדרך {ILS0.format(incomeAhead)}</span>}
                  {/* Certainties use the same base as "צפוי לצאת" above. */}
                  {(plan.expectation?.fixed.spent ?? plan.fixed.soFar) >= 1 && (
                    <span className="tag">קבועות שירדו {ILS0.format(plan.expectation?.fixed.spent ?? plan.fixed.soFar)}</span>
                  )}
                  {(plan.expectation?.fixed.ahead ?? fixedAhead) >= 1 && (
                    <span className="tag">קבועות בדרך {ILS0.format(plan.expectation?.fixed.ahead ?? fixedAhead)}</span>
                  )}
                  {plan.keep?.rate != null && plan.keep.target >= 1 && (
                    <span className="tag" title="יעד החיסכון שהגדרת, על ההכנסה של החודש הזה">
                      יעד חיסכון {Math.round(plan.keep.rate * 100)}% · {ILS0.format(plan.keep.target)}
                    </span>
                  )}
                </div>
                {/* the expectation, itemised: a bottom line this consequential may never be a
                    number the household has to take on faith */}
                {(() => {
                  const ahead = (plan.expectation?.rows ?? []).filter((r) => r.ahead >= 1);
                  if (ahead.length === 0) return null;
                  const shown = ahead.slice(0, 7);
                  const rest = ahead.slice(7).reduce((s, r) => s + r.ahead, 0);
                  return (
                    <>
                      <div className="label" style={{ marginTop: 14 }}>מה עוד צפוי לצאת החודש</div>
                      <ul className="txns">
                        {shown.map((r) => (
                          <li className="txn" key={`${r.kind}|${r.key}`}>
                            <span className="txn-desc">{r.labelHe}</span>
                            <span className="muted" style={{ fontSize: 14 }}>
                              {r.kind === 'fixed'
                                ? (r.spent >= 1 ? 'קבועה · חלקה כבר ירדה' : 'קבועה')
                                : r.spent >= 1
                                  ? `יצא ${ILS0.format(r.spent)} מתוך ${ILS0.format(r.expected)} בחודש רגיל`
                                  : `בחודש רגיל ${ILS0.format(r.expected)}`}
                            </span>
                            <Amount value={-r.ahead} />
                          </li>
                        ))}
                      </ul>
                      {rest >= 1 && (
                        <p className="muted" style={{ marginTop: 4 }}>
                          +{ahead.length - shown.length} נוספים · {ILS0.format(rest)}
                        </p>
                      )}
                    </>
                  );
                })()}
              </DetailModal>
            )}
          </div>

        </div>
      )}

      {/* ── חודש היסטורי: אותו מבנה בדיוק, בזמן עבר — גלילה בהיסטוריה היא לא אפליקציה אחרת.
             סנקי-על (נכנס→יצא/נותר), דונאט קטגוריות, וכרטיס השורה התחתונה במקום "נשאר להוציא" ── */}
      {!isCurrent && review && review.month === shownMonth && (
        <div className="grid">
          <div className="card hero g12">
            <CardChip icon={CalendarDays} />
            <div className="hero-top">
              <div className="label">
                החודש כולו · {monthLabel(shownMonth)}
                <Explain title="החודש כולו">
                  <p>הסיכום הסופי של חודש שהסתיים — אותו חישוב בדיוק כמו "החודש עד כה", רק על כל החודש.</p>
                  <Formula>
                    נכנס = כל העסקאות החיוביות שהושלמו בחודש
                    <br />יצא = כל העסקאות השליליות שהושלמו בחודש
                    <br />נותר ביד = נכנס − יצא
                  </Formula>
                  <p>בלי לספור חיוב כרטיס פעמיים ובלי העברות בין החשבונות שלך; גבולות החודש לפי היום שבו החודש שלך מתחיל (בהגדרות). ההשוואה בכיתוב — מול החודש השלם שלפניו.</p>
                </Explain>
              </div>
            </div>
            <Sankey
              income={review.current.income}
              deficit={Math.max(0, Math.round(-review.current.net * 100) / 100)}
              flows={[
                {
                  id: 'spent',
                  label: 'יצא החודש',
                  value: review.current.expenses,
                  color: 'var(--negative)',
                  ...(review.previous ? { title: `ב${monthLabel(review.previous.month)} יצאו ${ILS0.format(review.previous.expenses)}` } : {}),
                },
                ...(review.current.net >= 1
                  ? [{
                      id: 'savings',
                      label: 'נותר ביד',
                      value: review.current.net,
                      color: 'var(--positive)',
                      ...(review.previous ? { title: `ב${monthLabel(review.previous.month)} נותרו ${ILS0.format(review.previous.net)}` } : {}),
                    }]
                  : []),
              ]}
              sourceLabel="נכנס החודש"
              sourceTitle={review.previous ? `ב${monthLabel(review.previous.month)} נכנסו ${ILS0.format(review.previous.income)}` : undefined}
              deficitLabel="מעבר להכנסות"
              bigValues
            />
            {review.previous && (
              <p className="chart-caption">
                ב{monthLabel(review.previous.month)}: נכנסו {ILS0.format(review.previous.income)} ·
                יצאו {ILS0.format(review.previous.expenses)} · נותרו {ILS0.format(review.previous.net)}
              </p>
            )}
          </div>

          {review.byCategory.length > 0 && (
            <div className="card g12 tone-gold">
              <CardChip icon={ChartPie} />
              <div className="label">
                לאן הלך הכסף החודש
                <Explain title="לאן הלך הכסף (חודש שהסתיים)">
                  <p>כל הוצאות החודש שהסתיים, מקובצות לפי קטגוריה — הסיווג האוטומטי של כל עסקה (וסיווג ידני שלך תמיד גובר). האחוז = חלק הקטגוריה מסך ההוצאות.</p>
                  <p>לחיצה על מלבן פותחת את העסקאות של אותה קטגוריה בסקירה למטה.</p>
                </Explain>
              </div>
              <CategoryTreemap
                byCategory={review.byCategory}
                onSelect={(cat) => setCatRequest((r) => ({ id: cat, seq: (r?.seq ?? 0) + 1 }))}
                height={330}
              />
              <p className="card-sub" style={{ marginTop: 8 }}>
                שטח = כסף · סה״כ {ILS0.format(review.byCategory.reduce((s, c) => s + c.expenses, 0))}
              </p>
            </div>
          )}

          {/* the past-tense sibling of "נשאר להוציא בבטחה" — how the month actually closed */}
          <div className="card hero g12 tone-green">
            <CardChip icon={ShieldCheck} />
            <div className="hero-top">
              <div className="label">
                בסוף החודש · נשאר ביד
                <Explain title="נשאר ביד (חודש שהסתיים)">
                  <p>השורה התחתונה של החודש: הכנסות פחות הוצאות, על החודש כולו. חיובי = החודש בנה הון; שלילי = החודש שחק אותו. ההשוואה — מול החודש השלם שלפניו, באחוזים.</p>
                </Explain>
              </div>
            </div>
            <Amount value={review.current.net} hero tone={review.current.net >= 0 ? undefined : 'negative'} />
            {review.previous && (
              <div className={review.current.net >= 0 ? 'hero-compare amount-positive' : 'hero-compare amount-negative'}>
                {/* every figure names its own month: opening with "לעומת <חודש קודם>" and then
                    printing THIS month's sums made the sums read as the previous month's */}
                ב{monthLabel(shownMonth)} נכנסו {ILS0.format(review.current.income)} ויצאו {ILS0.format(review.current.expenses)} ·
                מול {monthLabel(review.previous.month)}: הכנסות {diffText(review.current.income, review.previous.income)},
                הוצאות {diffText(review.current.expenses, review.previous.expenses)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── הסקירה המלאה: תובנות, סוחרים ועסקאות — בלי הנטו: הכותרת (hero) והקומפוזיציה
             (דונאט) כבר צוירו למעלה בכל מצב, עובדה אחת = ויזואל אחד ── */}
      <MonthReview
        key={`${shownMonth}#${reloadSeq}`}
        month={shownMonth}
        embedded
        condensed={isCurrent || review?.month === shownMonth}
        categoryRequest={catRequest}
        preloaded={month ? review : undefined}
        // a re-categorisation moves money between slices — the hero, the donut and the plan above
        // are all downstream of it. Deliberately NOT bumping reloadSeq: that remounts the register
        // and would throw away the open panel, the search box and the row he is working on.
        onDataChanged={async () => {
          await load();
          if (month) {
            try {
              setReview(await api.monthReview(month));
            } catch {
              // the register already shows the new category; a stale review header is not worth an error
            }
          }
        }}
      />

      {posterOpen && posterData && (
        <PosterModal data={posterData} categoryNameHe={categoryNameHe} onClose={() => setPosterOpen(false)} />
      )}
    </div>
  );
}
