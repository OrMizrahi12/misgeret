import {
  Banknote, Bitcoin, Briefcase, Car, ClipboardPaste, Coins, CreditCard, Eye, Gem, Home, Info,
  KeyRound, Landmark, Plus, RefreshCw, Shapes, TrendingUp, TriangleAlert,
  Umbrella, Wrench, type LucideIcon,
} from 'lucide-react';
import { CardChip } from './CardChip';
import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Amount } from './Amount';
import { api, errorMessageHe } from './api';
import { Donut, LineAreaChart, Sparkline, type DonutItem } from './charts';
import { desktop } from './desktop';
import { Explain, ExplainH, Formula } from './Explain';
import {
  HOLDING_TYPES, holdingTypeMeta,
  type AccountStateApplyRow, type AccountStateLine, type AccountStatePreviewResponse, type AccountStatePreviewRow,
  type ApplicableLine, type ApplyAction, type Asset, type CurrencyInfo, type HoldingType,
  type NetWorthAttributionMonth, type NetWorthResponse,
} from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

/* any-currency formatters, cached: whole units for text lines, exact for raw foreign amounts */
const FMT0 = new Map<string, Intl.NumberFormat>([['ILS', ILS0]]);
function money0(currency: string): Intl.NumberFormat {
  let f = FMT0.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 0 });
    FMT0.set(currency, f);
  }
  return f;
}
const FMT2 = new Map<string, Intl.NumberFormat>();
function money2(currency: string): Intl.NumberFormat {
  let f = FMT2.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('he-IL', { style: 'currency', currency, maximumFractionDigits: 2 });
    FMT2.set(currency, f);
  }
  return f;
}

/** The history window is the tab's own, like overview/health — N flow months, 0 = everything. */
const MONTHS_KEY = 'misgeret-networth-months';
const MONTH_CHOICES: { value: number; label: string }[] = [
  { value: 3, label: '3ח' },
  { value: 6, label: '6ח' },
  { value: 12, label: 'שנה' },
  { value: 0, label: 'הכל' },
];

/** A manual balance is a fact with a decay rate, so the panel says its age in words: an ISO date
 *  tells you nothing about rot, "לפני חודש" tells you everything. */
function agoHe(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  if (days < 14) return 'לפני שבוע';
  if (days < 31) return `לפני ${Math.round(days / 7)} שבועות`;
  if (days < 61) return 'לפני חודש';
  if (days < 365) return `לפני ${Math.round(days / 30)} חודשים`;
  const years = Math.floor(days / 365);
  return years === 1 ? 'לפני שנה' : years === 2 ? 'לפני שנתיים' : `לפני ${years} שנים`;
}

