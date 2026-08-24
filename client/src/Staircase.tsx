import { History } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * המדרגות — a ranked list drawn as full-colour bars, biggest first, each carrying its own name and
 * amount INSIDE it. Sorted descending, the bars fall away like half a pyramid.
 *
 * ── the floor ─────────────────────────────────────────────────────────────────────────────────
 * The shortest bar is never shorter than the text it must hold, and the whole scale is stretched
 * onto that floor rather than clamped at it:
 *
 *     width = floor + (value ÷ largest) × (100% − floor)
 *
 * A plain `max(floor, share)` would crush the tail — two rows a factor of two apart would draw the
 * same bar, which is a lie. The price of stretching is that bar length stops being a true ratio and
 * becomes a ranking; that is exactly why the amount must sit inside the bar and be readable, and
 * why the floor is measured FROM that text instead of guessed at a round number.
 */

export interface StaircaseRow {
  id: string;
  name: string;
  /** Already formatted — the component measures the very string it will draw. */
  amountHe: string;
  value: number;
  color: string;
  /** Rides at the end of the row, outside the bar (a delta, a charge count). */
  tail?: ReactNode;
  /** Renders the leading history button when given. */
  onOpen?: () => void;
  openLabel?: string;
}

/** Padding + gap a bar spends on chrome before any glyph — must match `.stair-bar` in the CSS.
 *  The extra 8 covers what canvas cannot see: `font-variant-numeric: tabular-nums` changes digit
 *  advance widths, and a floor that is right to the pixel is a floor that clips. */
const BAR_CHROME_PX = 12 + 12 + 16 + 8;

/**
 * A name may not eat the whole track.
 *
 * The floor exists so the shortest bar can still be read — but a floor measured from the LONGEST
 * name is set by one row, and one long name flattens the staircase for everyone. Real merchant
 * names are not curated category words: "נמשך מכרטיס המסתיים ב- במכשיר הפועלים סניף 411" alone
 * pushes the floor near 60%, and above that the bars stop ranking and become a block.
 *
 * So the floor is capped, and past the cap the **name** yields — it ellipsizes, and hover gives it
 * back. The **amount never yields**: it is the truth of the bar, and a cut number is worth nothing.
 * That order is the whole rule.
 *
 * 40%: under the 41.8% the categories card measured for itself at the width it was first judged
 * good at, so the cap can only ever make a staircase steeper than one already approved.
 */
const MAX_FLOOR_PCT = 40;
/** What a capped floor still owes the name: enough to recognise it, not enough to read it out. */
const NAME_STUB_PX = 56;

/**
 * The measured floor, as a % of the track.
 *
 * Measured, never guessed: a hard-coded 30% stops being true the moment the window narrows or a
 * longer name appears. Re-measured on every width change — these cards live in a fluid grid.
 */
function useBarFloor(rows: StaircaseRow[]) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [floorPct, setFloorPct] = useState(0);
  /** The floor wants more room than the track has (a very narrow window) — the text moves outside
   *  the bar rather than being clipped. A cut number is worse than a plain one. */
  const [outside, setOutside] = useState(false);

  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el || rows.length === 0) return;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;

    const measure = () => {
      const w = el.clientWidth;
      if (!w) return;
      const cs = getComputedStyle(el);
      let need = 0;    // the widest row, whole: name + amount
      let needSum = 0; // the widest amount alone — this one is not negotiable
      for (const r of rows) {
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const wName = ctx.measureText(r.name).width;
        ctx.font = `700 ${cs.fontSize} ${cs.fontFamily}`; // .stair-sum is bolder than the row
        const wSum = ctx.measureText(r.amountHe).width;
        need = Math.max(need, wName + wSum);
        needSum = Math.max(needSum, wSum);
      }
      const whole = ((need + BAR_CHROME_PX) / w) * 100;
      const nonNegotiable = ((needSum + NAME_STUB_PX + BAR_CHROME_PX) / w) * 100;
      // Never inflate past what the text actually needs (`whole`); inside that, hold the cap —
      // unless the amount itself wants more room than the cap allows, and then it wins.
      const pct = Math.min(whole, Math.max(MAX_FLOOR_PCT, nonNegotiable));
      // Once the text steps outside, the bar carries no text — so it owes it no floor either, and
      // goes back to being a true proportion. Clamping to 100 instead drew every bar full width:
      // eight different numbers, one identical block, which is the one thing a bar may never do.
      setOutside(pct > 100);
      setFloorPct(pct > 100 ? 0 : pct);
    };
    measure();
    // Both, on purpose: the observer catches the card changing width on its own (a sibling card
    // growing, the grid reflowing), while the window listener catches the common case even where
    // observer callbacks are throttled — a background or non-painting window never delivers them,
    // and a stale floor is a clipped number.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [rows]);

  return { trackRef, floorPct, outside };
}

export function Staircase({ rows, tailWidth = 54, reserveOpen }: {
  rows: StaircaseRow[];
  tailWidth?: number;
  /** Force the leading button column even when no row opens anything. Two staircases on one page
   *  must reserve the same chrome, or their tracks differ and their bars stop being comparable —
   *  the same lie as within a card, one card up. */
  reserveOpen?: boolean;
}) {
  const { trackRef, floorPct, outside } = useBarFloor(rows);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const span = Math.max(0, 100 - floorPct);
  // All rows must be measured against the SAME track. If any row opens something, every row keeps
  // the button's width — otherwise a row without a door draws a wider track, and a smaller number
  // draws a longer bar than a bigger one. The whole staircase would be lying.
  const anyOpen = reserveOpen || rows.some((r) => r.onOpen);

  return (
    <ul className={outside ? 'stair outside' : 'stair'}>
      {rows.map((r, i) => (
        <li key={r.id} className="stair-row">
          {anyOpen && (r.onOpen ? (
            <button
              type="button"
              className="stair-btn"
              aria-label={r.openLabel ?? r.name}
              title={r.openLabel ?? r.name}
              onClick={r.onOpen}
            ><History size={15} strokeWidth={2} aria-hidden /></button>
          ) : (
            <span className="stair-btn empty" aria-hidden />
          ))}
          <div className="stair-track" ref={i === 0 ? trackRef : undefined}>
            <div
              className="stair-bar"
              style={{ width: `${floorPct + (r.value / max) * span}%`, '--bar': r.color } as CSSProperties}
            >
              {!outside && (
                <>
                  {/* a name the cap shortened is recoverable on hover — the amount never is cut */}
                  <span className="stair-name" title={r.name}>{r.name}</span>
                  <span className="stair-sum">{r.amountHe}</span>
                </>
              )}
            </div>
            {outside && (
              <span className="stair-aside">
                {r.name} · <span className="num">{r.amountHe}</span>
              </span>
            )}
          </div>
          {/* the slot is always there, filled or empty: a missing tail must not widen that row's
              track, or its bar would be drawn on a different scale than its neighbours */}
          <span className="stair-tail" style={{ width: tailWidth }}>{r.tail}</span>
        </li>
      ))}
    </ul>
  );
}
