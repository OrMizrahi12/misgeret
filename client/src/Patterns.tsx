import { CalendarCheck, CalendarClock, Footprints, Radar, Repeat } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { api, errorMessageHe } from './api';
import { CardChip } from './CardChip';
import { Explain, ExplainH, Formula } from './Explain';
import { MerchantHistoryModal } from './MerchantHistory';
import { PatternCard } from './PatternsViz';
import { RhythmMap } from './RhythmMap';
import type { InstallmentPlan, PatternNature, SpendingPatternsView, TxnMark } from './types';
import { categoryNameHe } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** The three rings, each with its identity colour (theme-independent islands, like the treemap).
 *  `tone` paints the whole section card in the family's world (the card-identity system). */
const NATURE: Record<PatternNature, { plural: string; color: string; tone: string; icon: LucideIcon }> = {
  subscription: { plural: 'מנויים', color: '#6b34d9', tone: 'tone-violet', icon: Repeat },
  fixed: { plural: 'חיובים קבועים', color: '#2a7fae', tone: 'tone-sky', icon: CalendarCheck },
  habit: { plural: 'הרגלים', color: '#0f9d8f', tone: 'tone-teal', icon: Footprints },
};
const ORDER: PatternNature[] = ['subscription', 'fixed', 'habit'];

