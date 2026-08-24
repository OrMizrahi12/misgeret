import { ArrowLeftRight, Check, ChevronDown, ChevronUp, MapPinned, Pencil, ShieldCheck, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { CardChip } from './CardChip';
import { useState, type CSSProperties } from 'react';
import { api, errorMessageHe } from './api';
import type { ProfileSummary } from './types';

/** A profile picks its color once and wears it on every identity surface: avatar, rows, picker. */
/* Stored per profile as literal hex — saturated mid-tones that hold up on light and dark alike.
   First one is the brand violet (סגול־שמש 4.0). */
export const PROFILE_COLORS = ['#5b2be0', '#0090ab', '#1f7a35', '#9a7100', '#d9730d', '#d30f45', '#5b58d8', '#b23aa6'];

export const PROFILE_NAME_MAX = 60;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Ink that stays readable on top of the profile's color, whatever the user picked. */
export function readableInk(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#0a0b12';
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  return luminance > 0.3 ? '#0a0b12' : '#f0f1f7';
}

const THEME_VARS = ['--accent', '--accent-2', '--accent-ink', '--grad-accent', '--glow-accent'];

/** Brand 4.0 (סגול־שמש): the brand owns the accent everywhere. The person's color
    lives in identity surfaces only — avatar, profile rows, pickers — which carry it
    inline. Identity stays unmistakable without repainting the brand.
    Always clearing also erases any pre-4.0 accent hijack left on the root. */
export function applyProfileTheme(_color: string | null): void {
  const root = document.documentElement;
  for (const v of THEME_VARS) root.style.removeProperty(v);
}

export function profileInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

export function connectionsHe(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return 'אין חיבורים';
  if (count === 1) return 'חיבור אחד';
  if (count === 2) return 'שני חיבורים';
  return `${count} חיבורים`;
}

export function freshnessHe(lastSyncAt: string | null): string {
  if (!lastSyncAt) return 'טרם סונכרן';
  const ms = Date.now() - new Date(lastSyncAt).getTime();
  if (!Number.isFinite(ms)) return 'טרם סונכרן';
  if (ms < 0) return 'סונכרן עכשיו';
  const hours = ms / 3600_000;
  if (hours < 1) return 'סונכרן ממש עכשיו';
  const h = Math.round(hours);
  if (h === 1) return 'סונכרן לפני שעה';
  if (h === 2) return 'סונכרן לפני שעתיים';
  if (h < 24) return `סונכרן לפני ${h} שעות`;
  const d = Math.round(hours / 24);
  if (d === 1) return 'סונכרן אתמול';
  if (d === 2) return 'סונכרן לפני יומיים';
  if (d < 31) return `סונכרן לפני ${d} ימים`;
  const months = Math.round(d / 30);
  if (months === 1) return 'סונכרן לפני חודש';
  if (months === 2) return 'סונכרן לפני חודשיים';
  return `סונכרן לפני ${months} חודשים`;
}

function dateHe(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ProfileAvatar({ name, color, size = 30 }: { name: string; color: string; size?: number }) {
  const style = {
    '--profile-color': color,
    '--profile-ink': readableInk(color),
    width: size,
    height: size,
    fontSize: Math.round(size * 0.44),
    borderRadius: Math.max(7, Math.round(size * 0.33)),
  } as CSSProperties;
  return <span className="profile-avatar" style={style} aria-hidden="true">{profileInitial(name)}</span>;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="swatches" role="radiogroup" aria-label="צבע המשתמש">
      {PROFILE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={value === c ? 'swatch active' : 'swatch'}
          style={{ background: c }}
          aria-label={`צבע ${c}`}
          onClick={() => onChange(c)}
        />
      ))}
    </span>
  );
}

