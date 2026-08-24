/**
 * עמוד לשותף — the month, on one shareable page.
 *
 * Family finance is a conversation between two people, but the app speaks only to whoever
 * operates it. This poster is the bridge: one beautiful, self-contained picture of the month
 * — copy it into WhatsApp or save it as PNG, and the household shares one language.
 *
 * Built as a hand-drawn SVG (the app's native medium) with every style inline, so it
 * rasterizes standalone. The brand webfonts are embedded as data-URIs at export time;
 * if that fails the system falls back to Segoe UI and the poster still ships.
 */
import { Copy, ImageDown, Share2, X } from 'lucide-react';
import { useRef, useState } from 'react';

export interface PosterData {
  month: string; // YYYY-MM
  income: number;
  expenses: number;
  net: number;
  categories: { category: string; expenses: number }[];
  /** The running month — captioned honestly as a mid-month snapshot. */
  partial: boolean;
}

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

function monthLabelHe(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

/* The poster is ALWAYS the light brand look — a shared artifact renders on strangers' screens,
   not inside the sender's theme. */
const INK = '#17131f';
const MUTED = '#6b6675';
const POSITIVE = '#248a3d';
const NEGATIVE = '#d70015';
const ACCENT = '#5b2be0';
const AMBER = '#db8a00';
const HAIRLINE = '#e8e3f0';
const METER_BG = '#efeaf8';
const FONT = "'Assistant', 'Segoe UI', system-ui, sans-serif";
const FONT_DISPLAY = "'Rubik', 'Segoe UI', system-ui, sans-serif";

/* Poster-owned light palette — categoryColor() speaks CSS vars, which a standalone SVG cannot. */
const CAT_HEX: Record<string, string> = {
  groceries: '#0e9370', restaurants: '#d9730d', transport: '#0071e3', housing: '#5b58d8',
  bills: '#b08800', health: '#d30f45', shopping: '#b23aa6', leisure: '#0090ab',
  education: '#66980a', insurance: '#9a7100', transfers: '#6e6e73', fees: '#d70015',
  income: '#1f7a35', other: '#74747a', uncategorized: '#5d6470',
};
const catHex = (id: string) => CAT_HEX[id] ?? '#74747a';

const W = 540;
const CARD_X = 26;
const CARD_W = 488;
const LEFT = 58; // inner content edges
const RIGHT = 484;

/** The poster SVG. Pure layout math — sections stack, height follows content. */
export function MonthPoster({ data, categoryNameHe, svgRef }: {
  data: PosterData;
  categoryNameHe: (id: string) => string;
  svgRef: React.Ref<SVGSVGElement>;
}) {
  const cats = data.categories.filter((c) => c.expenses > 0).slice(0, 5);
  const maxCat = Math.max(1, ...cats.map((c) => c.expenses));
  const maxFlow = Math.max(1, data.income, data.expenses);

  // ── stack the sections ─────────────────────────────────────────────────────────────────
  const y0 = 30; // card top
  let y = y0 + 96; // after header row + month title baseline
  const monthTitleY = y0 + 78;
  const partialY = y0 + 100;
  if (data.partial) y += 20;
  const netLabelY = y + 26;
  const netY = netLabelY + 52;
  const flowSubY = netY + 34;
  y = flowSubY + 26; // start of in/out bars
  const barRow = (i: number) => y + i * 34;
  let yAfterBars = barRow(2) + 2;
  const catsTop = yAfterBars + 20;
  const catRowH = 32;
  const catsH = cats.length > 0 ? 40 + cats.length * catRowH : 0;
  const footerY = catsTop + catsH + 26;
  const cardH = footerY + 34 - y0;
  const H = y0 + cardH + 28;

  const flowBar = (value: number) => Math.max(3, (value / maxFlow) * 210);

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg" role="img"
      aria-label={`סיכום ${monthLabelHe(data.month)}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="poster-bg" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ece5fb" />
          <stop offset="1" stopColor="#faf7ff" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={W} height={H} fill="url(#poster-bg)" />
      <rect x={CARD_X} y={y0} width={CARD_W} height={cardH} rx="26" fill="#ffffff" stroke={HAIRLINE} />

      {/* ── the brand mark: the frame that never fully closes, its sun in the gap ── */}
      <g transform={`translate(${RIGHT - 26}, ${y0 + 18})`}>
        <rect x="0" y="0" width="26" height="26" rx="8" fill="none" stroke={ACCENT} strokeWidth="4.6"
          strokeLinecap="round" pathLength={100} strokeDasharray="86 14" />
        <circle cx="2" cy="2" r="3.4" fill={AMBER} />
      </g>
      <text x={RIGHT - 36} y={y0 + 37} textAnchor="end" fontFamily={FONT_DISPLAY} fontSize="19" fontWeight="700" fill={ACCENT}>מסגרת</text>
      <text x={LEFT} y={y0 + 37} textAnchor="start" fontFamily={FONT} fontSize="13" fill={MUTED}>העמוד החודשי של הבית</text>

      <text x={W / 2} y={monthTitleY} textAnchor="middle" fontFamily={FONT_DISPLAY} fontSize="29" fontWeight="800" fill={INK}>
        {monthLabelHe(data.month)}
      </text>
      {data.partial && (
        <text x={W / 2} y={partialY} textAnchor="middle" fontFamily={FONT} fontSize="13.5" fill={MUTED}>
          תמונת ביניים — החודש עוד רץ
        </text>
      )}

      {/* ── the bottom line ── */}
      <text x={W / 2} y={netLabelY} textAnchor="middle" fontFamily={FONT} fontSize="15" fill={MUTED}>
        {/* a running month has an עודף, never a "נשאר ביד": the rent may not have moved yet,
            and a poster shared with a partner must not read as money available to spend */}
        {data.partial ? 'עודף עד כה' : 'נשאר ביד החודש'}
      </text>
      <text x={W / 2} y={netY} textAnchor="middle" fontFamily={FONT_DISPLAY} fontSize="44" fontWeight="800"
        fill={data.net >= 0 ? POSITIVE : NEGATIVE}>
        {ILS0.format(data.net)}
      </text>

      {/* ── in vs out, as two honest bars ── */}
      {[
        { label: 'נכנסו', value: data.income, color: POSITIVE },
        { label: 'יצאו', value: data.expenses, color: NEGATIVE },
      ].map((row, i) => (
        <g key={row.label}>
          <text x={RIGHT} y={barRow(i) + 12} textAnchor="end" fontFamily={FONT} fontSize="15" fill={INK}>{row.label}</text>
          <rect x={418 - flowBar(row.value)} y={barRow(i) + 1} width={flowBar(row.value)} height="13" rx="6.5"
            fill={row.color} opacity="0.88" />
          <text x={LEFT} y={barRow(i) + 12} textAnchor="start" fontFamily={FONT} fontSize="15" fontWeight="700" fill={INK}>
            {ILS0.format(row.value)}
          </text>
        </g>
      ))}

      {/* ── where the money went ── */}
      {cats.length > 0 && (
        <g>
          <line x1={LEFT} x2={RIGHT} y1={catsTop} y2={catsTop} stroke={HAIRLINE} />
          <text x={RIGHT} y={catsTop + 30} textAnchor="end" fontFamily={FONT} fontSize="16" fontWeight="700" fill={INK}>
            לאן הלך הכסף
          </text>
          {cats.map((c, i) => {
            const rowY = catsTop + 40 + i * catRowH + 16;
            const barLen = Math.max(3, (c.expenses / maxCat) * 150);
            return (
              <g key={c.category}>
                <circle cx={RIGHT - 5} cy={rowY - 5} r="5" fill={catHex(c.category)} />
                <text x={RIGHT - 18} y={rowY} textAnchor="end" fontFamily={FONT} fontSize="14.5" fill={INK}>
                  {categoryNameHe(c.category)}
                </text>
                <rect x={340 - barLen} y={rowY - 10} width={barLen} height="11" rx="5.5"
                  fill={catHex(c.category)} opacity="0.75" />
                <text x={LEFT} y={rowY} textAnchor="start" fontFamily={FONT} fontSize="14.5" fontWeight="700" fill={INK}>
                  {ILS0.format(c.expenses)}
                </text>
              </g>
            );
          })}
        </g>
      )}

      {/* ── the quiet signature ── */}
      <line x1={LEFT} x2={RIGHT} y1={footerY} y2={footerY} stroke={HAIRLINE} />
      <text x={W / 2} y={footerY + 22} textAnchor="middle" fontFamily={FONT} fontSize="12.5" fill={MUTED}>
        הופק במסגרת · הנתונים נשארים במחשב שלכם
      </text>
    </svg>
  );
}

/* ——— rasterization: SVG → PNG, with the brand fonts embedded ——— */

/** The bundled @font-face rules we care about, re-issued with data-URI sources so the
 *  standalone SVG carries its own typography. Failure returns '' — Segoe UI fallback. */
async function embeddedFontCss(): Promise<string> {
  const WANTED: Record<string, number[]> = { Assistant: [400, 700], Rubik: [700, 800] };
  const out: string[] = [];
  try {
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet — not ours
      }
      for (const rule of [...rules]) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
        const weight = Number(rule.style.getPropertyValue('font-weight') || '400');
        if (!WANTED[family]?.includes(weight)) continue;
        const range = rule.style.getPropertyValue('unicode-range');
        // only the scripts the poster prints — hebrew + latin keep the payload small
        if (range && !/0?590|0?5D0|0-7F|000-/i.test(range)) continue;
        const src = rule.style.getPropertyValue('src');
        const m = /url\(["']?([^"')]+\.woff2[^"')]*)["']?\)/i.exec(src) ?? /url\(["']?([^"')]+)["']?\)/i.exec(src);
        if (!m) continue;
        const url = new URL(m[1], sheet.href ?? document.baseURI).href;
        const blob = await (await fetch(url)).blob();
        const dataUri = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result as string);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        out.push(
          `@font-face{font-family:'${family}';font-weight:${weight};src:url(${dataUri}) format('woff2');${range ? `unicode-range:${range};` : ''}}`,
        );
      }
    }
  } catch {
    return '';
  }
  return out.join('\n');
}

export async function posterToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.removeAttribute('style');
  const fontCss = await embeddedFontCss();
  if (fontCss) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = fontCss;
    clone.insertBefore(style, clone.firstChild);
  }
  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('poster image failed to load'));
      img.src = url;
    });
    const vb = svg.viewBox.baseVal;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vb.width * scale);
    canvas.height = Math.round(vb.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ——— the modal: preview + copy + save ——— */

export function PosterModal({ data, categoryNameHe, onClose }: {
  data: PosterData;
  categoryNameHe: (id: string) => string;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function copyPng() {
    if (!svgRef.current) return;
    setBusy(true);
    setNote(null);
    try {
      const blob = await posterToPngBlob(svgRef.current);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setNote('הועתק — אפשר להדביק בוואטסאפ');
    } catch {
      setNote('ההעתקה לא הצליחה — נסו "שמירה כתמונה"');
    } finally {
      setBusy(false);
    }
  }

  async function savePng() {
    if (!svgRef.current) return;
    setBusy(true);
    setNote(null);
    try {
      const blob = await posterToPngBlob(svgRef.current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `מסגרת-${data.month}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNote('נשמר');
    } catch {
      setNote('השמירה לא הצליחה. נסו שוב.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal poster-modal" role="dialog" aria-modal="true" aria-label="עמוד לשותף" onClick={(e) => e.stopPropagation()}>
        <div className="poster-head">
          <span className="poster-title"><Share2 size={17} strokeWidth={2.2} className="ic" aria-hidden /> עמוד לשותף</span>
          <button className="link" onClick={onClose} aria-label="סגירה"><X size={18} strokeWidth={2.2} /></button>
        </div>
        <p className="poster-sub">החודש בעמוד אחד — למי שמנהל איתך את הבית. העתקה, הדבקה בוואטסאפ, וזהו.</p>
        <div className="poster-preview">
          <MonthPoster data={data} categoryNameHe={categoryNameHe} svgRef={svgRef} />
        </div>
        <div className="poster-actions">
          <button className="primary" onClick={copyPng} disabled={busy}>
            <Copy size={15} strokeWidth={2.2} className="ic" aria-hidden /> העתקה לשיתוף
          </button>
          <button onClick={savePng} disabled={busy}>
            <ImageDown size={15} strokeWidth={2.2} className="ic" aria-hidden /> שמירה כתמונה
          </button>
          {note && <span className="poster-note">{note}</span>}
        </div>
      </div>
    </div>
  );
}
