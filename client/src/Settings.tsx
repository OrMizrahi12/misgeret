import {
  Archive, CalendarCog, CalendarRange, CircleAlert, Coins, Compass, CreditCard,
  Database, Download, Landmark, Lightbulb, MoonStar, Puzzle, RefreshCw,
  ScrollText, SunMoon, Trash2, Eraser,
} from 'lucide-react';
import { CardChip } from './CardChip';
import { useEffect, useState } from 'react';
import { api, errorMessageHe } from './api';
import { RecurringManager } from './RecurringManager';
import { desktop, fileName, updateStateHe, PROJECT_URLS, openProjectPage, type DesktopAppInfo, type PresenceSettings, type UpdateState } from './desktop';
import { applyTheme, currentTheme, onThemeChange, type Theme } from './theme';
import {
  CATEGORIES, type BackupInfo, type CurrencyInfo, type MonthLens, type SettlementSuspect,
} from './types';

const ILS0 = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });

const MONTH_OPTIONS = [
  { value: 3, label: '3 חודשים' },
  { value: 6, label: 'חצי שנה' },
  { value: 12, label: 'שנה' },
  { value: 24, label: 'שנתיים' },
  { value: 0, label: 'הכל' },
];

/**
 * Every destructive action here is profile-scoped — `request()` attaches X-Misgeret-Profile — so
 * every one of them names the person whose money it touches, exactly as DeletePanel and the
 * import dialog do. "מחק הכל" with three users on screen reads as the whole installation.
 */