function monthHe(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** `kind` is the arithmetic truth and is derived from `type`; only 'other' asks the user (A7). */
function kindForType(type: HoldingType, fallback: 'asset' | 'liability'): 'asset' | 'liability' {
  return type === 'loan' || type === 'mortgage' ? 'liability' : type === 'other' ? fallback : 'asset';
}

/** The bank prints a debt as a positive magnitude; the panel prints what it does to your net worth.
 *  Everything here is semantics — a loan is a debt whether or not the bank printed a minus — which
 *  is exactly why `checking` is absent: its sign is *data* (see `pastedValue`). */
function displaySign(line: AccountStateLine): 1 | -1 {
  return line === 'loan' || line === 'card' ? -1 : 1;
}

/** What the paste said, in the panel's convention. `checking` is the one line whose sign the bank
 *  alone knows: an overdrafted עו"ש is the norm in Israel, it is not a holding so no `kind` carries
 *  its sign, and hardcoding `+1` printed a phantom disagreement on the one row whose whole job is
 *  to prove the paste was understood. */
function pastedValue(row: AccountStatePreviewRow): number {
  const magnitude = Math.abs(row.amount);
  return row.line === 'checking' ? magnitude * row.printedSign : magnitude * displaySign(row.line);
}

const APPLICABLE_LINES = ['deposit', 'loan', 'securities'] as const;
function isApplicableLine(line: AccountStateLine): line is ApplicableLine {
  return (APPLICABLE_LINES as readonly string[]).includes(line);
}
function isApplyAction(action: string): action is ApplyAction {
  return action === 'create' || action === 'update' || action === 'unchanged';
}

/** Scraped rows carry sync freshness — when the bank/card figure was last pulled. */
function syncedHe(data: NetWorthResponse, kind: 'bank' | 'card'): string | null {
  const at = data.accounts.filter((a) => a.kind === kind).map((a) => a.takenAt).sort().at(-1);
  return at ? `סונכרן ${agoHe(at)}` : null;
}

/* ——— the typed add/edit form ——— */

interface AssetDraft {
  name: string;
  type: HoldingType;
  /** Only consulted when type === 'other' — every other type derives its kind. */
  kind: 'asset' | 'liability';
  amount: string;
  currency: string;
  institution: string;
  monthlyPayment: string;
  liquid: boolean;
}

const EMPTY_DRAFT: AssetDraft = {
  name: '', type: 'other', kind: 'asset', amount: '', currency: 'ILS', institution: '', monthlyPayment: '', liquid: false,
};

/** Picking a type teaches the draft that type's defaults: a suggested name (only over an
 *  empty or previously-suggested one — never over something the user typed), the liquidity
 *  default, and whether a monthly payment even applies. */
function draftForType(draft: AssetDraft, type: HoldingType): AssetDraft {
  const meta = holdingTypeMeta(type);
  const nameWasSuggested =
    draft.name === '' || HOLDING_TYPES.some((t) => t.defaultName !== '' && t.defaultName === draft.name);
  return {
    ...draft,
    type,
    name: nameWasSuggested ? meta.defaultName : draft.name,
    liquid: type === 'other' ? draft.liquid : meta.liquidDefault,
    monthlyPayment: meta.hasPayment ? draft.monthlyPayment : '',
  };
}

/** One glyph per holding type — the visual anchor in the type picker, the header strip and
 *  (implicitly) the class it belongs to. Mirrors the lucide vocabulary the rest of the app uses. */
const TYPE_ICON: Record<HoldingType, LucideIcon> = {
  deposit: Landmark,
  securities: TrendingUp,
  pension: Umbrella,
  realEstate: Home,
  vehicle: Car,
  crypto: Bitcoin,
  business: Briefcase,
  valuable: Gem,
  loan: Banknote,
  mortgage: KeyRound,
  other: Shapes,
};

/** The class color of a type — the same palette the donut, the sheet and the history share, so the
 *  form paints a new holding in exactly the color it will wear in the balance sheet. `other` is the
 *  one type whose side is the user's, so its color follows the chosen kind. */
function typeColor(type: HoldingType, kind: 'asset' | 'liability'): string {
  if (type === 'loan' || type === 'mortgage') return 'var(--negative)';
  if (type === 'deposit') return 'var(--positive)';
  if (type === 'securities') return 'var(--cat-violet)';
  if (type === 'pension') return 'var(--cat-magenta)';
  if (type === 'realEstate') return 'var(--cat-pink)';
  if (type === 'other') return kind === 'liability' ? 'var(--negative)' : 'var(--cat-slate)';
  return 'var(--cat-orange)';
}

/** The typed add/edit form — the full personal-balance-sheet taxonomy, each type speaking
 *  its own language (per-type value word, context word, hints) via HOLDING_TYPES metadata. */
function AssetForm({ draft, setDraft, onSubmit, onCancel, busy, submitLabel, currencies }: {
  draft: AssetDraft;
  setDraft: (d: AssetDraft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  busy: boolean;
  submitLabel: string;
  currencies: CurrencyInfo[];
}) {
  const meta = holdingTypeMeta(draft.type);
  const kind = kindForType(draft.type, draft.kind);
  const assetTypes = HOLDING_TYPES.filter((t) => t.side === 'asset');
  const liabilityTypes = HOLDING_TYPES.filter((t) => t.side === 'liability');
  const otherType = HOLDING_TYPES.find((t) => t.id === 'other')!;
  const liabilityChips = [...liabilityTypes, otherType];
  const tc = typeColor(draft.type, kind);
  const StripIcon = TYPE_ICON[draft.type];
  const amt = Number(draft.amount);
  const hasAmt = draft.amount.trim() !== '' && Number.isFinite(amt) && amt >= 0;
  const previewName = draft.name.trim() || meta.defaultName || 'שם ההחזקה';
  const chip = (t: typeof HOLDING_TYPES[number], color: string) => {
    const Icon = TYPE_ICON[t.id];
    const on = draft.type === t.id;
    return (
      <button
        type="button"
        key={t.id}
        className={on ? 'tp-chip on' : 'tp-chip'}
        style={{ '--tc': color } as CSSProperties}
        onClick={() => setDraft(draftForType(draft, t.id))}
        aria-pressed={on}
      >
        <span className="tp-chip-ic"><Icon size={18} strokeWidth={2} aria-hidden /></span>
        <span className="tp-chip-name">{t.nameHe}</span>
      </button>
    );
  };
  return (
    <div onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') onSubmit(); }}>
      {/* בורר סוג ויזואלי — הצבע, האייקון והצד נגזרים מהסוג עצמו */}
      <div className="tp-group">
        <div className="tp-group-label">נכסים</div>
        <div className="tp-grid">{assetTypes.map((t) => chip(t, typeColor(t.id, 'asset')))}</div>
      </div>
      <div className="tp-group">
        <div className="tp-group-label">התחייבויות</div>
        <div className="tp-grid">{liabilityChips.map((t) => chip(t, typeColor(t.id, t.id === 'other' ? draft.kind : 'liability')))}</div>
      </div>
      {/* רצועת הסוג הנבחר — נצבעת בצבע המחלקה, אומרת מיד לאיזה צד במאזן זה הולך */}
      <div className="tp-strip" style={{ '--tc': tc } as CSSProperties}>
        <span className="tp-strip-ic"><StripIcon size={21} strokeWidth={2} aria-hidden /></span>
        <div>
          <div className="tp-strip-name">{meta.nameHe}</div>
          <div className="tp-strip-side" style={{ color: kind === 'liability' ? 'var(--negative-deep)' : 'var(--positive-deep)' }}>
            {kind === 'liability' ? 'התחייבות · מפחיתה מההון' : 'נכס · מוסיף להון'}
          </div>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <span className="field-label">שם</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={meta.defaultName || 'שם ההחזקה'}
            autoComplete="off"
            aria-label="שם ההחזקה"
          />
          <p className="field-hint">כך זה יופיע במאזן ובגרפים.</p>
        </div>
        {draft.type === 'other' && (
          <div className="field">
            <span className="field-label">נכס או התחייבות?</span>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'asset' | 'liability' })}>
              <option value="asset">נכס — מוסיף להון</option>
              <option value="liability">התחייבות — מפחיתה מההון</option>
            </select>
            <p className="field-hint">רק "אחר" שואל — לכל סוג אחר הצד נגזר מהסוג עצמו.</p>
          </div>
        )}
        <div className="field">
          <span className="field-label">{meta.amountLabelHe}</span>
          <input
            dir="ltr"
            inputMode="decimal"
            style={{ textAlign: 'end' }}
            value={draft.amount}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            placeholder="0"
            aria-label={meta.amountLabelHe}
          />
          <p className="field-hint">{meta.amountHintHe} תמיד בלי מינוס — הסוג קובע את הסימן.</p>
        </div>
        <div className="field">
          <span className="field-label">מטבע</span>
          <select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
            {(currencies.length > 0 ? currencies : [{ code: 'ILS', nameHe: 'שקל חדש', symbol: '₪' }]).map((c) => (
              <option key={c.code} value={c.code}>{c.symbol} {c.nameHe}</option>
            ))}
          </select>
          <p className="field-hint">חיסכון בפייפל נרשם בדולרים — ההמרה לשקלים בשער עדכני, אוטומטית.</p>
        </div>
        <div className="field">
          <span className="field-label">{meta.contextLabelHe} <span className="opt">רשות</span></span>
          <input
            value={draft.institution}
            onChange={(e) => setDraft({ ...draft, institution: e.target.value })}
            autoComplete="off"
            aria-label={meta.contextLabelHe}
          />
          <p className="field-hint">מופיע כתגית ליד השורה במאזן — עוזר להבדיל בין החזקות דומות.</p>
        </div>
        {meta.hasPayment && (
          <div className="field">
            <span className="field-label">החזר חודשי <span className="opt">רשות</span></span>
            <input
              dir="ltr"
              inputMode="decimal"
              style={{ textAlign: 'end' }}
              value={draft.monthlyPayment}
              onChange={(e) => setDraft({ ...draft, monthlyPayment: e.target.value })}
              aria-label="החזר חודשי"
            />
            <p className="field-hint">לתצוגה בלבד — ההחזר כבר מופיע כתנועה בבנק, וחישוב כפול היה מנפח את התחזית.</p>
          </div>
        )}
        {kind === 'asset' && (
          <div className="field">
            <span className="field-label">נזילות</span>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 7, display: 'flex', fontSize: 15, color: 'var(--ink)' }}>
              <input type="checkbox" checked={draft.liquid} onChange={(e) => setDraft({ ...draft, liquid: e.target.checked })} />
              ניתן למימוש מהיר (נזיל)
            </label>
            <p className="field-hint">נכס נזיל נספר בכרית החירום בטאב הבריאות — פיקדון שניתן לשבירה כן, דירה לא.</p>
          </div>
        )}
      </div>
      {/* תצוגה מקדימה חיה — בדיוק איך ההחזקה תיראה במאזן, לפני שנשמרה */}
      <div className="tp-preview">
        <div className="tp-preview-cap"><Eye size={15} strokeWidth={2} aria-hidden /> כך זה יופיע במאזן</div>
        <div className="tp-preview-row">
          <span className="legend-dot bsr-dot" style={{ background: tc }} />
          <span className="tp-preview-name">{previewName}</span>
          {draft.institution.trim() && <span className="tag">{draft.institution.trim()}</span>}
          {kind === 'asset' && draft.liquid && <span className="tag good">נזיל</span>}
          {draft.type === 'loan' && draft.monthlyPayment.trim() && <span className="tag">החזר {draft.monthlyPayment}/ח׳</span>}
          <span style={{ flex: 1 }} />
          {hasAmt
            ? <Amount value={kind === 'liability' ? -Math.abs(amt) : Math.abs(amt)} tone={kind === 'liability' ? 'negative' : undefined} currency={draft.currency} />
            : <span className="muted">— {meta.amountLabelHe}</span>}
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" onClick={onSubmit} disabled={busy}>{busy ? 'שומר…' : submitLabel}</button>
        {onCancel && <button className="link" onClick={onCancel}>ביטול</button>}
      </div>
    </div>
  );
}

/* ——— הדבקת מצב חשבון: paste → preview → review → apply ——— */

