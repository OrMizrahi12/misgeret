import {
  ArrowDownToLine, CalendarHeart, CalendarRange, Check, ChevronDown, Circle, Compass, HeartPulse, Home as HomeIcon, Link2, LoaderCircle, Menu, Moon,
  PanelRightClose, PanelRightOpen, RefreshCw, Repeat, Settings as SettingsIcon, Sun, Telescope, TrendingUp, Users, UserPlus,
  Wallet, X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorMessageHe, errorTypeHe, setActiveProfileId } from './api';
import { desktop, fileName, updateStateHe, type DesktopAppInfo, type DesktopCommand, type UpdateState } from './desktop';
import { applyTheme, currentTheme, onThemeChange, type Theme } from './theme';
import type { ProfileSummary, Status, SyncProgress } from './types';
import { Connections } from './Connections';
import { Future } from './Future';
import { Health } from './Health';
import { Home } from './Home';
import { Logo } from './Logo';
import { Month } from './Month';
import { NetWorth } from './NetWorth';
import { Overview } from './Overview';
import { Patterns } from './Patterns';
import { Plan } from './Plan';
import {
  applyProfileTheme, NewProfileForm, ProfileAvatar, ProfileIdentity, Profiles, PROFILE_COLORS,
} from './Profiles';
import { Review } from './Review';
import { Settings } from './Settings';
import { TourModal } from './Tour';
import { ViewBoundary } from './ViewBoundary';
import { Year } from './Year';
import { WhatsNewModal } from './WhatsNew';
import { entriesSince, type WhatsNewEntry } from './release-notes';
import type { SyncResult } from './types';

type View =
  | 'loading'
  | 'failed'
  | 'home'
  | 'month'
  | 'plan'
  | 'year'
  | 'overview'
  | 'patterns'
  | 'future'
  | 'health'
  | 'networth'
  | 'connections'
  | 'settings'
  | 'profiles'
  | 'review';

const NAV: { view: View; label: string; icon: typeof CalendarHeart }[] = [
  { view: 'home', label: 'הבית', icon: HomeIcon },
  { view: 'month', label: 'איך אני החודש?', icon: CalendarHeart },
  { view: 'plan', label: 'התוכנית שלי', icon: Compass },
  { view: 'year', label: 'איך עברה השנה?', icon: CalendarRange },
  { view: 'overview', label: 'איך אני בכללי?', icon: TrendingUp },
  { view: 'patterns', label: 'מה יורד לי כל חודש?', icon: Repeat },
  { view: 'future', label: 'ומה לגבי העתיד?', icon: Telescope },
  { view: 'health', label: 'בריאות', icon: HeartPulse },
  { view: 'networth', label: 'הון', icon: Wallet },
];

const NAV_FOOT: { view: View; label: string; icon: typeof CalendarHeart }[] = [
  { view: 'connections', label: 'חיבורים', icon: Link2 },
  { view: 'settings', label: 'הגדרות', icon: SettingsIcon },
];

const TITLES: Record<View, string> = {
  loading: '',
  failed: '',
  home: 'הבית',
  month: 'איך אני החודש?',
  plan: 'התוכנית שלי',
  year: 'איך עברה השנה?',
  overview: 'איך אני בכללי?',
  patterns: 'מה יורד לי כל חודש?',
  future: 'ומה לגבי העתיד?',
  health: 'בריאות פיננסית',
  networth: 'הון',
  connections: 'חיבורים',
  settings: 'הגדרות',
  profiles: 'ניהול משתמשים',
  review: 'חידוד סיווגים',
};

// unknown hashes (incl. '#/dashboard' and '#/cashflow' from old bookmarks) land on the junction
const HASH_VIEWS: View[] = [
  'home', 'month', 'plan', 'year', 'overview', 'patterns', 'future', 'health', 'networth', 'connections', 'settings', 'profiles', 'review',
];