export function Settings({ onOpenConnections, onStartTour, profileName }: {
  onOpenConnections: () => void;
  onStartTour?: () => void;
  profileName: string | null;
}) {
  const owner = profileName?.trim() || 'המשתמש הפעיל';
  const [months, setMonths] = useState(6);
  const [lens, setLens] = useState<MonthLens>('charge');
  const [anchorDay, setAnchorDay] = useState(1);
  const [overdraft, setOverdraft] = useState('0');
  const [persistedOverdraft, setPersistedOverdraft] = useState<string | null>(null);
  const [suggestedAnchor, setSuggestedAnchor] = useState<number | null>(null);
  const [autoSync, setAutoSync] = useState(true);
  /** נוכחות שקטה — desktop-only; null until (and unless) the shell reports its state. */
  const [presence, setPresence] = useState<PresenceSettings | null>(null);
  const [primaryCcy, setPrimaryCcy] = useState('ILS');
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [sectors, setSectors] = useState<{ sector: string; count: number }[]>([]);
  const [suspects, setSuspects] = useState<SettlementSuspect[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // which setting group just saved — "נשמר ✓" must appear only on the card the user touched
  const [saved, setSaved] = useState<'months' | 'month-shape' | 'overdraft' | 'autosync' | 'currency' | null>(null);
  const [wipe, setWipe] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [deep, setDeep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [deepWipeDone, setDeepWipeDone] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => onThemeChange(setTheme), []);

  async function changeFlow(payload: { monthLens?: MonthLens; monthStartDay?: number; overdraftLimit?: number; autoSyncOnOpen?: boolean; primaryCurrency?: string }) {
    setSaved(null);
    setError(null);
    try {
      const s = await api.updateSettings(payload);
      setLens(s.monthLens);
      setAnchorDay(s.monthStartDay);
      setOverdraft(String(s.overdraftLimit));
      setPersistedOverdraft(String(s.overdraftLimit));
      setAutoSync(s.autoSyncOnOpen);
      setPrimaryCcy(s.primaryCurrency);
      setSaved(
        payload.primaryCurrency !== undefined ? 'currency'
          : payload.overdraftLimit !== undefined ? 'overdraft'
            : payload.autoSyncOnOpen !== undefined ? 'autosync'
              : 'month-shape',
      );
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  async function wipeData() {
    setWipe('busy');
    setError(null);
    try {
      await api.clearData();
      // full reload — every screen starts clean, ready for a fresh sync
      window.location.reload();
    } catch (e) {
      setError(errorMessageHe(e));
      setWipe('idle');
    }
  }

  /** The deeper wipe. No automatic reload: the response names the safety copy, and that name is
   *  the only route back for the verdicts — the user gets to read it before the screens refresh. */
  async function deepWipe() {
    setDeep('busy');
    setError(null);
    try {
      const result = await api.clearDataFull();
      setDeepWipeDone(result.backupFile);
    } catch (e) {
      setError(errorMessageHe(e));
      setDeep('idle');
    }
  }

  async function load() {
    // flowCandidates stays for its settlementSuspects alone — the card that reads them is still here
    const [settings, sectorsRes, backupsRes, flowRes, ratesRes] = await Promise.all([
      api.getSettings(),
      api.issuerSectors(),
      api.backups(),
      api.flowCandidates(),
      api.rates(),
    ]);
    setPrimaryCcy(settings.primaryCurrency);
    setCurrencies(ratesRes.currencies);
    setSectors(sectorsRes.sectors);
    setSuspects(flowRes.settlementSuspects);
    setBackups(backupsRes.backups);
    setMonths(settings.months);
    setLens(settings.monthLens);
    setAnchorDay(settings.monthStartDay);
    setOverdraft(String(settings.overdraftLimit));
    setPersistedOverdraft(String(settings.overdraftLimit));
    setSuggestedAnchor(settings.suggestedAnchorDay);
    setAutoSync(settings.autoSyncOnOpen);
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessageHe(e)));
    const importNotice = window.sessionStorage.getItem('misgeret-import-notice');
    if (importNotice) {
      setDataMsg(importNotice);
      window.sessionStorage.removeItem('misgeret-import-notice');
    }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    void desktop.getAppInfo().then(setAppInfo).catch(() => {});
    void desktop.presenceGet?.().then(setPresence).catch(() => {});
    return desktop.onUpdateState(setUpdateState);
  }, []);

  async function changePresence(patch: Partial<PresenceSettings>) {
    if (!desktop?.presenceSet) return;
    try {
      setPresence(await desktop.presenceSet(patch));
    } catch {
      setError('לא ניתן לעדכן את הגדרות הנוכחות השקטה.');
    }
  }

  const overdraftDirty = persistedOverdraft !== null && overdraft !== persistedOverdraft;
  useEffect(() => {
    const bridge = desktop;
    if (!bridge || persistedOverdraft === null) return;
    void bridge.setUnsavedChanges(overdraftDirty).catch(() => {});
    return () => {
      if (overdraftDirty) void bridge.setUnsavedChanges(false).catch(() => {});
    };
  }, [overdraftDirty, persistedOverdraft]);

  async function changeMonths(value: number) {
    setMonths(value);
    setSaved(null);
    try {
      await api.setMonths(value);
      setSaved('months');
    } catch (e) {
      setError(errorMessageHe(e));
    }
  }

  async function createBackup() {
    setError(null);
    setBackupMsg(null);
    setBackupBusy(true);
    try {
      if (desktop) {
        const result = await desktop.createBackup();
        if (!result.ok) {
          setError('לא ניתן ליצור גיבוי כרגע. נסה שוב בעוד רגע.');
          return;
        }
        setBackupMsg(`נשמר${fileName(result.filePath) ? `: ${fileName(result.filePath)}` : ''} ✓`);
      } else {
        const result = await api.backup();
        setBackupMsg(`נשמר: ${result.file} ✓`);
      }
      setBackups((await api.backups()).backups);
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setBackupBusy(false);
    }
  }

  async function exportData() {
    if (!desktop) return;
    setError(null);
    setDataMsg(null);
    try {
      const result = await desktop.exportCsv();
      if (!result.canceled) {
        if (result.errorCode) setError('לא ניתן לשמור את קובץ הייצוא.');
        else setDataMsg(`קובץ ה-CSV נשמר${fileName(result.filePath) ? `: ${fileName(result.filePath)}` : ''} ✓`);
      }
    } catch {
      setError('לא ניתן לשמור את קובץ הייצוא.');
    }
  }

  async function importLegacyData() {
    if (!desktop) return;
    setError(null);
    setDataMsg(null);
    try {
      setImporting(true);
      const result = await desktop.importLegacyData();
      if (result.errorCode) {
        setError('לא ניתן לפתוח את קובץ הנתונים שנבחר.');
        return;
      }
      if (result.canceled || !result.ok || !result.parity) return;
      const tableCount = Object.keys(result.parity.tables).length;
      const credentialsMessage = result.parity.credentialsUnavailable.length > 0
        ? ` ${result.parity.credentialsUnavailable.length} חיבורים דורשים הזנת פרטי התחברות מחדש.`
        : '';
      const notice = `הייבוא הושלם ואומת מול ${tableCount} טבלאות.${credentialsMessage}`;
      setDataMsg(`${notice} מרענן את מסגרת…`);
      window.sessionStorage.setItem('misgeret-import-notice', notice);
      window.location.reload();
    } catch (e) {
      setError(errorMessageHe(e));
    } finally {
      setImporting(false);
    }
  }

  function changeTheme(next: Theme) {
    applyTheme(next);
    setTheme(next);
  }

  async function restartToUpdate() {
    if (!desktop) return;
    const result = await desktop.restartToUpdate();
    if (result.accepted) return;
    const reason = result.reason === 'busy'
      ? 'העדכון יוכל להתחיל לאחר סיום הפעולה הנוכחית.'
      : result.reason === 'backup-failed'
        ? 'העדכון נעצר כי לא ניתן היה ליצור גיבוי בטוח.'
        : result.reason === 'unsaved'
        ? 'יש שינויים שטרם נשמרו. שמור אותם לפני ההפעלה מחדש.'
        : 'העדכון עדיין אינו מוכן להתקנה.';
    setDataMsg(reason);
  }

  async function checkForUpdates() {
    if (!desktop) return;
    setError(null);
    try {
      setUpdateState({ status: 'checking' });
      setUpdateState(await desktop.checkForUpdates());
    } catch {
      setUpdateState({ status: 'error', message: 'לא ניתן לבדוק עדכונים כרגע.' });
    }
  }

  return (
    <div>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="card">
        <CardChip icon={Landmark} />
        <div className="label">חשבונות וחיבורים</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>הוספה, עדכון ומחיקה של בנקים וכרטיסי אשראי.</p>
        <button className="primary" onClick={onOpenConnections}>ניהול חיבורים</button>
      </div>

      {onStartTour && (
        <div className="card">
          <CardChip icon={Compass} />
          <div className="label">הדרכה</div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            דקה אחת על מה יש בכל טאב — ואיפה למצוא כל תשובה. אפשר לחזור לסיור מתי שרוצים.
          </p>
          <button onClick={onStartTour}>פתח את הסיור המודרך</button>
        </div>
      )}

      <div className="card">
        <CardChip icon={SunMoon} />
        <div className="label">מראה</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          <strong>בהיר</strong> — נייר חם, ברירת המחדל של מסגרת. <strong>כהה</strong> — לילה על הים.
          הגרפים והנתונים זהים בשני המצבים.
        </p>
        <div className="pills" style={{ display: 'inline-flex' }}>
          <button className={theme === 'light' ? 'pill active' : 'pill'} onClick={() => changeTheme('light')}>בהיר</button>
          <button className={theme === 'dark' ? 'pill active' : 'pill'} onClick={() => changeTheme('dark')}>כהה</button>
        </div>
      </div>

      <div className="card">
        <CardChip icon={CalendarRange} />
        <div className="label">טווח תצוגה</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          כמה חודשים אחורה להציג. הסנכרון תמיד מושך את מלוא ההיסטוריה שהמוסד מאפשר —
          הבחירה כאן היא תצוגה בלבד, שום נתון לא הולך לאיבוד. {saved === 'months' && <span className="amount-positive">נשמר ✓</span>}
        </p>
        <div className="pills" style={{ display: 'inline-flex' }}>
          {MONTH_OPTIONS.map((o) => (
            <button key={o.value} className={o.value === months ? 'pill active' : 'pill'} onClick={() => changeMonths(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <CardChip icon={CalendarCog} />
        <div className="label">מתי מתחיל החודש שלך</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          <strong>לפי רכישה</strong> — כל עסקה נספרת ביום שהעברת את הכרטיס: משוב מיידי על ההתנהגות,
          התפיסה התזרימית. <strong>לפי חיוב</strong> — כל שקל נספר בחודש שבו יצא מהבנק בפועל (עסקות
          כרטיס בחודש החיוב): המספרים מתיישבים אחד-לאחד מול הבנק, במחיר עיכוב של חודש במשוב.
        </p>
        <div className="pills" style={{ display: 'inline-flex', marginBottom: 14 }}>
          <button className={lens === 'purchase' ? 'pill active' : 'pill'} onClick={() => changeFlow({ monthLens: 'purchase' })}>
            לפי רכישה (ברירת מחדל)
          </button>
          <button className={lens === 'charge' ? 'pill active' : 'pill'} onClick={() => changeFlow({ monthLens: 'charge' })}>
            לפי חיוב
          </button>
        </div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          <strong>יום תחילת החודש</strong> — אם המשכורת או מועד החיוב שלך אינם ב-1 לחודש, קבע את היום
          שבו החודש הפיננסי שלך באמת מתחיל (למשל 10). "יולי" יימדד אז מה-10.7 עד ה-9.8 —
          ומשכורת שמקדימה (נכנסת ב-8 או ב-9) ממתינה ונספרת בחודש שהיא מממנת, זה שנפתח ב-10.
          {saved === 'month-shape' && <span className="amount-positive"> נשמר ✓</span>}
        </p>
        <label style={{ maxWidth: 220 }}>
          החודש שלי מתחיל ב-
          <select value={anchorDay} onChange={(e) => changeFlow({ monthStartDay: Number(e.target.value) })}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>{d === 1 ? '1 (כמו בלוח השנה)' : `${d} לחודש`}</option>
            ))}
          </select>
        </label>
        {suggestedAnchor !== null && suggestedAnchor !== anchorDay && suggestedAnchor >= 1 && suggestedAnchor <= 28 && (
          <p className="muted" style={{ marginTop: 10 }}>
            <Lightbulb size={13} strokeWidth={2.2} className="ic ic-muted" aria-hidden /> המשכורת שלך נכנסת בדרך כלל ב-{suggestedAnchor} לחודש.{' '}
            <button className="link" onClick={() => changeFlow({ monthStartDay: suggestedAnchor })}>
              למדוד את החודש ממנה
            </button>
          </p>
        )}
      </div>

      <div className="card">
        <CardChip icon={Coins} />
        <div className="label">מטבע ראשי</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          המטבע שבו מוצג ההון בטאב "הון" — כל החזקה נרשמת במטבע שלה (חיסכון בפייפל בדולרים)
          ומומרת אליו בשער עדכני מספק חינמי. נתוני העו״ש והתזרים נשארים בש״ח, כפי שהבנק מדווח.
          {saved === 'currency' && <span className="amount-positive"> נשמר ✓</span>}
        </p>
        <label style={{ maxWidth: 260 }}>
          ההון שלי מוצג ב-
          <select value={primaryCcy} onChange={(e) => changeFlow({ primaryCurrency: e.target.value })}>
            {(currencies.length > 0 ? currencies : [{ code: 'ILS', nameHe: 'שקל חדש', symbol: '₪' }]).map((c) => (
              <option key={c.code} value={c.code}>{c.symbol} {c.nameHe}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="card">
        <CardChip icon={CreditCard} />
        <div className="label">מסגרת אשראי בעו״ש</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          הקו האדום האמיתי של התזרים. אם יש לך מסגרת של 10,000 ₪, ירידה ל-−2,000 היא לא משבר —
          ופריצה של המסגרת כן. ההתראה בתזרים וסימון השפל נמדדים מול הערך הזה. 0 = התראה מתחת לאפס.
          {saved === 'overdraft' && <span className="amount-positive"> נשמר ✓</span>}
        </p>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            dir="ltr"
            inputMode="numeric"
            style={{ width: 120, textAlign: 'end' }}
            value={overdraft}
            onChange={(e) => setOverdraft(e.target.value)}
          />
          <button
            className="primary"
            onClick={() => {
              const n = Number(overdraft);
              if (Number.isFinite(n) && n >= 0) changeFlow({ overdraftLimit: n });
              else setError('מסגרת חייבת להיות מספר אי-שלילי');
            }}
          >
            שמירה
          </button>
        </div>
      </div>

      <div className="card">
        <CardChip icon={RefreshCw} />
        <div className="label">סנכרון אוטומטי</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          כשפותחים את האפליקציה ועברו יותר מ-12 שעות מהסנכרון האחרון — סנכרון מתחיל לבד ברקע.
        </p>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, display: 'flex' }}>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => changeFlow({ autoSyncOnOpen: e.target.checked })}
          />
          סנכרן אוטומטית בפתיחה
        </label>
      </div>

      {presence && (
        <div className="card">
          <CardChip icon={MoonStar} />
          <div className="label">נוכחות שקטה</div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            כשמדליקים: סגירת החלון ממזערת את מסגרת לפינת השעון במקום לצאת, הנתונים מסתנכרנים
            ברקע כל כמה שעות, ומסגרת מרשה לעצמה להפריע רק בשלושה מקרים — חיוב כפול חשוד,
            חיוב שהתייקר, ותחזית שחוצה את מסגרת האשראי. כל השאר מחכה בשקט שתפתחו.
          </p>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, display: 'flex' }}>
            <input
              type="checkbox"
              checked={presence.enabled}
              onChange={(e) => void changePresence({ enabled: e.target.checked })}
            />
            מסגרת ממשיכה ברקע ומתריעה כשחשוב
          </label>
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, display: 'flex', marginTop: 8, opacity: presence.enabled ? 1 : 0.55 }}>
            <input
              type="checkbox"
              checked={presence.launchAtLogin}
              disabled={!presence.enabled}
              onChange={(e) => void changePresence({ launchAtLogin: e.target.checked })}
            />
            הפעלה עם המחשב — ישר לאזור ההתראות, בלי חלון
          </label>
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 14 }}>
            התראה שהוצגה פעם אחת לא תוצג שוב. יציאה מלאה — מתפריט האייקון בפינת השעון.
          </p>
        </div>
      )}

      <RecurringManager />

      {suspects.length > 0 && (
        <div className="card">
          <CardChip icon={CircleAlert} />
          <div className="label">חיובי כרטיס שאינם מזוהים — ייתכן ספירה כפולה</div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            חיוב שיורד מהעו״ש לכרטיס אשראי אינו הוצאה בפני עצמו — ההוצאה היא העסקאות שבתוך הכרטיס,
            ומסגרת מנטרלת את הכפילות לפי שם חברת האשראי שבתיאור. השורות כאן נראות כמו חיוב כרטיס, אבל
            התיאור שלהן אינו נושא שם של חברה מוכרת (למשל "חיוב לכרטיס ויזה 5020"). כל עוד הכרטיס הזה
            אינו מחובר למסגרת, החיוב נספר כהוצאה — וזה נכון ומדויק. אם הוא מחובר, אותה הוצאה נספרת
            פעמיים: גם העסקאות בכרטיס וגם החיוב בבנק.
          </p>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            אין כאן כפתור, בכוונה: הנטרול הנכון תלוי בכרטיס המסוים ומוכרע מחדש בכל חודש — מחזור חיוב
            שההיסטוריה שלו מתחילה באמצעו נספר דווקא מהבנק — וסימון גורף וקבוע היה מוחק הוצאה אמיתית
            בדיוק בחודשים האלה. הדרך לסגור את זה היא לחבר את הכרטיס במסך החיבורים; משם הנטרול קורה
            מעצמו, חודש בחודש.
          </p>
          <ul className="txns">
            {suspects.map((s) => (
              <li className="txn" key={s.pattern}>
                <span className="txn-desc">{s.sampleDescription}</span>
                <span className="muted">{s.count} חיובים</span>
                <span className="recon-nums">{ILS0.format(s.total)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sectors.length > 0 && (
        <div className="card">
          <CardChip icon={Puzzle} />
          <div className="label">סוגי חיובים שמחכים לסיווג שלך ({sectors.length})</div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            חברת הכרטיס מצמידה לכל עסקה "סוג". את רובם המערכת מבינה לבד — את מה שנשאר מסווגים
            כאן פעם אחת, וזה חל מיד על כל ההיסטוריה ועל כל סנכרון עתידי.
          </p>
          <ul className="txns">
            {sectors.slice(0, 10).map((s) => (
              <li className="txn" key={s.sector}>
                <span className="txn-desc">{s.sector}</span>
                <span className="muted">{s.count} עסקאות</span>
                <select
                  defaultValue=""
                  onChange={async (e) => {
                    const category = e.target.value;
                    if (!category) return;
                    setError(null);
                    try {
                      await api.mapIssuerSector(s.sector, category);
                      setSectors((prev) => prev.filter((x) => x.sector !== s.sector));
                    } catch (err) {
                      setError(errorMessageHe(err));
                    }
                  }}
                >
                  <option value="" disabled>לאיזו קטגוריה זה שייך…</option>
                  {CATEGORIES.filter((c) => c.id !== 'income').map((c) => (
                    <option key={c.id} value={c.id}>{c.nameHe}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <CardChip icon={Archive} />
        <div className="label">גיבוי ושחזור — {owner}</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          צילום מלא של מסד הנתונים של <strong>{owner}</strong> (עסקאות, חיבורים, חוקים, נכסים
          והגדרות) לקובץ מתוארך
          {desktop
            ? ` בתיקיית הגיבויים של ${owner}, בתוך תיקיית הנתונים של מסגרת.`
            : <> ב-<code>{'data/profiles/<id>/backups'}</code>.</>} שחזור מחליף את כל הנתונים של {owner} בתוכן הגיבוי.
          {backupMsg && <span className="amount-positive" role="status" aria-live="polite"> {backupMsg}</span>}
        </p>
        <div className="settings-actions">
          <button className="primary" onClick={createBackup} disabled={backupBusy}>
            {backupBusy ? 'יוצר גיבוי…' : 'גבה עכשיו'}
          </button>
        </div>
        {backups.length > 0 && (
          <ul className="txns" style={{ marginTop: 10 }}>
            {backups.slice(0, 6).map((b) => (
              <li className="txn" key={b.file}>
                <span className="txn-desc" dir="ltr" style={{ textAlign: 'end' }}>{b.file}</span>
                <span className="muted">{new Date(b.createdAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                {restoreConfirm === b.file ? (
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    <span className="error-inline">להחליף את כל הנתונים של {owner} בתוכן הגיבוי?</span>
                    <button
                      className="danger"
                      onClick={async () => {
                        setError(null);
                        try {
                          await api.restoreBackup(b.file);
                          window.location.reload();
                        } catch (e) {
                          setError(errorMessageHe(e));
                          setRestoreConfirm(null);
                        }
                      }}
                    >
                      כן, שחזר
                    </button>
                    <button className="link" onClick={() => setRestoreConfirm(null)}>ביטול</button>
                  </span>
                ) : (
                  <button className="link" onClick={() => setRestoreConfirm(b.file)}>שחזור…</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <CardChip icon={Database} />
        <div className="label">הנתונים של {owner}</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          הכל מקומי: העסקאות, היתרות והחוקים של {owner} {desktop ? 'בתיקייה הפרטית שלו בתוך תיקיית הנתונים של מסגרת' : <>ב-<code>{'data/profiles/<id>/finance.db'}</code></>}; פרטי ההתחברות מוצפנים
          בהצפנת AES-256-GCM עם מפתח שמוגן על ידי מערכת ההפעלה. אין ענן. הייצוא חופשי — הנתונים שלך.
          {dataMsg && <span className="amount-positive" role="status" aria-live="polite"> {dataMsg}</span>}
        </p>
        <div className="settings-actions">
          {desktop ? (
            <>
              <button className="primary" onClick={exportData}>ייצוא כל העסקאות (CSV)</button>
              <button onClick={importLegacyData} disabled={importing}>
                {importing ? 'מייבא ומאמת…' : 'ייבוא מהתקנה קיימת…'}
              </button>
              <button onClick={() => void desktop?.revealData()}>פתיחת תיקיית הנתונים</button>
              <button onClick={() => void desktop?.revealLogs()}>פתיחת יומן האבחון</button>
            </>
          ) : (
            <a className="button-link" href="/api/export.csv" download>
              ייצוא כל העסקאות (CSV)
            </a>
          )}
        </div>
      </div>

      {desktop && (
        <div className="card">
          <CardChip icon={Download} />
          <div className="label">גרסה ועדכונים</div>
          <p className="muted" style={{ margin: '4px 0 10px' }}>
            {appInfo ? `מסגרת ${appInfo.version}` : 'מסגרת'} · {updateStateHe(updateState)}
          </p>
          <div className="settings-actions" aria-live="polite">
            <button
              onClick={checkForUpdates}
              disabled={updateState.status === 'checking' || updateState.status === 'downloading'}
            >
              {updateState.status === 'checking' ? 'בודק…' : 'בדיקת עדכונים'}
            </button>
            {updateState.status === 'downloaded' && (
              <button className="primary" onClick={restartToUpdate}>הפעלה מחדש ועדכון</button>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <CardChip icon={ScrollText} />
        <div className="label">קוד פתוח ומידע</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          מסגרת חינמית, ללא חשבון וללא תשלום. קוד המקור פתוח תחת רישיון MIT ואפשר לעיין בו,
          לדווח על בעיות ולתרום שיפורים.
        </p>
        <div className="settings-actions">
          <button onClick={() => openProjectPage(PROJECT_URLS.source)}>קוד המקור ב־GitHub</button>
          <button onClick={() => openProjectPage(PROJECT_URLS.license)}>רישיון MIT</button>
          <button onClick={() => openProjectPage(PROJECT_URLS.privacy)}>מדיניות פרטיות</button>
        </div>
      </div>

      {/* שתי מחיקות, ושמות שאומרים בדיוק מה כל אחת לוקחת. הכפתור הישן נקרא "מחיקת כל הנתונים"
          והוריד רק עסקאות ויתרות — ההבטחה הייתה רחבה מהמעשה, ומשם הגיע הבלבול. */}
      <div className="card danger-zone">
        <CardChip icon={Trash2} />
        <div className="label">מחיקת העסקאות של {owner}</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          מוחק את העסקאות והיתרות שנמשכו עבור <strong>{owner}</strong> בלבד — שאר המשתמשים
          במסגרת אינם מושפעים. <strong>הסימונים שלך נשארים</strong> (מנוי / קבוע / הרגל), וכך גם
          חוקי הקטגוריות, החיבורים והנכסים הידניים — סנכרון אחד מושך הכל מחדש, והסימונים נדבקים
          לשורות החדשות.
        </p>
        {wipe === 'idle' ? (
          <button className="danger" onClick={() => setWipe('confirm')}>מחק את העסקאות של {owner}…</button>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="error-inline">בטוח? סנכרון מחדש יחזיר את העסקאות.</span>
            <button className="danger" disabled={wipe === 'busy'} onClick={wipeData}>
              {wipe === 'busy' ? 'מוחק…' : `כן, מחק את העסקאות`}
            </button>
            <button className="link" disabled={wipe === 'busy'} onClick={() => setWipe('idle')}>ביטול</button>
          </div>
        )}
      </div>

      <div className="card danger-zone">
        <CardChip icon={Eraser} />
        <div className="label">התחלה נקייה — גם הסימונים והכללים</div>
        <p className="muted" style={{ margin: '4px 0 10px' }}>
          כמו למעלה, ובנוסף מוחק את <strong>כל מה שהחלטת</strong> על הכסף של {owner}: הסימונים
          (מנוי / קבוע / הרגל / הסתרה), הסכומים שעיגנת למנויים, חוקי הקטגוריות והסיווג, וחיובים
          חוזרים שהזנת ידנית. אחרי סנכרון הכל חוזר כ<strong>הצעות בלבד</strong>, ואתה מחליט מחדש.
        </p>
        <p className="muted" style={{ margin: '0 0 10px' }}>
          <strong>נשארים:</strong> החיבורים ופרטי ההתחברות, הנכסים שהקלדת, היעדים והתוכנית,
          וההגדרות. גיבוי אוטומטי נלקח לפני המחיקה.
        </p>
        {deepWipeDone ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* the filename is shown BEFORE reloading — it is the only way back, so it must be
                read, not flashed past by an automatic refresh */}
            <span className="muted">
              נמחק. גיבוי נשמר בשם <code>{deepWipeDone}</code> — אפשר לשחזר ממנו ב״גיבויים״.
            </span>
            <button className="danger" onClick={() => window.location.reload()}>רענן את המסכים</button>
          </div>
        ) : deep === 'idle' ? (
          <button className="danger" onClick={() => setDeep('confirm')}>התחלה נקייה של {owner}…</button>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="error-inline">
              בטוח? הסימונים והכללים לא חוזרים בסנכרון — רק מהגיבוי.
            </span>
            <button className="danger" disabled={deep === 'busy'} onClick={deepWipe}>
              {deep === 'busy' ? 'מגבה ומוחק…' : 'כן, מחק הכל חוץ מהחיבורים'}
            </button>
            <button className="link" disabled={deep === 'busy'} onClick={() => setDeep('idle')}>ביטול</button>
          </div>
        )}
      </div>
    </div>
  );
}