/** An installment plan's end (a full YYYY-MM-DD) as "מרץ 2027" — when it frees up. */
function endMonthHe(endDate: string | null): string {
  if (!endDate) return '';
  return new Date(`${endDate.slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/** The day-of-month a plan's slice lands (from its next occurrence) — e.g. 2. */
function chargeDayHe(nextDate: string): number | null {
  const d = Number(nextDate.slice(8, 10));
  return Number.isFinite(d) && d >= 1 && d <= 31 ? d : null;
}

/** The concrete next charge date, for the chip's tooltip — e.g. "2 באוגוסט 2026". */
function chargeDateHe(nextDate: string): string {
  return new Date(`${nextDate.slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** "נראה לאחרונה מרץ 2026" — the archive rows' timestamp. */
function lastSeenHe(d: string): string {
  return new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/** "מה יורד לי כל חודש?" — every repeating rhythm the engine finds, as a wall of "cycle cards": one per charge,
 *  each its own ring + cadence + trend, so the view is meaningful whether you have 3 patterns or 30 and
 *  never collapses onto one dominant charge. Grouped into three rings; the engine proposes, you confirm. */
export function Patterns() {
  const [data, setData] = useState<SpendingPatternsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'commitments' | 'habits' | 'proposed'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [installments, setInstallments] = useState<InstallmentPlan[]>([]);

  const load = () => api.patterns().then((d) => { setData(d); setError(null); }).catch((e) => setError(errorMessageHe(e)));
  useEffect(() => { void load(); }, []);
  // open instalment plans — finite debt with a known end. Its own endpoint, and its own failure
  // mode: the wall of patterns must still render if this one call falls over.
  useEffect(() => {
    api.installments().then((r) => setInstallments(r.plans)).catch(() => setInstallments([]));
  }, []);

  async function setMark(merchant: string, target: TxnMark | null, anchor: number) {
    setBusy(merchant);
    try {
      // the anchor ("the amount I marked IS the amount") only makes sense for a commitment verdict
      const withAnchor = target === 'subscription' || target === 'fixed';
      await api.applyMerchantMark(merchant, target, withAnchor ? anchor : undefined);
      await load();
    } finally {
      setBusy(null);
    }
  }

  /** Accept every ring the engine is proposing, exactly as proposed — one press instead of thirty.
   *  Sequential on purpose: each verdict rewrites the same marks table, and a burst of parallel
   *  writes would race. One reload at the end, so the wall does not flicker N times. */
  async function approveAll(list: { merchant: string; nature: TxnMark; typicalAmount: number }[]) {
    setBulk(true);
    try {
      for (const p of list) {
        const withAnchor = p.nature === 'subscription' || p.nature === 'fixed';
        await api.applyMerchantMark(p.merchant, p.nature, withAnchor ? p.typicalAmount : undefined);
      }
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBulk(false);
    }
  }

  if (error) return <div className="view"><div className="card"><p className="mh-error">{error}</p></div></div>;
  if (!data) return <div className="view"><div className="card"><p className="pat-loading">טוען דפוסים…</p></div></div>;

  const s = data.summary;
  // the tab shows LIVE rhythms only — a pattern that ended months ago is history, not information.
  // Ended (inactive) patterns fold into a quiet archive; dismissed ones into their own list.
  const live = data.patterns.filter((p) => !p.dismissed && p.active);
  const ended = data.patterns.filter((p) => !p.dismissed && !p.active);
  const hidden = data.patterns.filter((p) => p.dismissed);
  // what the engine guessed and you have not answered yet — nothing here is counted anywhere
  const proposals = live.filter((p) => p.source !== 'manual' && !p.userMarked);
  const visible = live.filter((p) => (
    filter === 'all' ? true
      : filter === 'commitments' ? p.isCommitment
        : filter === 'proposed' ? (p.source !== 'manual' && !p.userMarked)
          : p.nature === 'habit'));
  const byNature = (n: PatternNature) => visible.filter((p) => p.nature === n);
  const active = historyFor ? data.patterns.find((p) => p.merchant === historyFor) ?? null : null;
  // the instalment card's three headline figures: monthly burden, total still owed, next to free up
  const instMonthly = installments.reduce((sum, p) => sum + p.sliceAmount, 0);
  const instRemaining = installments.reduce((sum, p) => sum + p.remainingAmount, 0);
  const nextFree = installments.length > 0 ? installments[0] : null; // sorted soonest-ending first

  return (
    <div className="view">
      <div className="card g12 tone-night">
        <CardChip icon={Radar} />
        <div className="label">
          מה יורד לי כל חודש?
          <Explain title="מה יורד לי כל חודש?">
            <p>כל מה שחוזר בכסף שלך, מזוהה אוטומטית מהתנועות — וכל חיוב חוזר מוצג כ<strong>כרטיס-מחזור</strong> משלו: טבעת שמתמלאת לקראת החיוב הבא, הסכום החודשי במרכז, והקצב שלו במילים.</p>
            <p>הכרטיסים מחולקים לשלוש <strong>טבעות</strong> לפי המשמעות:</p>
            <ul>
              <li><strong>מנויים</strong> — שירות תקופתי יציב (נטפליקס, ChatGPT, חדר כושר).</li>
              <li><strong>חיובים קבועים</strong> — התחייבות תקופתית (שכ״ד, ביטוח, חשבון חשמל, תשלומים).</li>
              <li><strong>הרגלים</strong> — התנהגות שחוזרת, לא חוזה (דלק, הסופר, המסעדות). חוזר בזמן — אבל בשליטתך, ו<strong>לא</strong> נספר כ״מחויב מראש״.</li>
            </ul>
            <ExplainH>איך המנוע מזהה ומנחש</ExplainH>
            <p>הקצב מגיע מ<strong>המרווח הרגיל</strong> בין החיובים; ה<strong>סוג</strong> מהקטגוריה, שם הסוחר, ויציבות הסכום. לכל דפוס ציון ביטחון:</p>
            <Formula>ביטחון = 0.45·תמיכה + 0.4·סדירות + 0.15·טריוּת</Formula>
            <p>המנוע <strong>מציע</strong> טבעת, ואתה מאשר או מתקן בקליק (מנוי / קבוע / הרגל), או <strong>מסתיר</strong> זיהוי שגוי. הצעה שלא ענית עליה לובשת תווית <strong>״מוצע״</strong> והכפתור שלה מסומן בקו מקווקו — כדי שניחוש לא ייראה כמו החלטה.</p>
            <p><strong>שום דבר לא נספר בלי אישור שלך</strong> — לא במנויים, לא בקבועים ו<strong>גם לא בהרגלים</strong>. קליק על כפתור דולק מבטל את האישור ומחזיר את הדפוס להצעה בלבד. היוצא היחיד הוא תשלומים פתוחים, שהם התחייבות חוזית מרגע קיומם.</p>
            <p>מוצגים כאן רק דפוסים <strong>חיים</strong>: מנוי שבוטל או תשלומים שנגמרו יורדים לבד ל"דפוסים שהסתיימו" בתחתית. מה שאישרת כאן הוא בדיוק מה שמפת "מנויים וחיובים קבועים" בטאב ״איך אני בכללי״ מציגה.</p>
          </Explain>
        </div>
        <p className="card-sub">כל חיוב חוזר, ככרטיס-מחזור משלו — הטבעת מתמלאת לקראת החיוב הבא.</p>
        {/* אותה מפת קצב כמו בטאב "איך אני בכללי" — אותו רכיב, אותם נתונים, אפס סתירה אפשרית.
            כאן בלי גשר ("כל הדפוסים ←" / צ'יפ ההצעות) — ההצעות עצמן חיות בכרטיסים למטה. */}
        <RhythmMap view={data} baseMonthly={s.totalMonthlySpend} />
      </div>

      {/* ── תשלומים פתוחים ────────────────────────────────────────────────────────────────
           SECOND, on purpose — before the verdict machinery, not among it.
           An instalment plan is the one family here that counts itself: `countsAsCommitted`
           in patterns.ts admits it on `userMarked || installmentPlan`, because a signature is
           already a verdict. Placing it below "המנוע מציע" would put a signed contract among
           unconfirmed guesses.
           It is also the only family with an END DATE, which is the whole point of it — so the
           card keeps its own detail (the segmented track, "מתפנה מרץ 2027") instead of being
           flattened into the rhythm map's blue tiles above. */}
      {installments.length > 0 && (
        <div className="card g12 tone-blue">
          <CardChip icon={CalendarClock} />
          <div className="label">
            תשלומים פתוחים
            <Explain title="תשלומים פתוחים">
              <p>רכישות שפרסת לתשלומים — חיובים שנגמרים בתאריך ידוע. לכל תוכנית: כמה תשלומים כבר ירדו, כמה נשארו, כמה כסף עוד תשלם, ומתי היא נגמרת ומשחררת תזרים.</p>
              <ExplainH>למה הם לא מחכים לאישור שלך</ExplainH>
              <p>כל השאר במסך הזה הוא <strong>הצעה</strong> עד שתאשר. תשלומים פתוחים הם היוצא מן הכלל היחיד: חתמת עליהם, ולכן הם מחויבים מרגע קיומם — ונספרים לבד. הם גם יורדים לבד כשהתוכנית נגמרת.</p>
              <ExplainH>מאיפה המספרים</ExplainH>
              <Formula>
                נשארו = מספר התשלומים (N) − התשלום האחרון שנראה (k)
                <br />הסכום שנותר = נשארו × גובה תשלום רגיל
                <br />נגמר ב־ = חודש התשלום האחרון
              </Formula>
              <p>מספר התשלום ("3 מתוך 12") מגיע מחברת האשראי עם כל חיוב. התחזית כבר יודעת להפסיק את החיוב ביום שהתוכנית נגמרת — כאן רק רואים את זה בעיניים.</p>
            </Explain>
          </div>
          <p className="card-sub">מה עוד אתה משלם עליו — וכמה קרוב כל אחד לסיום, כדי לתכנן תזרים קדימה.</p>
          <div className="sub-tiles">
            <div className="sub-tile"><div className="sub-tile-label">יורד החודש בתשלומים</div><div className="sub-tile-value">{ILS0.format(instMonthly)}<span className="sub-tile-sub"> /ח׳</span></div></div>
            <div className="sub-tile"><div className="sub-tile-label">סה״כ נותר לשלם</div><div className="sub-tile-value accent">{ILS0.format(instRemaining)}</div></div>
            {nextFree && (
              <div className="sub-tile">
                <div className="sub-tile-label">הבא שמתפנה</div>
                <div className="sub-tile-value">{ILS0.format(nextFree.sliceAmount)}<span className="sub-tile-sub"> · {endMonthHe(nextFree.endDate)}</span></div>
              </div>
            )}
          </div>
          <ul className="inst-list">
            {installments.map((p) => {
              const dense = p.total > 40;
              const pct = Math.round((p.paid / p.total) * 100);
              const chargeDay = chargeDayHe(p.nextDate);
              return (
                <li className="inst-row" key={p.merchant}>
                  <div className="inst-head">
                    <span className="inst-name">{p.name}</span>
                    {p.category && <span className="tag">{categoryNameHe(p.category)}</span>}
                    <span className="inst-dates">
                      {chargeDay !== null && (
                        <span className="inst-chip inst-charge" title={`החיוב הבא: ${chargeDateHe(p.nextDate)}`}>
                          <CalendarClock size={13} strokeWidth={2.2} aria-hidden />מחויב ב־<strong>{chargeDay}</strong> בחודש
                        </span>
                      )}
                      <span className="inst-chip inst-free"><CalendarCheck size={13} strokeWidth={2.2} aria-hidden />מתפנה {endMonthHe(p.endDate)}</span>
                    </span>
                  </div>
                  <div
                    className={dense ? 'inst-track dense' : 'inst-track'}
                    style={{ '--n': p.total } as CSSProperties}
                    role="img"
                    aria-label={`שולמו ${p.paid} מתוך ${p.total} תשלומים`}
                  >
                    {Array.from({ length: p.total }, (_, i) => i + 1).map((n) => {
                      const state = n <= p.paid ? 'paid' : n === p.paid + 1 ? 'next' : 'future';
                      return <span key={n} className={`inst-seg ${state}`}><i>{n}</i></span>;
                    })}
                  </div>
                  <div className="inst-meta">
                    <span className="inst-pct">{pct}%</span>
                    <span className="inst-prog">שולמו {p.paid} מתוך {p.total}</span>
                    <span className="inst-dot">·</span>
                    <span>נשארו <strong>{p.remaining}</strong> · {ILS0.format(p.remainingAmount)}</span>
                    <span className="inst-dot">·</span>
                    <span>{ILS0.format(p.sliceAmount)}/ח׳</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ── ההכרזה ────────────────────────────────────────────────────────────────────────
           A headline, not a card. It carries no figure and no button on purpose: the count lives
           on the filter pill below, and the decision lives on each card.
           The first line names the three choices, so the buttons on every card underneath are
           understood before they are reached — the headline teaches the surface it introduces. */}
      {proposals.length > 0 && (
        <p className="pat-declare">
          <span className="pat-declare-q">מנוי? קבוע? הרגל?</span>
          אתה מחליט על כל אחד
        </p>
      )}

      <div className="pat-filters">
        <button className={filter === 'all' ? 'pill active' : 'pill'} onClick={() => setFilter('all')}>הכול</button>
        <button className={filter === 'commitments' ? 'pill active' : 'pill'} onClick={() => setFilter('commitments')}>התחייבויות</button>
        <button className={filter === 'habits' ? 'pill active' : 'pill'} onClick={() => setFilter('habits')}>הרגלים</button>
        {proposals.length > 0 && (
          <>
            <button className={filter === 'proposed' ? 'pill active' : 'pill'} onClick={() => setFilter('proposed')}>
              מחכים לאישור ({proposals.length})
            </button>
            {/* the one action the headline could not keep: thirty proposals must not mean thirty
                clicks. It sits in the row that is already made of buttons, not in the headline. */}
            <button className="pill" onClick={() => void approveAll(proposals)} disabled={bulk}>
              {bulk ? 'מאשר…' : 'אשר את כולם כפי שהוצעו'}
            </button>
          </>
        )}
      </div>

      {ORDER.filter((n) => byNature(n).length > 0).map((n) => {
        const list = byNature(n);
        // The header quotes the COUNTED sum — the same figure the rhythm map above shows. Summing
        // the cards on screen instead would put two different totals for one word on one screen
        // (the habits section read 7,390 while the map read 0). Proposals are named separately,
        // as a count, so nothing is hidden and nothing pretends to be money that is settled.
        const counted = list.filter((p) => (n === 'habit' ? p.countsAsHabit : p.countsAsCommitted));
        const sum = counted.reduce((a, p) => a + p.monthlyAmount, 0);
        const waiting = list.length - counted.length;
        return (
          <div className={`card g12 ${NATURE[n].tone}`} key={n}>
            <CardChip icon={NATURE[n].icon} />
            <div className="pat-sec-head">
              <span className="pat-sec-title"><i className="pat-dot lg" style={{ background: NATURE[n].color }} />{NATURE[n].plural}</span>
              <span className="pat-sec-sum">
                {ILS0.format(sum)}<span className="pat-amount-sub">/ח׳</span>
                {waiting > 0 && <span className="pat-sec-waiting"> · {waiting} מחכים לאישור</span>}
              </span>
            </div>
            <div className="pcard-grid">
              {list.map((p) => (
                <PatternCard
                  key={p.merchant}
                  p={p}
                  color={NATURE[n].color}
                  busy={busy === p.merchant}
                  onMark={(t) => void setMark(p.merchant, t, p.typicalAmount)}
                  onHistory={() => setHistoryFor(p.merchant)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {visible.length === 0 && (
        <div className="card"><p className="pat-loading">אין עדיין דפוסים בקטגוריה הזו. ככל שיצטברו חיובים חוזרים — הם יופיעו כאן.</p></div>
      )}

      {/* דפוסים שהסתיימו — מנוי שבוטל, תשלומים שנגמרו. היסטוריה, לא מידע: מקופלים ושקטים. */}
      {ended.length > 0 && (
        <div className="card g12 tone-slate">
          <button className="link" onClick={() => setShowEnded((v) => !v)} aria-expanded={showEnded}>
            {showEnded ? 'הסתר את הרשימה' : `דפוסים שהסתיימו (${ended.length})`}
          </button>
          {showEnded && (
            <ul className="pat-hidden-list">
              {ended.map((p) => (
                <li className="pat-hidden-row" key={p.merchant}>
                  <span className="pat-hidden-name" title={p.name}>{p.name}</span>
                  <span className="pat-hidden-meta">
                    {p.cadenceHe} · {ILS0.format(p.typicalAmount)} · נראה לאחרונה {lastSeenHe(p.lastDate)}
                  </span>
                  {p.source !== 'manual' && (
                    <button
                      type="button" className="txn-mark" disabled={busy === p.merchant}
                      title="הסתר — אפשר להחזיר בכל רגע מ״הוסתרו על ידך״"
                      onClick={() => void setMark(p.merchant, 'dismissed', p.typicalAmount)}
                    >הסתר</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* דפוסים שהוסתרו — false positives שהמשתמש סילק. נשארים בהישג יד, עם שחזור בקליק. */}
      {hidden.length > 0 && (
        <div className="card g12 tone-slate">
          <button className="link" onClick={() => setShowHidden((v) => !v)} aria-expanded={showHidden}>
            {showHidden ? 'הסתר את הרשימה' : `הוסתרו על ידך (${hidden.length})`}
          </button>
          {showHidden && (
            <ul className="pat-hidden-list">
              {hidden.map((p) => (
                <li className="pat-hidden-row" key={p.merchant}>
                  <span className="pat-hidden-name" title={p.name}>{p.name}</span>
                  <span className="pat-hidden-meta">{p.cadenceHe} · {ILS0.format(p.monthlyAmount)}/ח׳</span>
                  <button
                    type="button" className="txn-mark" disabled={busy === p.merchant}
                    onClick={() => void setMark(p.merchant, null, p.typicalAmount)}
                  >החזר</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {active && (
        <MerchantHistoryModal
          merchant={active.merchant}
          title={active.name}
          mark={active.userMarked ? active.nature : null}
          busy={busy === active.merchant}
          onMark={(t) => void setMark(active.merchant, t, active.typicalAmount)}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}