/** Create form, shared by the sidebar popover and the management view — one implementation, one behavior. */
export function NewProfileForm({ defaultColor, onCreate, onCancel, compact, autoFocus }: {
  defaultColor: string;
  onCreate: (name: string, color: string) => Promise<void>;
  onCancel?: () => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(defaultColor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > PROFILE_NAME_MAX) {
      setError(`נדרש שם באורך של 1 עד ${PROFILE_NAME_MAX} תווים.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed, color);
      setName('');
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'profile-form compact' : 'profile-form'}>
      <div className="profile-form-row">
        <ProfileAvatar name={name || '?'} color={color} size={compact ? 28 : 34} />
        <input
          placeholder="שם (אור, נועה, העסק…)"
          value={name}
          maxLength={PROFILE_NAME_MAX}
          autoFocus={autoFocus}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape' && onCancel) onCancel();
          }}
          style={{ flex: 1, minWidth: compact ? 0 : 180 }}
        />
      </div>
      <div className="profile-form-row">
        <ColorPicker value={color} onChange={setColor} />
        <span className="profile-form-actions">
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'יוצר…' : 'יצירה'}
          </button>
          {onCancel && <button className="link" onClick={onCancel} disabled={busy}>ביטול</button>}
        </span>
      </div>
      {error && <p className="error-inline">{error}</p>}
    </div>
  );
}

/** Deleting is typed-name confirmation — and it says plainly that the data is moved aside, not destroyed. */
function DeletePanel({ profile, onCancel, onConfirmed }: {
  profile: ProfileSummary;
  onCancel: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === profile.name.trim();

  async function confirm() {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProfile(profile.id);
      await onConfirmed();
    } catch (e) {
      setError(errorMessageHe(e));
      setBusy(false);
    }
  }

  return (
    <div className="profile-danger">
      <p style={{ margin: '0 0 8px' }}>
        <strong>מחיקת {profile.name}</strong>
      </p>
      <p className="muted" style={{ margin: '0 0 10px', lineHeight: 1.65 }}>
        התיקייה של {profile.name} — מסד הנתונים, כל הגיבויים ופרטי ההתחברות — <strong>תועבר הצידה</strong> לתיקיית{' '}
        <code>deleted-profiles</code> בתוך תיקיית הנתונים של מסגרת. שום דבר לא נמחק מהדיסק, וניתן לשחזר אותו ידנית.
        מסגרת פשוט תפסיק להציג את המשתמש הזה.
      </p>
      <label style={{ maxWidth: 320 }}>
        כדי לאשר, הקלד את השם <strong>{profile.name}</strong> במדויק:
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={profile.name} autoFocus />
      </label>
      {error && <p className="error-inline" style={{ marginTop: 8 }}>{error}</p>}
      <div className="settings-actions" style={{ marginTop: 12 }}>
        <button className="danger" onClick={() => void confirm()} disabled={!matches || busy}>
          {busy ? 'מעביר הצידה…' : `כן, העבר את ${profile.name} הצידה`}
        </button>
        <button className="link" onClick={onCancel} disabled={busy}>ביטול</button>
      </div>
    </div>
  );
}

function ProfileRow({ profile, isActive, isOnly, isFirst, isLast, busyReason, onChanged, onSwitch, onMove }: {
  profile: ProfileSummary;
  isActive: boolean;
  isOnly: boolean;
  isFirst: boolean;
  isLast: boolean;
  busyReason: string | null;
  onChanged: () => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onMove: (id: string, direction: -1 | 1) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [color, setColor] = useState(profile.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > PROFILE_NAME_MAX) {
      setError(`נדרש שם באורך של 1 עד ${PROFILE_NAME_MAX} תווים.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateProfile(profile.id, { name: trimmed, color });
      await onChanged();
      setEditing(false);
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBusy(false);
    }
  }

  const connections = connectionsHe(profile.connectionCount);

  return (
    <div className={isActive ? 'profile-row is-active' : 'profile-row'}>
      <div className="profile-order">
        <button
          onClick={() => void onMove(profile.id, -1)}
          disabled={isFirst || busy}
          aria-label={`הזז את ${profile.name} למעלה`}
          title="הזז למעלה"
        >
          <ChevronUp size={13} aria-hidden="true" />
        </button>
        <button
          onClick={() => void onMove(profile.id, 1)}
          disabled={isLast || busy}
          aria-label={`הזז את ${profile.name} למטה`}
          title="הזז למטה"
        >
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>

      <ProfileAvatar name={editing ? name || '?' : profile.name} color={editing ? color : profile.color} size={38} />

      <div className="profile-row-main">
        {editing ? (
          <div className="profile-form-row" style={{ flexWrap: 'wrap' }}>
            <input
              value={name}
              maxLength={PROFILE_NAME_MAX}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') { setEditing(false); setName(profile.name); setColor(profile.color); }
              }}
              style={{ minWidth: 150 }}
            />
            <ColorPicker value={color} onChange={setColor} />
          </div>
        ) : (
          <>
            <div className="profile-row-name">{profile.name}</div>
            <div className="profile-row-meta">
              {isActive && <span className="tag good">פעיל עכשיו</span>}
              {connections !== null && <span className="tag">{connections}</span>}
              <span className="tag">{freshnessHe(profile.lastSyncAt)}</span>
              <span className="muted" style={{ fontSize: 14 }}>נוצר {dateHe(profile.createdAt)}</span>
            </div>
          </>
        )}
        {error && <p className="error-inline" style={{ marginTop: 6 }}>{error}</p>}
      </div>

      <div className="profile-row-actions">
        {editing ? (
          <>
            <button className="primary" onClick={() => void save()} disabled={busy}>
              {busy ? 'שומר…' : 'שמירה'}
            </button>
            <button
              className="link"
              disabled={busy}
              onClick={() => { setEditing(false); setName(profile.name); setColor(profile.color); setError(null); }}
            >
              ביטול
            </button>
          </>
        ) : (
          <>
            {!isActive && (
              <button
                onClick={() => void onSwitch(profile.id)}
                disabled={busyReason !== null}
                title={busyReason ?? `מעבר לעולם של ${profile.name}`}
              >
                <ArrowLeftRight size={14} aria-hidden="true" /> מעבר אליו
              </button>
            )}
            <button onClick={() => setEditing(true)} title="שינוי שם וצבע" aria-label={`עריכת ${profile.name}`}>
              <Pencil size={14} aria-hidden="true" /> עריכה
            </button>
            <button
              className="link danger"
              onClick={() => setDeleting((v) => !v)}
              disabled={isOnly}
              title={isOnly ? 'זה המשתמש היחיד — חייב להישאר לפחות אחד' : `מחיקת ${profile.name}`}
              aria-label={`מחיקת ${profile.name}`}
            >
              <Trash2 size={14} aria-hidden="true" /> מחיקה
            </button>
          </>
        )}
      </div>

      {deleting && !isOnly && (
        <div className="profile-row-full">
          <DeletePanel
            profile={profile}
            onCancel={() => setDeleting(false)}
            onConfirmed={async () => { setDeleting(false); await onChanged(); }}
          />
        </div>
      )}
    </div>
  );
}