function PasteReview({ preview, chosen, toggle, onApply, onCancel, busy, error }: {
  preview: AccountStatePreviewResponse;
  chosen: Set<number>;
  toggle: (i: number) => void;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  /** The server sends `current` signed for the two scraped lines (a real overdraft is negative) and
   *  as a magnitude for the three holding lines, which is what `assets.amount` is. Normalize both
   *  to what the panel prints — the pasted and the held number are allowed to differ visibly (A1). */
  const currentFor = (row: AccountStatePreviewRow): number | null =>
    row.current === null ? null
      : isApplicableLine(row.line) ? Math.abs(row.current) * displaySign(row.line)
        : row.current;

  const status = (row: AccountStatePreviewRow) => {
    if (row.action === 'readonly') return <span className="tag">לקריאה בלבד</span>;
    if (row.action === 'ambiguous') return <span className="tag warn">לא ניתן להחליט</span>;
    if (row.action === 'create') return <span className="tag good">חדש</span>;
    if (row.action === 'unchanged') return <span className="tag">ללא שינוי · יאושר מחדש</span>;
    return <span className="tag good">עדכון</span>;
  };

  const reason = (row: AccountStatePreviewRow): string | null => {
    if (row.noteHe) return row.noteHe;
    if (row.action === 'readonly') return 'נמשך מהבנק אוטומטית — מוצג כדי להוכיח שההדבקה הובנה, ולעולם לא נכתב.';
    if (row.action === 'ambiguous') return 'יש יותר מהחזקה אחת מהסוג הזה, ומסגרת לא מנחשת לאיזו מהן המספר מתייחס. עדכן אותה ידנית במאזן למעלה.';
    if (row.action === 'unchanged') return 'המספר זהה למה שכבר רשום — האישור רק מעדכן את תאריך הבדיקה האחרונה.';
    return null;
  };

  // The likeliest outcome of a first attempt: the wrong region of the page was swept, or a
  // rendering that carries no ₪ glyphs. An empty table under five headings says nothing about
  // what went wrong — and `ignored` reads 0 here however much text was discarded, because with no
  // label there is no summary to have read.
  if (preview.rows.length === 0) {
    return (
      <div style={{ marginTop: 14 }}>
        <p className="muted" style={{ margin: '0 0 8px', maxWidth: 640 }}>
          לא זוהתה אף שורה של מצב חשבון בטקסט הזה, ולכן לא נכתב שום מספר.
        </p>
        <p className="muted" style={{ margin: '0 0 8px', maxWidth: 640 }}>
          מסגרת מחפשת את התוויות <strong>יתרת עו"ש</strong>, <strong>כרטיסי אשראי</strong>,{' '}
          <strong>הלוואות</strong>, <strong>פקדונות וחסכונות</strong> ו־<strong>תיק ניירות ערך</strong>,
          כשאחרי כל אחת מהן מופיע סכום עם הסימן ₪ (למשל <span dir="ltr">₪45,678.90</span>). מספר בלי ₪
          אינו נחשב סכום — הוא יכול להיות מספר חשבון או תאריך.
        </p>
        <p className="muted" style={{ margin: '0 0 10px', maxWidth: 640 }}>
          סמן באתר הבנק את טבלת "מצב החשבון שלך" עצמה — כולל שמות השורות — והדבק שוב.
        </p>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button className="link" onClick={onCancel}>ביטול</button>
        </div>
      </div>
    );
  }

  // every row parsed, but all of them are the two read-only lines: the button below is disabled and
  // must say why rather than sit greyed out with no explanation
  const noneApplicable = !preview.rows.some((r) => isApplicableLine(r.line) && isApplyAction(r.action));

  return (
    <div style={{ marginTop: 14 }}>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        הובנו <strong>{preview.understood}</strong> שורות
        {preview.ignored > 0 && <> · {preview.ignored} שורות לא זוהו והמערכת התעלמה מהן</>}
        {' '}· שום מספר לא נכתב עד שתאשר כאן.
      </p>
      <div className="paste-table-wrap">
      <table className="summary">
        <thead>
          <tr>
            <th style={{ width: 44 }}>החל</th>
            <th>השורה בבנק</th>
            <th>מה שהודבק</th>
            <th>מה שרשום במסגרת</th>
            <th>סטטוס</th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, i) => {
            const applicable = isApplicableLine(row.line) && isApplyAction(row.action);
            const current = currentFor(row);
            const pasted = pastedValue(row);
            const why = reason(row);
            return (
              <tr key={`${row.line}|${i}`} className={applicable ? undefined : 'muted-txn'}>
                <td>
                  <input
                    type="checkbox"
                    checked={chosen.has(i)}
                    disabled={!applicable}
                    onChange={() => toggle(i)}
                    aria-label={`החלת ${row.labelHe}`}
                  />
                </td>
                <td>
                  {row.labelHe}
                  {why && <p className="state-note" style={{ margin: '3px 0 0' }}>{why}</p>}
                </td>
                <td><Amount value={pasted} tone={pasted < 0 ? 'negative' : undefined} /></td>
                <td>
                  {current === null
                    ? <span className="muted">אין נתון</span>
                    : <Amount value={current} tone={current < 0 ? 'negative' : undefined} />}
                </td>
                <td>{status(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {error && <p className="error" style={{ marginTop: 12 }} role="alert">{error}</p>}
      {noneApplicable && (
        <p className="muted" style={{ marginTop: 12, maxWidth: 640 }}>
          אין כאן שורה להחיל: עו"ש וכרטיסי אשראי נמשכים מהבנק אוטומטית ולעולם לא נכתבים מהדבקה. כדי
          לעדכן יתרות, הדבק גם את שורות ההלוואות, הפקדונות או ניירות הערך.
        </p>
      )}
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <button className="primary" onClick={onApply} disabled={busy || chosen.size === 0}>
          {busy ? 'שומר…' : `אישור והחלה (${chosen.size})`}
        </button>
        <button className="link" onClick={onCancel} disabled={busy}>ביטול</button>
      </div>
    </div>
  );
}

/* ——— the balance-sheet rows: one holding per row, class-grouped ——— */

/** Class labels and colors — one palette shared by the donut, the layered history and the sheet.
 *  Polarity law: assets wear green, liabilities red; every slice/layer is direct-labeled (spec §6). */
const CLASS_META = {
  checking: { label: 'עו״ש ומזומן', color: 'var(--accent)' },
  deposit: { label: 'פקדונות וחסכונות', color: 'var(--positive)' },
  securities: { label: 'שוק ההון', color: 'var(--cat-violet)' },
  pension: { label: 'פנסיה והשתלמות', color: 'var(--cat-magenta)' },
  realEstate: { label: 'נדל״ן', color: 'var(--cat-pink)' },
  otherAsset: { label: 'נכסים אחרים', color: 'var(--cat-orange)' },
  liabilities: { label: 'התחייבויות', color: 'var(--negative)' },
} as const;

export function NetWorth() {
  const [data, setData] = useState<NetWorthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [months, setMonths] = useState<number>(() => {
    const raw = localStorage.getItem(MONTHS_KEY);
    if (raw === null) return 12; // Number(null) is 0 — "הכל" — which must stay an explicit choice
    const stored = Number(raw);
    return MONTH_CHOICES.some((c) => c.value === stored) ? stored : 12;
  });

  // add / edit — lives in the maintenance zone; opening an edit opens the zone
  const [draft, setDraft] = useState<AssetDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [maintOpen, setMaintOpen] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // the sheet's inline "read the bank, type the new number" path
  const [inlineId, setInlineId] = useState<number | null>(null);
  const [inlineAmount, setInlineAmount] = useState('');

  // paste flow
  const [pasteOpen, setPasteOpen] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<AccountStatePreviewResponse | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [pasteBusy, setPasteBusy] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);

  async function load() {
    const [nw, ratesInfo] = await Promise.all([api.netWorth(), api.rates()]);
    setData(nw);
    setCurrencies(ratesInfo.currencies);
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessageHe(e)));
  }, []);

  useEffect(() => {
    localStorage.setItem(MONTHS_KEY, String(months));
  }, [months]);

  const hasDraft = draft.name.length > 0 || draft.amount.length > 0 || text.trim().length > 0 || inlineId !== null;
  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    void bridge.setUnsavedChanges(hasDraft).catch(() => {});
    return () => {
      if (hasDraft) void bridge.setUnsavedChanges(false).catch(() => {});
    };
  }, [hasDraft]);

  function parseDraft(): { amount: number; monthlyPayment: number | null } | null {
    const amount = Number(draft.amount);
    if (!draft.name.trim()) {
      setError('נדרש שם להחזקה.');
      return null;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setError('הסכום חייב להיות מספר אי-שלילי — הסוג קובע אם זה נכס או התחייבות, לא המינוס.');
      return null;
    }
    let monthlyPayment: number | null = null;
    if (draft.type === 'loan' && draft.monthlyPayment.trim() !== '') {
      const mp = Number(draft.monthlyPayment);
      if (!Number.isFinite(mp) || mp <= 0) {
        setError('ההחזר החודשי חייב להיות מספר חיובי.');
        return null;
      }
      monthlyPayment = mp;
    }
    return { amount, monthlyPayment };
  }

  async function submitDraft() {
    const parsed = parseDraft();
    if (!parsed) return;
    const kind = kindForType(draft.type, draft.kind);
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: draft.name.trim(),
        amount: parsed.amount,
        liquid: kind === 'asset' && draft.liquid,
        type: draft.type,
        institution: draft.institution.trim() || null,
        monthlyPayment: parsed.monthlyPayment,
        currency: draft.currency,
      };
      if (editingId !== null) await api.updateAsset(editingId, payload);
      else await api.addAsset({ ...payload, kind });
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(a: Asset) {
    setEditingId(a.id);
    setDraft({
      name: a.name,
      type: a.type,
      kind: a.kind,
      amount: String(a.amount),
      currency: a.currency,
      institution: a.institution ?? '',
      monthlyPayment: a.monthlyPayment !== null ? String(a.monthlyPayment) : '',
      liquid: a.liquid,
    });
    setMaintOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ block: 'center' }), 0);
  }

  /** An empty line offers to add rather than showing a bare 0, and hands the form the identity the
   *  paste would have created — so adding by hand and adding by paste converge on the same row. */
  function startAdd(type: HoldingType) {
    setEditingId(null);
    const meta = holdingTypeMeta(type);
    setDraft({
      ...EMPTY_DRAFT,
      type,
      name: meta.defaultName,
      liquid: meta.liquidDefault,
      // the three bank lines default to the bank; off-bank types have no obvious institution
      institution: type === 'deposit' || type === 'loan' || type === 'securities' ? 'בנק לאומי' : '',
    });
    setMaintOpen(true);
    setTimeout(() => formRef.current?.scrollIntoView({ block: 'center' }), 0);
  }

  /** The whole point of the feature in one control: read the bank, type the number, done.
   *  Sends the balance alone — name/liquid/institution are the user's and no edit here may touch them. */
  async function saveInline(a: Asset) {
    const value = Number(inlineAmount);
    if (!Number.isFinite(value) || value < 0) {
      setError('הסכום חייב להיות מספר אי-שלילי — הסוג קובע אם זו התחייבות, לא המינוס.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateAsset(a.id, { amount: value });
      setInlineId(null);
      setInlineAmount('');
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setError(null);
    try {
      await api.deleteAsset(id);
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  function closePaste() {
    setPasteOpen(false);
    setText('');
    setPreview(null);
    setChosen(new Set());
    setPasteError(null);
  }

  async function runPreview() {
    if (!text.trim()) return;
    setPasteBusy(true);
    setPasteError(null);
    setNotice(null);
    try {
      const res = await api.accountStatePreview(text);
      setPreview(res);
      // Every applicable row starts checked — including `unchanged`, because confirming a number
      // that did not change is exactly how a correct-but-old balance stops being nagged about (A11).
      setChosen(new Set(
        res.rows.flatMap((r, i) => (isApplicableLine(r.line) && isApplyAction(r.action) ? [i] : [])),
      ));
    } catch (e) {
      setPasteError(errorMessageHe(e));
    } finally {
      setPasteBusy(false);
    }
  }

  async function applyPaste() {
    if (!preview) return;
    const rows: AccountStateApplyRow[] = [];
    preview.rows.forEach((r, i) => {
      if (!chosen.has(i) || !isApplicableLine(r.line) || !isApplyAction(r.action)) return;
      // labelHe rides along so a created holding is named with the bank's own label, verbatim (A12)
      rows.push({ line: r.line, action: r.action, assetId: r.assetId, amount: Math.abs(r.amount), labelHe: r.labelHe });
    });
    if (rows.length === 0) return;
    setPasteBusy(true);
    setPasteError(null);
    try {
      const res = await api.accountStateApply(rows);
      closePaste();
      setNotice(
        `${res.applied} שורות הוחלו — נוצרו ${res.created}, עודכנו ${res.updated}, אושרו מחדש ${res.confirmed} ✓`,
      );
      await load();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setPasteBusy(false);
    }
  }

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">טוען…</p>;

  const { gross, attribution, history, layers, assetHistories } = data;
  /** Every converted figure in this tab speaks the primary currency the server answered in. */
  const ccy = data.currency;
  const nis = money0(ccy);
  const rateByCcy = new Map(data.rates.map((r) => [r.currency, r]));
  const foreignHeld = [...new Set(data.assets.filter((a) => a.currency !== 'ILS').map((a) => a.currency))];
  const blindCards = data.cardsMissingBalance;
  const byLine = new Map(data.accountState.rows.map((r) => [r.line, r]));
  const netBank = data.accountState.netBank;
  // The one thing that keeps `נטו בבנק` from reading as a contradiction of `שווי נקי`.
  const offBank = data.assets.filter((a) => a.type === 'other');

  /* ── the display window: the last N flow months, cut on real month boundaries ── */
  const windowRows: NetWorthAttributionMonth[] = months === 0 ? attribution : attribution.slice(-months);
  const fromDate = windowRows[0]?.from ?? history[0]?.date ?? '';
  const startIdx = Math.max(0, history.findIndex((p) => p.date >= fromDate));
  const shown = history.slice(startIdx);
  /** Where the reconstructed era ends inside the shown window (same convention as before). */
  const mutedBefore = (() => {
    if (data.manualFrom === null || shown.length < 2) return undefined;
    const i = shown.findIndex((p) => p.date >= data.manualFrom!);
    if (i === 0) return undefined;
    return i < 0 ? shown.length - 1 : i;
  })();

  /* ── window KPIs ── */
  const windowDelta = shown.length > 1 ? shown[shown.length - 1].balance - shown[0].balance : null;
  const monthlyPace = median(windowRows.filter((r) => !r.partial && r.open !== null && r.close !== null)
    .map((r) => r.close! - r.open!));
  const allTimeHigh = history.length > 0 ? Math.max(...history.map((p) => p.balance)) : null;
  const athIsNow = allTimeHigh !== null && history.length > 0 && history[history.length - 1].balance >= allTimeHigh - 0.005;

  /* ── this month's attribution (the hero line) ── */
  const current = attribution.length > 0 ? attribution[attribution.length - 1] : null;
  const currentDelta = current && current.open !== null && current.close !== null ? current.close - current.open : null;
  const currentFlows = current ? current.income - current.expenses : null;

  /* ── composition & liquidity ── */
  const depositAssets = data.assets.filter((a) => a.type === 'deposit');
  const securitiesAssets = data.assets.filter((a) => a.type === 'securities');
  const pensionAssets = data.assets.filter((a) => a.type === 'pension');
  const realEstateAssets = data.assets.filter((a) => a.type === 'realEstate');
  const loanAssets = data.assets.filter((a) => a.type === 'loan' || a.type === 'mortgage');
  const otherAssets = data.assets.filter(
    (a) => a.kind === 'asset' && ['vehicle', 'crypto', 'business', 'valuable', 'other'].includes(a.type),
  );
  const otherLiabilities = data.assets.filter((a) => a.type === 'other' && a.kind === 'liability');
  /** The asset composition in class order — one list feeds the mirror bars AND (value-sorted)
   *  the donut, so the two visuals can never tell different stories. Zero-value holdings are
   *  real rows in the sheet but draw no segment. */
  const composition: DonutItem[] = [
    ...(data.bankTotal > 0
      ? [{ id: 'checking', label: CLASS_META.checking.label, color: CLASS_META.checking.color, value: data.bankTotal }]
      : []),
    ...(depositAssets.length > 0 ? [{ id: 'deposit', label: CLASS_META.deposit.label, color: CLASS_META.deposit.color, value: depositAssets.reduce((s, a) => s + a.value, 0) }] : []),
    ...(securitiesAssets.length > 0 ? [{ id: 'securities', label: 'תיק ניירות ערך', color: CLASS_META.securities.color, value: securitiesAssets.reduce((s, a) => s + a.value, 0) }] : []),
    ...pensionAssets.map((a) => ({ id: `asset-${a.id}`, label: a.name, color: CLASS_META.pension.color, value: a.value })),
    ...realEstateAssets.map((a) => ({ id: `asset-${a.id}`, label: a.name, color: CLASS_META.realEstate.color, value: a.value })),
    ...otherAssets.map((a) => ({ id: `asset-${a.id}`, label: a.name, color: CLASS_META.otherAsset.color, value: a.value })),
  ].filter((it) => it.value > 0);
  const donutItems: DonutItem[] = [...composition].sort((a, b) => b.value - a.value);
  const liquidTotal = Math.max(0, data.bankTotal) + data.assets.filter((a) => a.kind === 'asset' && a.liquid).reduce((s, a) => s + a.value, 0);
  const lockedTotal = Math.max(0, gross.assets - liquidTotal);
  const liquidPct = gross.assets > 0 ? Math.round((liquidTotal / gross.assets) * 100) : null;
  const leveragePct = gross.assets > 0 ? (gross.liabilities / gross.assets) * 100 : null;

  const staleCount = data.assets.filter((a) => {
    const row = byLine.get(a.type as AccountStateLine);
    return row?.stale && row.assetId === a.id;
  }).length + data.accountState.rows.filter((r) => r.stale && r.holdingCount > 1).length;
  const cardRow = byLine.get('card');
  const loanRow = byLine.get('loan');

  /* ── the sheet: thin uniform list rows in the app's own .txn grammar. The VISUAL lives
        above them (the mirror bars); rows carry a class dot, one % figure on the shared
        base (סך הנכסים), and their actions — no scaffolding, no per-row bars ── */
  const fmtPct = (v: number) => (gross.assets > 0 ? Math.min(100, Math.round((Math.abs(v) / gross.assets) * 100)) : 0);
  const classColor = (a: Asset) =>
    a.kind === 'liability' ? 'var(--negative)'
      : a.type === 'deposit' ? CLASS_META.deposit.color
        : a.type === 'securities' ? CLASS_META.securities.color
          : a.type === 'pension' ? CLASS_META.pension.color
            : a.type === 'realEstate' ? CLASS_META.realEstate.color
              : CLASS_META.otherAsset.color;
  const sparkOf = (a: Asset) => {
    const series = assetHistories[a.id];
    if (!series || series.length < 2) return null;
    // the CONVERTED value trend — a flat dollar amount still moves in shekels when the rate does
    const values = series.map((p) => p.value);
    const improving = a.kind === 'liability' ? values[values.length - 1] < values[0] : values[values.length - 1] >= values[0];
    return <Sparkline values={values} color={improving ? 'var(--positive)' : a.kind === 'liability' ? 'var(--negative)' : 'var(--accent)'} />;
  };
  /** One holding, one thin line: dot · name · tags · sparkline · % · amount · actions.
   *  The loan's payoff bound rides as a hover title — it stays visible in תמונת החוב. */
  const holdingLi = (a: Asset & { value: number }) => {
    const liability = a.kind === 'liability';
    const row = byLine.get(a.type as AccountStateLine);
    const stale = row?.stale && (row.assetId === a.id || row.holdingCount > 1);
    const payoff = a.type === 'loan' && loanRow?.assetId === a.id ? loanRow.remainingPaymentsHe : null;
    const rate = a.currency !== 'ILS' ? rateByCcy.get(a.currency) : undefined;
    return (
      <Fragment key={a.id}>
        <li className="txn">
          <span className="legend-dot bsr-dot" style={{ background: classColor(a) }} />
          <span className="txn-desc" title={payoff ?? undefined}>
            {a.name}
            {a.currency !== 'ILS' && (
              <span
                className="tag good"
                title={rate ? `לפי שער ${rate.rate} ₪ ל־${a.currency}, עודכן ${agoHe(rate.fetchedAt)}` : 'אין שער — ההחזקה לא נספרת בהון'}
              >
                {money2(a.currency).format(a.amount)}
              </span>
            )}
            {a.institution && <span className="tag">{a.institution}</span>}
            {a.liquid && <span className="tag good" title="נספר בכרית החירום במסך הבריאות">נזיל</span>}
            {a.type === 'loan' && a.monthlyPayment !== null && <span className="tag">החזר {money0(a.currency).format(a.monthlyPayment)}/ח׳</span>}
            <span className={stale ? 'tag warn' : 'tag'} title={stale ? 'עבר יותר מדי זמן מאז העדכון האחרון — הערך כנראה כבר לא נכון' : undefined}>
              {stale ? 'דורש רענון' : `עודכן ${agoHe(a.updatedAt)}`}
            </span>
          </span>
          {sparkOf(a)}
          <span className="bs-pct">{fmtPct(a.value)}%</span>
          <Amount value={liability ? -a.value : a.value} tone={liability ? 'negative' : undefined} currency={ccy} />
          <button className="link" onClick={() => { setInlineId(a.id); setInlineAmount(String(a.amount)); }}>עדכון</button>
          <button className="link" onClick={() => startEdit(a)}>עריכה</button>
          <button className="link danger" onClick={() => void remove(a.id)}>הסרה</button>
        </li>
        {inlineId === a.id && (
          <li className="txn">
            <div className="state-inline" style={{ margin: 0 }}>
              <input
                dir="ltr"
                inputMode="decimal"
                autoFocus
                style={{ width: 130, textAlign: 'end' }}
                value={inlineAmount}
                onChange={(e) => setInlineAmount(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveInline(a); }}
                aria-label={`יתרה חדשה — ${a.name}`}
                title="הסכום כפי שהבנק מציג אותו, בלי מינוס"
              />
              <button className="primary" onClick={() => void saveInline(a)} disabled={busy}>שמירה</button>
              <button className="link" onClick={() => { setInlineId(null); setInlineAmount(''); }}>ביטול</button>
              <span className="muted">כל שינוי בסכום נשמר כנקודה בציר הזמן של ההחזקה.</span>
            </div>
          </li>
        )}
      </Fragment>
    );
  };
  /** A bank line we hold no number for: one quiet row — אין ≠ 0, without the scaffolding. */
  const missingLi = (line: ApplicableLine, label: string) => (
    <li className="txn" key={line}>
      <span className="legend-dot bsr-dot" style={{ background: 'var(--hairline-strong)' }} />
      <span className="txn-desc muted">{label} · אין נתון</span>
      <button className="link" onClick={() => startAdd(line)}>+ הוספה</button>
    </li>
  );
  const sumLi = (label: string, value: number, pct: number | null, tone?: 'negative') => (
    <li className="txn bs-sum">
      <span className="txn-desc">{label}</span>
      <span className="bs-pct">{pct !== null ? `${pct}%` : ''}</span>
      <Amount value={value} tone={tone} currency={ccy} />
    </li>
  );

  return (
    <div>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="grid">
        {/* ── 1 · הכותרת: הון עצמי והייחוס — המספר, לא ציור שחוזר על הדונאט ─────────── */}
        <div className="card hero g12">
          <CardChip icon={Coins} />
          <div className="hero-top">
            <div className="label">
              הון עצמי
              <Explain title="הון עצמי">
                <p>כל מה שיש לך פחות כל מה שאתה חייב, ברגע זה.</p>
                <ExplainH>הנוסחה, עם המספרים שלך</ExplainH>
                <Formula>
                  יתרות בנק {nis.format(data.bankTotal)}
                  <br />+ יתרה לחיוב בכרטיסים {nis.format(data.cardTotal)}
                  <br />+ נכסים ידניים {nis.format(data.assetsTotal)}
                  <br />− התחייבויות ידניות {nis.format(data.liabilitiesTotal)}
                  <br />= <strong>{nis.format(data.netWorth)}</strong>
                </Formula>
                <ExplainH>שורת "החודש: תזרים · שערוך והתאמות"</ExplainH>
                <Formula>
                  תזרים = הכנסות − הוצאות של החודש (המספר של טאב "איך אני החודש")
                  <br />שערוך והתאמות = (ההון היום − ההון בתחילת החודש) − התזרים
                </Formula>
                <p>
                  השערוך הוא <strong>שארית</strong>: הוא תופס עליית ערך של החזקות ותנודות שער מט״ח, אבל
                  סופג גם פערי כיסוי (כרטיס שלא מדווח יתרה, יתרה ידנית ישנה) — ולכן בחודש עם כיסוי חלקי
                  יש להתייחס אליו בהתאם.
                </p>
                <ExplainH>מט״ח</ExplainH>
                <p>החזקה במטבע זר נשמרת בסכום המקורי שלה ומומרת בשער העדכני מהמטמון (גיל השער — בשורת האמינות למטה).</p>
              </Explain>
            </div>
            {currentDelta !== null && (
              <span className={currentDelta >= 0 ? 'tag good' : 'tag warn'}>
                {currentDelta >= 0 ? '▲' : '▼'} {nis.format(Math.abs(currentDelta))} החודש
              </span>
            )}
          </div>
          <div className="nw-split">
          <div className="nw-col">
          <Amount value={data.netWorth} hero tone={data.netWorth < 0 ? 'negative' : undefined} currency={ccy} />
          {gross.liabilities >= 1 && (
            <p className="muted" style={{ margin: '4px 0 0' }}>
              מתוך נכסים {nis.format(gross.assets)} · פחות התחייבויות <strong className="amount-negative">{nis.format(gross.liabilities)}</strong>
            </p>
          )}
          {current && currentFlows !== null && current.revaluation !== null && (
            <p
              className="muted"
              style={{ margin: '4px 0 0' }}
              title={`${monthHe(current.month)} עד היום: נכנסו ${nis.format(current.income)} · יצאו ${nis.format(current.expenses)} · שערוך והתאמות הם השארית מול השינוי בהון`}
            >
              החודש: תזרים <Amount value={currentFlows} tone={currentFlows >= 0 ? 'positive' : 'negative'} currency={ccy} /> ·
              שערוך והתאמות <Amount value={current.revaluation} tone={current.revaluation >= 0 ? 'positive' : 'negative'} currency={ccy} />
            </p>
          )}
          {blindCards.length > 0 && (
            <p className="muted" style={{ margin: '6px 0 0', maxWidth: 640 }}>
              <TriangleAlert size={13} strokeWidth={2.2} className="ic ic-warn" aria-hidden /> {blindCards.join(', ')} {blindCards.length === 1 ? 'אינו מדווח' : 'אינם מדווחים'} יתרה
              לחיוב, ולכן החוב {blindCards.length === 1 ? 'שלו' : 'שלהם'} <strong>אינו</strong> כלול
              במספר הזה. השווי הנקי גבוה מהאמת בגובה החיוב הקרוב של{' '}
              {blindCards.length === 1 ? 'אותו כרטיס' : 'אותם כרטיסים'}.
            </p>
          )}
          {data.missingRates.length > 0 && (
            <p className="error" role="alert" style={{ marginTop: 8 }}>
              אין שער זמין ל־{data.missingRates.join(', ')} — ההחזקות במטבע הזה <strong>אינן נספרות</strong> בהון עד שיתקבל שער. נסה "רענון שערים" בתחזוקת הנתונים.
            </p>
          )}
          </div>
          <div className="nw-col">
          <div className="label" style={{ marginTop: 2 }}>
            ממה בנוי ההון
            <Explain title="ממה בנוי ההון">
              <p>סך הנכסים (בלי ההתחייבויות), מפולח: יתרת העו״ש מהבנק + כל החזקה ידנית לפי הערך העדכני שלה. האחוז = חלק מהסך.</p>
              <ExplainH>פרוסות תוכניות החיסכון</ExplainH>
              <p>תוכנית שהכסף שלה <strong>בתוך</strong> העו״ש חוצה את פרוסת העו״ש: "עו״ש פנוי" ולידה, בירוק-מנטה, הכסף שסומן. אלה <strong>אותם שקלים</strong> — הפיצול צובע, לא מוסיף: עו״ש פנוי + שמור = יתרת העו״ש. תוכנית שהכסף שלה <strong>מחוץ</strong> לעו״ש היא פרוסה נפרדת (טורקיז) שמתווספת באמת לסך הנכסים.</p>
              <ExplainH>פס הנזילות</ExplainH>
              <Formula>
                נזיל = יתרת עו״ש + החזקות שסומנו "נזיל"
                <br />נעול = כל השאר (השתלמות, ני״ע, נדל״ן…)
              </Formula>
              <p>"נזיל" = ניתן למימוש תוך ימים בלי קנס משמעותי — אתה קובע את הסימון בעריכת ההחזקה. פסיקת כרית החירום עצמה נמצאת בטאב הבריאות.</p>
            </Explain>
          </div>
          <Donut
            items={donutItems}
            centerLabel="סך הנכסים"
            ariaLabel="הרכב הנכסים לפי מחלקה"
            emptyText="אין עדיין נכסים — סנכרן את הבנק או הוסף החזקה בתחזוקת הנתונים למטה."
            rollupLabel="שאר הנכסים"
            currency={ccy}
          />
          </div>
          </div>
          {liquidPct !== null && (
            <>
              <div className="label" style={{ marginTop: 14 }}>נזילות</div>
              <div className="liq-bar" role="img" aria-label={`נזיל ${liquidPct}% מסך הנכסים`}>
                <i style={{ width: `${liquidPct}%`, background: 'var(--accent)' }} />
                <i style={{ width: `${100 - liquidPct}%`, background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }} />
              </div>
              <div className="liq-labels">
                <span>נזיל · <strong>{nis.format(liquidTotal)}</strong> ({liquidPct}%)</span>
                <span className="muted">נעול · {nis.format(lockedTotal)}</span>
              </div>
              <p className="chart-caption">נזיל = עו״ש + החזקות שסומנו נזילות · כרית החירום נמדדת בטאב הבריאות</p>
            </>
          )}
        </div>

        {/* ── 2 · ההון לאורך זמן, בשכבות ─────────────────────────────────────────────── */}
        {shown.length > 1 && (
          <div className="card g12 tone-teal">
            <CardChip icon={TrendingUp} />
            <div className="hero-top">
              <div className="label">
                ההון לאורך זמן
                <Explain title="ההון לאורך זמן">
                  <p>קו ההון העצמי לאורך הזמן — כמה היית שווה בכל יום. הציר מתקרב לטווח הנתונים כדי שהתנועה תיראה, במקום להימעך אל האפס.</p>
                  <ExplainH>איך הערך היומי מחושב</ExplainH>
                  <ul>
                    <li><strong>עו״ש</strong> — היתרה היומית משוחזרת אחורה מהיתרה האחרונה, דרך כל תנועה: יתרת אתמול = יתרת היום − תנועות היום.</li>
                    <li><strong>שמור לתוכניות חיסכון</strong> — סכום ההפקדות פחות המשיכות ביומני התוכניות שבתוך העו״ש עד כל יום, נצבע מתוך שכבת העו״ש (עו״ש פנוי + שמור = העו״ש המלא — הפיצול לא משנה את הסכום).</li>
                    <li><strong>תוכניות חיסכון מחוץ לעו״ש</strong> — אותו חישוב יומי לתוכניות שהכסף שלהן בחשבון נפרד; זו שכבה אמיתית שמתווספת להון.</li>
                    <li><strong>החזקות ידניות</strong> — כל עדכון ערך נשמר כנקודה בציר הזמן; בין נקודות הערך "צועד" קבוע. החזקת מט״ח נשמרת עם שער היום שבו נצפתה — העבר לא מתומחר מחדש; הנקודה האחרונה כן מתומחרת בשער של עכשיו.</li>
                    <li><strong>כרטיסים</strong> — היתרה לחיוב לפי ציר הזמן האמיתי של הדיווחים.</li>
                  </ul>
                  <ExplainH>הקטע המקווקו</ExplainH>
                  <p>לפני הרישום הידני הראשון אין לנו נתונים אמיתיים על ההחזקות — הקו שם הוא הערך הראשון שנרשם, מוחזר אחורה. זו מוסכמת תצוגה, לא היסטוריה — ולכן הוא מסומן.</p>
                </Explain>
              </div>
              <div className="pills" style={{ display: 'inline-flex' }}>
                {MONTH_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    className={months === c.value ? 'pill active' : 'pill'}
                    onClick={() => setMonths(c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="kpis" style={{ margin: '2px 0 10px' }}>
              {windowDelta !== null && (
                <div className="kpi">
                  <div className="label">שינוי בטווח</div>
                  <span className={windowDelta >= 0 ? 'kpi-value amount-positive' : 'kpi-value amount-negative'}>{windowDelta >= 0 ? '+' : ''}{nis.format(windowDelta)}</span>
                </div>
              )}
              {monthlyPace !== null && (
                <div className="kpi">
                  <div className="label">קצב חודשי חציוני</div>
                  <span className={monthlyPace >= 0 ? 'kpi-value amount-positive' : 'kpi-value amount-negative'}>{monthlyPace >= 0 ? '+' : ''}{nis.format(monthlyPace)}</span>
                </div>
              )}
              {allTimeHigh !== null && (
                <div className="kpi">
                  <div className="label">שיא כל הזמנים</div>
                  <span className="kpi-value">{nis.format(allTimeHigh)}{athIsNow ? ' · עכשיו' : ''}</span>
                </div>
              )}
            </div>
            <LineAreaChart
              series={shown}
              hug
              mutedBeforeIndex={mutedBefore}
              mutedBeforeLabel="לפני הרישום הידני"
              endValue={nis.format(shown[shown.length - 1].balance)}
              endLabel="היום"
              ariaLabel="ההון העצמי לאורך זמן"
            />
            <p className="chart-caption">
              כמה היית שווה בכל יום · עדכון ערך של החזקה נשמר כנקודה בציר הזמן.
              {data.manualStale && <> <TriangleAlert size={12} strokeWidth={2.2} className="ic ic-warn" aria-hidden /> יתרות ידניות לא עודכנו זמן רב — הקטע שם שוחזר, לא מציאות.</>}
            </p>
          </div>
        )}

        {/* ── 3ב · תמונת החוב ────────────────────────────────────────────────────────── */}
        <div className="card g12 tone-coral">
          <CardChip icon={CreditCard} />
          <div className="label">
            תמונת החוב
            <Explain title="תמונת החוב">
              <p>כל ההתחייבויות במקום אחד: יתרה לחיוב בכרטיסים (נמשכת אוטומטית כשהחברה מדווחת) וההלוואות שרשמת.</p>
              <ExplainH>חסם הפירעון של הלוואה</ExplainH>
              <Formula>מספר תשלומים ≥ יתרת ההלוואה ÷ ההחזר החודשי</Formula>
              <p>זה <strong>חסם תחתון מכוון</strong>: הריבית אינה מחושבת (היא לא זמינה בנתונים), ולכן המספר האמיתי גבוה יותר. עדיף אמת חלקית מוצהרת מניחוש שלם.</p>
              <ExplainH>מד המינוף</ExplainH>
              <Formula>מינוף = סך התחייבויות ÷ סך נכסים × 100</Formula>
              <p>העובדה בלבד — הפסיקה אם זה בריא נמצאת בטאב הבריאות, שמודד את עומס ההחזר מול ההכנסה.</p>
            </Explain>
          </div>
          {gross.liabilities < 1 && (!cardRow || cardRow.signedAmount === null || cardRow.signedAmount >= 0) ? (
            <p className="muted">אין התחייבויות רשומות. הלוואה שלא מופיעה כאן? הוסף אותה בתחזוקת הנתונים.</p>
          ) : (
            <table className="bs-table">
              <colgroup>
                <col />
                <col style={{ width: 72 }} />
                <col style={{ width: 120 }} />
              </colgroup>
              <tbody>
                {cardRow && cardRow.signedAmount !== null && cardRow.signedAmount < 0 && (
                  <tr>
                    <td className="bs-name">
                      יתרה לחיוב בכרטיסים
                      <span className="tag">{syncedHe(data, 'card') ?? 'נמשך מהבנק'}</span>
                    </td>
                    <td className="bs-spark" />
                    <td className="bs-num"><Amount value={cardRow.signedAmount} tone="negative" currency={ccy} /></td>
                  </tr>
                )}
                {[...loanAssets, ...otherLiabilities].map((a) => (
                  <tr key={a.id}>
                    <td className="bs-name">
                      {a.name}
                      {a.institution && <span className="tag">{a.institution}</span>}
                      {a.monthlyPayment !== null && <span className="tag">החזר {money0(a.currency).format(a.monthlyPayment)}/ח׳</span>}
                      {loanRow?.assetId === a.id && loanRow.remainingPaymentsHe && (
                        <p className="state-note">{loanRow.remainingPaymentsHe}</p>
                      )}
                    </td>
                    <td className="bs-spark">{sparkOf(a)}</td>
                    <td className="bs-num"><Amount value={-a.value} tone="negative" currency={ccy} /></td>
                  </tr>
                ))}
                <tr className="bs-total">
                  <td>סך התחייבויות</td>
                  <td />
                  <td className="bs-num"><Amount value={gross.liabilities === 0 ? 0 : -gross.liabilities} tone={gross.liabilities > 0 ? 'negative' : undefined} currency={ccy} /></td>
                </tr>
              </tbody>
            </table>
          )}
          {leveragePct !== null && (
            <>
              <div className="label" style={{ marginTop: 14 }}>מינוף · התחייבויות ÷ נכסים</div>
              <div className="meter" role="img" aria-label={`מינוף ${leveragePct.toFixed(1)} אחוזים`}>
                <i style={{ width: `${Math.min(100, leveragePct)}%` }} />
              </div>
              <div className="liq-labels">
                <span><strong>{leveragePct.toFixed(1)}%</strong></span>
                <span className="muted">הפסיקה על עומס החוב — בטאב הבריאות</span>
              </div>
            </>
          )}
        </div>

        {/* ── 5 · תחזוקת הנתונים: הכלים, לא הסיפור ──────────────────────────────────── */}
        <div className="card g12 maint tone-slate">
          <div className="hero-top">
            <div className="label">
              <Wrench size={12} style={{ verticalAlign: '-2px', marginInlineEnd: 5 }} />
              תחזוקת הנתונים
              {staleCount > 0 && <span className="tag warn" style={{ marginInlineStart: 8 }}>{staleCount === 1 ? 'החזקה אחת דורשת רענון' : `${staleCount} החזקות דורשות רענון`}</span>}
            </div>
            <button className="link" onClick={() => setMaintOpen((v) => !v)}>{maintOpen ? 'סגירה' : 'פתיחה'}</button>
          </div>
          <div className="maint-tools">
            <button
              className="maint-tool"
              style={{ '--tc': 'var(--accent)' } as CSSProperties}
              onClick={() => { setMaintOpen(true); setPasteOpen(true); setNotice(null); }}
            >
              <span className="maint-tool-head">
                <span className="maint-tool-ic"><ClipboardPaste size={19} strokeWidth={2} aria-hidden /></span>
                <span className="maint-tool-title">הדבקת מצב חשבון</span>
              </span>
              <span className="maint-tool-sub">מדביקים את טבלת הבנק — מסגרת מפרקת, מראה, וכותבת רק את מה שתאשרו.</span>
            </button>
            <button
              className="maint-tool"
              style={{ '--tc': 'var(--positive)' } as CSSProperties}
              onClick={() => startAdd('deposit')}
            >
              <span className="maint-tool-head">
                <span className="maint-tool-ic"><Plus size={19} strokeWidth={2.4} aria-hidden /></span>
                <span className="maint-tool-title">הוספת נכס או התחייבות</span>
              </span>
              <span className="maint-tool-sub">דירה, פנסיה, רכב, הלוואה — כל מה שאף בנק לא מושך אוטומטית.</span>
            </button>
            {foreignHeld.length > 0 && (
              <button
                className="maint-tool"
                style={{ '--tc': 'var(--cat-teal)' } as CSSProperties}
                disabled={busy}
                title="מושך שער עדכני מהספק החינמי (frankfurter, עם גיבוי) — נשלחת בקשה אנונימית בלבד, שום נתון אישי לא יוצא"
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api.refreshRates();
                    await load();
                  } catch (e) {
                    setError(errorMessageHe(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <span className="maint-tool-head">
                  <span className="maint-tool-ic"><RefreshCw size={18} strokeWidth={2.2} aria-hidden /></span>
                  <span className="maint-tool-title">רענון שערים</span>
                </span>
                <span className="maint-tool-sub">מושך שער מט״ח עדכני. בקשה אנונימית — שום נתון אישי לא יוצא.</span>
              </button>
            )}
          </div>
          {notice && <p className="muted" role="status" aria-live="polite" style={{ marginTop: 8 }}><span className="amount-positive">{notice}</span></p>}

          {maintOpen && (
            <>
              {pasteOpen && (
                <div className="paste-panel">
                  <div className="label">הדבקת מצב חשבון</div>
                  <p className="muted" style={{ margin: '4px 0 10px' }}>
                    היכנס לאתר הבנק, סמן את טבלת "מצב החשבון שלך" והדבק אותה כאן. מסגרת תפרק אותה לשורות,
                    תראה לך בדיוק מה היא הבינה, ותכתוב רק את מה שתאשר.
                  </p>
                  <textarea
                    rows={7}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={'מצב החשבון שלך\nיתרת עו"ש ₪3,456.78\nכרטיסי אשראי\n₪1,234.56\nהלוואות\n₪45,678.90\n…'}
                    aria-label="טקסט מצב החשבון מהבנק"
                  />
                  <div className="toolbar" style={{ marginBottom: 0 }}>
                    <button className="primary" onClick={() => void runPreview()} disabled={pasteBusy || !text.trim()}>
                      {pasteBusy && !preview ? 'קורא…' : 'תצוגה מקדימה'}
                    </button>
                    <button className="link" onClick={closePaste} disabled={pasteBusy}>סגירה</button>
                  </div>
                  {pasteError && !preview && <p className="error" style={{ marginTop: 12 }} role="alert">{pasteError}</p>}
                  {preview && (
                    <PasteReview
                      preview={preview}
                      chosen={chosen}
                      toggle={(i) => setChosen((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i); else next.add(i);
                        return next;
                      })}
                      onApply={() => void applyPaste()}
                      onCancel={closePaste}
                      busy={pasteBusy}
                      error={pasteError}
                    />
                  )}
                </div>
              )}

              <div ref={formRef} style={{ marginTop: 14 }}>
                <div className="label">{editingId !== null ? 'עריכת החזקה' : 'הוספת החזקה'}</div>
                <p className="card-sub">
                  פקדון אינו תוכנית חיסכון: תוכנית חיסכון היא סימון על כסף שכבר יושב בעו״ש, ופקדון הוא כסף
                  שנמצא <strong>מחוצה</strong> לו. אותו שקל בשניהם נספר פעמיים.
                </p>
                <AssetForm
                  draft={draft}
                  setDraft={setDraft}
                  onSubmit={() => void submitDraft()}
                  onCancel={editingId !== null ? () => { setEditingId(null); setDraft(EMPTY_DRAFT); } : undefined}
                  busy={busy}
                  submitLabel={editingId !== null ? 'שמירה' : 'הוספה'}
                  currencies={currencies}
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <div className="label">חשבונות מחוברים</div>
                <ul className="txns">
                  {data.accounts.map((a) => (
                    <li className="txn" key={`${a.connectionId}|${a.account}`}>
                      <span className="txn-desc">
                        {a.label}
                        {a.kind === 'card' && <span className="tag">החיוב הבא</span>}
                      </span>
                      <Amount value={a.balance} currency={ccy} />
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