/** '#/cashflow' ↔ view, '#/month/2026-06' ↔ that month's tab — refresh keeps your place, back works. */
function parseHash(): { view: View; month: string | null } {
  const h = window.location.hash.replace(/^#\/?/, '');
  const m = h.match(/^month\/(\d{4}-\d{2})$/);
  if (m) return { view: 'month', month: m[1] };
  return { view: (HASH_VIEWS as string[]).includes(h) ? (h as View) : 'home', month: null };
}

const STALE_SYNC_MS = 12 * 3600_000;

/** Only a hint about who you were last time. The registry's activeId is the truth (see A15). */
const REMEMBERED_PROFILE_KEY = 'misgeret-active-profile';

/** The last app version this machine was SEEN running — the "מה חדש" popup fires on change. */
const SEEN_VERSION_KEY = 'misgeret-seen-version';

/** '1' ⇒ the sidebar is minimized to an icons-only rail — a per-machine taste, remembered. */
const SIDEBAR_RAIL_KEY = 'misgeret-sidebar-rail';

/** Sync-step state in the app's icon language: a quiet circle waits, a spinner works,
 *  a check lands, an X fails — same lucide line as the rest of the chrome. */
const PROGRESS_ICON: Record<string, ReactNode> = {
  pending: <Circle size={12} strokeWidth={2.2} className="ic ic-muted" aria-hidden />,
  running: <LoaderCircle size={12} strokeWidth={2.2} className="ic ic-spin" aria-hidden />,
  ok: <Check size={12} strokeWidth={2.4} className="ic ic-ok" aria-hidden />,
  error: <X size={12} strokeWidth={2.4} className="ic ic-bad" aria-hidden />,
};

function rememberedProfile(): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_PROFILE_KEY);
  } catch {
    return null;
  }
}

