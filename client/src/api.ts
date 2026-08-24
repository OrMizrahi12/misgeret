import type {
  AccountStateApplyResponse, AccountStateApplyRow, AccountStatePreviewResponse, AppSettings, BackupInfo,
  BalanceHistoryResponse, BalanceRow, Cadence, CashflowPlan, CashflowResponse, CategoryHistory, Company, Connection, DashboardResponse,
  FlowCandidatesResponse, ForecastConfig, HealthReport, HoldingType, MonthReview, MonthTxn,
  ExchangeRate, ForecastAccuracyResponse, NetWorthResponse, OverviewResponse, ProfileSummary, ProfilesResponse, RatesResponse,
  ExpenseDetailView, InstallmentPlan, MerchantChargeHistory, ReviewTxn, ScenarioParams, SearchResponse, SpendingPatternsView, Status, SummaryResponse, SyncProgress, SyncResponse, TxnMark,
  PlanResponse,
  YearReport,
} from './types';

export class ApiError extends Error {
  constructor(
    public errorType: string,
    message?: string,
  ) {
    super(message ?? errorType);
  }
}

/** Which person's world every /api call addresses. Set once at boot and on every switch. */
let activeProfileId: string | null = null;

/** These answer for the installation, not for a person — a stale header must never 404 them. */
const GLOBAL_API = /^\/api\/(profiles|runtime)(?:[/?#]|$)/;

export function setActiveProfileId(id: string | null): void {
  activeProfileId = id;
}

export function getActiveProfileId(): string | null {
  return activeProfileId;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Site demo build only: answers come from a frozen recording, never a server.
  // In every other build this condition is a compile-time constant and the demo
  // chunk is neither shipped nor loaded.
  if (import.meta.env.VITE_DEMO === '1') {
    const { demoRequest } = await import('./demo');
    return demoRequest<T>(url, init);
  }
  const headers = new Headers(init?.headers);
  // Naming the profile on every call is what makes a query bug unable to cross the boundary:
  // there is no other database open on this request.
  if (activeProfileId && url.startsWith('/api/') && !GLOBAL_API.test(url)) {
    headers.set('X-Misgeret-Profile', activeProfileId);
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let body: { errorType?: string; errorMessage?: string } = {};
    try {
      body = await res.json();
    } catch {
      // non-JSON error body — fall back to status code
    }
    throw new ApiError(body.errorType ?? `HTTP_${res.status}`, body.errorMessage ?? undefined);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  profiles: () => request<ProfilesResponse>('/api/profiles'),
  createProfile: (payload: { name: string; color?: string }) =>
    request<{ profile: ProfileSummary }>('/api/profiles', jsonInit('POST', payload)),
  updateProfile: (id: string, payload: { name?: string; color?: string }) =>
    request<{ profile: ProfileSummary }>(`/api/profiles/${encodeURIComponent(id)}`, jsonInit('PUT', payload)),
  activateProfile: (id: string) =>
    request<{ activeId: string }>(`/api/profiles/${encodeURIComponent(id)}/activate`, { method: 'POST' }),
  reorderProfiles: (ids: string[]) =>
    request<{ profiles: ProfileSummary[] }>('/api/profiles/reorder', jsonInit('POST', { ids })),
  deleteProfile: (id: string) => request<void>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  status: () => request<Status>('/api/status'),
  companies: () => request<Company[]>('/api/companies'),
  connections: () => request<Connection[]>('/api/connections'),
  addConnection: (payload: { company: string; nickname?: string; credentials: Record<string, string> }) =>
    request<{ id: number }>('/api/connections', jsonInit('POST', payload)),
  updateConnection: (id: number, payload: { nickname?: string; credentials?: Record<string, string> }) =>
    request<{ id: number }>(`/api/connections/${id}`, jsonInit('PUT', payload)),
  deleteConnection: (id: number) => request<void>(`/api/connections/${id}`, { method: 'DELETE' }),
  sync: () => request<SyncResponse>('/api/sync', { method: 'POST' }),
  summary: () => request<SummaryResponse>('/api/summary'),
  monthTxns: (month: string) => request<{ txns: MonthTxn[] }>(`/api/months/${month}/txns`),
  getSettings: () => request<AppSettings>('/api/settings'),
  setMonths: (months: number) => request<AppSettings>('/api/settings', jsonInit('PUT', { months })),
  updateSettings: (payload: Partial<AppSettings>) => request<AppSettings>('/api/settings', jsonInit('PUT', payload)),
  balances: () => request<{ balances: BalanceRow[] }>('/api/balances'),
  balanceHistory: () => request<BalanceHistoryResponse>('/api/balance-history'),
  review: () => request<{ txns: ReviewTxn[] }>('/api/review'),
  setTxnCategory: (key: string, payload: { category: string; rulePattern?: string }) =>
    request<{ key: string; category: string; ruleId?: number }>(`/api/txns/${key}/category`, jsonInit('PUT', payload)),
  clearTxnCategory: (key: string) => request<void>(`/api/txns/${key}/category`, { method: 'DELETE' }),
  deleteRule: (id: number, revert = false) =>
    request<void>(`/api/rules/${id}${revert ? '?revert=1' : ''}`, { method: 'DELETE' }),
  rulePreview: (pattern: string) =>
    request<{ count: number }>(`/api/rules/preview?pattern=${encodeURIComponent(pattern)}`),
  search: (q: string) => request<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`),
  syncProgress: () => request<SyncProgress>('/api/sync/progress'),
  cashflow: (days?: number, scenario?: ScenarioParams) => {
    const q = new URLSearchParams();
    if (days) q.set('days', String(days));
    if (scenario?.extraMonthly) q.set('extraMonthly', String(scenario.extraMonthly));
    if (scenario?.oneOffAmount && scenario?.oneOffMonth) {
      q.set('oneOffAmount', String(scenario.oneOffAmount));
      q.set('oneOffMonth', scenario.oneOffMonth);
    }
    if (scenario?.variableFactor && scenario.variableFactor !== 1) q.set('variableFactor', String(scenario.variableFactor));
    const qs = q.toString();
    return request<CashflowResponse>(`/api/cashflow${qs ? `?${qs}` : ''}`);
  },
  forecastAccuracy: () => request<ForecastAccuracyResponse>('/api/forecast/accuracy'),
  cashflowPlan: () => request<CashflowPlan>('/api/cashflow/plan'),
  /** היעד שלי — the share of income to close each month with. A SHARE (0.15), never "15".
   *  null clears it: nothing is held back, and that is a legitimate answer. */
  setTarget: (rate: number | null) => request<{ rate: number | null }>('/api/target', jsonInit('PUT', { rate })),
  /** "התוכנית שלי" — the household's one declaration and everything it implies. */
  plan: () => request<PlanResponse>('/api/plan'),
  updateForecastConfig: (payload: Partial<ForecastConfig>) =>
    request<ForecastConfig>('/api/cashflow/config', jsonInit('PUT', payload)),
  dashboard: () => request<DashboardResponse>('/api/dashboard'),
  overview: (months: number) => request<OverviewResponse>(`/api/overview?months=${months}`),
  muteRecurring: (merchant: string, kind: 'income' | 'expense') =>
    request<{ ok: boolean }>('/api/recurring/mute', jsonInit('POST', { merchant, kind })),
  unmuteRecurring: (merchant: string, kind: 'income' | 'expense') =>
    request<{ ok: boolean }>('/api/recurring/unmute', jsonInit('POST', { merchant, kind })),
  expenseDetail: () => request<ExpenseDetailView>('/api/setup/subscriptions'),
  markTxn: (key: string, mark: TxnMark | null) =>
    request<{ ok: boolean }>('/api/setup/txn-mark', jsonInit('POST', { key, mark })),
  /** `expectedAmount` (the tagged charge's amount) anchors the subscription's monthly cost —
   *  "the amount I marked IS the amount". Omitted when clearing/dismissing. */
  applyMerchantMark: (merchant: string, mark: TxnMark | null, expectedAmount?: number) =>
    request<{ ok: boolean; applied: number }>('/api/setup/txn-mark/apply-merchant', jsonInit('POST', { merchant, mark, expectedAmount })),
  /** Re-anchor a subscription to a new monthly cost (the "עדכן ל-₪X" action on a price-change alert). */
  updateSubscriptionExpected: (merchant: string, amount: number) =>
    request<{ ok: boolean }>('/api/setup/subscription/expected', jsonInit('POST', { merchant, amount })),
  /** Silence a one-off price change so it stops nagging ("התעלם"). */
  dismissSubscriptionChange: (merchant: string, amount: number) =>
    request<{ ok: boolean }>('/api/setup/subscription/dismiss-change', jsonInit('POST', { merchant, amount })),
  /** Open installment plans (תשלומים): payments/amount left and when each frees up. */
  installments: () => request<{ plans: InstallmentPlan[] }>('/api/installments'),
  /** One merchant's full charge history + pattern, for the "היסטוריה ודפוס" popup. */
  merchantHistory: (merchant: string) =>
    request<MerchantChargeHistory>(`/api/merchant-history?merchant=${encodeURIComponent(merchant)}`),
  /** Every detected spending rhythm + its suggested nature, for the "מה יורד לי כל חודש?" tab. */
  patterns: () => request<SpendingPatternsView>('/api/patterns'),
  /** שכבת השנה — the annual statement; omit year for the current flow year. */
  year: (year?: string) => request<YearReport>(`/api/year${year ? `?year=${year}` : ''}`),
  /** One category's month-by-month history, for the "היסטוריית התשלומים" popup. */
  categoryHistory: (category: string) =>
    request<CategoryHistory>(`/api/category-history?category=${encodeURIComponent(category)}`),
  addManualRecurring: (payload: {
    name: string; amount: number; cadence: Cadence; dayOfMonth?: number | null; category?: string | null; mark?: 'subscription' | 'fixed';
  }) => request<{ id: number }>('/api/setup/manual-recurring', jsonInit('POST', payload)),
  deleteManualRecurring: (id: number) => request<void>(`/api/setup/manual-recurring/${id}`, { method: 'DELETE' }),
  health: (months?: number) => request<HealthReport>(`/api/health${months ? `?months=${months}` : ''}`),
  netWorth: () => request<NetWorthResponse>('/api/networth'),
  rates: () => request<RatesResponse>('/api/rates'),
  refreshRates: () => request<{ source: string; rates: ExchangeRate[] }>('/api/rates/refresh', { method: 'POST' }),
  // `amount` is always the magnitude the bank prints, non-negative — `type`/`kind` carry the sign (A8).
  addAsset: (payload: {
    name: string;
    kind: 'asset' | 'liability';
    amount: number;
    liquid?: boolean;
    type?: HoldingType;
    institution?: string | null;
    monthlyPayment?: number | null;
    currency?: string;
  }) => request<{ id: number }>('/api/assets', jsonInit('POST', payload)),
  /** Patch-shaped: only the fields sent change. Until now the client could not update an asset at
   *  all, which is what made asset_snapshots — the value timeline — dead code in practice. */
  updateAsset: (id: number, payload: {
    name?: string;
    amount?: number;
    liquid?: boolean;
    type?: HoldingType;
    institution?: string | null;
    monthlyPayment?: number | null;
    currency?: string;
  }) => request<{ id: number }>(`/api/assets/${id}`, jsonInit('PUT', payload)),
  accountStatePreview: (text: string) =>
    request<AccountStatePreviewResponse>('/api/account-state/preview', jsonInit('POST', { text })),
  accountStateApply: (rows: AccountStateApplyRow[]) =>
    request<AccountStateApplyResponse>('/api/account-state/apply', jsonInit('POST', { rows })),
  addManualTxn: (payload: { date: string; description: string; amount: number; category?: string }) =>
    request<{ key: string }>('/api/txns', jsonInit('POST', payload)),
  deleteTxn: (key: string) => request<void>(`/api/txns/${key}`, { method: 'DELETE' }),
  backup: () => request<{ file: string; profileId: string }>('/api/backup', { method: 'POST' }),
  backups: () => request<{ backups: BackupInfo[] }>('/api/backups'),
  restoreBackup: (file: string) => request<{ ok: boolean }>('/api/backups/restore', jsonInit('POST', { file })),
  issuerSectors: () => request<{ sectors: { sector: string; count: number }[] }>('/api/issuer-sectors'),
  mapIssuerSector: (sector: string, category: string) =>
    request<{ sector: string; category: string; updated: number }>('/api/issuer-sectors/map', jsonInit('POST', { sector, category })),
  flowCandidates: () => request<FlowCandidatesResponse>('/api/flow-candidates'),
  deleteAsset: (id: number) => request<void>(`/api/assets/${id}`, { method: 'DELETE' }),
  monthReview: (month: string) => request<MonthReview>(`/api/months/${month}/review`),
  clearData: () => request<{ txns: number; snapshots: number }>('/api/data', { method: 'DELETE' }),
  /** The deeper wipe: transactions AND the verdict/rule layer. Connections, assets, goals and
   *  settings survive. Takes an automatic safety copy first and names it in the response. */
  clearDataFull: () => request<{ txns: number; snapshots: number; verdicts: number; rules: number; backupFile: string }>(
    '/api/data/full', { method: 'DELETE' },
  ),
};

const ERROR_HE: Record<string, string> = {
  DEMO_MODE: 'זו סביבת דמו להתנסות — כאן רק מסתכלים 🙂 במסגרת המלאה (חינם) הכל עובד, עם הנתונים האמיתיים שלך.',
  DEMO_DATA_MISSING: 'נתוני הדמו לא נטענו. רענן את הדף ונסה שוב.',
  INVALID_PASSWORD: 'פרטי ההתחברות שגויים. עדכן אותם ונסה שוב.',
  CHANGE_PASSWORD: 'המוסד דורש החלפת סיסמה. היכנס לאתר שלו, עדכן סיסמה, ואז עדכן אותה גם כאן.',
  ACCOUNT_BLOCKED: 'הגישה לחשבון נחסמה. יש לפנות למוסד הפיננסי.',
  TIMEOUT: 'החיבור למוסד לקח יותר מדי זמן. נסה שוב בעוד כמה דקות.',
  // The library defines seven error types; these two used to fall through to GENERIC and be shown
  // as "שגיאה בסנכרון. נסה שוב מאוחר יותר. (GENERAL_ERROR)".
  GENERAL_ERROR: 'ההתחברות למוסד נכשלה לפני שהגיעה לחשבון. בדוק שהאתר של המוסד עולה בדפדפן ונסה שוב.',
  TWO_FACTOR_RETRIEVER_MISSING: 'המוסד הזה דורש קוד אימות חד-פעמי בזמן ההתחברות, ומסגרת אינה תומכת בזה.',
  // A hang or an unattributed failure at an institution whose scraper is known to be broken. Never
  // "try again in a few minutes" — that sends a person to retry something that cannot work.
  PROVIDER_OUTAGE: 'תקלה ידועה בצד המוסד — לא בפרטים שלך. ההסבר המלא מופיע במסך החיבורים.',
  NO_CONNECTIONS: 'אין חיבורים מוגדרים — הוסף חיבור במסך החיבורים.',
  NOT_FOUND: 'הפריט המבוקש לא נמצא.',
  INVALID_INPUT: 'קלט לא תקין — ודא שכל השדות מלאים.',
  RULE_EXISTS: 'חוק עם התבנית הזו כבר קיים.',
  SETTLEMENT_PATTERN: 'זהו חיוב של כרטיס אשראי. הנטרול שלו נקבע מחדש בכל חודש לפי הפירוט שהתקבל מהכרטיס עצמו, ולכן אי אפשר לקבע אותו כאן.',
  UNIDENTIFIED_CARD: 'זהו חיוב לכרטיס שמסגרת לא מזהה לאיזו חברת אשראי הוא שייך. סימון קבוע כתנועה פנימית היה מוחק הוצאה אמיתית בחודשים שבהם הפירוט של הכרטיס חלקי. חבר את הכרטיס הזה במסך החיבורים — אז החיוב ינוטרל אוטומטית, ורק בחודשים שבהם זה נכון.',
  AMBIGUOUS_HOLDING: 'יש יותר מהחזקה אחת מהסוג הזה, ומסגרת לא מנחשת לאיזו מהן הסכום בבנק מתייחס. עדכן אותה ידנית ברשימה למטה.',
  ACCOUNT_STATE_CHANGED: 'הנתונים השתנו מאז התצוגה המקדימה — שום דבר לא נכתב. הדבק שוב כדי לראות את המצב העדכני.',
  SYNC_RUNNING: 'סנכרון כבר רץ ברקע — המתן לסיומו.',
  APP_BUSY: 'מסגרת מבצעת פעולה אחרת כרגע. המתן לסיומה ונסה שוב.',
  IMPORT_FAILED: 'ייבוא הנתונים לא הושלם. מסד הנתונים הקיים נשאר ללא שינוי.',
  CREDENTIALS_UNAVAILABLE: 'פרטי ההתחברות אינם זמינים למשתמש Windows הזה. עדכן אותם כדי לחדש את הסנכרון.',
  PROFILE_NOT_FOUND: 'המשתמש הזה כבר לא קיים במסגרת. רענן את הדף כדי לראות את רשימת המשתמשים המעודכנת.',
  PROFILE_NAME_INVALID: 'שם המשתמש חייב להיות בין תו אחד ל-60 תווים.',
  PROFILE_NAME_EXISTS: 'כבר יש משתמש בשם הזה. בחר שם אחר כדי שלא תתבלבלו.',
  PROFILE_BUSY: 'המשתמש הזה באמצע פעולה (סנכרון, גיבוי או שחזור). המתן לסיומה ונסה שוב.',
  LAST_PROFILE: 'זה המשתמש היחיד במסגרת — חייב להישאר לפחות אחד.',
  PROFILE_OPEN_FAILED: 'לא ניתן לפתוח את הנתונים של המשתמש הזה. הקובץ נשאר במקומו — פתח את יומן האבחון.',
  PROFILE_DELETE_FAILED: 'לא ניתן להעביר את תיקיית המשתמש הצידה. שום נתון לא נמחק. נסה שוב בעוד רגע.',
  RUNTIME_SHUTTING_DOWN: 'מסגרת נסגרת כרגע. הפעולה לא בוצעה.',
  BACKUP_FAILED: 'יצירת הגיבוי נכשלה. הנתונים נשארו ללא שינוי.',
  GENERIC: 'שגיאה בסנכרון. נסה שוב מאוחר יותר.',
  UNKNOWN_ERROR: 'שגיאה לא צפויה. נסה שוב מאוחר יותר.',
};

export function errorTypeHe(errorType: string): string {
  return ERROR_HE[errorType] ?? `${ERROR_HE.GENERIC} (${errorType})`;
}

export function errorMessageHe(e: unknown): string {
  if (e instanceof ApiError) return errorTypeHe(e.errorType);
  return 'שגיאה בתקשורת עם השרת המקומי. ודא שהשרת רץ ורענן את הדף.';
}