export function Profiles({ profiles, activeId, onChanged, onSwitch, onCreate, switchBlockedReason }: {
  profiles: ProfileSummary[];
  activeId: string | null;
  onChanged: () => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  /** Creation lives in App: it also activates, and only App may move the active profile. */
  onCreate: (name: string, color: string) => Promise<void>;
  switchBlockedReason: string | null;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ordered = [...profiles].sort((a, b) => a.order - b.order);

  async function create(name: string, color: string) {
    setError(null);
    await onCreate(name, color);
    setCreating(false);
  }

  async function move(id: string, direction: -1 | 1) {
    const ids = ordered.map((p) => p.id);
    const from = ids.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    setError(null);
    try {
      await api.reorderProfiles(ids);
      await onChanged();
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  return (
    <div>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card">
        <CardChip icon={UsersRound} />
        <div className="hero-top">
          <div className="label">כל אחד — והעולם שלו</div>
          {!creating && (
            <button
              className="primary"
              onClick={() => setCreating(true)}
              disabled={switchBlockedReason !== null}
              title={switchBlockedReason ?? 'משתמש חדש, ומעבר אליו מיד'}
            >
              <UserPlus size={15} aria-hidden="true" /> הוסף משתמש
            </button>
          )}
        </div>
        <p className="muted" style={{ margin: '4px 0 0', lineHeight: 1.7, maxWidth: 760 }}>
          לכל משתמש כאן יש מסד נתונים משלו, תיקיית גיבויים משלו ופרטי התחברות משלו — קבצים נפרדים לגמרי על
          הדיסק. אין טבלה משותפת ואין שדה שמפריד ביניכם, ולכן אין מה שיכול לדלוף: כשאתה מסתכל על עולם אחד,
          המסד של השני אפילו לא פתוח. הצבע שתבחר צובע את כל האפליקציה — כדי שלעולם לא תתבלבל במי אתה מסתכל.
        </p>
        {creating && (
          <div style={{ marginTop: 14 }}>
            <NewProfileForm
              defaultColor={PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]}
              onCreate={create}
              onCancel={() => setCreating(false)}
              autoFocus
            />
            <p className="muted" style={{ margin: '8px 0 0' }}>
              {switchBlockedReason
                ? `המשתמש החדש ייווצר ריק, אך ${switchBlockedReason.replace(/\.$/, '')} — מסגרת תישאר על המשתמש הנוכחי.`
                : 'המשתמש החדש ייווצר ריק, ומסגרת תעבור אליו מיד כדי שתחבר לו חשבונות.'}
            </p>
          </div>
        )}
      </div>

      {ordered.length === 0 ? (
        <p className="muted">עוד אין משתמשים — צור את הראשון.</p>
      ) : (
        <div className="profile-rows">
          {ordered.map((p, i) => (
            <ProfileRow
              key={p.id}
              profile={p}
              isActive={p.id === activeId}
              isOnly={ordered.length === 1}
              isFirst={i === 0}
              isLast={i === ordered.length - 1}
              busyReason={switchBlockedReason}
              onChanged={onChanged}
              onSwitch={onSwitch}
              onMove={move}
            />
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 14 }}>
        <CardChip icon={MapPinned} />
        <div className="label">איפה זה יושב</div>
        <p className="muted" style={{ margin: '4px 0 0', lineHeight: 1.7 }}>
          <ShieldCheck size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> הכל מקומי, כמו תמיד: כל
          משתמש הוא תיקייה בתוך תיקיית הנתונים של מסגרת. מחיקת משתמש רק מעבירה את התיקייה שלו ל-
          <code>deleted-profiles</code> — הנתונים ממשיכים לשבת על הדיסק שלך. אפשר לפתוח את התיקייה מהמסך "הגדרות".
        </p>
      </div>
    </div>
  );
}

/** The active profile's identity, at a glance — used by the sidebar trigger and the popover rows. */
export function ProfileIdentity({ profile, active }: { profile: ProfileSummary; active?: boolean }) {
  const connections = connectionsHe(profile.connectionCount);
  return (
    <>
      <ProfileAvatar name={profile.name} color={profile.color} size={30} />
      <span className="profile-option-text">
        <span className="profile-option-name">{profile.name}</span>
        <span className="profile-option-meta">
          {[connections, freshnessHe(profile.lastSyncAt)].filter(Boolean).join(' · ')}
        </span>
      </span>
      {active && <Check size={15} className="profile-option-check" aria-hidden="true" />}
    </>
  );
}