/** The sidebar switcher: who you are, everyone else, and the way to add one more. */
function ProfileSwitcher({ profiles, activeId, blockedReason, onSwitch, onCreate, onManage }: {
  profiles: ProfileSummary[];
  activeId: string | null;
  blockedReason: string | null;
  onSwitch: (id: string) => Promise<void>;
  onCreate: (name: string, color: string) => Promise<void>;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'create'>('list');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setMode('list');
  }, [open]);

  const active = profiles.find((p) => p.id === activeId) ?? null;
  if (!active) return null;
  const ordered = [...profiles].sort((a, b) => a.order - b.order);

  return (
    <div className="profile-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className={open ? 'profile-trigger open' : 'profile-trigger'}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`המשתמש הפעיל: ${active.name}. החלפת משתמש`}
        title={`המשתמש הפעיל: ${active.name}`}
      >
        <ProfileAvatar name={active.name} color={active.color} size={30} />
        <span className="profile-trigger-text">
          <span className="profile-trigger-name">{active.name}</span>
          <span className="profile-trigger-sub">
            {profiles.length === 1 ? 'המשתמש היחיד' : `משתמש ${ordered.findIndex((p) => p.id === active.id) + 1} מתוך ${profiles.length}`}
          </span>
        </span>
        <ChevronDown size={14} className="profile-trigger-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div className="profile-popover" role="menu" aria-label="בחירת משתמש">
          {mode === 'create' ? (
            <div className="profile-popover-create">
              <div className="profile-popover-title">משתמש חדש</div>
              {/* create mode replaces the list, note and all — but the promise below ("we switch to
                  it immediately") is exactly what a sync starting mid-form would break */}
              {blockedReason && <p className="profile-popover-note">{blockedReason}</p>}
              <NewProfileForm
                compact
                autoFocus
                defaultColor={PROFILE_COLORS[profiles.length % PROFILE_COLORS.length]}
                onCancel={() => setMode('list')}
                onCreate={async (name, color) => {
                  await onCreate(name, color);
                  setOpen(false);
                }}
              />
            </div>
          ) : (
            <>
              {blockedReason && <p className="profile-popover-note">{blockedReason}</p>}
              {ordered.map((p) => (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={p.id === activeId}
                  className={p.id === activeId ? 'profile-option current' : 'profile-option'}
                  disabled={p.id !== activeId && blockedReason !== null}
                  onClick={() => {
                    setOpen(false);
                    if (p.id !== activeId) void onSwitch(p.id);
                  }}
                >
                  <ProfileIdentity profile={p} active={p.id === activeId} />
                </button>
              ))}
              <div className="profile-popover-sep" role="separator" />
              <button
                className="profile-option action"
                role="menuitem"
                disabled={blockedReason !== null}
                title={blockedReason ?? 'משתמש חדש, ומעבר אליו מיד'}
                onClick={() => setMode('create')}
              >
                <span className="profile-option-icon"><UserPlus size={15} aria-hidden="true" /></span>
                <span className="profile-option-text"><span className="profile-option-name">הוסף משתמש</span></span>
              </button>
              <button
                className="profile-option action"
                role="menuitem"
                onClick={() => { setOpen(false); onManage(); }}
              >
                <span className="profile-option-icon"><Users size={15} aria-hidden="true" /></span>
                <span className="profile-option-text"><span className="profile-option-name">ניהול משתמשים</span></span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One click between the warm paper and the night sea — shown on every screen. */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => onThemeChange(setTheme), []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={() => applyTheme(next)}
      aria-label={next === 'dark' ? 'מעבר למצב כהה' : 'מעבר למצב בהיר'}
      title={next === 'dark' ? 'מצב כהה' : 'מצב בהיר'}
    >
      {theme === 'dark' ? <Sun size={16} strokeWidth={2} /> : <Moon size={16} strokeWidth={2} />}
    </button>
  );
}

export function App() {
  const [view, setView] = useState<View>('loading');
  const [reviewMonth, setReviewMonth] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [autoSynced, setAutoSynced] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncFailures, setSyncFailures] = useState<SyncResult[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [rail, setRail] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_RAIL_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [startupRetrying, setStartupRetrying] = useState(false);
  const [desktopNotice, setDesktopNotice] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [whatsNew, setWhatsNew] = useState<WhatsNewEntry[] | null>(null);
  const [tourOpen, setTourOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Bumped on every switch: remounts the whole view tree so not one number can survive. */
  const [profileEpoch, setProfileEpoch] = useState(0);
  const [switchingProfile, setSwitchingProfile] = useState(false);
  const syncingRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  function toggleRail() {
    setRail((v) => {
      try {
        window.localStorage.setItem(SIDEBAR_RAIL_KEY, v ? '0' : '1');
      } catch {
        // taste, not truth — losing it costs one click
      }
      return !v;
    });
  }

  /** The single navigation entry point: updates state AND the hash (deep links + back button). */
  function goto(v: View, month?: string) {
    if (v === 'month') setReviewMonth(month ?? null); // no month = the running month
    setView(v);
    setSidebarOpen(false);
    const target = v === 'month' && month ? `#/month/${month}` : `#/${v}`;
    if (window.location.hash !== target) window.location.hash = target;
  }

  async function installReadyUpdate() {
    if (!desktop) return;
    const result = await desktop.restartToUpdate();
    if (result.accepted) return;
    setDesktopNotice(result.reason === 'backup-failed'
      ? 'העדכון נעצר כי לא ניתן היה ליצור גיבוי בטוח.'
      : result.reason === 'busy'
        ? 'העדכון יותקן לאחר סיום הפעולה הנוכחית.'
        : result.reason === 'unsaved'
          ? 'יש לשמור או לבטל את השינויים הפתוחים לפני העדכון.'
          : 'העדכון עדיין אינו מוכן להתקנה.');
  }

  /** Everything downstream of "we know whose world this is". Never call it before the profile is resolved. */
  async function enterApp(opts?: { stay?: boolean }): Promise<Status> {
    const status = await api.status();
    setLastSyncAt(status.lastSyncAt);
    if (opts?.stay) return status;
    if (status.connectionCount === 0) {
      // a brand-new install lands on the Home welcome guide, which walks the user
      // to the connections screen itself — guidance first, forms second
      goto('home');
      return status;
    }
    const { view: next, month } = parseHash();
    goto(next, month ?? undefined);
    return status;
  }

  function adoptProfile(id: string) {
    activeIdRef.current = id;
    setActiveId(id);
    setActiveProfileId(id);
    try {
      window.localStorage.setItem(REMEMBERED_PROFILE_KEY, id);
    } catch {
      // a locked-down profile store must not stop the app — the registry still knows who is active
    }
  }

  /** Wipe every number this renderer is holding, then remount the tree. */
  function resetProfileState() {
    setLastSyncAt(null);
    setSyncError(null);
    setSyncFailures([]);
    setProgress(null);
    setAutoSynced(false);
    setReviewMonth(null);
    setProfileEpoch((e) => e + 1);
  }

  async function refreshProfiles(): Promise<void> {
    try {
      const res = await api.profiles();
      setProfiles(res.profiles);
      // the registry moved under us (the active profile was just deleted) — follow it, and follow it hard
      if (res.activeId && res.activeId !== activeIdRef.current) {
        adoptProfile(res.activeId);
        resetProfileState();
        await enterApp({ stay: true });
      }
    } catch {
      // the switcher keeps showing the last known list — a listing hiccup must never break the app
    }
  }

  // a switch mid-sync would leave one person's scrape writing into another's screen
  const switchBlockedReason = syncing
    ? 'לא ניתן להחליף משתמש בזמן סנכרון — המתן לסיומו.'
    : switchingProfile
      ? 'מחליף משתמש…'
      : null;

  /** Returns false when it refused. Refusing silently is how you end up looking at the wrong money. */
  async function switchProfile(id: string, opts?: { stay?: boolean }): Promise<boolean> {
    if (id === activeIdRef.current) return true;
    if (syncingRef.current || switchingProfile) return false;
    setSwitchingProfile(true);
    try {
      // the registry is the truth: activate BEFORE rendering, so the desktop's header-less calls
      // (ייצוא CSV, צור גיבוי, גיבוי טרום-עדכון) can never answer for someone else
      await api.activateProfile(id);
    } catch (e) {
      setDesktopNotice(errorMessageHe(e));
      setSwitchingProfile(false);
      return false;
    }
    adoptProfile(id);
    resetProfileState();
    void refreshProfiles();
    try {
      await enterApp(opts);
    } catch (e) {
      setDesktopNotice(errorMessageHe(e));
      setView('failed');
    } finally {
      setSwitchingProfile(false);
    }
    return true;
  }

  /**
   * Creating a user promises an immediate switch, and the create actions are disabled while a
   * switch is blocked. A sync starting between opening the form and submitting it still slips
   * through, so the refusal is named rather than swallowed — otherwise the popover just closes
   * and the new user exists nowhere the user can see.
   */
  async function createProfile(name: string, color: string) {
    const created = await api.createProfile({ name, color });
    await refreshProfiles();
    if (!(await switchProfile(created.profile.id))) {
      setDesktopNotice(`${created.profile.name} נוצר, אך מסגרת עדיין מציגה את ${activeProfile?.name ?? 'המשתמש הנוכחי'} — ${switchBlockedReason ?? 'לא ניתן להחליף משתמש כעת.'}`);
    }
  }

  async function boot() {
    try {
      const res = await api.profiles();
      setProfiles(res.profiles);
      let id = res.activeId;
      // No profile resolves — we cannot know whose money this is, so we render none of it.
      if (!id) {
        setView('failed');
        return;
      }
      let reactivated = false;
      const remembered = rememberedProfile();
      // localStorage is a hint, never a second source of truth: if it still names a real profile
      // and the registry disagrees, we activate it rather than quietly rendering it
      if (remembered && remembered !== id && res.profiles.some((p) => p.id === remembered)) {
        id = (await api.activateProfile(remembered)).activeId;
        reactivated = true;
      }
      // adopt before any refresh, or the refresh reads activeIdRef as null and "corrects" a phantom drift
      adoptProfile(id);
      if (reactivated) void refreshProfiles();
    } catch {
      setView('failed');
      return;
    }
    try {
      const status = await enterApp();
      if (status.connectionCount === 0) return;
      // the data should be fresh when you open the app — without you remembering to click
      const stale = !status.lastSyncAt || Date.now() - new Date(status.lastSyncAt).getTime() > STALE_SYNC_MS;
      if (status.autoSyncOnOpen && stale) {
        setAutoSynced(true);
        void sync();
      }
    } catch {
      setView('failed');
    }
  }

  useEffect(() => {
    void boot();
    const applyHash = () => {
      const { view: v, month } = parseHash();
      if (v === 'month') setReviewMonth(month); // null = back to the running month
      setView((prev) => (prev === 'loading' || prev === 'failed' ? prev : v));
    };
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

  useEffect(() => {
    applyProfileTheme(activeProfile?.color ?? null);
  }, [activeProfile?.color]);

  useEffect(() => {
    if (!desktop) return;

    void desktop.rendererReady(__MISGERET_BUILD_ID__).catch(() => {});
    void desktop.getAppInfo().then(setAppInfo).catch(() => {});
    const removeUpdateListener = desktop.onUpdateState(setUpdateState);
    const removeCommandListener = desktop.onCommand((command) => {
      void handleDesktopCommand(command).catch(() => {
        setDesktopNotice('הפעולה לא הושלמה. אפשר לנסות שוב מתפריט מסגרת.');
      });
    });

    const handleDesktopRefresh = (event: KeyboardEvent) => {
      const isRefresh = event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
      if (!isRefresh) return;
      event.preventDefault();
      refreshData();
    };
    window.addEventListener('keydown', handleDesktopRefresh);

    return () => {
      removeCommandListener();
      removeUpdateListener();
      window.removeEventListener('keydown', handleDesktopRefresh);
    };
    // The bridge is immutable for the life of the renderer; handlers use refs and functional state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sidebarOpen]);

  useEffect(() => {
    if (view !== 'loading' && view !== 'failed') mainRef.current?.focus({ preventScroll: true });
  }, [view]);

  useEffect(() => {
    if (!desktopNotice) return;
    const timer = window.setTimeout(() => setDesktopNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [desktopNotice]);

  // After an update relaunches the app, the version on disk moved past the version this
  // machine last saw — that gap IS the "מה חדש" popup. A fresh install just records itself.
  useEffect(() => {
    const version = appInfo?.version;
    if (!version) return;
    try {
      const seen = window.localStorage.getItem(SEEN_VERSION_KEY);
      if (seen && seen !== version) {
        const entries = entriesSince(seen, version);
        if (entries.length > 0) {
          setWhatsNew(entries);
          return; // seen is recorded when the popup closes, so a crash re-shows it
        }
      }
      window.localStorage.setItem(SEEN_VERSION_KEY, version);
    } catch {
      // a locked-down profile store must not break startup — the popup is a nicety
    }
  }, [appInfo?.version]);

  function dismissWhatsNew() {
    setWhatsNew(null);
    try {
      if (appInfo?.version) window.localStorage.setItem(SEEN_VERSION_KEY, appInfo.version);
    } catch {
      // best effort — worst case the popup shows once more next launch
    }
  }

  async function sync() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    const syncedProfile = activeIdRef.current;
    setSyncing(true);
    setSyncError(null);
    setSyncFailures([]);
    // a scrape is minutes of headless browser per institution — show who is where
    const poll = window.setInterval(() => {
      api.syncProgress().then(setProgress).catch(() => {});
    }, 1500);
    try {
      const res = await api.sync();
      if (activeIdRef.current !== syncedProfile) return;
      setSyncFailures(res.results.filter((r) => !r.success));
      setLastSyncAt(res.lastSyncAt);
      setRefreshKey((k) => k + 1); // every screen refetches
      void refreshProfiles();
    } catch (e) {
      if (activeIdRef.current === syncedProfile) setSyncError(errorMessageHe(e));
    } finally {
      window.clearInterval(poll);
      setProgress(null);
      setSyncing(false);
      setAutoSynced(false);
      syncingRef.current = false;
    }
  }

  function refreshData() {
    setRefreshKey((key) => key + 1);
    setDesktopNotice('הנתונים המקומיים רועננו.');
    void api.status().then((status) => setLastSyncAt(status.lastSyncAt)).catch(() => {});
  }

  async function retryStartup() {
    setStartupRetrying(true);
    setView('loading');
    try {
      if (desktop) await desktop.recoveryAction('retry');
      const res = await api.profiles();
      setProfiles(res.profiles);
      if (!res.activeId) {
        setView('failed');
        return;
      }
      adoptProfile(res.activeId);
      await enterApp();
    } catch {
      setView('failed');
    } finally {
      setStartupRetrying(false);
    }
  }

  async function handleDesktopCommand(command: DesktopCommand) {
    if (!desktop) return;
    if (command.startsWith('navigate-')) {
      goto(command.slice('navigate-'.length) as View);
      return;
    }
    if (command === 'sync') {
      await sync();
      return;
    }
    if (command === 'refresh') {
      refreshData();
      return;
    }
    if (command === 'export-csv') {
      const result = await desktop.exportCsv();
      if (!result.canceled) {
        setDesktopNotice(result.filePath ? `קובץ הייצוא נשמר: ${fileName(result.filePath)}` : 'קובץ הייצוא נשמר.');
      }
      return;
    }
    if (command === 'create-backup') {
      const result = await desktop.createBackup();
      setDesktopNotice(result.ok ? `הגיבוי נשמר${fileName(result.filePath) ? `: ${fileName(result.filePath)}` : ''}.` : 'לא ניתן ליצור גיבוי.');
      if (result.ok) setRefreshKey((key) => key + 1);
      return;
    }
    if (command === 'check-for-updates') {
      setUpdateState(await desktop.checkForUpdates());
    }
  }

  // חידוד סיווגים is reached from the month tab — the sidebar keeps that tab lit
  const active = view === 'review' ? 'month' : view;
  const dataKey = `${refreshKey}-${profileEpoch}`;

  let content;
  if (view === 'failed') {
    content = desktop ? (
      <section className="recovery-card" role="alert" aria-labelledby="recovery-title">
        <h2 id="recovery-title">מסגרת לא הצליחה להפעיל את מנוע הנתונים</h2>
        <p className="muted">הנתונים שלך נשארו שמורים. אפשר לנסות להתחבר שוב או לפתוח את יומן האבחון.</p>
        <div className="recovery-actions">
          <button className="primary" onClick={retryStartup} disabled={startupRetrying}>
            {startupRetrying ? 'מנסה שוב…' : 'נסה שוב'}
          </button>
          <button onClick={() => void desktop?.recoveryAction('open-logs')}>פתיחת יומן האבחון</button>
          <button className="link" onClick={() => void desktop?.recoveryAction('quit')}>יציאה ממסגרת</button>
        </div>
      </section>
    ) : (
      <p className="error" role="alert">אין חיבור לשרת המקומי. ודא שהשרת רץ (npm run dev) ורענן את הדף.</p>
    );
  } else if (view === 'loading') {
    content = <p className="muted" role="status" aria-live="polite">טוען…</p>;
  } else if (view === 'profiles') {
    content = (
      <Profiles
        key={dataKey}
        profiles={profiles}
        activeId={activeId}
        onChanged={refreshProfiles}
        onSwitch={async (id) => { await switchProfile(id, { stay: true }); }}
        onCreate={createProfile}
        switchBlockedReason={switchBlockedReason}
      />
    );
  } else if (view === 'connections') {
    content = <Connections key={dataKey} onBack={() => goto('month')} />;
  } else if (view === 'settings') {
    content = (
      <Settings
        key={dataKey}
        profileName={activeProfile?.name ?? null}
        onOpenConnections={() => goto('connections')}
        onStartTour={() => setTourOpen(true)}
      />
    );
  } else if (view === 'review') {
    content = <Review key={dataKey} onBack={() => goto('month')} />;
  } else if (view === 'health') {
    content = <Health key={dataKey} />;
  } else if (view === 'networth') {
    content = <NetWorth key={dataKey} />;
  } else if (view === 'plan') {
    content = <Plan key={dataKey} onOpenMonth={() => goto('month')} />;
  } else if (view === 'year') {
    content = <Year key={dataKey} />;
  } else if (view === 'overview') {
    content = <Overview key={dataKey} onOpenMonth={(month) => goto('month', month)} />;
  } else if (view === 'patterns') {
    content = <Patterns key={dataKey} />;
  } else if (view === 'future') {
    content = <Future key={dataKey} />;
  } else if (view === 'home') {
    content = (
      <Home
        key={dataKey}
        profileName={activeProfile?.name ?? null}
        onNavigate={(v) => goto(v)}
        onOpenConnections={() => goto('connections')}
        onSyncNow={() => void sync()}
        onStartTour={() => setTourOpen(true)}
        syncing={syncing}
      />
    );
  } else {
    content = (
      <Month
        key={dataKey}
        month={reviewMonth}
        onNavigate={(month) => goto('month', month)}
        onOpenReview={() => goto('review')}
      />
    );
  }

  const ready = view !== 'loading' && view !== 'failed';
  const updateReady = updateState.status === 'downloaded';

  return (
    <div className={desktop ? 'desktop-app is-desktop' : 'desktop-app'}>
      {desktop && (
        <div className="desktop-titlebar" aria-label="סרגל הכותרת של מסגרת">
          <div className="desktop-titlebar-content">
            <div className="desktop-titlebar-brand" title={appInfo ? `מסגרת ${appInfo.version}` : 'מסגרת'}>
              <Logo size={20} />
              <span>מסגרת</span>
              {activeProfile && <span className="desktop-titlebar-view">· {activeProfile.name}</span>}
              {TITLES[view] && <span className="desktop-titlebar-view">/ {TITLES[view]}</span>}
            </div>
            <div className="desktop-titlebar-right">
              {updateReady && (
                <button
                  className="desktop-update-ready"
                  title={updateStateHe(updateState)}
                  onClick={() => void installReadyUpdate()}
                >
                  <ArrowDownToLine size={13} strokeWidth={2.4} aria-hidden="true" />
                  יש עדכון חדש · עדכן
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={rail ? 'shell rail' : 'shell'}>
      <aside id="app-sidebar" className={sidebarOpen ? 'sidebar open' : 'sidebar'} aria-label="ניווט באפליקציה">
        <div className="brand">
          <Logo />
          <span className="brand-name">מסגרת</span>
        </div>
        {ready && activeProfile && (
          <ProfileSwitcher
            profiles={profiles}
            activeId={activeId}
            blockedReason={switchBlockedReason}
            onSwitch={async (id) => { await switchProfile(id); }}
            onCreate={createProfile}
            onManage={() => goto('profiles')}
          />
        )}
        <nav className="side-nav" aria-label="ניווט ראשי">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={active === n.view ? 'nav-item active' : 'nav-item'}
              onClick={() => goto(n.view)}
              aria-current={active === n.view ? 'page' : undefined}
              aria-label={n.label}
              title={rail ? n.label : undefined}
            >
              <n.icon size={17} strokeWidth={1.75} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <nav className="side-nav side-nav-foot" aria-label="ניהול האפליקציה">
          {NAV_FOOT.map((n) => (
            <button
              key={n.view}
              className={active === n.view ? 'nav-item active' : 'nav-item'}
              onClick={() => goto(n.view)}
              aria-current={active === n.view ? 'page' : undefined}
              aria-label={n.label}
              title={rail ? n.label : undefined}
            >
              <n.icon size={17} strokeWidth={1.75} />
              <span>{n.label}</span>
            </button>
          ))}
          <button
            className={active === 'profiles' ? 'nav-item active' : 'nav-item'}
            onClick={() => goto('profiles')}
            aria-current={active === 'profiles' ? 'page' : undefined}
            aria-label="משתמשים"
            title={rail ? 'משתמשים' : undefined}
          >
            <Users size={17} strokeWidth={1.75} />
            <span>משתמשים</span>
          </button>
          <button
            className="nav-item rail-toggle"
            onClick={toggleRail}
            aria-pressed={rail}
            aria-label={rail ? 'הרחבת התפריט' : 'מזעור התפריט'}
            title={rail ? 'הרחבת התפריט' : 'מזעור התפריט'}
          >
            {rail
              ? <PanelRightOpen size={17} strokeWidth={1.75} />
              : <PanelRightClose size={17} strokeWidth={1.75} />}
            <span>מזעור</span>
          </button>
        </nav>
      </aside>
      <button
        className={sidebarOpen ? 'sidebar-scrim visible' : 'sidebar-scrim'}
        aria-label="סגירת תפריט הניווט"
        aria-hidden={!sidebarOpen}
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />

      <div className="main">
        <header className="header">
          <div className="header-heading">
            <button
              className="sidebar-toggle"
              onClick={() => setSidebarOpen((open) => !open)}
              aria-label={sidebarOpen ? 'סגירת תפריט הניווט' : 'פתיחת תפריט הניווט'}
              aria-controls="app-sidebar"
              aria-expanded={sidebarOpen}
            >
              <Menu size={18} aria-hidden="true" />
            </button>
            <h1 className="header-title">{TITLES[view]}</h1>
            {ready && activeProfile && (
              <button
                className="header-profile"
                onClick={() => goto('profiles')}
                title={`כל המספרים במסך הזה שייכים ל${activeProfile.name}`}
              >
                <i style={{ background: activeProfile.color }} aria-hidden="true" />
                {activeProfile.name}
              </button>
            )}
          </div>
          {ready && (
            <div className="header-actions">
              {syncing && progress && progress.items.length > 0 ? (
                <span className="muted sync-steps" dir="rtl" role="status" aria-live="polite">
                  {progress.items.map((i, idx) => (
                    <span className="sync-step" key={`${i.nickname ?? i.nameHe}-${idx}`}>
                      {i.nickname ?? i.nameHe} {PROGRESS_ICON[i.status]}
                    </span>
                  ))}
                </span>
              ) : (
                lastSyncAt && (
                  <span className="muted">
                    סנכרון אחרון: {new Date(lastSyncAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )
              )}
              <ThemeToggle />
              <button className="primary sync-btn" onClick={sync} disabled={syncing} aria-label={syncing ? 'סנכרון הנתונים מתבצע' : 'סנכרון הנתונים עכשיו'}>
                <RefreshCw size={15} strokeWidth={2} className={syncing ? 'spin' : ''} />
                {syncing ? 'מסנכרן…' : 'סנכרון'}
              </button>
            </div>
          )}
        </header>

        <div className="content-scroll">
        <main className="content" ref={mainRef} tabIndex={-1} id="main-content">
          {syncing && autoSynced && (
            <p className="muted" role="status" aria-live="polite">עברו יותר מ-12 שעות מהסנכרון האחרון — מסנכרן אוטומטית ברקע. אפשר להמשיך לעבוד.</p>
          )}
          {syncError && <p className="error" role="alert">{syncError}</p>}
          {syncFailures.length > 0 && (
            <div className="error" role="alert">
              {syncFailures.map((f) => (
                <div key={f.connectionId}>
                  {f.nickname ?? f.nameHe}: {errorTypeHe(f.errorType ?? 'GENERIC')}
                </div>
              ))}
            </div>
          )}
          {desktopNotice && <div className="desktop-toast" role="status" aria-live="polite">{desktopNotice}</div>}
          {whatsNew && appInfo && ready && (
            <WhatsNewModal entries={whatsNew} version={appInfo.version} onClose={dismissWhatsNew} />
          )}
          {tourOpen && ready && <TourModal onClose={() => setTourOpen(false)} />}
          <div className={`view view-${view}`} key={`${view}-${dataKey}`}>
            <ViewBoundary>{content}</ViewBoundary>
          </div>
        </main>

        <footer className="footer">
          <span>מסגרת — המסגרת הפיננסית שלך</span>
          <span>‏100% מקומי · ללא ענן של מסגרת · הנתונים נשמרים אצלך</span>
          <span>כלי חינוכי, לא ייעוץ פיננסי</span>
        </footer>
        </div>
      </div>
      </div>
    </div>
  );
}
