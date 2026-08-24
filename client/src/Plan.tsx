import { Target } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { CardChip } from './CardChip';
import { DetailButton, DetailModal } from './Detail';
import { Explain, ExplainH, Formula } from './Explain';
import type { PlanResponse, SavingsTarget } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** The choices offered. "אחר" is always one step away, but a household that has never thought
 *  about this should not have to invent a number to get started. */
const PRESETS = [0.05, 0.1, 0.15, 0.2, 0.25];

/**
 * ההגדרה — the one thing the household declares.
 *
 * Ask what share of income the household wants to keep and derive the spending ceiling from it.
 * Every shekel on this card is `rate × THIS month's actual income`; typical income informs only
 * the observed and maximum rates, which are explicitly historical facts.
 */
function TargetCard({ target, thisMonth, daysLeft, onSaved }: {
  target: SavingsTarget;
  thisMonth: PlanResponse['thisMonth'];
  daysLeft: number;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const declared = target.rate;
  const shown = target.effectiveRate;

  // ── this month's arithmetic, at the shown rate ────────────────────────────────────────────
  // When a rate is declared the server's own figures are used verbatim (they also feed the
  // month tab, so the two screens can never disagree by a rounding). Before any declaration,
  // the same formula runs on the preview rate.
  const monthIncome = thisMonth?.income ?? 0;
  const keepAmt = declared !== null && thisMonth
    ? thisMonth.keep.target
    : Math.round(monthIncome * shown);
  const applied = declared !== null && thisMonth
    ? thisMonth.keep.applied
    : keepAmt;
  const leftForVariable = Math.round(monthIncome - (thisMonth?.fixed ?? 0) - applied);
  const safeLeft = declared !== null && thisMonth
    ? Math.round(thisMonth.leftToSpend)
    : Math.round(leftForVariable - (thisMonth?.variableSoFar ?? 0));

  async function save(rate: number | null) {
    setBusy(true);
    setError(null);
    try {
      await api.setTarget(rate);
      await onSaved();
      setCustom(false);
      setDraft('');
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  function submitDraft() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      setError('אחוז בין 1 ל-60.');
      return;
    }
    void save(Math.round(n) / 100);
  }

  // the presets a household would actually consider, plus its own declared number and the
  // app's suggestion when those are not among them — a chosen 17%, or a suggested 24%, must
  // never vanish from the row that is supposed to show it
  const options = [...new Set([
    ...PRESETS,
    ...(declared !== null ? [declared] : []),
    ...(target.available ? [target.suggestedRate] : []),
  ])].sort((a, b) => a - b);

  return (
    <div className="card g12 tone-violet">
      <CardChip icon={Target} />
      <div className="hero-top">
        <div className="label">
          יעד החיסכון שלי
          <Explain title="יעד החיסכון שלי">
            <p>
              ההגדרה האחת של הבית: באיזה חלק מההכנסה אתה רוצה לסיים כל חודש. כל שאר המספרים
              באפליקציה נגזרים ממנו — כמה נשאר להוציא בבטחה החודש, ומה נחשב חריגה.
            </p>
            <ExplainH>איך זה מחושב — על החודש הזה, בפועל</ExplainH>
            <Formula>
              הכנסות החודש (נכנסו + בדרך) {ILS0.format(monthIncome)}
              <br />− הקבועות (שכ״ד, מנויים, חשבונות) {ILS0.format(thisMonth?.fixed ?? 0)}
              <br />− החיסכון ({pct(shown)} מהכנסת החודש) {ILS0.format(applied)}
              <br />− קניות היום-יום שכבר יצאו {ILS0.format(thisMonth?.variableSoFar ?? 0)}
              <br />= <strong>{ILS0.format(safeLeft)}</strong> נשאר להוציא בבטחה
            </Formula>
            <p>
              האחוז נמדד תמיד מול ההכנסה שנכנסה בפועל — לא מול חודש משוער. חודש חזק שם בצד
              יותר שקלים, חודש רזה פחות, החלק תמיד זהה. אם עוד צפויה הכנסה החודש, הסכומים
              יתעדכנו כשהיא תיכנס. תוכניות חיסכון שהגדרת הן רצפה — אם הן מפרישות יותר מיעד החיסכון,
              הן גוברות.
            </p>
            <ExplainH>אז בשביל מה ההיסטוריה?</ExplainH>
            <p>
              רק לשני הנתונים שמתחת לבחירה: באיזה אחוז נסגר אצלך חודש רגיל, וכמה המבנה שלך
              בכלל מאפשר בחודש רגיל. הם עוזרים לבחור אחוז ריאלי — אבל השקלים תמיד נמדדים מול
              החודש עצמו.
            </p>
          </Explain>
        </div>
        {declared !== null && (
          <button className="link" onClick={() => void save(null)} disabled={busy}>ביטול יעד החיסכון</button>
        )}
      </div>

      <p className="target-question">עם כמה אחוז מההכנסה אתה רוצה לסגור כל חודש?</p>

      <div className="target-choices" role="group" aria-label="בחירת יעד החיסכון החודשי">
        {options.map((r) => (
          <button
            key={r}
            className={`target-choice ${declared === r ? 'is-on' : ''} ${declared === null && target.suggestedRate === r ? 'is-suggested' : ''}`}
            onClick={() => void save(r)}
            disabled={busy}
            aria-pressed={declared === r}
            aria-label={`יעד של ${pct(r)} מההכנסה`}
          >
            <bdi className="target-choice-pct">{pct(r)}</bdi>
            {/* ELASTIC: the shekels under a percent are that share of THIS month's actual
                income — the same base the month tab binds on, so the two screens always quote
                the same figure for the same rate. Never a typical month's money. */}
            {monthIncome >= 1 && (
              <span className="target-choice-ils">{ILS0.format(Math.round(monthIncome * r))}</span>
            )}
          </button>
        ))}
        <button className="target-choice is-other" onClick={() => setCustom((v) => !v)} disabled={busy} aria-label="יעד באחוז אחר">
          <span className="target-choice-pct">אחר</span>
        </button>
      </div>

      {monthIncome >= 1 && (
        <p className="target-basis muted">
          מחושב על הכנסת החודש בפועל · {ILS0.format(monthIncome)}
        </p>
      )}

      {custom && (
        <div className="target-custom">
          <input
            dir="ltr"
            inputMode="numeric"
            style={{ textAlign: 'end', width: 90 }}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitDraft(); }}
            placeholder="18"
            aria-label="אחוז היעד"
          />
          <span className="muted">אחוז מההכנסה</span>
          <button className="primary" onClick={submitDraft} disabled={busy}>קביעה</button>
        </div>
      )}

      {error && <p className="error">{error}</p>}

      {/* The two historical facts that keep the choice honest. "בחודשים שכבר הסתיימו" is
           essential: a statistic about completed months must not read as a current forecast. */}
      {target.available && (
        <p className="target-line">
          {target.observedRate !== null ? (
            <>
              בחודשים שכבר הסתיימו אתה סוגר <strong>בדרך כלל</strong> עם{' '}
              {/* a signed percentage is a number too: isolated, so RTL never moves the minus */}
              <bdi className={`target-line-num ${target.observedRate < 0 ? 'neg' : 'observed'}`}>
                {target.observedRate < 0 ? `−${pct(-target.observedRate)}` : pct(target.observedRate)}
              </bdi>
              , והמבנה שלך מאפשר עד{' '}
            </>
          ) : (
            <>המבנה שלך מאפשר עד{' '}</>
          )}
          <bdi className="target-line-num ceiling">{pct(target.maxRate)}</bdi>
          {' '}— <strong>מעבר לזה</strong> לא יישאר לקבועות ולמחיה.
        </p>
      )}

      {declared === null && target.available && (
        <p className="target-suggestion">
          <strong>ההצעה: {pct(target.suggestedRate)}</strong> — {target.suggestionHe}
        </p>
      )}

      {/* Keep the decision prominent, show the salary as plain named blocks, and place the
           complete arithmetic behind "פירוט מלא". */}
      {monthIncome >= 1 ? (
        <>
          {/* The hero that stood here said "נשאר להוציא בבטחה" over `safeLeft` — the very figure
              the green block below already carries under the name "פנוי לבזבז". Same number,
              two names, one card. The blocks keep it; the per-day pace moved down to sit with
              them, since it describes that green block and appears nowhere else. */}
          {(() => {
            /** Three blocks: committed money, the savings target and the genuinely free amount. */
            const gone = Math.max(0, (thisMonth?.fixed ?? 0) + (thisMonth?.variableSoFar ?? 0));
            const segs = [
              {
                key: 'gone', label: 'יצא ותפוס', value: gone, color: 'var(--negative)',
                title: 'כל מה שכבר יצא + כל ההתחייבויות שאישרת שעוד ירדו החודש',
              },
              {
                key: 'kept', label: `לחיסכון · ${pct(shown)}`, value: Math.max(0, applied), color: 'var(--accent)',
                title: 'מה שביקשת לשמור בצד — לא נספר כפנוי',
              },
              {
                key: 'left', label: 'פנוי לבזבז', value: Math.max(0, safeLeft), color: 'var(--positive)',
                title: 'מה שבאמת נשאר לבזבז עד סוף החודש',
              },
            ].filter((s) => s.value >= 1);
            return (
              <>
                <p className="budget-blocks-title">כך נחלקת הכנסת החודש · {ILS0.format(monthIncome)}</p>
                <div className="budget-blocks" role="img" aria-label={`חלוקת הכנסת החודש: ${segs.map((s) => `${s.label} ${ILS0.format(s.value)}`).join(', ')}`}>
                  {segs.map((s) => (
                    <div
                      key={s.key} className="budget-block"
                      style={{ flexGrow: s.value, background: s.color }}
                      title={s.title}
                    >
                      <span className="budget-block-name">{s.label}</span>
                      <span className="budget-block-amount">{ILS0.format(s.value)}</span>
                    </div>
                  ))}
                </div>
                {safeLeft > 0 && daysLeft >= 1 && (
                  <p className="budget-blocks-foot">
                    <span className="tag">≈ {ILS0.format(safeLeft / daysLeft)} ליום · {daysLeft} ימים</span>
                  </p>
                )}
              </>
            );
          })()}
          <DetailButton onClick={() => setDetailOpen(true)} />
          {detailOpen && (
            <DetailModal title="יעד החיסכון שלי · החשבון המלא" onClose={() => setDetailOpen(false)}>
              <div className="target-derivation">
                <div className="target-derivation-row plus">
                  <span>הכנסות החודש הזה (נכנסו + בדרך)</span>
                  <Amount value={monthIncome} decimals={0} />
                </div>
                <div className="target-derivation-row minus">
                  {/* the vouched certainties — the SAME figure "צפוי לצאת" stands on, so the
                      two tabs reconcile by a single subtraction instead of by a mystery */}
                  <span>הקבועות של החודש · ירדו + בדרך</span>
                  <Amount value={thisMonth?.fixed ?? 0} decimals={0} />
                </div>
                <div className="target-derivation-row minus">
                  <span>{`חיסכון — ${pct(shown)} מהכנסת החודש`}</span>
                  <Amount value={applied} decimals={0} />
                </div>
                <div className="target-derivation-row total">
                  <span>נשאר לקניות היום-יום החודש</span>
                  <Amount value={leftForVariable} decimals={0} tone={leftForVariable < 0 ? 'negative' : undefined} />
                </div>
                {(thisMonth?.variableSoFar ?? 0) >= 1 && (
                  <>
                    <div className="target-derivation-row minus">
                      <span>קניות היום-יום שכבר יצאו</span>
                      <Amount value={thisMonth?.variableSoFar ?? 0} decimals={0} />
                    </div>
                    <div className="target-derivation-row total">
                      <span>נשאר להוציא בבטחה</span>
                      <Amount value={safeLeft} decimals={0} tone={safeLeft < 0 ? 'negative' : undefined} />
                    </div>
                  </>
                )}
              </div>
              <p className={`target-note ${target.feasible ? '' : 'is-broken'}`}>
                {target.available ? target.noteHe : `${target.reasonHe} ${target.suggestionHe}`}
              </p>
            </DetailModal>
          )}
        </>
      ) : (
        <p className="muted">עוד לא נכנסו הכנסות החודש — הסכומים יופיעו ברגע שתיכנס הכנסה.</p>
      )}

      {/* the ONE verdict allowed on the clean surface: a target the month cannot carry */}
      {!target.feasible && target.noteHe && (
        <p className="target-note is-broken">{target.noteHe}</p>
      )}
    </div>
  );
}

/**
 * "התוכנית שלי" — one definition, and nothing else.
 *
 * Every other tab in this app observes. This is the only place the household DECIDES, and it
 * holds exactly one decision. Everything that used to sit beneath it — a ceiling, stances,
 * goals, a queue of recommendations — was configuration wearing the costume of a plan.
 */
export function Plan({ onOpenMonth }: { onOpenMonth: () => void }) {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.plan());
      setError(null);
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  return (
    <div>
      {error && <p className="error">{error}</p>}

      <p className="view-identity">
        ההגדרה של הבית: מה אתה רוצה שיישאר בסוף כל חודש.
        <button className="link" onClick={onOpenMonth}>ואיך אני החודש בפועל? ←</button>
      </p>

      <TargetCard target={data.target} thisMonth={data.thisMonth} daysLeft={data.daysLeft} onSaved={load} />

      <p className="plan-foot muted">
        יעד החיסכון הוא חשבון על הנתונים שלך, לא ייעוץ פיננסי אישי.
      </p>
    </div>
  );
}
