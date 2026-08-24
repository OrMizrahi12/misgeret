import { Treemap, type TreemapDatum } from './charts';
import type { SpendingPattern, SpendingPatternsView } from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/** Two families only: subscriptions get a violet SET, fixed charges (open installments included) a
 *  blue SET — one shade per tile so same-type neighbours stay distinct. Every shade is dark enough
 *  for the tiles' white text, and identical in both themes (colour islands, S&P-heatmap style). */
const SUB_SET = ['#5b2be0', '#6b34d9', '#7c3aed', '#5324b8', '#8347e6'];
const FIX_SET = ['#1e6091', '#24709e', '#2a7fae', '#1b6b8a', '#327bb0', '#1f7d94'];
const TYPE_MAIN = { sub: SUB_SET[0], fixed: FIX_SET[0] } as const;
/** The habits family colour — the patterns tab's teal, one identity end-to-end — and its SHADE SET
 *  for the habits treemap (dark enough for white tile text, like the violet/blue sets). */
const HABIT_COLOR = '#0f9d8f';
const HABIT_SET = ['#0f9d8f', '#0b7f75', '#12a394', '#0a6e63', '#15887c', '#0d9186'];
const TYPE_HE = { sub: 'מנוי', fixed: 'חיוב קבוע' } as const;
type CommitType = keyof typeof TYPE_HE;
interface CommitRaw { id: string; name: string; value: number; type: CommitType; pat: SpendingPattern }
const DOW_FULL = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** An installment plan's end (a full YYYY-MM-DD) as "מרץ 2027" — when it frees up. */
function endMonthHe(endDate: string | null): string {
  if (!endDate) return '';
  return new Date(`${endDate.slice(0, 10)}T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/**
 * The rhythm map: the rhythm strip (average monthly spend cut into subscriptions · fixed · habits ·
 * free), three sibling family treemaps, and the grid-anchored confluence pouring into one figure.
 *
 * The maps show exactly what countsAsCommitted (approved + installments + manual) plus active
 * habits — a bare detection NEVER enters here (curated-commitments law).
 */
export function RhythmMap({ view, baseMonthly }: {
  view: SpendingPatternsView;
  /** What the strip measures against — the engine's own totalMonthlySpend. */
  baseMonthly: number;
}) {
  // every commitment as one tile — straight from the pattern engine's verdict: everything (and only
  // what) countsAsCommitted, i.e. what the user approved + contractual installments + manual entries.
  const rawCommit: CommitRaw[] = view.patterns
    .filter((p) => p.countsAsCommitted && p.monthlyAmount > 0)
    .map((p) => ({
      id: p.merchant, name: p.name, value: p.monthlyAmount,
      type: p.nature === 'subscription' ? 'sub' as const : 'fixed' as const,
      pat: p,
    }));
  const subMonthly = rawCommit.filter((x) => x.type === 'sub').reduce((s, x) => s + x.value, 0);
  const fixedMonthly = rawCommit.filter((x) => x.type === 'fixed').reduce((s, x) => s + x.value, 0);
  const committedMonthly = subMonthly + fixedMonthly;
  // three sibling family maps — same shape, family colour: one shade per tile from the family's
  // SET, deepest for the biggest, so same-family neighbours stay distinct (the treemap's own rule).
  const familyTiles = (
    list: { id: string; name: string; value: number; pat: SpendingPattern }[],
    set: string[], typeLabel: string, familyTotal: number,
  ): TreemapDatum[] => {
    const ranked = [...list].sort((a, b) => b.value - a.value);
    return ranked.map((x, i) => {
      const p = x.pat;
      const instRemain = p.installmentsTotal !== null && p.installmentsPaid !== null
        ? Math.max(0, p.installmentsTotal - p.installmentsPaid) : null;
      return {
        id: x.id, label: x.name, value: x.value, color: set[i % set.length], amountHe: ILS0.format(x.value),
        tip: (
          <>
            <div className="tm-tip-row">
              {typeLabel} · {familyTotal > 0 ? Math.round((x.value / familyTotal) * 100) : 0}% מהמשפחה
              {' · '}{p.cadenceHe}{p.dayOfWeek !== null ? ` · בימי ${DOW_FULL[p.dayOfWeek]}` : ''}
            </div>
            {p.installmentPlan && instRemain !== null && (
              <div className="tm-tip-row">תשלום {p.installmentsPaid} מתוך {p.installmentsTotal} · נשארו {instRemain} · מתפנה {endMonthHe(p.endDate)}</div>
            )}
            {p.source === 'manual' && <div className="tm-tip-row">הוזן ידנית</div>}
          </>
        ),
      };
    });
  };
  const habitPats = view.patterns
    .filter((p) => p.countsAsHabit && p.monthlyAmount > 0)
    .map((p) => ({ id: p.merchant, name: p.name, value: p.monthlyAmount, pat: p }));
  const habitMonthly = habitPats.reduce((s, x) => s + x.value, 0);
  const subTiles = familyTiles(rawCommit.filter((x) => x.type === 'sub'), SUB_SET, TYPE_HE.sub, subMonthly);
  const fixedTiles = familyTiles(rawCommit.filter((x) => x.type === 'fixed'), FIX_SET, TYPE_HE.fixed, fixedMonthly);
  const habitTiles = familyTiles(habitPats, HABIT_SET, 'הרגל', habitMonthly);
  const rhythmGrand = committedMonthly + habitMonthly; // what the three maps pour into

  // the rhythm strip: the monthly spend, cut into subscriptions · fixed · habits · free
  const rhythmTotal = Math.max(baseMonthly, committedMonthly + habitMonthly);
  const freeMonthly = Math.max(0, rhythmTotal - committedMonthly - habitMonthly);
  const rhythmSegs = [
    { id: 'subs', label: 'מנויים', value: subMonthly, color: TYPE_MAIN.sub },
    { id: 'fixed', label: 'קבועים', value: fixedMonthly, color: TYPE_MAIN.fixed },
    { id: 'habits', label: 'הרגלים', value: habitMonthly, color: HABIT_COLOR },
    { id: 'free', label: 'חופשי להחלטות', value: freeMonthly, color: 'var(--hairline-strong)' },
  ].filter((s) => s.value > 0);
  const showRhythm = rhythmTotal > 0 && committedMonthly + habitMonthly > 0;
  const autopilotPct = rhythmTotal > 0 ? Math.round(((committedMonthly + habitMonthly) / rhythmTotal) * 100) : 0;

  return (
    <>
      {/* רצועת הקצב: ההוצאה החודשית, מחולקת למנויים · מחזוריים · הרגלים · חופשי. */}
      {showRhythm && (
        <>
          <div className="rhythm-head">
            <span className="rhythm-lead">{autopilotPct}% מההוצאה שלך רצה על טייס אוטומטי</span>
          </div>
          <div className="rhythm-strip" role="img" aria-label={`חלוקת ההוצאה החודשית: ${rhythmSegs.map((s) => `${s.label} ${ILS0.format(s.value)}`).join(', ')}`}>
            {rhythmSegs.map((s) => (
              <div
                key={s.id}
                className={s.id === 'free' ? 'rhythm-seg free' : 'rhythm-seg'}
                style={{ flexGrow: s.value, background: s.color }}
                title={`${s.label} · ${ILS0.format(s.value)} לחודש`}
              />
            ))}
          </div>
          <div className="rhythm-legend">
            {rhythmSegs.map((s) => (
              <span key={s.id}><i className="commit-dot" style={{ background: s.color }} />{s.label} {ILS0.format(s.value)}</span>
            ))}
          </div>
        </>
      )}

      {subTiles.length + fixedTiles.length + habitTiles.length === 0 ? (
        <p className="sub-empty">
          עדיין לא אישרת מנויים או חיובים קבועים. אשר הצעה בכרטיסים כאן למטה, או סמן חיוב
          כ<strong>מנוי</strong> או כ<strong>קבוע</strong> בפירוט העסקאות — והוא יופיע כאן מיד.
        </p>
      ) : (
        <>
          {/* ── שלוש מפות אחיות: אותה צורה, צבע משפחה — והכול מתנקז לסכום אחד ────────
               ההתנקזות בנויה על אותו grid כמו הפאנלים, כדי שהחצים יישארו
               מחוברים למרכז העמודות בכל רוחב. */}
          <div className="trio">
            {([
              { id: 'subs', title: 'מנויים', sum: subMonthly, color: TYPE_MAIN.sub, tiles: subTiles, empty: 'עדיין אין מנויים מאושרים' },
              { id: 'fixed', title: 'קבועים', sum: fixedMonthly, color: TYPE_MAIN.fixed, tiles: fixedTiles, empty: 'עדיין אין חיובים קבועים מאושרים' },
              { id: 'habits', title: 'הרגלים', sum: habitMonthly, color: HABIT_COLOR, tiles: habitTiles, empty: 'עדיין אין הרגלים מאושרים' },
            ] as const).map((f) => (
              <div className="trio-panel" key={f.id}>
                <div className="trio-head">
                  <span className="trio-title"><i className="commit-dot" style={{ background: f.color }} />{f.title}</span>
                  <span className="trio-sum">{ILS0.format(f.sum)}<span className="trio-sum-sub">/ח׳</span></span>
                </div>
                {f.tiles.length > 0 ? (
                  <Treemap items={f.tiles} height={190} ariaLabel={`מפת ה${f.title} — גודל לפי סכום חודשי`} />
                ) : (
                  <p className="trio-empty">{f.empty}</p>
                )}
              </div>
            ))}
          </div>
          <div className="trio-join" aria-hidden>
            <i style={{ background: TYPE_MAIN.sub }} />
            <i style={{ background: TYPE_MAIN.fixed }} />
            <i style={{ background: HABIT_COLOR }} />
          </div>
          <div className="trio-bar" aria-hidden />
          <div className="trio-drop" aria-hidden />
          <div className="trio-total">
            <span className="trio-total-num">{ILS0.format(rhythmGrand)}</span>
            <span className="trio-total-cap">רץ על קצב, כל חודש</span>
            <span className="trio-total-sub">
              מחויב מראש {ILS0.format(committedMonthly)} · הרגלים {ILS0.format(habitMonthly)}
            </span>
          </div>
        </>
      )}
    </>
  );
}
