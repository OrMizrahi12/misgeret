import { Router, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  NOTE_AMBIGUOUS_HE, NOTE_DEPOSIT_FUNDING_HE, NOTE_NO_CARD_CONNECTED_HE, PANEL_LABELS_HE,
  createdHolding, decays, isApplicableLine, isHoldingType, kindForType, noteForAmbiguity, noteMissingCardBalanceHe,
  parseAccountState, remainingPaymentsTextHe, resolveLine, stalenessDays,
  type AccountStateLine, type ApplicableLine, type HoldingRef, type HoldingType, type Resolution,
} from './account-state.js';
import { balanceStats, reconstructDailyBalances } from './balance-history.js';
import {
  CATEGORY_IDS, merchantKey, merchantLabel, normalizePattern, resolveCategory, sectorToCategory,
  type CategoryId, type MerchantCategoryHints, type ResolveContext,
} from './categories.js';
import {
  companyKind, companyNameHe, companyOutage, flagExcluded, isSettlementShaped,
  listCompanies, settlementCompany, syncErrorType, syncWindowMonths,
  type FlaggedTxn, type FlowClass, type FlowOverrides,
} from './companies.js';
import { alertsFromInsights, forecastFloorAlert, type PendingAlert } from './alerts.js';
import { buildCardOutlook } from './cards.js';
import { buildExpectation } from './expectation.js';
import { buildAdvice, type Advice, type AdviceGoalSeed } from './advice.js';
import { applyLens, buildFlowCalendar, effectiveDate, monthsBack, type FlowCalendar, type FlowSettings } from './flow.js';
import {
  computeDrift, frameForMonth, frameProposal, proposeSplit, splitProgress, variableByMonth,
  type FrameProposal,
} from './frame.js';
import { goalProgress } from './goals.js';
import {
  analyzeVariableSpend, applyForecastConfigPatch, calibrateDrift, forecastBalance, impliedMonthlyNet,
  parseForecastConfig, projectEvents,
  MAX_HORIZON_DAYS, MIN_HORIZON_DAYS, MAX_LOOKBACK_BLOCKS,
  type CalibrationMonth, type ForecastEvent, type ForecastExplain, type KnownCharge,
} from './forecast.js';
import { CURRENCIES, RATE_FRESH_HOURS, fetchIlsRates, isSupportedCurrency } from './currency.js';
import { monthInsights, topMerchants } from './insights.js';
import { computeMetrics } from './metrics.js';
import { LAYER_KEYS, buildLayerValues, computeAttribution, grossTotals, holdingLayer } from './networth.js';
import { computeOverview } from './overview.js';
import { addDays, bankCashFlows, detectRecurring } from './recurring.js';
import {
  activeInstallmentPlans, anchorsToBackfill, buildExpenseDetail, deriveMerchantMarks, isClassifiableExpense,
  manualToRecurringItem, merchantHistory, promotedRecurringItems, subscriptionMerchants, subscriptionPriceChanges,
} from './subscriptions.js';
import { spendingPatterns } from './patterns.js';
import { isValidTargetRate, savingsTarget } from './target.js';
import { computeCategoryHistory, computeYear } from './year.js';
import { decryptCredentials, encryptCredentials, isLegacyCredentialBlob } from './credentials.js';
import type { FinanceDb } from './db.js';
import { OperationCoordinator, type OperationKind } from './operation-coordinator.js';
import type { BankScraper } from './scraper.js';
import type { RuntimeInfo } from './runtime-info.js';
import { dedupeAcrossConnections, makeTxnKey, monthKey, toCategoryBreakdown, toMonthlySummary } from './txns.js';
import { dataDir as defaultDataDir } from './paths.js';
import {
  automaticBackupFileName,
  isManualBackupFile,
  manualBackupFileName,
  pruneAutomaticBackups,
} from './backup-policy.js';

/** One line of the מצב החשבון panel — the bank's summary, mirrored line for line. */
export interface AccountStateRow {
  line: AccountStateLine;
  labelHe: string;
  /** The row's contribution to netBank, sign included — this is what the panel prints.
   *  `null` means we have no number and MUST render `אין נתון`; it never means zero. */
  signedAmount: number | null;
  source: 'scraped' | 'manual' | 'none';
  /** The single holding behind the row, or null when there are none or more than one. */
  assetId: number | null;
  holdingCount: number;
  /** Oldest touch/confirm across the row's holdings — the weakest link is the honest one. */
  updatedAt: string | null;
  stale: boolean;
  ambiguous: boolean;
  monthlyPayment: number | null;
  /** The bound AND its caveat as one string: the number alone would be a flattering lie (A2). */
  remainingPaymentsHe: string | null;
  noteHe: string | null;
}

/** Display-range choices. 0 = everything we hold. This is a VIEW filter only — sync depth
 *  is fixed and deep, because data the institutions age out can never be fetched later. */
const ALLOWED_MONTHS = [3, 6, 12, 24, 0];
const DEFAULT_MONTHS = 6;

/** Today in Israel local time (YYYY-MM-DD). Everything month-related derives from this —
 *  the packaged desktop inherits the user's OS timezone, so raw Date.getMonth() would drift
 *  off the Asia/Jerusalem bucketing the rest of the pipeline uses. */
function israelToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** First month (YYYY-MM) of an N-month window ending in the current Israel-local month. */
function windowStartMonth(months: number, today = israelToday()): string {
  return monthsBack(today.slice(0, 7), months - 1);
}

/** Same window start as a Date (UTC midnight of the first day) — the scraper start date. */
export function windowStart(months: number, today = israelToday()): Date {
  return new Date(`${windowStartMonth(months, today)}-01T00:00:00.000Z`);
}

function getMonths(db: FinanceDb): number {
  const raw = db.getSetting('months');
  if (raw === null) return DEFAULT_MONTHS; // unset must not collapse into 0 ("all")
  const n = Number(raw);
  return ALLOWED_MONTHS.includes(n) ? n : DEFAULT_MONTHS;
}

function getFlow(db: FinanceDb): FlowSettings {
  const lens = db.getSetting('monthLens');
  const anchor = Number(db.getSetting('monthStartDay'));
  return {
    // purchase-dating is the default (the RiseUp conception); charge stays an explicit choice
    lens: lens === 'charge' ? 'charge' : 'purchase',
    anchorDay: Number.isInteger(anchor) && anchor >= 1 && anchor <= 28 ? anchor : 1,
  };
}

/** The checking account's credit line (מסגרת עו"ש) — the forecast's real red line.
 *  Not in any scraped data, so the user tells us. Default 0 = the classic zero line. */
function getOverdraftLimit(db: FinanceDb): number {
  const n = Number(db.getSetting('overdraftLimit'));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function getAutoSyncOnOpen(db: FinanceDb): boolean {
  return db.getSetting('autoSyncOnOpen') !== '0';
}

/** היעד — the share of income the household wants to close each month with, or null while
 *  nothing has been declared. Nothing is protected and nothing binds until it is. */
function getTargetRate(db: FinanceDb): number | null {
  const raw = db.getSetting('savingsTargetRate');
  if (raw === null) return null;
  const n = Number(raw);
  return isValidTargetRate(n) ? n : null;
}

/** The currency net worth is expressed in. The bank/flow world stays ILS as reported —
 *  this setting governs the balance-sheet tab, where foreign holdings live. */
function getPrimaryCurrency(db: FinanceDb): string {
  const c = db.getSetting('primaryCurrency');
  return isSupportedCurrency(c) ? c : 'ILS';
}

/** The forecast's tunables (model, lookback, weekday shape, band, horizon) — one JSON row,
 *  parsed defensively so a bad value can never brick the cashflow screen. */
function getForecastConfig(db: FinanceDb) {
  return parseForecastConfig(db.getSetting('forecastConfig'));
}

function connectedCardCompanies(db: FinanceDb): Set<string> {
  return new Set(
    db.getConnections()
      .filter((c) => companyKind(c.company) === 'card')
      .map((c) => c.company),
  );
}

/** Returns the validated + trimmed login fields for a company, or null if invalid. */
function validateCredentials(company: string, credentials: unknown): Record<string, string> | null {
  const info = listCompanies().find((c) => c.id === company);
  if (!info) return null;
  const raw = (credentials ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of info.loginFields) {
    const v = raw[f.name];
    if (typeof v !== 'string' || !v.trim()) return null;
    out[f.name] = f.name === 'password' ? v : v.trim();
  }
  return out;
}

function logRedactedFailure(scope: string, error: unknown): void {
  const record = typeof error === 'object' && error !== null ? error as { name?: unknown; code?: unknown } : null;
  const name = typeof record?.name === 'string' && /^[A-Za-z]+Error$/.test(record.name) ? record.name : 'Error';
  const code = typeof record?.code === 'string' && /^[A-Z0-9_]+$/.test(record.code) ? record.code : undefined;
  console.error(`[${scope}] failed`, code ? { name, code } : { name });
}

/** The headless browsers are shared across every profile: two syncing must not spawn four. */
export interface ScrapeSemaphore {
  acquire(): Promise<() => void>;
}

export interface ApiOptions {
  coordinator?: OperationCoordinator;
  runtime?: RuntimeInfo;
  backupsDir?: string;
  desktopActionAuthorizationRequired?: boolean;
  /** The profile this router answers for; absent in the single-workspace shape. */
  profileId?: string;
  /** The registry root. `dataDir` is this router's profile directory, not the runtime's root. */
  rootDataDir?: string;
  scrapeSemaphore?: ScrapeSemaphore;
  /** Injected in tests; production uses global fetch against the free public rate providers. */
  rateFetcher?: Parameters<typeof fetchIlsRates>[0];
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function createApi(
  db: FinanceDb,
  scraper: BankScraper,
  dataDir: string = defaultDataDir,
  options: ApiOptions = {},
): Router {
  const router = Router();
  const backupsDir = options.backupsDir ?? path.join(dataDir, 'backups');
  const coordinator = options.coordinator ?? new OperationCoordinator();
  const rootDataDir = options.rootDataDir ?? dataDir;
  const scrapeSemaphore = options.scrapeSemaphore ?? { acquire: async () => () => {} };

  /* ——— FX: the cached shekel rate per unit, with its honest age ——— */

  function ratesMap(): Map<string, { rate: number; fetchedAt: string }> {
    return new Map(db.getExchangeRates().map((r) => [r.currency, { rate: r.rate, fetchedAt: r.fetchedAt }]));
  }

  /** The emergency-buffer resource in shekels — the metrics live in the ILS bank-world.
   *  A foreign holding with no cached rate contributes NOTHING rather than pricing 1:1;
   *  in practice a rate always exists, because creating the holding required one. */
  function liquidAssetsIls(): number {
    const rates = ratesMap();
    return db.getAssets()
      .filter((a) => a.kind === 'asset' && a.liquid)
      .reduce((s, a) => s + a.amount * (a.currency === 'ILS' ? 1 : rates.get(a.currency)?.rate ?? 0), 0);
  }

  /** Refresh the rates the liquid holdings are priced with, then return the shekel total.
   *  Without this, "כרית חירום" quoted whatever rate happened to be cached — so opening ההון first
   *  (it refreshes) and opening בריאות first produced two different liquid figures for the same
   *  money on the same day: 110,828 ₪ against 110,694 ₪. Whoever asks, the answer is one number. */
  async function liquidAssetsIlsFresh(): Promise<number> {
    await ensureRates(db.getAssets().filter((a) => a.kind === 'asset' && a.liquid).map((a) => a.currency));
    return liquidAssetsIls();
  }

  /** Refresh the cache when any needed rate is missing or stale. Never throws — the caller
   *  proceeds with the cache and its age. An ILS-only need triggers NO network call at all:
   *  the everything-local doctrine bends only for public rates, and only when actually used. */
  async function ensureRates(needed: string[]): Promise<void> {
    const foreign = [...new Set(needed.filter((c) => c !== 'ILS'))];
    if (foreign.length === 0) return;
    const cache = ratesMap();
    const now = Date.now();
    const fresh = (c: string) => {
      const hit = cache.get(c);
      return !!hit && now - Date.parse(hit.fetchedAt) < RATE_FRESH_HOURS * 3_600_000;
    };
    if (foreign.every(fresh)) return;
    try {
      const { ratesIlsPerUnit } = await fetchIlsRates(options.rateFetcher);
      db.setExchangeRates(ratesIlsPerUnit, new Date().toISOString());
    } catch {
      // offline or both providers down — the cache and its age are the truth we have
    }
  }

  /** What each merchant was already categorized as, by trust order: user > rule > issuer.
   *  Lets the auto tier stamp a NEW row of a KNOWN merchant without any pattern matching. */
  function merchantHints(): MerchantCategoryHints {
    const priority: Record<string, number> = { user: 3, rule: 2, issuer: 1 };
    const best = new Map<string, { category: CategoryId; p: number }>();
    for (const r of db.getTxnsSinceMonth('0000-00')) {
      if (!r.category || r.category === 'other') continue;
      const p = priority[r.categorySource ?? ''] ?? 0;
      if (p === 0) continue;
      const m = normalizePattern(r.description);
      if (m.length < 2) continue;
      const prev = best.get(m);
      if (!prev || p > prev.p) best.set(m, { category: r.category as CategoryId, p });
    }
    return new Map([...best.entries()].map(([m, v]) => [m, v.category]));
  }

  /** Everything the automatic tiers need beyond the row itself. */
  function resolveContext(): ResolveContext {
    return {
      hints: merchantHints(),
      sectorOverrides: new Map(db.getSectorOverrides().map((o) => [o.sector, o.category as CategoryId])),
    };
  }

  function flowOverrides(): FlowOverrides {
    return new Map(db.getFlowOverrides().map((o) => [o.pattern, o.class]));
  }

  /** One-time backfill: the zero-uncategorized guarantee applied to everything already stored.
   *  Every transaction gets a category — 'other' is the refinable floor, never null.
   *  Version bumps re-run over machine-made ('auto') rows only; user/rule/issuer stamps stay. */
  function backfillCategories(): void {
    if (db.getSetting('autoCategorize') === 'v3') return;
    const rules = db.getRules();
    const context = resolveContext();
    // 'income' is the naive positive-credit fallback — a machine stamp, exactly as re-resolvable
    // as 'auto'. Without it a deposit's principal keeps its income stamp forever.
    const candidates = [
      ...db.getUncategorizedSinceMonth('0000-00'),
      ...db.getTxnsSinceMonth('0000-00').filter((t) => t.categorySource === 'auto' || t.categorySource === 'income'),
    ];
    const pending = candidates.map((t) => {
      const resolved = resolveCategory(t, rules, context);
      return { key: t.key, category: resolved.category, source: resolved.source };
    });
    if (pending.length > 0) db.setResolvedCategories(pending);
    db.setSetting('autoCategorize', 'v3');
  }
  backfillCategories();

  const rejectBusy = (res: Response, requested: OperationKind) => {
    res.status(409).json({
      errorType: 'APP_BUSY',
      errorMessage: `cannot start ${requested} while application state is ${coordinator.state}`,
      operation: coordinator.state,
    });
  };

  if (options.runtime) {
    router.get('/runtime', (_req, res) => {
      res.json(options.runtime);
    });
  }

  router.use((req, res, next) => {
    if (coordinator.state === 'restoring' || coordinator.state === 'migrating' || coordinator.state === 'shuttingDown') {
      res.status(409).json({
        errorType: 'APP_BUSY',
        errorMessage: `application state is ${coordinator.state}`,
        operation: coordinator.state,
      });
      return;
    }
    if (coordinator.state === 'syncing' && req.method !== 'GET' && req.path !== '/sync') {
      res.status(409).json({
        errorType: 'APP_BUSY',
        errorMessage: 'application state is syncing',
        operation: 'syncing',
      });
      return;
    }
    next();
  });

  router.get('/status', (_req, res) => {
    res.json({
      connectionCount: db.getConnections().length,
      lastSyncAt: db.getSetting('lastSyncAt'),
      autoSyncOnOpen: getAutoSyncOnOpen(db),
    });
  });

  router.get('/companies', (_req, res) => {
    res.json(listCompanies());
  });

  router.get('/connections', (_req, res) => {
    res.json(db.getConnections().map((c) => ({
      ...c,
      nameHe: companyNameHe(c.company),
      historyMonths: syncWindowMonths(c.company),
      outage: companyOutage(c.company),
    })));
  });

  router.post('/connections', (req, res) => {
    const { company, nickname, credentials } = (req.body ?? {}) as {
      company?: unknown;
      nickname?: unknown;
      credentials?: unknown;
    };
    const creds = typeof company === 'string' ? validateCredentials(company, credentials) : null;
    if (!creds) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'unknown company or missing login fields' });
      return;
    }
    const nick = typeof nickname === 'string' && nickname.trim() ? nickname.trim() : null;
    const id = db.addConnection(company as string, nick, encryptCredentials(creds));
    res.status(201).json({ id });
  });

  router.put('/connections/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.getConnections().find((c) => c.id === id);
    if (!existing) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const { nickname, credentials } = (req.body ?? {}) as { nickname?: unknown; credentials?: unknown };
    let blob: Buffer | null = null;
    if (credentials !== undefined) {
      const creds = validateCredentials(existing.company, credentials);
      if (!creds) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'missing login fields' });
        return;
      }
      blob = encryptCredentials(creds);
    }
    const nick = typeof nickname === 'string' ? nickname.trim() || null : existing.nickname;
    db.updateConnection(id, nick, blob);
    res.json({ id });
  });

  router.delete('/connections/:id', (req, res) => {
    if (!db.deleteConnection(Number(req.params.id))) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.status(204).end();
  });

  function settingsPayload() {
    const flow = getFlow(db);
    // the detected salary day powers the "anchor the month to your salary" suggestion —
    // a CURRENT salary; a job left months ago must not anchor anything
    const salary = analysisData().recurring.find(
      (r) => r.kind === 'income' && r.amountStable && !r.provisional && r.active && r.amount >= 3000,
    );
    return {
      months: getMonths(db),
      monthLens: flow.lens,
      monthStartDay: flow.anchorDay,
      overdraftLimit: getOverdraftLimit(db),
      autoSyncOnOpen: getAutoSyncOnOpen(db),
      primaryCurrency: getPrimaryCurrency(db),
      suggestedAnchorDay: salary ? salary.dayOfMonth : null,
    };
  }

  router.get('/settings', (_req, res) => {
    res.json(settingsPayload());
  });

  /** Partial update — only the provided keys change. */
  router.put('/settings', (req, res) => {
    const { months, monthLens, monthStartDay, overdraftLimit, autoSyncOnOpen, primaryCurrency } = (req.body ?? {}) as {
      months?: unknown;
      monthLens?: unknown;
      monthStartDay?: unknown;
      overdraftLimit?: unknown;
      autoSyncOnOpen?: unknown;
      primaryCurrency?: unknown;
    };
    if (months !== undefined && !ALLOWED_MONTHS.includes(Number(months))) {
      res.status(400).json({
        errorType: 'INVALID_INPUT',
        errorMessage: `months must be one of: ${ALLOWED_MONTHS.join(', ')}`,
      });
      return;
    }
    if (monthLens !== undefined && monthLens !== 'charge' && monthLens !== 'purchase') {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'monthLens must be charge or purchase' });
      return;
    }
    const anchor = monthStartDay === undefined ? undefined : Number(monthStartDay);
    if (anchor !== undefined && (!Number.isInteger(anchor) || anchor < 1 || anchor > 28)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'monthStartDay must be an integer 1-28' });
      return;
    }
    const overdraft = overdraftLimit === undefined ? undefined : Number(overdraftLimit);
    if (overdraft !== undefined && (!Number.isFinite(overdraft) || overdraft < 0)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'overdraftLimit must be a non-negative number' });
      return;
    }
    if (autoSyncOnOpen !== undefined && typeof autoSyncOnOpen !== 'boolean') {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'autoSyncOnOpen must be a boolean' });
      return;
    }
    if (primaryCurrency !== undefined && !isSupportedCurrency(primaryCurrency)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'primaryCurrency must be a supported ISO code' });
      return;
    }
    if (months !== undefined) db.setSetting('months', String(Number(months)));
    if (monthLens !== undefined) db.setSetting('monthLens', monthLens as string);
    if (anchor !== undefined) db.setSetting('monthStartDay', String(anchor));
    if (overdraft !== undefined) db.setSetting('overdraftLimit', String(overdraft));
    if (autoSyncOnOpen !== undefined) db.setSetting('autoSyncOnOpen', autoSyncOnOpen ? '1' : '0');
    if (primaryCurrency !== undefined) db.setSetting('primaryCurrency', primaryCurrency as string);
    res.json(settingsPayload());
  });

  /* ——— FX rates: cache + manual refresh. Public data only; nothing personal leaves ——— */

  router.get('/rates', (_req, res) => {
    res.json({
      primaryCurrency: getPrimaryCurrency(db),
      currencies: CURRENCIES,
      rates: db.getExchangeRates(),
    });
  });

  router.post('/rates/refresh', async (_req, res) => {
    try {
      const { ratesIlsPerUnit, source } = await fetchIlsRates(options.rateFetcher);
      db.setExchangeRates(ratesIlsPerUnit, new Date().toISOString());
      res.json({ source, rates: db.getExchangeRates() });
    } catch {
      res.status(502).json({
        errorType: 'RATES_UNAVAILABLE',
        errorMessage: 'שערי המט״ח אינם זמינים כרגע — בדוק את החיבור לאינטרנט ונסה שוב. בינתיים משמש השער האחרון שנשמר.',
        rates: db.getExchangeRates(),
      });
    }
  });

  type SyncItemStatus = 'pending' | 'running' | 'ok' | 'error';
  interface SyncResultItem {
    connectionId: number; company: string; nameHe: string; nickname: string | null;
    success: boolean; added: number; errorType?: string;
  }
  let syncProgress: {
    running: boolean;
    items: { connectionId: number; nameHe: string; nickname: string | null; status: SyncItemStatus }[];
  } = { running: false, items: [] };

  /** Live per-connection sync state — a scrape is minutes of headless browser; the UI polls this. */
  router.get('/sync/progress', (_req, res) => {
    res.json(syncProgress);
  });

  router.post('/sync', async (_req, res) => {
    const connections = db.getConnections();
    if (connections.length === 0) {
      res.status(400).json({ errorType: 'NO_CONNECTIONS', errorMessage: 'no connections configured' });
      return;
    }
    if (syncProgress.running) {
      res.status(409).json({ errorType: 'SYNC_RUNNING', errorMessage: 'a sync is already in progress' });
      return;
    }
    const operation = coordinator.tryBegin('syncing');
    if (!operation) {
      rejectBusy(res, 'syncing');
      return;
    }
    try {
    const rules = db.getRules();
    const context = resolveContext();
    syncProgress = {
      running: true,
      items: connections.map((c) => ({
        connectionId: c.id, nameHe: companyNameHe(c.company), nickname: c.nickname, status: 'pending' as SyncItemStatus,
      })),
    };
    const mark = (id: number, status: SyncItemStatus) => {
      const it = syncProgress.items.find((i) => i.connectionId === id);
      if (it) it.status = status;
    };
    const results: SyncResultItem[] = new Array(connections.length);

    const scrapeOne = async (conn: (typeof connections)[number], i: number) => {
      const base = {
        connectionId: conn.id,
        company: conn.company,
        nameHe: companyNameHe(conn.company),
        nickname: conn.nickname,
      };
      mark(conn.id, 'running');
      // Always as deep as the institution allows — never couple fetch depth to the view. But the
      // scrapers clamp their own start date silently, and eleven of the sixteen we offer cap at a
      // year (Yahav at three months): asking every one of them for 24 is a number we tell ourselves
      // and cannot keep. Ask each for what it will actually give, and quote THAT to the person.
      const startDate = windowStart(syncWindowMonths(conn.company));
      try {
        const blob = db.getConnectionCredentials(conn.id);
        if (!blob) throw new Error('missing credentials blob');
        const credentials = decryptCredentials(blob);
        if (isLegacyCredentialBlob(blob)) db.replaceConnectionCredentials(conn.id, encryptCredentials(credentials));
        // The browser permit is global: this profile's two workers queue behind every other
        // profile's, so N profiles syncing at once still spawn two browsers, not 2N.
        const releasePermit = await scrapeSemaphore.acquire();
        let outcome;
        try {
          outcome = await scraper.scrape({ connectionId: conn.id, company: conn.company }, credentials, startDate);
        } finally {
          releasePermit();
        }
        if (outcome.success) {
          // zero-uncategorized guarantee: every incoming row leaves with a category
          const withCategories = outcome.txns.map((t) => {
            const resolved = resolveCategory(t, rules, context);
            return { ...t, category: resolved.category, categorySource: resolved.source };
          });
          const added = db.insertTxnsForSync(conn.id, withCategories);
          const takenAt = new Date().toISOString();
          for (const acc of outcome.accounts) {
            if (acc.balance !== null) db.insertSnapshot(conn.id, acc.accountNumber, acc.balance, acc.balanceDate, takenAt);
          }
          db.setConnectionSyncResult(conn.id, takenAt, null);
          results[i] = { ...base, success: true, added };
          mark(conn.id, 'ok');
        } else {
          // One sanitised, outage-aware code for all three consumers — the log, the stored
          // lastError and the response. They used to disagree: the log was sanitised and the other
          // two took the library's string raw, straight into the database and onto the screen.
          const errorType = syncErrorType(conn.company, outcome.errorType);
          console.error(`[sync] ${conn.company}#${conn.id} failed`, { errorType });
          db.setConnectionSyncResult(conn.id, conn.lastSyncAt, errorType);
          results[i] = { ...base, success: false, added: 0, errorType };
          mark(conn.id, 'error');
        }
      } catch (err) {
        logRedactedFailure(`sync:${conn.company}#${conn.id}`, err);
        db.setConnectionSyncResult(conn.id, conn.lastSyncAt, 'GENERIC');
        results[i] = { ...base, success: false, added: 0, errorType: 'GENERIC' };
        mark(conn.id, 'error');
      }
    };

    // two headless browsers at a time: parallel enough to halve wall-clock, sane on memory
    const queue = connections.map((c, i) => [c, i] as const);
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        await scrapeOne(next[0], next[1]);
      }
    });
    try {
      await Promise.all(workers);
    } finally {
      syncProgress = { ...syncProgress, running: false };
    }

    let lastSyncAt = db.getSetting('lastSyncAt');
    if (results.some((r) => r.success)) {
      lastSyncAt = new Date().toISOString();
      db.setSetting('lastSyncAt', lastSyncAt);
      recordForecastSnapshots(); // fresh data → a receipt for the accuracy audit
    }
    res.json({ results, lastSyncAt });
    } finally {
      operation.release();
    }
  });

  /** dedupe → reality exclusions → salary-aware calendar → lens re-bucketing: the one
   *  pipeline every read shares. Always over ALL data — the calendar's boundaries and the
   *  exclusion sums must never be computed off a subset (two endpoints would bucket the same
   *  transaction into different months). Callers cut their own windows by flow month. */
  function readAll(): { rows: FlaggedTxn[]; cal: FlowCalendar } {
    const flagged = flagExcluded(
      dedupeAcrossConnections(db.getTxnsSinceMonth('0000-00')), connectedCardCompanies(db), flowOverrides());
    const cal = buildFlowCalendar(flagged, getFlow(db));
    return { rows: applyLens(flagged, getFlow(db), todayLocal(), cal), cal };
  }
  function readLensed(): FlaggedTxn[] {
    return readAll().rows;
  }

  router.get('/summary', (_req, res) => {
    const months = getMonths(db);
    // flag over ALL data (exclusion sums must never see a subset), then cut the view window
    const { rows: all, cal } = readAll();
    const currentFlow = cal.monthOf(todayLocal());
    const fromFlow = months === 0 ? null : monthsBack(currentFlow, months - 1);
    const flagged = fromFlow ? all.filter((r) => r.month >= fromFlow) : all;
    const breakdown = toCategoryBreakdown(flagged);
    const summary = toMonthlySummary(flagged).map((m) => ({ ...m, byCategory: breakdown[m.month] ?? [] }));
    // nothing is ever uncategorized — the refine queue is the auto-'other' floor, an offer, not a debt
    const reviewCount = all.filter(
      (r) => r.status === 'completed' && !r.excluded && r.category === 'other' && r.categorySource === 'auto',
    ).length;
    // the strongest observation about the running month deserves a line on the dashboard
    const analysis = analysisData();
    const top = monthInsights(currentFlow, analysis.rows, analysis.recurring, cal.monthOf)[0];
    const topInsight = top ? { month: currentFlow, type: top.type, textHe: top.textHe } : null;
    res.json({ months, summary, reviewCount, topInsight });
  });

  /** The financial situation room — everything the dashboard shows, in one composition.
   *  Four strips by decision urgency: pulse (liquid position after the upcoming charge),
   *  the month (plan hero + DAY-ADJUSTED comparison + a ranked action queue where silence
   *  is the headline), trajectory (YTD delta, green streak, rolling savings rate, one
   *  health chip), composition (top categories vs their 3-month median).
   *  See docs/2026-07-14-dashboard-vision.md. */
  router.get('/dashboard', async (_req, res) => {
    const { rows, recurring, cal, all } = analysisData();
    const today = todayLocal();
    const flow = getFlow(db);
    const round = (n: number) => Math.round(n * 100) / 100;
    const median = (nums: number[]) => {
      const s = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length === 0 ? 0 : s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

    const plan = monthlyPlan(rows, recurring, today, cal);
    const { month, daysElapsed } = plan;

    // ── pulse: the liquid truth, AFTER what is already committed ────────────────────────
    const snap = latestBankSnapshot();
    let bankBalance: number | null = null;
    if (snap) {
      const sinceSnapshot = rows
        .filter((r) =>
          companyKind(r.company) === 'bank' && r.status === 'completed' &&
          localDay(r.date) > snap.latestDate && localDay(r.date) <= today)
        .reduce((s, r) => s + r.amount, 0);
      bankBalance = round(snap.latestBankBalance + sinceSnapshot);
    }
    // the nearest card debit: what the delivered cycle already shows, or the settlement
    // streams' projection — the conservative (larger) of the two, like the forecast does
    const knownByDay = new Map<string, number>();
    for (const r of rows) {
      if (companyKind(r.company) !== 'card' || r.status !== 'completed' || !r.processedDate) continue;
      const d = localDay(r.processedDate);
      if (d <= today) continue;
      knownByDay.set(d, round((knownByDay.get(d) ?? 0) + r.amount));
    }
    // ONLY settlement streams are card debits. excludedFlow alone would let a renewing פק"ם — or
    // a monthly העברה עצמית — announce itself as the upcoming charge, which is the fiction the
    // exclusion engine exists to delete, resurrected on the dashboard's most prominent number.
    const streamItems = recurring.filter(
      (i) => i.excludeReason === 'settlement' && i.kind === 'expense' && i.forecastEligible);
    const streamDate = streamItems.map((i) => i.nextDate).sort()[0] ?? null;
    const streamSum = streamDate
      ? round(streamItems.filter((i) => Math.abs(dayDiff(i.nextDate, streamDate)) <= 7).reduce((s, i) => s + i.amount, 0))
      : 0;
    const knownDate = [...knownByDay.keys()].sort()[0] ?? null;
    const knownSum = knownDate ? knownByDay.get(knownDate)! : 0;
    let upcomingCharge: { date: string; amount: number } | null = null;
    if (knownDate && streamDate && Math.abs(dayDiff(knownDate, streamDate)) <= 7) {
      upcomingCharge = { date: knownDate, amount: Math.min(knownSum, streamSum) };
    } else if (knownDate || streamDate) {
      const d = [knownDate, streamDate].filter((x): x is string => x !== null).sort()[0];
      upcomingCharge = { date: d, amount: d === knownDate ? knownSum : streamSum };
    }
    const lastSyncAt = db.getSetting('lastSyncAt');
    const syncAgeHours = lastSyncAt ? Math.round((Date.now() - Date.parse(lastSyncAt)) / 3_600_000) : null;

    // ── the month: day-adjusted triple — month-to-date vs the SAME day count last month ──
    const monthRows = rows.filter((r) => r.month === month && r.status === 'completed' && !r.excluded);
    const triple = {
      income: round(monthRows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
      expenses: round(monthRows.filter((r) => r.amount < 0).reduce((s, r) => s + -r.amount, 0)),
      net: 0,
    };
    triple.net = round(triple.income - triple.expenses);
    const prevMonth = monthsBack(month, 1);
    const prevStart = cal.startOf(prevMonth);
    const prevRows = rows.filter((r) =>
      r.month === prevMonth && r.status === 'completed' && !r.excluded &&
      dayDiff(prevStart, localDay(effectiveDate(r, flow.lens))) + 1 <= daysElapsed);
    const prevTriple = {
      income: round(prevRows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)),
      expenses: round(prevRows.filter((r) => r.amount < 0).reduce((s, r) => s + -r.amount, 0)),
      net: 0,
    };
    prevTriple.net = round(prevTriple.income - prevTriple.expenses);

    // ── the action queue: few, ranked by money, silence is the headline ─────────────────
    type Action = {
      id: string; severity: 'red' | 'yellow' | 'info'; textHe: string; target: string;
      /** A price-change alert carries the data to resolve it inline (re-anchor / dismiss). */
      resolve?: { kind: 'price-change'; merchant: string; oldAmount: number; newAmount: number; month: string };
    };
    const actions: Action[] = [];
    const ILS = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
    const insights = monthInsights(month, rows, recurring, cal.monthOf);
    const dup = insights.find((i) => i.type === 'duplicate-charge');
    if (dup) actions.push({ id: 'duplicate', severity: 'red', textHe: dup.textHe, target: 'monthreview' });
    if (plan.paceEndOfMonth < 0) {
      actions.push({
        id: 'pace', severity: 'yellow',
        textHe: `בקצב ההוצאה הנוכחי החודש ייסגר ב־${ILS.format(plan.paceEndOfMonth)} — נדרשת האטה של ${ILS.format(Math.abs(plan.paceEndOfMonth) / plan.daysLeft)} ליום`,
        target: 'cashflow',
      });
    }
    if (syncAgeHours === null || syncAgeHours >= 24) {
      actions.push({
        id: 'stale', severity: 'yellow',
        textHe: syncAgeHours === null ? 'טרם בוצע סנכרון — הנתונים ריקים' : `הנתונים בני ${syncAgeHours} שעות — כדאי לסנכרן`,
        target: 'sync',
      });
    }
    // A manual balance is a fact with a decay rate. Repaying a loan is net-worth-neutral, but the
    // cash is scraped and the liability is manual — so every month the loan row goes untouched,
    // netWorth drops by exactly the repayment and /networth draws that fabricated decline as a
    // trend. One item for all of them, never one per holding.
    const nowMs = Date.now();
    const staleManual = db.getAssets().filter(
      (a) => decays(a.type) && (nowMs - Date.parse(a.updatedAt)) / 86_400_000 > stalenessDays(a),
    );
    if (staleManual.length > 0) {
      const oldest = staleManual.map((a) => a.updatedAt).sort()[0];
      const monthHe = new Date(oldest).toLocaleDateString('he-IL', {
        timeZone: 'Asia/Jerusalem', month: 'long', year: 'numeric',
      });
      // stays `info`: a rot warning is not a duplicate charge, and inflating it to win a slice
      // fight would corrupt the severity scale — a worse trade than losing the slot.
      actions.push({
        id: 'manual-stale', severity: 'info',
        textHe: `יתרות ידניות (הלוואות, פקדונות) לא עודכנו מאז ${monthHe} — כדאי לרענן`,
        target: 'networth',
      });
    }
    const sectorOverrides = new Set(db.getSectorOverrides().map((o) => o.sector));
    const unknownSectors = db.getIssuerSectors()
      .filter((s) => sectorToCategory(s.sector) === null && !sectorOverrides.has(s.sector.trim())).length;
    if (unknownSectors > 0) {
      actions.push({ id: 'sectors', severity: 'info', textHe: `${unknownSectors} סוגי חיובים חדשים מחכים לסיווג שלך`, target: 'settings' });
    }
    const refineCount = rows.filter(
      (r) => r.status === 'completed' && !r.excluded && r.category === 'other' && r.categorySource === 'auto',
    ).length;
    if (refineCount > 0) {
      actions.push({ id: 'refine', severity: 'info', textHe: `${refineCount} עסקאות מסווגות כ"אחר" — אפשר לחדד`, target: 'review' });
    }
    // subscriptions whose latest settled month diverged from the amount the user anchored — a tier
    // change or a price hike. Actionable inline: re-anchor to the new price, or dismiss a one-off.
    const subMark = deriveMerchantMarks(db.getTxnMarks(), rows);
    for (const pc of subscriptionPriceChanges({ rows, merchantMark: subMark, expected: subscriptionAnchors(rows, subMark, today), today })) {
      actions.push({
        id: `price:${pc.merchant}`,
        severity: 'yellow',
        textHe: `${pc.name}: החיוב האחרון היה ${ILS.format(pc.latest)} במקום ${ILS.format(pc.expected)} שסימנת — השתנה המחיר?`,
        target: 'month',
        resolve: { kind: 'price-change', merchant: pc.merchant, oldAmount: pc.expected, newAmount: pc.latest, month: pc.month },
      });
    }
    // The queue can hold more than it shows, so the tiebreak is explicit rather than leaning on
    // sort stability: within a severity, the earlier-pushed item is the one that survives the slice.
    const severityRank = { red: 0, yellow: 1, info: 2 } as const;
    const ranked = actions
      .map((a, i) => ({ a, i }))
      .sort((x, y) => severityRank[x.a.severity] - severityRank[y.a.severity] || x.i - y.i)
      .map((z) => z.a);

    // ── trajectory ───────────────────────────────────────────────────────────────────────
    const { series } = fullBankSeries();
    const year = today.slice(0, 4);
    const firstOfYear = series.find((p) => p.date >= `${year}-01-01`) ?? series[0] ?? null;
    const ytdDelta = series.length > 0 && firstOfYear ? round(series[series.length - 1].balance - firstOfYear.balance) : null;
    const summaries = toMonthlySummary(rows);
    const complete = summaries.filter((s) => s.month !== month);
    let greenStreak = 0;
    for (const s of complete) {
      if (s.net >= 0) greenStreak += 1;
      else break;
    }
    const last3 = complete.slice(0, 3);
    const income3 = last3.reduce((s, m) => s + m.income, 0);
    const savingsRate3m = income3 > 0 ? round(last3.reduce((s, m) => s + m.net, 0) / income3) : null;
    // No health verdict is computed here. This response used to carry a `trend.health` chip that
    // NO client component ever rendered — and to fill it, every Month view ran the full 12-metric
    // report over an 11-complete-month window while the tab itself runs 12. A second verdict, on a
    // different window, that nobody reads: the cost was real and the only thing it could ever do
    // was disagree with בריאות פיננסית. The tab is the one place that answers this question.

    // ── composition: the month's full category breakdown, each vs its 3-month median ────
    const breakdown = toCategoryBreakdown(rows);
    const prev3 = [1, 2, 3].map((n) => monthsBack(month, n));
    const categories = (breakdown[month] ?? []).map((c) => {
      const med = round(median(prev3.map((m) => breakdown[m]?.find((x) => x.category === c.category)?.expenses ?? 0)));
      return {
        category: c.category,
        spent: c.expenses,
        median3m: med,
        deltaPct: med > 0 ? Math.round(((c.expenses - med) / med) * 100) : null,
      };
    });
    const topMerchant = topMerchants(month, rows, 1)[0] ?? null;

    res.json({
      pulse: {
        bankBalance,
        upcomingCharge,
        afterCharge: bankBalance !== null && upcomingCharge ? round(bankBalance + upcomingCharge.amount) : bankBalance,
        overdraftLimit: getOverdraftLimit(db),
        lastSyncAt,
        syncAgeHours,
      },
      month: { ...plan, triple, prevTriple },
      actions: ranked.slice(0, 5),
      trend: {
        ytdDelta,
        greenStreak,
        savingsRate3m,
        monthsNet: summaries.slice(0, 6),
      },
      composition: { categories, topMerchant },
    });
  });

  /** Free-text search across everything we hold ("where did I pay for that?"). */
  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'query must be at least 2 characters' });
      return;
    }
    const labels = new Map(db.getConnections().map((c) => [c.id, c.nickname || companyNameHe(c.company)]));
    const needle = q.toUpperCase();
    const hits = readLensed()
      .filter((r) => r.description.toUpperCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date));
    res.json({
      total: hits.length,
      txns: hits.slice(0, 100).map((t) => ({
        key: t.key,
        date: t.date,
        month: t.month,
        description: t.description,
        amount: t.amount,
        company: t.company,
        connectionLabel: labels.get(t.connectionId) ?? companyNameHe(t.company),
        category: t.category,
        status: t.status,
        excluded: t.excluded,
        // search is the second place the user can audit an excluded row; without the reason it
        // renders a bare grey "מוחרג" on money he never spent and cannot ask why
        excludeReason: t.excludeReason ?? null,
      })),
    });
  });

  router.get('/balances', (_req, res) => {
    const conns = new Map(db.getConnections().map((c) => [c.id, c]));
    res.json({
      balances: db.getLatestSnapshots().map((s) => {
        const conn = conns.get(s.connectionId);
        return {
          connectionId: s.connectionId,
          account: s.account,
          label: conn ? conn.nickname || companyNameHe(conn.company) : s.account,
          kind: conn ? companyKind(conn.company) : 'other',
          balance: s.balance,
          balanceDate: s.balanceDate,
          takenAt: s.takenAt,
        };
      }),
    });
  });

  router.get('/review', (_req, res) => {
    const labels = new Map(db.getConnections().map((c) => [c.id, c.nickname || companyNameHe(c.company)]));
    // exclusions must be computed over the FULL window — settlement/detail sums are compared per
    // month, so flagging a filtered subset would mis-count coverage. Filter afterward.
    // Nothing is ever uncategorized anymore: the queue offers the auto-'other' rows for refining.
    const flagged = readLensed();
    const rows = flagged.filter(
      (r) => !r.excluded && r.status === 'completed' && r.category === 'other' && r.categorySource === 'auto',
    );
    res.json({
      txns: rows.map((t) => ({
        key: t.key,
        date: t.date,
        description: t.description,
        amount: t.amount,
        issuerCategory: t.issuerCategory,
        connectionLabel: labels.get(t.connectionId) ?? companyNameHe(t.company),
      })),
    });
  });

  router.put('/txns/:key/category', (req, res) => {
    const { category, rulePattern } = (req.body ?? {}) as { category?: unknown; rulePattern?: unknown };
    if (typeof category !== 'string' || !CATEGORY_IDS.has(category)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'unknown category' });
      return;
    }
    if (!db.setTxnCategory(req.params.key, category)) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    let ruleId: number | undefined;
    if (rulePattern !== undefined) {
      const pattern = typeof rulePattern === 'string' ? rulePattern.trim() : '';
      if (pattern.length < 2) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'rule pattern too short' });
        return;
      }
      try {
        ruleId = db.addRule(pattern, category);
      } catch {
        res.status(409).json({ errorType: 'RULE_EXISTS', errorMessage: 'a rule with this pattern already exists' });
        return;
      }
      db.applyRuleToExisting(pattern, category);
    }
    // ruleId lets the client undo the whole action (category + rule) in one step
    res.json({ key: req.params.key, category, ...(ruleId !== undefined ? { ruleId } : {}) });
  });

  /** Manual (cash) transaction — the money the scrapers can never see. Counts in months and
   *  categories like any row; kind 'other' keeps it out of bank-balance reconstruction. */
  router.post('/txns', (req, res) => {
    const { date, description, amount, category } = (req.body ?? {}) as {
      date?: unknown; description?: unknown; amount?: unknown; category?: unknown;
    };
    if (
      typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof description !== 'string' || description.trim().length < 2 ||
      typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0 ||
      (category !== undefined && (typeof category !== 'string' || !CATEGORY_IDS.has(category)))
    ) {
      res.status(400).json({
        errorType: 'INVALID_INPUT',
        errorMessage: 'date (YYYY-MM-DD), description (2+ chars), non-zero amount required; category optional',
      });
      return;
    }
    const iso = `${date}T10:00:00.000Z`; // midday Israel time — safely inside the local day
    const desc = description.trim();
    const key = makeTxnKey('cash', iso, amount, desc, randomUUID());
    db.insertTxns([{
      key,
      account: 'מזומן',
      date: iso,
      month: monthKey(iso),
      processedDate: iso,
      amount,
      originalAmount: amount,
      currency: 'ILS',
      description: desc,
      memo: null,
      status: 'completed',
      company: 'manual',
      connectionId: 0,
      type: 'normal',
      installmentNumber: null,
      installmentTotal: null,
      chargedCurrency: 'ILS',
      issuerCategory: null,
      category: typeof category === 'string' ? category : null,
      categorySource: typeof category === 'string' ? 'user' : null,
    }]);
    res.status(201).json({ key });
  });

  /** Only manual rows are deletable — scraped data is reality and comes back on sync anyway. */
  router.delete('/txns/:key', (req, res) => {
    if (!db.deleteManualTxn(req.params.key)) {
      res.status(404).json({ errorType: 'NOT_FOUND', errorMessage: 'only manual transactions can be deleted' });
      return;
    }
    res.status(204).end();
  });

  /** Undo for a categorization — back to whatever the automatic engine says (never to null). */
  router.delete('/txns/:key/category', (req, res) => {
    if (!db.clearTxnCategory(req.params.key)) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const cleared = db.getUncategorizedSinceMonth('0000-00').filter((t) => t.key === req.params.key);
    if (cleared.length === 1) {
      const resolved = resolveCategory(cleared[0], db.getRules(), resolveContext());
      db.setResolvedCategories([{ key: cleared[0].key, category: resolved.category, source: resolved.source }]);
    }
    res.status(204).end();
  });

  /** "This rule would catch N more transactions" — shown before the user commits to it. */
  router.get('/rules/preview', (req, res) => {
    const pattern = String(req.query.pattern ?? '').trim();
    if (pattern.length < 2) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'pattern too short' });
      return;
    }
    res.json({ count: db.countRuleMatches(pattern) });
  });

  /** ?revert=1 also un-categorizes the rows this rule categorized — a full undo.
   *  Without it (the Settings flow), already-classified rows keep their category. */
  router.delete('/rules/:id', (req, res) => {
    const rule = db.getRule(Number(req.params.id));
    if (!rule || !db.deleteRule(rule.id)) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    if (req.query.revert === '1') {
      db.revertRuleApplications(rule.pattern, rule.category);
      // rows the rule had OVERWRITTEN fall back to their automatic classification — the
      // zero-uncategorized guarantee holds through an undo too
      const rules = db.getRules();
      const context = resolveContext();
      const repaired = db.getUncategorizedSinceMonth('0000-00').map((t) => {
        const resolved = resolveCategory(t, rules, context);
        return { key: t.key, category: resolved.category, source: resolved.source };
      });
      db.setResolvedCategories(repaired);
    }
    res.status(204).end();
  });

  /** 12-month analysis window regardless of the display setting — the engines want history.
   *  User-muted items (false-positive recurring) are filtered here so every engine agrees. */
  /** The RETROSPECTIVE recurring set — detected streams only, minus user mutes. Every current/past
   *  engine reads this (the month plan + its calendar heat, metrics, insights). User per-transaction
   *  classifications deliberately do NOT touch it: classifying an expense must never repaint the
   *  current-month plan or reassign already-spent money between fixed and variable. Those feed the
   *  FORWARD forecast only — see forecastRecurring. */
  function analysisData() {
    const today = todayLocal();
    const { rows: all, cal } = readAll();
    const fromFlow = monthsBack(cal.monthOf(today), 11);
    const rows = all.filter((r) => r.month >= fromFlow);
    const detected = detectRecurring(rows, { today });
    const overrides = new Set(db.getRecurringOverrides().map((o) => `${o.merchant}|${o.kind}`));
    const recurring = detected.filter((i) => !overrides.has(`${i.merchant}|${i.kind}`));
    const muted = detected.filter((i) => overrides.has(`${i.merchant}|${i.kind}`));
    // `all` rides along for the callers that must NOT be windowed — the pattern view reads every
    // stored month, so the health chip here and the health tab itself see one identical set.
    return { rows, recurring, muted, cal, all };
  }

  /** The FORWARD recurring set: the detected streams PLUS the user's forward-looking classifications
   *  — hand-typed subscriptions and merchants they promoted that the detector missed. Used ONLY by
   *  the forecast's expected-charges list. Promoted/manual carry company 'manual', so they never
   *  enter the calibrated balance curve (bankCashFlows is bank-only): expected charges, nothing
   *  retroactive, and nothing that can push the current month into a phantom deficit. */
  function forecastRecurring(rows: FlaggedTxn[], recurring: ReturnType<typeof detectRecurring>, today: string) {
    const merchantMark = deriveMerchantMarks(db.getTxnMarks(), rows);
    const detectedExpenseMerchants = new Set(recurring.filter((i) => i.kind === 'expense').map((i) => i.merchant));
    const manual = db.getManualRecurring()
      .map((r) => manualToRecurringItem(r, today))
      .filter((i) => !recurring.some((x) => x.merchant === i.merchant && x.kind === i.kind));
    const promoted = promotedRecurringItems(merchantMark, rows, detectedExpenseMerchants, today);
    return [...recurring, ...manual, ...promoted];
  }

  function todayLocal(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  }

  /** The subscription anchors, self-healing: back-fills a monthly-cost anchor (the latest settled
   *  month's total) for any subscription/fixed merchant that was marked BEFORE anchoring existed,
   *  then returns the current set. Idempotent — a user-set anchor is never overwritten. */
  function subscriptionAnchors(rows: FlaggedTxn[], merchantMark: ReturnType<typeof deriveMerchantMarks>, today: string) {
    const existing = db.getMerchantExpected();
    const backfill = anchorsToBackfill(rows, merchantMark, new Set(existing.map((e) => e.merchant)), today);
    if (backfill.length === 0) return existing;
    const now = new Date().toISOString();
    for (const b of backfill) db.setMerchantExpectedIfMissing(b.merchant, b.amount, now);
    return db.getMerchantExpected();
  }

  /** Sum + observation day of the latest snapshot per connected bank account. */
  function latestBankSnapshot(): { latestBankBalance: number; latestDate: string } | null {
    const conns = new Map(db.getConnections().map((c) => [c.id, c]));
    const bankSnaps = db.getLatestSnapshots().filter((s) => {
      const c = conns.get(s.connectionId);
      return c && companyKind(c.company) === 'bank';
    });
    if (bankSnaps.length === 0) return null;
    return {
      latestBankBalance: bankSnaps.reduce((s, b) => s + b.balance, 0),
      latestDate: bankSnaps
        .map((s) => new Date(s.takenAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }))
        .sort()
        .at(-1)!,
    };
  }

  function bankSnapshotState(rows: FlaggedTxn[]) {
    const snap = latestBankSnapshot();
    if (!snap) return { latestBankBalance: null, stats: null };
    const bankRows = rows.filter((r) => companyKind(r.company) === 'bank');
    const series = reconstructDailyBalances(snap.latestBankBalance, snap.latestDate, bankRows, windowStartMonth(12) + '-01');
    return { latestBankBalance: snap.latestBankBalance, stats: balanceStats(series) };
  }

  /** The full daily equity curve over EVERYTHING we hold — display ranges are cut client-side. */
  function fullBankSeries(): { latestBankBalance: number | null; series: { date: string; balance: number }[] } {
    const snap = latestBankSnapshot();
    if (!snap) return { latestBankBalance: null, series: [] };
    const bankRows = dedupeAcrossConnections(db.getTxnsSinceMonth('0000-00')).filter(
      (r) => companyKind(r.company) === 'bank' && r.status === 'completed',
    );
    if (bankRows.length === 0) return { latestBankBalance: snap.latestBankBalance, series: [] };
    const days = bankRows.map((r) => new Date(r.date).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
    const firstDay = days.reduce((a, b) => (a < b ? a : b));
    return {
      latestBankBalance: snap.latestBankBalance,
      series: reconstructDailyBalances(snap.latestBankBalance, snap.latestDate, bankRows, firstDay),
    };
  }

  /** The full forecast computation — shared by the route, the what-if scenario overlay, and
   *  the post-sync snapshot receipts. One code path, so every consumer tells the same story. */
  function cashflowAnalysis(days: number) {
    const config = getForecastConfig(db);
    const { rows, recurring, muted, cal } = analysisData();
    const today = todayLocal();
    const flow = getFlow(db);
    const overdraftLimit = getOverdraftLimit(db);
    // the forecast (and ONLY the forecast) also carries the user's forward classifications —
    // promoted merchants + manual subscriptions. The month plan above never sees them.
    const recurringFwd = forecastRecurring(rows, recurring, today);
    const flows = bankCashFlows(recurringFwd, rows);
    const recurringMerchants = new Set(recurringFwd.map((r) => r.merchant));
    const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

    // the snapshot is the balance at the END of its own day — completed movements since then
    // are already reality, and a forecast seeded days behind shifts the whole path and trough
    const snap = latestBankSnapshot();
    let latestBankBalance: number | null = null;
    if (snap) {
      const sinceSnapshot = rows
        .filter((r) =>
          companyKind(r.company) === 'bank' && r.status === 'completed' &&
          localDay(r.date) > snap.latestDate && localDay(r.date) <= today)
        .reduce((s, r) => s + r.amount, 0);
      latestBankBalance = Math.round((snap.latestBankBalance + sinceSnapshot) * 100) / 100;
    }

    // variable spend: bank rows only, nothing excluded, and never card-settlement debits of ANY
    // card — connected ones are projected (recurring stream / exact known charge), and an
    // unconnected card's settlements form their own recurring stream now that per-month-total
    // detection sees them
    const bankVariableRows = rows
      .filter((r) => companyKind(r.company) === 'bank' && !r.excluded && settlementCompany(r.description) === null)
      .map((r) => ({ amount: r.amount, status: r.status, description: r.description, memo: r.memo, localDay: localDay(r.date) }));
    const earliestBankDay = bankVariableRows.reduce<string | undefined>(
      (a, r) => (a === undefined || r.localDay < a ? r.localDay : a),
      undefined,
    );
    // the configured model over the configured lookback — the analysis carries every block
    // and factor it used, so the client can show the math instead of asserting a number
    const variable = analyzeVariableSpend(bankVariableRows, recurringMerchants, (r) => merchantKey(r.description, r.memo), today, config, earliestBankDay);

    // the honest ceiling for the "history basis" slider: you cannot calculate on more history than
    // you hold. One 30-day block per month of real bank data, capped at the hard MAX_LOOKBACK_BLOCKS.
    const maxLookbackBlocks = earliestBankDay
      ? Math.min(MAX_LOOKBACK_BLOCKS, Math.max(1, Math.ceil((Date.parse(today) - Date.parse(earliestBankDay)) / 86_400_000 / 30)))
      : 1;

    // exact upcoming card debits: the scrapers deliver the next cycle in advance,
    // and all rows of a cycle share one debit date — group and sum per (company, debit day)
    const knownByKey = new Map<string, KnownCharge>();
    for (const r of rows) {
      if (companyKind(r.company) !== 'card' || r.status !== 'completed' || !r.processedDate) continue;
      const debitDay = localDay(r.processedDate);
      if (debitDay <= today) continue;
      const k = `${r.company}|${debitDay}`;
      const cur = knownByKey.get(k) ?? { company: r.company, merchant: companyNameHe(r.company), date: debitDay, amount: 0 };
      cur.amount = Math.round((cur.amount + r.amount) * 100) / 100;
      knownByKey.set(k, cur);
    }
    const knownCharges = [...knownByKey.values()].filter((c) => c.amount < 0);

    // pending bank rows are near-certain, dated movements — free information for the next days.
    // Guards against double counting: settlement-like pendings are already covered by the known
    // charges / settlement streams; a pending הו"ק that is a detected recurring flow is already
    // projected; and a pending older than two weeks is a ghost the bank abandoned, not a debit.
    const projectedMerchants = new Set(flows.filter((f) => f.forecastEligible).map((f) => f.merchant));
    const pendingEvents: ForecastEvent[] = rows
      .filter((r) =>
        companyKind(r.company) === 'bank' && r.status === 'pending' && r.amount !== 0 &&
        settlementCompany(r.description) === null &&
        !projectedMerchants.has(merchantKey(r.description, r.memo)) &&
        localDay(r.date) >= addDays(today, -14))
      .map((r): ForecastEvent => {
        const d = localDay(r.date);
        return { date: d > today ? d : addDays(today, 1), merchant: `${r.description} (ממתין)`, amount: r.amount, source: 'pending' };
      });

    // "end of month" is the user's flow month, not the calendar's: the day before the next
    // month opens (nominal until its salary actually arrives)
    const endOfMonthDate = cal.endOf(cal.monthOf(today));

    // ——— calibration: level from history ———
    // The calendar knows salary, fixed bills and settlements — but irregular flows (ביט,
    // checks, cash, one-off transfers) have no rhythm to detect, and they can dominate a
    // month's net. The observed complete flow months are the ground truth the path must
    // reconcile with; the read is wider than analysisData's 12-month base because the
    // lookback window needs one complete month beyond it.
    const currentFlowMonth = cal.monthOf(today);
    const calibFrom = monthsBack(currentFlowMonth, config.lookbackBlocks);
    // the read covers ALL data on purpose: when data extends beyond the window, the earliest
    // observed day lands before every voting month and proves them all complete
    const calibRows = readLensed().filter(
      (r) => companyKind(r.company) === 'bank' && r.status === 'completed',
    );
    // every completed bank movement counts — the balance path lives in cash reality, not in
    // spending semantics, so exclusions (transfers, savings) stay IN
    const netByFlowMonth = new Map<string, number>();
    let earliestCalibDay: string | null = null;
    for (const r of calibRows) {
      if (r.month >= calibFrom) netByFlowMonth.set(r.month, (netByFlowMonth.get(r.month) ?? 0) + r.amount);
      const d = localDay(r.date);
      if (earliestCalibDay === null || d < earliestCalibDay) earliestCalibDay = d;
    }
    // the month holding the first-ever observed row is partial by construction — it must not
    // vote (earliestCalibDay comes from the calibration read itself: when the data extends
    // beyond the window it lands before every voting month and the guard never fires)
    const calibrationMonths: CalibrationMonth[] = [];
    for (let i = 1; i <= config.lookbackBlocks; i++) {
      const m = monthsBack(currentFlowMonth, i);
      if (earliestCalibDay === null || m <= cal.monthOf(earliestCalibDay)) break;
      calibrationMonths.push({ month: m, net: Math.round((netByFlowMonth.get(m) ?? 0) * 100) / 100 });
    }
    const calibration = calibrateDrift(calibrationMonths, config.lookbackBlocks, impliedMonthlyNet(flows, variable.daily));
    const driftOpts = calibration === null ? {} : {
      driftDaily: calibration.driftDaily,
      ...(calibration.driftLow !== null && calibration.driftHigh !== null
        ? { driftLow: calibration.driftLow, driftHigh: calibration.driftHigh }
        : {}),
    };

    let forecast = null;
    if (latestBankBalance !== null && snap) {
      const fc = forecastBalance(latestBankBalance, flows, variable.daily, today, days, knownCharges, endOfMonthDate, pendingEvents, {
        weekdayFactors: variable.weekdayFactors,
        p25Daily: variable.p25Daily,
        p75Daily: variable.p75Daily,
        band: config.showBand,
        ...driftOpts,
      });
      // the transparency payload: where the starting shekel came from and every number the
      // variable model and the calibration chewed — rendered verbatim by "איך זה מחושב"
      const explain: ForecastExplain = {
        start: {
          balance: latestBankBalance,
          snapshotDate: snap.latestDate,
          movementsSince: Math.round((latestBankBalance - snap.latestBankBalance) * 100) / 100,
        },
        variable,
        calibration,
      };
      forecast = { ...fc, explain };
    }
    return {
      payload: { recurring: recurringFwd, muted, forecast, latestBankBalance, overdraftLimit, days, config, maxLookbackBlocks },
      internals: { flows, variable, knownCharges, pendingEvents, endOfMonthDate, latestBankBalance, snap, today, driftOpts },
    };
  }

  /** What-if adjustments, parsed defensively: absent/garbage params mean "no scenario". */
  function parseScenario(query: Record<string, unknown>) {
    const num = (v: unknown) => {
      const n = Number(v);
      return typeof v === 'string' && v !== '' && Number.isFinite(n) ? n : null;
    };
    const extraMonthly = num(query.extraMonthly);
    const oneOffAmount = num(query.oneOffAmount);
    const oneOffMonth = typeof query.oneOffMonth === 'string' && /^\d{4}-\d{2}$/.test(query.oneOffMonth) ? query.oneOffMonth : null;
    const variableFactor = num(query.variableFactor);
    const scenario = {
      extraMonthly: extraMonthly !== null && Math.abs(extraMonthly) <= 100_000 ? extraMonthly : null,
      oneOff: oneOffAmount !== null && oneOffAmount >= 1 && oneOffAmount <= 1_000_000 && oneOffMonth !== null
        ? { amount: oneOffAmount, month: oneOffMonth }
        : null,
      variableFactor: variableFactor !== null && variableFactor >= 0.25 && variableFactor <= 2 ? variableFactor : null,
    };
    return scenario.extraMonthly !== null || scenario.oneOff !== null || scenario.variableFactor !== null ? scenario : null;
  }

  router.get('/cashflow', (req, res) => {
    const config = getForecastConfig(db);
    const rawDays = Number(req.query.days);
    const days = Number.isInteger(rawDays) && rawDays >= MIN_HORIZON_DAYS && rawDays <= MAX_HORIZON_DAYS
      ? rawDays
      : config.horizonDays;
    const { payload, internals } = cashflowAnalysis(days);

    // the what-if overlay: same engine, adjusted inputs — never a client-side fake
    let scenario = null;
    const params = parseScenario(req.query as Record<string, unknown>);
    if (params && payload.forecast && internals.latestBankBalance !== null) {
      const { flows, variable, knownCharges, pendingEvents, endOfMonthDate, today, driftOpts } = internals;
      const f = params.variableFactor ?? 1;
      const events: ForecastEvent[] = [...pendingEvents];
      if (params.extraMonthly !== null) {
        let m = today.slice(0, 7);
        for (let i = 0; i < 14; i++) {
          m = monthsBack(m, -1);
          const date = `${m}-01`;
          if (date > addDays(today, days)) break;
          if (date <= today) continue;
          events.push({ date, merchant: 'תרחיש: שינוי הכנסה חודשי', amount: params.extraMonthly, source: 'pending' });
        }
      }
      if (params.oneOff !== null) {
        const date = `${params.oneOff.month}-15` > today ? `${params.oneOff.month}-15` : addDays(today, 1);
        if (date <= addDays(today, days)) {
          events.push({ date, merchant: 'תרחיש: הוצאה חד-פעמית', amount: -params.oneOff.amount, source: 'pending' });
        }
      }
      // the scenario rides the SAME calibration drift as the baseline — a what-if changes
      // the inputs the user asked about, never the model underneath
      const fc = forecastBalance(internals.latestBankBalance, flows, variable.daily * f, today, days, knownCharges, endOfMonthDate, events, {
        weekdayFactors: variable.weekdayFactors,
        p25Daily: variable.p25Daily * f,
        p75Daily: variable.p75Daily * f,
        band: false,
        ...driftOpts,
      });
      scenario = { path: fc.path, trough: fc.trough, endOfMonth: fc.endOfMonth, params };
    }

    res.json({ ...payload, scenario });
  });

  /** After a successful sync, leave receipts: what this fresh data predicts for +30 and +90
   *  days. The accuracy audit compares them against reality once those dates arrive. */
  function recordForecastSnapshots(): void {
    try {
      const { payload } = cashflowAnalysis(90);
      if (!payload.forecast) return;
      const today = todayLocal();
      for (const horizon of [30, 90]) {
        const target = addDays(today, horizon);
        const point = payload.forecast.path.find((p) => p.date === target);
        if (point) db.saveForecastSnapshot(today, horizon, target, point.balance);
      }
    } catch {
      // a failed receipt must never fail a sync
    }
  }

  /** The audit nobody ships: past predictions vs what actually happened. */
  router.get('/forecast/accuracy', (_req, res) => {
    const today = todayLocal();
    const matured = db.listForecastSnapshots().filter((s) => s.targetDate <= today);
    if (matured.length === 0) {
      res.json({ entries: [] });
      return;
    }
    const byDate = new Map(fullBankSeries().series.map((p) => [p.date, p.balance]));
    const entries = matured.flatMap((s) => {
      const actual = byDate.get(s.targetDate);
      if (actual === undefined) return [];
      return [{
        takenOn: s.takenOn,
        horizonDays: s.horizonDays,
        targetDate: s.targetDate,
        predicted: Math.round(s.predictedBalance * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        error: Math.round((s.predictedBalance - actual) * 100) / 100,
      }];
    });
    res.json({ entries });
  });

  /** The forecast's tunables. PATCH-style: only the provided fields change, invalid input is
   *  rejected whole — the stored config is always complete and valid. */
  router.put('/cashflow/config', (req, res) => {
    const result = applyForecastConfigPatch(getForecastConfig(db), req.body ?? {});
    if (!result.ok) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: result.error });
      return;
    }
    db.setSetting('forecastConfig', JSON.stringify(result.config));
    res.json(result.config);
  });

  /** The monthly spending plan — one transparent equation (Simplifi "Available" / RiseUp
   *  "נשאר להוציא"): expected income − fixed commitments − variable spent so far = left to
   *  spend. All within the user's FLOW month and lens. Settlement streams (excludedFlow)
   *  never enter: they are the cash-side view of card spending already counted
   *  transaction-by-transaction — the classic double-count trap.
   *  Shared by the cash-flow tab and the dashboard hero. */
  function monthlyPlan(rows: FlaggedTxn[], recurring: ReturnType<typeof detectRecurring>, today: string, cal: FlowCalendar) {
    const flow = getFlow(db);
    const round = (n: number) => Math.round(n * 100) / 100;
    const month = cal.monthOf(today);
    // the ACTUAL boundaries — when the salary opened the month early, day 1 is its arrival
    const monthStart = cal.startOf(month);
    const monthEnd = cal.endOf(month);
    const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    const daysElapsed = Math.max(1, dayDiff(monthStart, today) + 1);
    const daysLeft = Math.max(1, dayDiff(today, monthEnd) + 1); // today is still a spending day

    const monthRows = rows.filter((r) => r.month === month && r.status === 'completed' && !r.excluded);
    const incomeSoFar = round(monthRows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0));
    // plan-scope recurring: LIVE spending commitments, never the settlement cash streams.
    // Inactive streams stay out entirely — a dead merchant's coincidental new charge is
    // variable spending, not a "fixed" bucket revival.
    const planExpenses = recurring.filter((i) => i.kind === 'expense' && !i.excludedFlow && i.active);
    const planIncome = recurring.filter((i) => i.kind === 'income' && !i.excludedFlow && i.active);
    const fixedMerchants = new Set(planExpenses.map((i) => i.merchant));
    const expenseRows = monthRows.filter((r) => r.amount < 0);
    const fixedSoFar = round(
      expenseRows.filter((r) => fixedMerchants.has(merchantKey(r.description, r.memo))).reduce((s, r) => s + -r.amount, 0),
    );
    const spentSoFar = round(expenseRows.reduce((s, r) => s + -r.amount, 0));
    const variableSoFar = round(spentSoFar - fixedSoFar);
    /** "יצא עד כה" split by where it happened — the arithmetic bridge between the chart and
     *  the card ledger. Always true by construction: card + other = spentSoFar. */
    const cardSpendSoFar = round(
      expenseRows.filter((r) => companyKind(r.company) === 'card').reduce((s, r) => s + -r.amount, 0),
    );
    const spendSplit = { card: cardSpendSoFar, other: round(spentSoFar - cardSpendSoFar) };

    /**
     * The card ledger shows real cash that is deliberately outside purchase-date totals.
     * Under the purchase lens, each purchase is counted on the day it was made; counting the
     * bank debit that pays for it would count the same shopping twice. A
     * sentence under a chart was not enough: the card's own two facts (what left, what is
     * already scheduled to leave) now come back as data, with the months that counted them.
     */
    const cardOutlook = buildCardOutlook(rows, month, today);
    const cardSettlements = { amount: cardOutlook.settled.amount, count: cardOutlook.settled.count };

    // the "trail": real variable spend for every day of the flow month — same fixed-vs-variable
    // split as variableSoFar — plus each day's category breakdown for the hover card. Future days
    // stay empty (no transactions yet). Index 0 = monthStart (day 1); length = calendar days.
    const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const daysInMonth = dayDiff(monthStart, monthEnd) + 1;
    const dayBuckets = Array.from({ length: daysInMonth }, () => ({ total: 0, cats: new Map<string, number>() }));
    for (const r of expenseRows) {
      if (fixedMerchants.has(merchantKey(r.description, r.memo))) continue;
      const idx = dayDiff(monthStart, localDay(effectiveDate(r, flow.lens)));
      if (idx < 0 || idx >= daysInMonth) continue;
      const amt = -r.amount;
      const cat = r.category ?? 'other';
      const b = dayBuckets[idx];
      b.total = round(b.total + amt);
      b.cats.set(cat, round((b.cats.get(cat) ?? 0) + amt));
    }
    const variableByDay = dayBuckets.map((b) => ({
      total: b.total,
      cats: [...b.cats.entries()].map(([cat, amount]) => ({ cat, amount })).sort((a, z) => z.amount - a.amount),
    }));

    // "צפוי לצאת/להיכנס" — remaining occurrences of the recurring calendar inside this flow month.
    // The NEXT main income is filtered out of the tail: it opens the next month by construction,
    // and projecting it here would count the same salary in two months ("expectedTotal 27,168"
    // on a 13k-income month was this exact double-count).
    const expectedIncomeEvents = projectEvents(planIncome, addDays(today, 1), monthEnd)
      .filter((e) => !cal.opensNext(month, e.date, e.amount));
    const expectedFixedEvents = projectEvents(planExpenses, addDays(today, 1), monthEnd);
    const expectedIncomeRemaining = round(expectedIncomeEvents.reduce((s, e) => s + e.amount, 0));
    const fixedExpectedRemaining = round(expectedFixedEvents.reduce((s, e) => s + -e.amount, 0));

    const expectedIncomeTotal = round(incomeSoFar + expectedIncomeRemaining);
    const fixedTotal = round(fixedSoFar + fixedExpectedRemaining);

    /**
     * שכבת הציפייה — what the month is still going to cost, bucket by bucket.
     *
     * Everything above this line is month-to-date plus the recurring calendar's REMAINING
     * events. That leaves out two whole classes of money the household has every reason to
     * expect: a fixed charge whose usual day already passed without arriving, and the
     * habitual variable spend (groceries, fuel, eating out) that has not happened yet
     * because the month is not over. RiseUp counts both — it is why their bottom line reads
     * 1,863 ₪ where an actuals-only subtraction reads 9,710 ₪, on the same account, the same
     * day. See expectation.ts for the single rule that produces it.
     */
    /**
     * CERTAINTIES ONLY: "צפוי לצאת" includes only charges that are genuinely expected.
     *
     * A charge earns a place in "צפוי לצאת" when the household VOUCHED for it — marked it
     * מנוי/קבוע in "מה יורד לי כל חודש?", typed it in by hand, or signed for it (an installment plan is
     * contractual the moment it exists). A detection the user never confirmed is a proposal,
     * not a commitment; a category's habitual size is a statistic, not a bill. Neither may
     * reserve a shekel. The curated-commitments rule governs the
     * forecast as well as the treemap.
     *
     * Upcoming CARD debits need no line here: the exclusion engine already treats a card
     * settlement as the cash-side mirror of purchases counted transaction-by-transaction, so
     * adding it would charge the household twice for the same shopping.
     */
    const merchantMark = deriveMerchantMarks(db.getTxnMarks(), rows);
    const anchors = new Map(subscriptionAnchors(rows, merchantMark, today).map((a) => [a.merchant, a.amount]));
    const vouchedFor = new Set<string>();
    for (const [merchant, mark] of merchantMark) {
      if (mark === 'subscription' || mark === 'fixed') vouchedFor.add(merchant);
    }
    for (const p of activeInstallmentPlans(recurring)) vouchedFor.add(p.merchant); // signed for
    const activeStream = new Map(planExpenses.map((i) => [i.merchant, Math.abs(i.monthlyAmount)]));
    // a commitment the household vouched for still has to be ALIVE: a cancelled subscription
    // keeps its verdict forever, and a dead charge must not hold money back
    const lastChargeAt = new Map<string, string>();
    for (const r of rows) {
      if (r.amount >= 0 || r.excluded || r.status !== 'completed') continue;
      const mk = merchantKey(r.description, r.memo);
      const d = localDay(r.date);
      if (!lastChargeAt.has(mk) || d > lastChargeAt.get(mk)!) lastChargeAt.set(mk, d);
    }
    const monthlyByMerchant: Record<string, number> = {};
    for (const merchant of vouchedFor) {
      const alive = activeStream.has(merchant)
        || dayDiff(lastChargeAt.get(merchant) ?? '1970-01-01', today) <= 70;
      if (!alive) continue;
      // the anchor the household confirmed wins over the detector's own average; a vouched
      // merchant the detector never saw as a stream still counts, on its anchored amount
      const amount = anchors.get(merchant) ?? activeStream.get(merchant) ?? 0;
      if (amount > 0) monthlyByMerchant[merchant] = round(amount);
    }
    // hand-typed commitments are declarations by construction — nothing to approve
    for (const m of db.getManualRecurring().map((r) => manualToRecurringItem(r, today))) {
      monthlyByMerchant[m.merchant] = round(Math.abs(m.monthlyAmount));
    }
    const fixedSpentByMerchant: Record<string, number> = {};
    for (const r of expenseRows) {
      const mk = merchantKey(r.description, r.memo);
      if (!fixedMerchants.has(mk)) continue;
      fixedSpentByMerchant[mk] = round((fixedSpentByMerchant[mk] ?? 0) + -r.amount);
    }

    // ── the proposal ────────────────────────────────────────────────────────────────────
    // The app no longer asks for the number cold. Everything below derives it from the
    // household's own history, using the SAME fixed-vs-variable definition as the figures
    // above, so a recommendation can never contradict the month it is recommending for.
    const summariesAll = toMonthlySummary(rows);
    const { total: variableHistory, byCategory: variableCatHistory } = variableByMonth(rows, fixedMerchants);
    const historyMonths = summariesAll
      .map((s) => s.month)
      .filter((m) => m < month && (variableHistory[m] ?? 0) > 0)
      .sort();
    const fixedMonthlyEquivalent = round(planExpenses.reduce((s, i) => s + Math.abs(i.monthlyAmount), 0));
    const bankNow = bankSnapshotState(rows).latestBankBalance;
    const liquidTotal = bankNow === null ? null : round(bankNow + liquidAssetsIls());
    const declaredTargetRate = getTargetRate(db);
    const proposal = frameProposal({
      currentMonth: month,
      summaries: summariesAll,
      variable: variableHistory,
      variableCategory: variableCatHistory,
      fixedMonthly: fixedMonthlyEquivalent,
            liquidTotal,
      history: db.getFrameHistory(),
      ...(declaredTargetRate === null ? {} : { setAsideRate: declaredTargetRate }),
    });

    /**
     * היעד — the one thing the household declares, and the only input the rest derives from.
     *
     * It binds THIS month against THIS month's income: "close with a tenth" means a tenth of
     * what actually came in, so a thin month protects fewer shekels at the same promise rather
     * than pretending a typical month happened. Declared savings plans are a floor under it —
     * a target may never quietly shrink money the household already committed elsewhere.
     */
    const target = savingsTarget({
      declaredRate: declaredTargetRate,
      currentMonth: month,
      summaries: summariesAll,
      commitments: fixedMonthlyEquivalent,
            essentialFloor: proposal.available ? proposal.observed.essentialFloor : 0,
    });
    const targetKeep = declaredTargetRate === null ? 0 : round(expectedIncomeTotal * declaredTargetRate);
    const protectedThisMonth = targetKeep;

    // the expectation, built on the SAME fixed-vs-variable split as every figure above
    const spentByCategoryNow: Record<string, number> = {};
    for (const r of expenseRows) {
      if (fixedMerchants.has(merchantKey(r.description, r.memo))) continue;
      const cat = r.category ?? 'other';
      spentByCategoryNow[cat] = round((spentByCategoryNow[cat] ?? 0) + -r.amount);
    }
    const expectation = buildExpectation({
      variableSpentByCategory: spentByCategoryNow,
      // NO history on the variable side: a category's habitual size is an estimate, and an
      // estimate may not reserve money. It survives only as `habitEstimate` below — a labelled
      // aside, never a commitment and never inside a total.
      variableHistory: {},
      completeMonths: [],
      fixedSpentByMerchant,
      fixedMonthlyByMerchant: monthlyByMerchant,
    });
    /** "בחודש רגיל יוצאים עוד ~X על הרגלים" — perspective, explicitly not a commitment. */
    const habitEstimate = round(buildExpectation({
      variableSpentByCategory: spentByCategoryNow,
      variableHistory: variableCatHistory,
      completeMonths: historyMonths,
      fixedSpentByMerchant: {},
      fixedMonthlyByMerchant: {},
    }).variable.ahead);
    // never below the calendar's own remaining events: a stream that charges TWICE inside one
    // flow month (a 10th-of-month bill when the month runs 10th→9th) is a real, dated debit,
    // and a one-per-month expectation would quietly drop the second one
    const expectedSpendTotal = round(Math.max(expectation.expectedTotal, fixedTotal + variableSoFar));
    const expectedAhead = round(Math.max(0, expectedSpendTotal - fixedSoFar - variableSoFar));

    /**
     * TWO questions, and they must never be answered by the same number.
     *
     *   "כמה עוד אפשר להוציא"  → `leftToSpend`, with the target protected.
     *   "איך החודש ייסגר"      → `paceEndOfMonth`, in CASH, with the target NOT protected.
     *
     * A target is an intention, not a bill. When the projection was computed off the
     * target-net figure it announced "החודש ייסגר ב־‎−1,222 ₪" to a household heading for
     * ‎+1,369 in the bank — the app calling a missed goal an overdraft, in red, three times
     * over (the card, the trail flag and the action queue). Missing a target and running out
     * of money are different events and get different sentences.
     *
     * Both now stand on the EXPECTED cost of the month, not on what has left it so far. The
     * A household is not free to spend the rent just because the rent has not gone
     * out yet.
     */
    const leftBeforeTarget = round(expectedIncomeTotal - expectedSpendTotal);
    const leftToSpend = round(expectedIncomeTotal - expectedSpendTotal - protectedThisMonth);
    const leftPerDay = round(leftToSpend / daysLeft);
    const variablePace = round(variableSoFar / daysElapsed);
    /** How the month is expected to close, in cash: everything in, minus everything the month
     *  is expected to cost. No extrapolated daily pace — the habitual spend is already inside
     *  `expectedSpendTotal`, and a second forecast on top of it would count it twice. */
    const paceEndOfMonth = leftBeforeTarget;
    // the same close measured against the declared target — null when no target is binding,
    // so the UI never invents a goal the household never set
    const paceVsTarget = protectedThisMonth > 0 ? leftToSpend : null;

    // המסגרת: the DECLARED ceiling for variable spending, measured with the exact same
    // fixed-vs-variable split as variableSoFar — the math card and the intention card must
    // never disagree about what "variable" means.
    const frameAmount = frameForMonth(db.getFrameHistory(), month);

    // this month's variable spend per category — the mid-month "where exactly am I leaking"
    const spentByCategory: Record<string, number> = {};
    for (const r of expenseRows) {
      if (fixedMerchants.has(merchantKey(r.description, r.memo))) continue;
      const cat = r.category ?? 'other';
      spentByCategory[cat] = round((spentByCategory[cat] ?? 0) + -r.amount);
    }

    /**
     * The frame is a STANDING DECISION, built from a typical month; `leftToSpend` is THIS
     * month's cash reality. Both are right, and they can disagree — a month that earned less
     * than usual simply cannot honour a ceiling sized for a normal one.
     *
     * When they disagree, the smaller one binds, and the app must say so out loud. Letting the
     * frame card announce "5,611 left" directly beneath a card that says "2,794 is safe" is the
     * worst thing this feature could do: two trustworthy-looking numbers, one of which walks the
     * household into overdraft.
     */
    const frameLeft = frameAmount === null ? 0 : round(frameAmount - variableSoFar);
    // the frame is built on RELIABLE income, so that is the level a thin month is thin against
    const reliableIncome = proposal.available ? proposal.observed.reliableIncome : 0;
    const reality = frameAmount !== null && frameLeft - leftToSpend >= Math.max(200, frameAmount * 0.05)
      ? {
          safeLeft: leftToSpend,
          monthIncome: expectedIncomeTotal,
          typicalIncome: reliableIncome,
          // Naming the cause is not decoration: "this month came in low" is a DIFFERENT problem
          // from "the frame is simply too big", and asserting the first when the second is true
          // is the app telling the household something it never checked.
          cause: reliableIncome > 0 && expectedIncomeTotal < reliableIncome * 0.9
            ? ('thin-month' as const)
            : ('over-declared' as const),
        }
      : null;

    const frame = frameAmount === null ? null : {
      amount: frameAmount,
      spent: variableSoFar,
      left: frameLeft,
      // the allowed pace follows whichever constraint actually binds — a per-day figure drawn
      // from a ceiling the month cannot afford is an instruction to overdraw
      perDayAllowed: round(Math.max(0, Math.min(frameLeft, reality ? leftToSpend : frameLeft)) / daysLeft),
      projectedSpend: round(variablePace * daysInMonth),
      reality,
      // the split follows the DECLARED frame, never the recommended one — the household is
      // measured against its own decision
      split: splitProgress(
        proposeSplit(frameAmount, historyMonths, variableCatHistory),
        spentByCategory,
        daysElapsed,
        daysInMonth,
      ),
    };

    return {
      proposal,
      month,
      monthStart,
      monthEnd,
      daysElapsed,
      daysLeft,
      daysInMonth,
      income: { soFar: incomeSoFar, expectedRemaining: expectedIncomeEvents, expectedTotal: expectedIncomeTotal },
      fixed: { soFar: fixedSoFar, expectedRemaining: expectedFixedEvents, total: fixedTotal },
      variable: { soFar: variableSoFar, perDayPace: variablePace, byDay: variableByDay },
      /** Card debits that hit the bank inside this flow month. Cash, real, and NOT part of any
       *  figure above — the purchases behind them were counted on their own dates. Surfaced so
       *  a large movement never disappears from the month without a word. */
      cardSettlements,
      /** The card's own ledger: what already left the bank this month, and what the issuer has
       *  ALREADY scheduled to take next (purchases made, charge date fixed — not a forecast).
       *  Both sit outside every total above, with the flow months that counted them, so the
       *  claim "each shekel is counted exactly once" is checkable rather than asserted. */
      cardOutlook,
      /** "יצא עד כה" split by instrument (card purchases vs everything else). The bridge that
       *  lets the ledger point at the exact figure above it instead of near-matching it. */
      spendSplit,
      /** What the month is expected to COST — every bucket at max(spent, typical). The
       *  bottom line stands on this, never on month-to-date alone. */
      expectation: {
        total: expectedSpendTotal,
        ahead: expectedAhead,
        spent: round(fixedSoFar + variableSoFar),
        fixed: expectation.fixed,
        variable: expectation.variable,
        rows: expectation.rows,
        /** What a typical month still spends on habits from here. An ESTIMATE — shown beside
         *  the certainties, never added to them and never subtracted from what is free. */
        habitEstimate,
        /** Detected charges the household has not vouched for. They reserve nothing; the app
         *  offers them for approval instead of quietly spending the user's money for them. */
        unconfirmed: planExpenses
          .filter((i) => !vouchedFor.has(i.merchant) && Math.abs(i.monthlyAmount) >= 30)
          .map((i) => ({ merchant: i.merchant, monthlyAmount: round(Math.abs(i.monthlyAmount)) }))
          .sort((a, b) => b.monthlyAmount - a.monthlyAmount)
          .slice(0, 8),
      },
      // the target, and what it holds back from THIS month specifically
      target,
      keep: { rate: declaredTargetRate, target: targetKeep, applied: protectedThisMonth },
      leftToSpend,
      /** Cash still available this month BEFORE the target is protected — the bridge between
       *  "נותר ביד" and "נשאר להוציא בבטחה", so the gap between them is never a mystery. */
      leftBeforeTarget,
      leftPerDay,
      paceEndOfMonth,
      paceVsTarget,
      frame,
    };
  }

  /**
   * היעד שלי — the household's one declaration: the share of income it wants to close each
   * month with. `null` clears it, and clearing is a legitimate answer, not a failure state:
   * with no target nothing is held back and the app goes back to only describing.
   *
   * Stored as a share (0.15), never as "15" — a percentage that changes unit between the wire
   * and the arithmetic is exactly how a figure ends up a hundred times too large.
   */
  router.put('/target', (req, res) => {
    const { rate } = (req.body ?? {}) as { rate?: unknown };
    if (rate !== null && !isValidTargetRate(rate)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'rate must be a share between 0.01 and 0.6, or null' });
      return;
    }
    // whole percents: the target is said out loud, and 14.7% is not a sentence anyone says
    const stored = rate === null ? null : Math.round(rate * 100) / 100;
    if (stored === null) db.setSetting('savingsTargetRate', '');
    else db.setSetting('savingsTargetRate', String(stored));
    res.json({ rate: stored });
  });

  /** המסגרת החודשית — declare (or switch off with null) the variable-spending ceiling.
   *  Stamped on the CURRENT flow month, so finished months keep the frame that governed them. */
  router.put('/frame', (req, res) => {
    const { amount } = (req.body ?? {}) as { amount?: unknown };
    const valid = amount === null || (typeof amount === 'number' && Number.isFinite(amount) && amount > 0);
    if (!valid) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'amount must be a positive number or null' });
      return;
    }
    // whole shekels: a frame is a round intention, not an accounting figure
    const rounded = amount === null ? null : Math.round(amount);
    const month = readAll().cal.monthOf(todayLocal());
    db.setFrameForMonth(month, rounded, new Date().toISOString());
    res.json({ amount: rounded });
  });

  router.get('/cashflow/plan', (_req, res) => {
    const { rows, recurring, cal } = analysisData();
    res.json({
      ...monthlyPlan(rows, recurring, todayLocal(), cal),
      history: toMonthlySummary(rows),
    });
  });

  /* ——— "התוכנית שלי" — the decision surface ————————————————————————————————————————
   *  One declaration and everything it implies. That is the whole tab, and it is the whole
   *  payload: the screen holds one card, so the route that feeds it does one cheap read.
   *
   *  The recommendation engine is not assembled on this path. It has a separate endpoint and
   *  tests because concrete, priced, data-derived actions are independently useful. */
  router.get('/plan', (_req, res) => {
    const today = todayLocal();
    const { rows, recurring, cal } = analysisData();
    const plan = monthlyPlan(rows, recurring, today, cal);
    res.json({
      month: plan.month,
      target: plan.target,
      daysLeft: plan.daysLeft,
      /**
       * The RUNNING month's actual figures — what the target card's shekels are computed on.
       *
       * A percent is elastic by nature; pinning its shekel illustration to a
       * typical month made the card quote money no specific month actually holds. Typical
       * income survives only inside the structural facts (observed rate, max rate) — every
       * shekel shown to the user comes from the month that is actually happening.
       */
      thisMonth: {
        income: plan.income.expectedTotal,
        /**
         * CERTAINTIES, not the detector's calendar. The plan card and the month tab stand on
         * the same vouched expectation: what already went down plus every confirmed commitment,
         * which is the exact base of "צפוי לצאת".
         */
        fixed: plan.expectation.fixed.expected,
        keep: plan.keep,
        variableSoFar: plan.expectation.variable.spent,
        /** What the month is expected to cost in total — the base the bottom line stands on. */
        expectedSpend: plan.expectation.total,
        leftToSpend: plan.leftToSpend,
      },
    });
  });

  function planPayload() {
    const round = (n: number) => Math.round(n * 100) / 100;
    const today = todayLocal();
    const { rows, recurring, cal } = analysisData();
    const month = cal.monthOf(today);
    const plan = monthlyPlan(rows, recurring, today, cal);
    const summaries = toMonthlySummary(rows);

    // patterns read ALL stored history, exactly as the "מה יורד לי כל חודש?" tab does — the two
    // surfaces must never disagree about what counts as a commitment
    const patterns = spendingPatterns({
      rows: readLensed(), txnMarks: db.getTxnMarks(), today, manual: db.getManualRecurring(),
    }).patterns;

    const bankNow = bankSnapshotState(rows).latestBankBalance;
    const liquidTotal = bankNow === null ? null : round(bankNow + liquidAssetsIls());

    const state = db.listAdviceState();
    const byKey = new Map(state.map((s) => [s.key, s]));
    // accepted items stay in the queue carrying their state; dismissed and done ones leave it
    const suppressed = new Set(state.filter((s) => s.status !== 'accepted').map((s) => s.key));

    const view = buildAdvice({
      today,
      currentMonth: month,
      summaries,
      rows,
      recurring,
      patterns,
      installments: activeInstallmentPlans(recurring),
      daily: fullBankSeries().series,
      monthOf: cal.monthOf,
      liquidTotal,
      suppressed,
    });

    // goals, measured by whatever tells the truth about each shape
    const categoryByMonth: Record<string, Record<string, number>> = {};
    for (const r of rows) {
      if (r.status !== 'completed' || r.excluded || r.amount >= 0) continue;
      const g = categoryByMonth[r.month] ?? (categoryByMonth[r.month] = {});
      const cat = r.category ?? 'other';
      g[cat] = round((g[cat] ?? 0) + -r.amount);
    }
    const savedByGoalId: Record<number, number> = {};
    const goals = goalProgress({
      goals: db.listPlanGoals(),
      currentMonth: month,
      completeMonths: summaries.map((s) => s.month).filter((m) => m < month).sort(),
      liquidTotal,
      savedByGoalId,
      categoryByMonth,
    });

    // the ledger: only money that provably stopped leaving, frozen at the moment of the
    // decision — a cancelled charge is absent from today's data, so recomputing would read zero
    const done = state.filter((s) => s.status === 'done' && s.valueKind === 'saving' && s.valueCertain === 1);
    const monthlySaved = round(done.reduce((s, r) => s + r.monthlyValue, 0));

    return {
      month,
      target: plan.target,
      daysLeft: plan.daysLeft,
      advice: {
        ...view,
        items: view.items.map((a) => ({ ...a, state: byKey.get(a.key)?.status ?? null })),
      },
      goals,
      ledger: {
        monthlySaved,
        annualSaved: round(monthlySaved * 12),
        doneCount: state.filter((s) => s.status === 'done').length,
        dismissedCount: state.filter((s) => s.status === 'dismissed').length,
      },
    };
  }

  /** The dormant engine's own endpoint — nothing in the app calls it today. It exists so the
   *  queue stays exercised and one wiring away from a surface, instead of rotting unrun. */
  router.get('/plan/advice', (_req, res) => {
    res.json(planPayload());
  });

  /** The household's verdict on one recommendation. `reset` puts it back in the queue —
   *  changing your mind about a decision is itself a decision the app must allow. */
  router.post('/advice/act', (req, res) => {
    const { key, action } = (req.body ?? {}) as { key?: unknown; action?: unknown };
    const valid = action === 'accept' || action === 'dismiss' || action === 'done' || action === 'reset';
    if (typeof key !== 'string' || key.length < 1 || key.length > 200 || !valid) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'key and action (accept|dismiss|done|reset) required' });
      return;
    }
    if (action === 'reset') {
      db.clearAdviceState(key);
      res.json({ ok: true });
      return;
    }
    // the item must currently exist in the queue — a verdict on a fact the data no longer
    // holds would poison the ledger with a number nothing backs
    const current = planPayload().advice.items.find((a) => a.key === key);
    if (!current) {
      res.status(404).json({ errorType: 'NOT_FOUND', errorMessage: 'no such recommendation' });
      return;
    }
    db.setAdviceState({
      key,
      status: action === 'accept' ? 'accepted' : action === 'dismiss' ? 'dismissed' : 'done',
      kind: current.kind,
      valueKind: current.valueKind,
      monthlyValue: current.monthlyValue,
      valueCertain: current.valueCertain ? 1 : 0,
      actionHe: current.actionHe,
      actedAt: new Date().toISOString(),
    });
    res.json({ ok: true, goal: current.goal });
  });

  const GOAL_TYPES = new Set(['buffer', 'reduction', 'set-aside']);

  /** Create a goal — from an accepted recommendation's seed, or typed by hand. A set-aside
   *  goal also opens the savings envelope that funds it, because a jar you cannot put money
   *  into is not a plan. A buffer goal does NOT: it is measured against real liquid money the
   *  household already holds, and an envelope starting at zero would understate it. */
  router.post('/goals', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const type = typeof b.type === 'string' && GOAL_TYPES.has(b.type) ? b.type as 'buffer' | 'reduction' | 'set-aside' : null;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!type || name.length < 2) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'type (buffer|reduction|set-aside) and a name are required' });
      return;
    }
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
    const targetAmount = num(b.targetAmount);
    const monthlyAmount = num(b.monthlyAmount);
    const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null;
    const categoryCeiling = num(b.categoryCeiling);
    if (type === 'reduction' && (category === null || categoryCeiling === null)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'a reduction goal needs a category and a ceiling' });
      return;
    }
    const savingsGoalId: number | null = null;
    const id = db.addPlanGoal({
      type,
      name,
      targetAmount,
      monthlyAmount,
      category,
      categoryCeiling,
      adviceKey: typeof b.adviceKey === 'string' && b.adviceKey ? b.adviceKey : null,
      savingsGoalId,
      status: 'active',
      startMonth: readAll().cal.monthOf(todayLocal()),
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ id, savingsGoalId });
  });

  router.put('/goals/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = db.listPlanGoals().find((g) => g.id === id);
    if (!existing) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' && b.name.trim().length >= 2 ? b.name.trim() : existing.name;
    const status = b.status === 'active' || b.status === 'achieved' || b.status === 'abandoned' ? b.status : existing.status;
    const num = (v: unknown, fallback: number | null): number | null => {
      if (v === null) return null;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : fallback;
    };
    db.updatePlanGoal(id, {
      name,
      targetAmount: num(b.targetAmount, existing.targetAmount),
      monthlyAmount: num(b.monthlyAmount, existing.monthlyAmount),
      categoryCeiling: num(b.categoryCeiling, existing.categoryCeiling),
      status,
      closedAt: status === 'active' ? null : (existing.closedAt ?? new Date().toISOString()),
    });
    res.json({ ok: true });
  });

  /** Removing a goal leaves its savings envelope alone: the money in it is real, and deleting
   *  an intention must never delete shekels. */
  router.delete('/goals/:id', (req, res) => {
    if (!db.deletePlanGoal(Number(req.params.id))) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.status(204).end();
  });

  /** A detected "recurring" that is actually two coincidental purchases pollutes the forecast —
   *  the user can silence it (and bring it back). */
  router.post('/recurring/mute', (req, res) => {
    const { merchant, kind } = (req.body ?? {}) as { merchant?: unknown; kind?: unknown };
    if (typeof merchant !== 'string' || merchant.trim().length < 2 || (kind !== 'income' && kind !== 'expense')) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'merchant and kind (income|expense) required' });
      return;
    }
    db.addRecurringOverride(merchant.trim(), kind);
    res.json({ ok: true });
  });

  router.post('/recurring/unmute', (req, res) => {
    const { merchant, kind } = (req.body ?? {}) as { merchant?: unknown; kind?: unknown };
    if (typeof merchant !== 'string' || (kind !== 'income' && kind !== 'expense')) {
      res.status(400).json({ errorType: 'INVALID_INPUT' });
      return;
    }
    db.deleteRecurringOverride(merchant, kind);
    res.json({ ok: true });
  });

  /* ——— "דברים שחשוב להגדיר" · המנויים שלי ———
   *  The human-in-the-loop layer over the recurring detector: the user curates which recurring
   *  charges are subscriptions (מנוי) vs other fixed commitments (חיוב קבוע), dismisses false
   *  positives (לא מחזורי → the existing mute), and adds ones the detector never saw. */
  router.get('/setup/subscriptions', (_req, res) => {
    const today = todayLocal();
    const { rows } = analysisData();
    const detected = detectRecurring(rows, { today });
    const merchantMark = deriveMerchantMarks(db.getTxnMarks(), rows);
    const expected = subscriptionAnchors(rows, merchantMark, today);
    res.json(buildExpenseDetail({
      rows, detected, txnMarks: db.getTxnMarks(), manual: db.getManualRecurring(), today,
      expected: new Map(expected.map((e) => [e.merchant, e.amount])),
    }));
  });

  const isTxnMark = (v: unknown): v is 'subscription' | 'fixed' | 'habit' | 'dismissed' =>
    v === 'subscription' || v === 'fixed' || v === 'habit' || v === 'dismissed';

  /** Classify one transaction. mark null clears it. The mark is metadata on that data-point; the
   *  merchant's recurring behavior (forecast, tags) is derived from these per-transaction verdicts. */
  router.post('/setup/txn-mark', (req, res) => {
    const { key, mark } = (req.body ?? {}) as { key?: unknown; mark?: unknown };
    if (typeof key !== 'string' || key.length < 1) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'key required' });
      return;
    }
    if (mark === null) db.deleteTxnMark(key);
    else if (isTxnMark(mark)) db.setTxnMark(key, mark, new Date().toISOString());
    else {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'mark must be subscription|fixed|habit|dismissed|null' });
      return;
    }
    res.json({ ok: true });
  });

  /** Apply one classification to every charge of a merchant (the "החל על כל החיובים" convenience).
   *  Operates over the 12-month analysis window — the same transactions the tab shows. */
  router.post('/setup/txn-mark/apply-merchant', (req, res) => {
    const { merchant, mark, expectedAmount } = (req.body ?? {}) as { merchant?: unknown; mark?: unknown; expectedAmount?: unknown };
    if (typeof merchant !== 'string' || merchant.length < 1 || (mark !== null && !isTxnMark(mark))) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'merchant and mark (subscription|fixed|habit|dismissed|null) required' });
      return;
    }
    const { rows } = analysisData();
    const keys = rows.filter((r) => isClassifiableExpense(r) && merchantKey(r.description, r.memo) === merchant).map((r) => r.key);
    db.setTxnMarksBulk(keys, mark, new Date().toISOString());
    // "the amount I marked IS the amount": anchor the subscription to the charge the user pointed at.
    // Clearing or dismissing the merchant drops the anchor (it is no longer a tracked commitment).
    if (mark === 'subscription' || mark === 'fixed') {
      if (typeof expectedAmount === 'number' && Number.isFinite(expectedAmount) && expectedAmount !== 0) {
        db.setMerchantExpected(merchant, Math.abs(expectedAmount), null, new Date().toISOString());
      }
    } else {
      db.clearMerchantExpected(merchant);
    }
    res.json({ ok: true, applied: keys.length });
  });

  /** Re-anchor a subscription to a new monthly cost — the "עדכן ל-₪X" action when its price changed. */
  router.post('/setup/subscription/expected', (req, res) => {
    const { merchant, amount } = (req.body ?? {}) as { merchant?: unknown; amount?: unknown };
    if (typeof merchant !== 'string' || merchant.length < 1 || typeof amount !== 'number' || !Number.isFinite(amount) || amount === 0) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'merchant and non-zero numeric amount required' });
      return;
    }
    db.setMerchantExpected(merchant, Math.abs(amount), null, new Date().toISOString());
    res.json({ ok: true });
  });

  /** Silence a one-off price change ("התעלם"): remember the amount so it does not nag again. */
  router.post('/setup/subscription/dismiss-change', (req, res) => {
    const { merchant, amount } = (req.body ?? {}) as { merchant?: unknown; amount?: unknown };
    if (typeof merchant !== 'string' || merchant.length < 1 || typeof amount !== 'number' || !Number.isFinite(amount)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'merchant and numeric amount required' });
      return;
    }
    db.setMerchantAlerted(merchant, Math.abs(amount));
    res.json({ ok: true });
  });

  /** Open installment plans (תשלומים): how many payments / how much is left, and when each frees up —
   *  the cash-flow-forward view of finite financed commitments. */
  router.get('/installments', (_req, res) => {
    res.json({ plans: activeInstallmentPlans(analysisData().recurring) });
  });

  /** The full charge history + pattern of ONE merchant, for the "היסטוריה ודפוס" popup. Reads ALL
   *  stored months (not the 12-month analysis window) so a long-run pattern (price drift, real
   *  cadence) is visible. `merchant` is the normalized key the transaction row already carries. */
  router.get('/merchant-history', (req, res) => {
    const merchant = typeof req.query.merchant === 'string' ? req.query.merchant : '';
    if (!merchant) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'merchant is required' });
      return;
    }
    const all = readLensed();
    const hist = merchantHistory({ rows: all, merchant, txnMarks: db.getTxnMarks() });
    if (!hist) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.json(hist);
  });

  /** נוכחות שקטה — the alerts worth a Windows notification, minus everything already shown.
   *  Read by the desktop shell on its background tick; the renderer never calls this. */
  router.get('/alerts/pending', (_req, res) => {
    const today = todayLocal();
    const { rows, recurring, cal } = analysisData();
    const month = cal.monthOf(today);
    const candidates: PendingAlert[] = alertsFromInsights(monthInsights(month, rows, recurring, cal.monthOf));
    try {
      const { payload } = cashflowAnalysis(30);
      if (payload.forecast) {
        const floor = forecastFloorAlert(payload.forecast.path, getOverdraftLimit(db), today);
        if (floor) candidates.push(floor);
      }
    } catch {
      // no forecast (thin data) — the other alerts still stand
    }
    const seen = new Set(db.listNotifiedAlertKeys());
    res.json({ alerts: candidates.filter((a) => !seen.has(a.key)) });
  });

  /** The desktop shell reports which alerts it actually showed — those keys never fire again. */
  router.post('/alerts/ack', (req, res) => {
    const { keys } = (req.body ?? {}) as { keys?: unknown };
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 64
      || !keys.every((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 200)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'keys must be 1-64 non-empty strings' });
      return;
    }
    db.markAlertsNotified(keys, new Date().toISOString());
    res.json({ ok: true });
  });

  /** שכבת השנה — the annual statement over ALL stored history (the year picker needs every year).
   *  ?year=YYYY, defaulting to the current flow year. */
  router.get('/year', (req, res) => {
    const { rows: all, cal } = readAll();
    const currentMonth = cal.monthOf(todayLocal());
    const raw = typeof req.query.year === 'string' ? req.query.year : currentMonth.slice(0, 4);
    if (!/^\d{4}$/.test(raw)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'year must be YYYY' });
      return;
    }
    res.json(computeYear(all, raw, currentMonth, db.getTxnMarks()));
  });

  /** The month-by-month history of ONE category, for the "היסטוריית התשלומים" popup opened from a
   *  row of "הקטגוריות של השנה". Reads ALL stored months — the same source the year card reads —
   *  so the bars and the row that opened them can never disagree. */
  router.get('/category-history', (req, res) => {
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    if (!category) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'category is required' });
      return;
    }
    const { rows: all } = readAll();
    const hist = computeCategoryHistory(all, category, db.getTxnMarks());
    if (!hist) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.json(hist);
  });

  /** "מה יורד לי כל חודש?": every repeating rhythm in the user's spending — statistically detected, each with a
   *  suggested nature (מנוי/קבוע/הרגל), plus the household's own verdicts. Reads ALL stored history
   *  for depth: what you are committed to is a present-state fact, not a window average.
   *
   *  THE surface for commitment claims. Whoever asks "how much is spoken for" — the tab, the health
   *  metrics — asks here, so no two screens can answer differently. */
  function patternsView(rows: FlaggedTxn[]) {
    return spendingPatterns({ rows, txnMarks: db.getTxnMarks(), today: todayLocal(), manual: db.getManualRecurring() });
  }

  router.get('/patterns', (_req, res) => {
    res.json(patternsView(readLensed()));
  });

  /** A subscription the detector never saw — paid in cash, on an unconnected card, or too new. */
  router.post('/setup/manual-recurring', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const amount = Number(b.amount);
    const cadence = b.cadence;
    const validCadence = cadence === 'weekly' || cadence === 'biweekly' || cadence === 'monthly'
      || cadence === 'bimonthly' || cadence === 'yearly';
    if (name.length < 2 || !Number.isFinite(amount) || amount <= 0 || !validCadence) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'name, positive amount and a valid cadence are required' });
      return;
    }
    const rawDay = Number(b.dayOfMonth);
    const dayOfMonth = Number.isFinite(rawDay) ? Math.min(31, Math.max(1, Math.round(rawDay))) : null;
    const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim() : null;
    const mark = b.mark === 'fixed' ? 'fixed' : 'subscription';
    const id = db.addManualRecurring({
      name, amount: Math.abs(amount), cadence, dayOfMonth, category, mark, createdAt: new Date().toISOString(),
    });
    res.json({ id });
  });

  router.delete('/setup/manual-recurring/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ errorType: 'INVALID_INPUT' });
      return;
    }
    db.deleteManualRecurring(id);
    res.status(204).end();
  });

  /** The equity curve of the checking account: end-of-day balance, day after day, reconstructed
   *  backwards from the latest snapshot through every bank transaction (nothing excluded —
   *  the balance is reality). Clipped at the first bank transaction we hold, so the chart
   *  never shows invented flat history. Covers ALL held data; the client cuts display ranges. */
  router.get('/balance-history', (_req, res) => {
    res.json(fullBankSeries());
  });

  /** "איך אני בכללי?" — the longitudinal conduct view. Spec: docs/2026-07-16-overview-tab-spec.md. */
  router.get('/overview', (req, res) => {
    const raw = Number(req.query.months);
    const monthsRequested = [3, 6, 12, 24].includes(raw) ? raw : 12;
    const flow = getFlow(db);
    const today = todayLocal();

    // flag over ALL data (exclusion sums must never see a subset), summarize everything we hold
    const { rows: all, cal } = readAll();
    const currentMonth = cal.monthOf(today);
    const breakdown = toCategoryBreakdown(all);
    const summaries = toMonthlySummary(all).map((m) => ({ ...m, byCategory: breakdown[m.month] ?? [] }));

    // fixed = spending on merchants the recurring engine knows, dead or alive: a stream that
    // ended last year was still a fixed commitment in the months it charged
    const overrides = new Set(db.getRecurringOverrides().map((o) => `${o.merchant}|${o.kind}`));
    const detected = detectRecurring(all, { today }).filter((i) => !overrides.has(`${i.merchant}|${i.kind}`));
    const fixedMerchants = new Set(detected.filter((i) => i.kind === 'expense' && !i.excludedFlow).map((i) => i.merchant));
    const fixedByMonth: Record<string, number> = {};
    for (const r of all) {
      if (r.status !== 'completed' || r.excluded || r.amount >= 0) continue;
      if (!fixedMerchants.has(merchantKey(r.description, r.memo))) continue;
      fixedByMonth[r.month] = (fixedByMonth[r.month] ?? 0) + -r.amount;
    }

    // envelope deposits per flow month, over the window + the previous window (for deltas)
    res.json(computeOverview({
      monthsRequested,
      currentMonth,
      anchorDay: flow.anchorDay,
      monthOf: cal.monthOf,
      summaries,
      daily: fullBankSeries().series,
      fixedByMonth,
      overdraftLimit: getOverdraftLimit(db),
    }));
  });

  /** ?months=3|6|12|24 — the user-chosen time basis. Averages, ratios and streaks read from
   *  this window; recurring streams stay detected over the full 12-month base — a 3-month
   *  window cannot see a yearly premium, and "what am I committed to" is a present-state
   *  fact, not a window average. */
  router.get('/health', async (req, res) => {
    const raw = Number(req.query.months);
    const windowMonths = [3, 6, 12, 24].includes(raw) ? raw : 12;
    // N COMPLETE months: the running month rides along and the metrics drop it themselves
    const { rows: all, cal } = readAll();
    const fromFlow = monthsBack(cal.monthOf(todayLocal()), windowMonths);
    const rows = all.filter((r) => r.month >= fromFlow);
    const { recurring } = analysisData();
    const summaries = toMonthlySummary(rows);
    const snap = latestBankSnapshot();
    let stats = null;
    if (snap) {
      const bankRows = rows.filter((r) => companyKind(r.company) === 'bank');
      stats = balanceStats(reconstructDailyBalances(snap.latestBankBalance, snap.latestDate, bankRows, `${fromFlow}-01`));
    }
    res.json({
      ...computeMetrics({
        summaries, rows, recurring, patterns: patternsView(all), bankStats: stats,
        latestBankBalance: snap?.latestBankBalance ?? null, liquidAssetsTotal: await liquidAssetsIlsFresh(),
      }),
      windowMonths,
    });
  });

  /**
   * The connected cards that contribute no יתרה לחיוב to `cardTotal`, by display name.
   *
   * Derived from the connections, never from the snapshots that happen to exist: a Cal + Isracard
   * user has a card snapshot, so `some(kind === 'card')` calls the picture complete while Isracard's
   * whole debt is missing from `netWorth` — and a user with no card at all has no snapshot, so the
   * same flag blames three issuers he never connected. A card connection writes no snapshot when the
   * scraper returns no balance (`:436`), so "has any snapshot" is exactly "reports a balance" here.
   */
  function cardsWithNoBalance(): string[] {
    const reporting = new Set(db.getLatestSnapshots().map((s) => s.connectionId));
    return db.getConnections()
      .filter((c) => companyKind(c.company) === 'card' && !reporting.has(c.id))
      .map((c) => c.nickname || companyNameHe(c.company));
  }

  router.get('/networth', async (_req, res) => {
    const conns = new Map(db.getConnections().map((c) => [c.id, c]));
    const latest = db.getLatestSnapshots().map((s) => {
      const c = conns.get(s.connectionId);
      return { ...s, kind: c ? companyKind(c.company) : 'other', label: c ? c.nickname || companyNameHe(c.company) : s.account };
    });
    const bankTotal = latest.filter((s) => s.kind === 'bank').reduce((s2, b) => s2 + b.balance, 0);
    // upcoming card debit is money already spent — counting it is what makes the number honest
    const cardTotal = latest.filter((s) => s.kind === 'card').reduce((s2, b) => s2 + b.balance, 0);
    // Only Cal reports a next-debit balance; for a Max/Isracard/Amex-only user there is no card
    // figure at all, so netWorth is knowingly missing the card debit and the panel must say so (A1).
    const cardBalanceAvailable = latest.some((s) => s.kind === 'card');
    const bankBalanceAvailable = latest.some((s) => s.kind === 'bank');
    const missingCards = cardsWithNoBalance();
    const assets = db.getAssets();

    // ── FX: every holding converts through the cached shekel rate; ILS-only users make
    //    no network call, and a missing rate EXCLUDES the holding rather than pricing it 1:1 ──
    const primaryCurrency = getPrimaryCurrency(db);
    await ensureRates([...assets.map((a) => a.currency), primaryCurrency]);
    const rates = ratesMap();
    const rateOf = (c: string) => (c === 'ILS' ? 1 : rates.get(c)?.rate ?? 0);
    const missingRates = [...new Set(
      [...assets.map((a) => a.currency), primaryCurrency].filter((c) => c !== 'ILS' && !rates.has(c)),
    )];
    const valueIls = (a: { amount: number; currency: string }) => a.amount * rateOf(a.currency);
    const assetsTotal = assets.filter((a) => a.kind === 'asset').reduce((s, a) => s + valueIls(a), 0);
    const liabilitiesTotal = assets.filter((a) => a.kind === 'liability').reduce((s, a) => s + valueIls(a), 0);

    // history: the reconstructed daily bank curve + the manual-asset timeline + the card timeline,
    // all stepped the same way. The card snapshots have a real timeline of their own, so pinning
    // today's cardTotal onto the last point would invent a cliff there instead (A6).
    const { series } = fullBankSeries();
    const localDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const kindById = new Map(assets.map((a) => [a.id, a.kind]));
    const currencyById = new Map(assets.map((a) => [a.id, a.currency]));
    const assetSnaps = db.getAssetSnapshots();
    const perAsset = new Map<number, { day: string; signed: number }[]>();
    for (const s of assetSnaps) {
      const g = perAsset.get(s.assetId) ?? [];
      // signed by the asset's CURRENT kind, never the snapshot's: a reclassification corrects what
      // the row always was, and must not carve a cliff into a day when nothing happened (A9).
      g.push({ day: localDay(s.takenAt), signed: (kindById.get(s.assetId) === 'liability' ? -1 : 1) * s.amount * s.rate });
      perAsset.set(s.assetId, g);
    }
    // the LAST point of each holding re-prices at today's rate: the past keeps the rate it was
    // observed at, but the present must agree with netWorth — one number, not two
    for (const [assetId, list] of perAsset) {
      const currency = currencyById.get(assetId);
      if (!currency || currency === 'ILS' || list.length === 0) continue;
      const currentRate = rates.get(currency)?.rate;
      if (currentRate === undefined) continue;
      const last = list[list.length - 1];
      const raw = assetSnaps.filter((s) => s.assetId === assetId).at(-1)!;
      last.signed = (kindById.get(assetId) === 'liability' ? -1 : 1) * raw.amount * currentRate;
    }
    const perCard = new Map<string, { day: string; signed: number }[]>();
    for (const s of db.getAllSnapshots()) {
      const c = conns.get(s.connectionId);
      if (!c || companyKind(c.company) !== 'card') continue;
      const key = `${s.connectionId}|${s.account}`;
      const g = perCard.get(key) ?? [];
      g.push({ day: localDay(s.takenAt), signed: s.balance }); // already stored negative
      perCard.set(key, g);
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;

    // ── תוכניות חיסכון: two kinds by where the money lives. INSIDE goals are envelopes
    //    over the checking balance — display attribution only, never in netWorth (that
    //    would count the same shekel twice). OUTSIDE goals hold money the bank feed cannot
    //    see (a separate account/deposit) — a real asset layer that joins netWorth.
    const cumulate = (daily: { date: string; amount: number }[]): number[] => {
      const out: number[] = [];
      let cum = 0;
      let i = 0;
      for (const p of series) {
        while (i < daily.length && daily[i].date <= p.date) cum += daily[i++].amount;
        out.push(cum);
      }
      return out;
    };

    // the same arithmetic, grouped by economic class — the combined curve IS the layers' sum,
    // so the decomposed chart can never disagree with the headline series
    const layerOf = new Map(assets.map((a) => [a.id, holdingLayer(a.type, a.kind)]));
    const layerValues = buildLayerValues(series, perAsset, layerOf, perCard);
    const history = series.map((p, i) => ({
      date: p.date,
      balance: round2(LAYER_KEYS.reduce((s, k) => s + layerValues[k][i], 0)),
    }));

    // where the reconstructed manual layer stops being invented: before this day the chart is
    // showing the first value we ever recorded, back-filled — a convention, not history (A5)
    const manualFrom = assetSnaps.map((s) => localDay(s.takenAt)).sort()[0] ?? null;

    // ── the balance-sheet layer: attribution, gross sides, per-holding timelines ──────────
    // flows through the same read pipeline as /summary, so "מחיסכון" here is the exact
    // number the month tab calls נטו — the user audits totals across tabs (spec §4)
    const { rows: lensedAll, cal } = readAll();
    const attribution = computeAttribution(
      history,
      toMonthlySummary(lensedAll),
      cal.startOf,
      cal.monthOf(todayLocal()),
    );
    const gross = grossTotals(
      latest.filter((s) => s.kind === 'bank' || s.kind === 'card').map((s) => s.balance),
      [
        ...assets.map((a) => ({ kind: a.kind, amount: valueIls(a) })),
        // external savings plans are an asset side the bank doesn't show
      ],
    );
    const assetHistories: Record<number, { date: string; amount: number; value: number }[]> = {};
    for (const s of assetSnaps) {
      const list = assetHistories[s.assetId] ?? (assetHistories[s.assetId] = []);
      const day = localDay(s.takenAt);
      const value = s.amount * s.rate; // the day's own rate, frozen at write time
      // one point per day — the last write that day is the day's fact
      if (list.length > 0 && list[list.length - 1].date === day) {
        list[list.length - 1].amount = s.amount;
        list[list.length - 1].value = value;
      } else list.push({ date: day, amount: s.amount, value });
    }
    // the latest point re-prices at today's rate, matching the history layer and netWorth
    for (const a of assets) {
      const list = assetHistories[a.id];
      if (!list || list.length === 0 || a.currency === 'ILS') continue;
      const rate = rates.get(a.currency)?.rate;
      if (rate !== undefined) list[list.length - 1].value = list[list.length - 1].amount * rate;
    }

    // ── מצב החשבון: the bank's five lines, ours line for line ────────────────────────────
    const nowMs = Date.now();
    const ageDays = (iso: string) => (nowMs - Date.parse(iso)) / 86_400_000;
    const isStale = (a: { type: HoldingType; monthlyPayment: number | null; updatedAt: string }) =>
      decays(a.type) && ageDays(a.updatedAt) > stalenessDays(a);

    function holdingRow(line: ApplicableLine): AccountStateRow {
      // the five lines mirror what the BANK prints, and the bank prints shekels: a foreign
      // holding (PayPal in dollars) lives in netWorth and the sheet, never in the bank mirror
      const list = assets.filter((a) => a.type === line && a.currency === 'ILS');
      const single = list.length === 1 ? list[0] : null;
      const note = line === 'deposit' && list.length > 0 ? NOTE_DEPOSIT_FUNDING_HE : null;
      return {
        line,
        labelHe: PANEL_LABELS_HE[line],
        // אין ≠ 0: no holding means we have no number, not a balance of nothing
        signedAmount: list.length === 0
          ? null
          : round2(list.reduce((s, a) => s + (a.kind === 'liability' ? -a.amount : a.amount), 0)),
        source: list.length === 0 ? 'none' : 'manual',
        assetId: single?.id ?? null,
        holdingCount: list.length,
        updatedAt: list.map((a) => a.updatedAt).sort()[0] ?? null,
        stale: list.some(isStale),
        ambiguous: list.length > 1,
        monthlyPayment: single?.monthlyPayment ?? null,
        remainingPaymentsHe: single ? remainingPaymentsTextHe(single.amount, single.monthlyPayment) : null,
        noteHe: list.length > 1 ? NOTE_AMBIGUOUS_HE : note,
      };
    }

    /** The two lines we scrape: no holding behind them, and never applicable from a paste. */
    const scrapedRow = (line: AccountStateLine, signedAmount: number | null, noteHe: string | null): AccountStateRow => ({
      line,
      labelHe: PANEL_LABELS_HE[line],
      signedAmount,
      source: 'scraped',
      assetId: null,
      holdingCount: 0,
      updatedAt: null,
      stale: false,
      ambiguous: false,
      monthlyPayment: null,
      remainingPaymentsHe: null,
      noteHe,
    });

    const rows: AccountStateRow[] = [
      scrapedRow('checking', bankBalanceAvailable ? round2(bankTotal) : null, null),
      scrapedRow(
        'card',
        cardBalanceAvailable ? round2(cardTotal) : null,
        // name the cards that report nothing; with none connected, say THAT rather than blaming
        // three issuers the user has never heard of in this app (A1)
        noteMissingCardBalanceHe(missingCards, cardBalanceAvailable)
          ?? (cardBalanceAvailable ? null : NOTE_NO_CARD_CONNECTED_HE),
      ),
      holdingRow('loan'),
      holdingRow('deposit'),
      holdingRow('securities'),
    ];

    // ── the primary-currency lens: everything is computed in shekels, then expressed in the
    //    chosen currency at the JSON edge. With no rate for it (never fetched), ILS wins —
    //    a silently wrong denomination is worse than an honest fallback (missingRates says so).
    const primaryRate = primaryCurrency === 'ILS' ? 1 : rates.get(primaryCurrency)?.rate;
    const currency = primaryRate ? primaryCurrency : 'ILS';
    const factor = primaryRate ? 1 / primaryRate : 1;
    const money = (n: number) => Math.round(n * factor * 100) / 100;

    res.json({
      netWorth: money(bankTotal + cardTotal + assetsTotal - liabilitiesTotal),
      currency,
      bankTotal: money(bankTotal),
      cardTotal: money(cardTotal),
      cardBalanceAvailable,
      cardsMissingBalance: missingCards,
      accounts: latest.map((a) => ({ ...a, balance: money(a.balance) })),
      // `amount` stays RAW in the holding's own currency; `value` is the primary-currency figure
      assets: assets.map((a) => ({ ...a, value: money(valueIls(a)) })),
      assetsTotal: money(assetsTotal),
      liabilitiesTotal: money(liabilitiesTotal),
      history: history.map((p) => ({ date: p.date, balance: money(p.balance) })),
      // aligned index-for-index with `history` — the same numbers, split by economic class
      layers: Object.fromEntries(LAYER_KEYS.map((k) => [k, layerValues[k].map(money)])),
      attribution: attribution.map((r) => ({
        ...r,
        income: money(r.income),
        expenses: money(r.expenses),
        open: r.open === null ? null : money(r.open),
        close: r.close === null ? null : money(r.close),
        revaluation: r.revaluation === null ? null : money(r.revaluation),
      })),
      gross: { assets: money(gross.assets), liabilities: money(gross.liabilities) },
      assetHistories: Object.fromEntries(
        Object.entries(assetHistories).map(([id, list]) => [
          id,
          list.map((p) => ({ ...p, value: money(p.value) })),
        ]),
      ),
      rates: db.getExchangeRates(),
      missingRates,
      anchorDay: cal.settings.anchorDay,
      manualFrom,
      manualStale: assets.some(isStale),
      accountState: {
        rows: rows.map((r) => (r.signedAmount === null ? r : { ...r, signedAmount: money(r.signedAmount) })),
        // the sum of the panel's five rows only — the bank picture, NOT net worth. It equals
        // netWorth only when the user holds nothing the bank doesn't show (an 'other' holding
        // or any foreign-currency one), which is why it is never labelled with an unqualified `נטו`.
        netBank: money(rows.reduce((s, r) => s + (r.signedAmount ?? 0), 0)),
      },
    });
  });

  /** The optional semantic fields shared by POST and PUT. Returns null when the body is malformed. */
  function holdingFields(body: Record<string, unknown>):
    | { type?: HoldingType; institution?: string | null; monthlyPayment?: number | null }
    | null {
    const out: { type?: HoldingType; institution?: string | null; monthlyPayment?: number | null } = {};
    const { type, institution, monthlyPayment } = body;
    if (type !== undefined) {
      if (!isHoldingType(type)) return null;
      out.type = type;
    }
    if (institution !== undefined) {
      if (institution !== null && (typeof institution !== 'string' || institution.length > 64)) return null;
      out.institution = institution === null ? null : institution.trim() || null;
    }
    if (monthlyPayment !== undefined) {
      if (monthlyPayment === null) out.monthlyPayment = null;
      else if (typeof monthlyPayment !== 'number' || !Number.isFinite(monthlyPayment) || monthlyPayment < 0) return null;
      else out.monthlyPayment = monthlyPayment;
    }
    return out;
  }

  /** A foreign-currency write needs a shekel rate to freeze into the snapshot. Fetches on
   *  demand; returns null (with the response already sent) when no rate can be had. */
  async function rateForWrite(res: Response, currency: string): Promise<number | null> {
    if (currency === 'ILS') return 1;
    await ensureRates([currency]);
    const rate = ratesMap().get(currency)?.rate;
    if (rate === undefined) {
      res.status(409).json({
        errorType: 'RATES_UNAVAILABLE',
        errorMessage: 'אין שער זמין למטבע הזה — בדוק את החיבור לאינטרנט ונסה שוב.',
      });
      return null;
    }
    return rate;
  }

  router.post('/assets', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { name, kind, amount, liquid, currency } = body as {
      name?: unknown; kind?: unknown; amount?: unknown; liquid?: unknown; currency?: unknown;
    };
    if (typeof name !== 'string' || !name.trim() || (kind !== 'asset' && kind !== 'liability') || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'name, kind (asset|liability), non-negative amount required' });
      return;
    }
    if (currency !== undefined && !isSupportedCurrency(currency)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'currency must be a supported ISO code' });
      return;
    }
    const extra = holdingFields(body);
    if (!extra) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'type (deposit|loan|securities|other), institution, monthlyPayment' });
      return;
    }
    const cur = currency ?? 'ILS';
    const rate = await rateForWrite(res, cur);
    if (rate === null) return;
    // kind follows type when a type is given; `other` keeps the user's choice
    const resolvedKind = extra.type ? kindForType(extra.type, kind) : kind;
    res.status(201).json({
      id: db.addAsset({
        name: name.trim(), kind, amount, liquid: resolvedKind === 'asset' && liquid === true,
        currency: cur, rateIlsPerUnit: rate, ...extra,
      }),
    });
  });

  /** Patch-shaped (A10), matching `db.updateAsset`: validate what is present, never demand what is
   *  not. Requiring `name` alongside `amount` made the panel's inline balance update — the one edit
   *  this feature exists for — a 400, and forced the client to re-send an unchanged name to fake it. */
  router.put('/assets/:id', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { name, amount, liquid, currency } = body as { name?: unknown; amount?: unknown; liquid?: unknown; currency?: unknown };
    const patch: { name?: string; amount?: number; liquid?: boolean; currency?: string; rateIlsPerUnit?: number } = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'name must be a non-empty string' });
        return;
      }
      patch.name = name.trim();
    }
    if (amount !== undefined) {
      // A8: always the magnitude the bank prints. A negative reaching netWorth flips the sign of the
      // largest number in the app and still reads as plausible.
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'amount must be a non-negative number' });
        return;
      }
      patch.amount = amount;
    }
    if (liquid !== undefined) {
      if (typeof liquid !== 'boolean') {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'liquid must be a boolean' });
        return;
      }
      patch.liquid = liquid;
    }
    if (currency !== undefined) {
      if (!isSupportedCurrency(currency)) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'currency must be a supported ISO code' });
        return;
      }
      patch.currency = currency;
    }
    const extra = holdingFields(body);
    if (!extra) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'type (deposit|loan|securities|other), institution, monthlyPayment' });
      return;
    }
    // the snapshot a moved value leaves behind freezes the day's rate — resolve it for the
    // row's currency AFTER the patch (an inline amount update of a USD holding sends no currency)
    const target = patch.currency
      ?? db.getAssets().find((a) => a.id === Number(req.params.id))?.currency
      ?? 'ILS';
    const rate = await rateForWrite(res, target);
    if (rate === null) return;
    patch.rateIlsPerUnit = rate;
    if (!db.updateAsset(Number(req.params.id), { ...patch, ...extra })) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.json({ id: Number(req.params.id) });
  });

  /* ——— הדבקת מצב חשבון: paste → review → apply. A parsed number is never written silently ——— */

  function holdingRefs(): HoldingRef[] {
    // a paste is the bank's ₪ summary — a foreign-currency holding (PayPal in dollars) is
    // never one of its lines, and letting an ILS paste overwrite a USD amount corrupts it
    return db.getAssets()
      .filter((a) => a.currency === 'ILS')
      .map((a) => ({ id: a.id, name: a.name, type: a.type, amount: a.amount }));
  }

  router.post('/account-state/preview', (req, res) => {
    const { text } = (req.body ?? {}) as { text?: unknown };
    if (typeof text !== 'string') {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'text required' });
      return;
    }
    const { lines, understood, ignored } = parseAccountState(text);
    const holdings = holdingRefs();
    const assets = db.getAssets();
    const conns = new Map(db.getConnections().map((c) => [c.id, c]));
    const latest = db.getLatestSnapshots().map((s) => ({
      kind: conns.has(s.connectionId) ? companyKind(conns.get(s.connectionId)!.company) : 'other',
      balance: s.balance,
    }));
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const bank = latest.filter((s) => s.kind === 'bank');
    const cards = latest.filter((s) => s.kind === 'card');

    /** The app's own figure for the same line — what the review table compares against. */
    function current(line: AccountStateLine): number | null {
      if (line === 'checking') return bank.length > 0 ? round2(bank.reduce((s, b) => s + b.balance, 0)) : null;
      if (line === 'card') return cards.length > 0 ? round2(cards.reduce((s, b) => s + b.balance, 0)) : null;
      const list = assets.filter((a) => a.type === line);
      return list.length === 0 ? null : round2(list.reduce((s, a) => s + a.amount, 0));
    }

    const missingCards = cardsWithNoBalance();
    const rows = lines.map((l) => {
      const resolution = resolveLine(l.line, l.amount, holdings);
      return {
        line: l.line,
        labelHe: l.label,
        amount: l.amount,
        // only the two non-holding lines may use it — they have no `kind` to carry their sign (A8)
        printedSign: l.printedSign,
        action: resolution.action,
        assetId: resolution.assetId,
        current: current(l.line),
        noteHe: noteForPreview(l.line, resolution, current(l.line), missingCards),
      };
    });
    res.json({ rows, understood, ignored });
  });

  /** The bank's two scraped lines are shown beside our own figure and are allowed to differ
   *  visibly — that is the point, so the note has to say WHY rather than hide the gap. */
  function noteForPreview(
    line: AccountStateLine,
    resolution: Resolution,
    current: number | null,
    missingCards: string[],
  ): string | null {
    if (resolution.ambiguity) return noteForAmbiguity(resolution.ambiguity);
    if (line === 'checking') return 'נקרא מהבנק אוטומטית — מוצג רק כדי להוכיח שההדבקה הובנה';
    if (line === 'card') {
      return noteMissingCardBalanceHe(missingCards, current !== null)
        ?? (current === null
          ? NOTE_NO_CARD_CONNECTED_HE
          : 'המספר שלנו מכסה רק את הכרטיסים המחוברים — שורת הבנק מכסה כל כרטיס בחשבון, והפער תקין');
    }
    if (line === 'deposit') return NOTE_DEPOSIT_FUNDING_HE;
    return null;
  }

  /**
   * Applies exactly what the user reviewed. Each row echoes the preview's resolution, and the server
   * re-derives it against live holdings: a second הלוואה created between preview and apply must 409,
   * not silently become a duplicate ₪45,678.90 liability. Every guard is server-side — the disabled
   * row in the UI is a courtesy, never the guard.
   */
  router.post('/account-state/apply', (req, res) => {
    const { rows } = (req.body ?? {}) as { rows?: unknown };
    if (!Array.isArray(rows)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'rows required' });
      return;
    }
    const holdings = holdingRefs();
    const planned: {
      line: ApplicableLine;
      action: 'create' | 'update' | 'unchanged';
      assetId: number | null;
      amount: number;
      labelHe: string;
    }[] = [];

    // validate every row BEFORE writing any: a mid-list rejection must leave nothing written
    for (const raw of rows) {
      const { line, action, assetId, amount, labelHe } = (raw ?? {}) as Record<string, unknown>;
      if (!isApplicableLine(line)) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'line must be deposit|loan|securities' });
        return;
      }
      if (action !== 'create' && action !== 'update' && action !== 'unchanged') {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'action must be create|update|unchanged' });
        return;
      }
      // A round-tripped negative reaching updateAsset would flip the sign of the largest number in
      // the app and still look plausible. Guarded here, not only at the /assets routes (A8).
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'amount must be a non-negative number' });
        return;
      }
      if (assetId !== null && assetId !== undefined && typeof assetId !== 'number') {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'assetId must be a number or null' });
        return;
      }
      if (labelHe !== undefined && (typeof labelHe !== 'string' || labelHe.length > 64)) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'labelHe must be a string of at most 64 chars' });
        return;
      }
      // The bank prints each line once. Two `create` rows for the same line would each resolve
      // against the same untouched holdings and both be written — a duplicate ₪45,678.90 liability.
      if (planned.some((p) => p.line === line)) {
        res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: `line ${line} appears more than once` });
        return;
      }
      const server = resolveLine(line, amount, holdings);
      if (server.action === 'ambiguous') {
        // the reason decides the words: one asks the user to pick a holding, the other to classify
        // the untyped row that would otherwise be doubled by this very create
        res.status(409).json({ errorType: 'AMBIGUOUS_HOLDING', errorMessage: noteForAmbiguity(server.ambiguity!) });
        return;
      }
      if (server.action !== action || server.assetId !== (assetId ?? null)) {
        res.status(409).json({ errorType: 'ACCOUNT_STATE_CHANGED', errorMessage: `${line} השתנה מאז שההדבקה נקראה` });
        return;
      }
      planned.push({ line, action, assetId: server.assetId, amount, labelHe: typeof labelHe === 'string' && labelHe.trim() ? labelHe.trim() : PANEL_LABELS_HE[line] });
    }

    let created = 0;
    let updated = 0;
    let confirmed = 0;
    db.transaction(() => {
      for (const row of planned) {
        if (row.action === 'create') {
          db.addAsset({ ...createdHolding(row.line, row.labelHe), amount: row.amount });
          created++;
        } else if (row.action === 'update') {
          // never touches liquid/name/institution — a user override survives every later paste (A12)
          db.updateAsset(row.assetId!, { amount: row.amount });
          updated++;
        } else {
          // "still true": moves updated_at so the nag clears, writes no snapshot (A11)
          db.confirmAsset(row.assetId!);
          confirmed++;
        }
      }
    });
    res.json({ applied: planned.length, created, updated, confirmed });
  });

  router.delete('/assets/:id', (req, res) => {
    if (!db.deleteAsset(Number(req.params.id))) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    res.status(204).end();
  });

  /* ——— savings goals: envelopes over money already in the account ——— */

  /** Parses/validates the goal body shared by create and update. Returns null when invalid. */

  router.get('/months/:month/review', (req, res) => {
    const month = req.params.month;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'month must be YYYY-MM' });
      return;
    }
    const { rows, recurring, cal } = analysisData();
    const summaries = toMonthlySummary(rows);
    const idx = summaries.findIndex((s) => s.month === month);
    const current = idx >= 0 ? summaries[idx] : null;
    if (!current) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const breakdown = toCategoryBreakdown(rows);
    // pending rows are (rightly) outside every figure above — but a number that quietly
    // ignores what the bank is still clearing feels "short"; name it instead
    const pendingRows = rows.filter((r) => r.month === month && r.status === 'pending' && !r.excluded);
    // המסגרת verdict: the frame in force for THIS month vs its variable spend. The fixed-vs-
    // variable split deliberately mirrors monthlyPlan (live commitments only) so the current
    // month's review and its plan card can never show two different numbers for "variable".
    const history = db.getFrameHistory();
    const frameAmount = frameForMonth(history, month);
    const fixedMerchants = new Set(
      recurring.filter((i) => i.kind === 'expense' && !i.excludedFlow && i.active).map((i) => i.merchant),
    );
    const { total: variableHistory, byCategory: variableCatHistory } = variableByMonth(rows, fixedMerchants);
    let frame: {
      amount: number; spent: number; left: number;
      split: ReturnType<typeof splitProgress>;
    } | null = null;
    if (frameAmount !== null) {
      const spent = Math.round((variableHistory[month] ?? 0) * 100) / 100;
      // the split the month is judged by is built from the months BEFORE it — a finished month
      // is never re-shaped by habits formed after it ended
      const priorMonths = Object.keys(variableCatHistory).filter((m) => m < month).sort();
      const monthSplit = proposeSplit(frameAmount, priorMonths, variableCatHistory);
      frame = {
        amount: frameAmount,
        spent,
        left: Math.round((frameAmount - spent) * 100) / 100,
        // a finished month is fully elapsed, so the projection IS the outcome
        split: splitProgress(monthSplit, variableCatHistory[month] ?? {}, 1, 1),
      };
    }

    // הריטואל החודשי: the app's one scheduled opinion. Reality against the declaration over
    // the last three judged months, and — when they consistently disagree — the number reality
    // says the frame actually is. Judged only on months up to the one being reviewed, so an
    // old review never argues with a decision made after it.
    const judgeable = Object.keys(variableHistory).filter((m) => m <= month).sort();
    const drift = computeDrift(history, variableHistory, judgeable);

    res.json({
      month,
      current,
      previous: summaries[idx + 1] ?? null,
      byCategory: breakdown[month] ?? [],
      topMerchants: topMerchants(month, rows),
      insights: monthInsights(month, rows, recurring, cal.monthOf),
      frame,
      drift,
      pending: {
        count: pendingRows.length,
        net: Math.round(pendingRows.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      },
    });
  });

  /** Wipe scraped data only (transactions + balance snapshots). Connections with their
   *  encrypted credentials, categorization rules, manual assets and settings all survive —
   *  one sync brings everything back clean. */
  router.delete('/data', (_req, res) => {
    const operation = coordinator.tryBegin('restoring');
    if (!operation) {
      rejectBusy(res, 'restoring');
      return;
    }
    try {
      res.json(db.clearScrapedData());
    } finally {
      operation.release();
    }
  });

  /** The deeper wipe: scraped data AND the verdict/rule layer on top of it (מנוי/קבוע/הרגל,
   *  anchored amounts, category and sector rules, manual recurring rows). Connections, assets,
   *  goals and settings survive — see FinanceDb.clearDataAndVerdicts.
   *
   *  A safety copy is taken first and reported back: this is the one destructive action in the
   *  app that no re-sync can undo, because the verdicts never existed in any bank. */
  router.delete('/data/full', async (_req, res) => {
    const operation = coordinator.tryBegin('restoring');
    if (!operation) {
      rejectBusy(res, 'restoring');
      return;
    }
    const file = automaticBackupFileName('wipe');
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      await db.backupTo(path.join(backupsDir, file));
      pruneAutomaticBackups(backupsDir);
    } catch (err) {
      // refuse to wipe when the net could not be hung — an irreversible delete without its
      // safety copy is exactly the case this backup exists for
      logRedactedFailure('pre-wipe-backup', err);
      operation.release();
      res.status(500).json({ errorType: 'BACKUP_FAILED' });
      return;
    }
    try {
      res.json({ ...db.clearDataAndVerdicts(), backupFile: file });
    } finally {
      operation.release();
    }
  });

  /** Trusted desktop import. The selected path is never echoed back to the renderer. */
  router.post('/data/import', async (req, res) => {
    if (
      options.desktopActionAuthorizationRequired
      && res.locals.desktopActionAuthorized !== true
    ) {
      res.status(403).json({ errorType: 'DESKTOP_ACTION_REQUIRED' });
      return;
    }
    const { sourcePath } = (req.body ?? {}) as { sourcePath?: unknown };
    if (
      typeof sourcePath !== 'string' ||
      !path.isAbsolute(sourcePath) ||
      !/\.(?:db|misgeret-backup)$/i.test(sourcePath)
    ) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'an absolute database backup path is required' });
      return;
    }
    // Import is a full destructive replace. Without this, cloning one profile's live database
    // over another is a supported gesture: the suffix check alone accepts profiles/<A>/finance.db.
    if (
      isPathInside(path.join(rootDataDir, 'profiles'), sourcePath)
      || isPathInside(path.join(rootDataDir, 'deleted-profiles'), sourcePath)
    ) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'source path is inside the profile store' });
      return;
    }
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const operation = coordinator.tryBegin('migrating');
    if (!operation) {
      rejectBusy(res, 'migrating');
      return;
    }
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      await db.restoreFrom(sourcePath, {
        preRestorePath: path.join(backupsDir, automaticBackupFileName('import')),
      });
      pruneAutomaticBackups(backupsDir);
      const credentialsUnavailable: number[] = [];
      for (const connection of db.getConnections()) {
        const blob = db.getConnectionCredentials(connection.id);
        try {
          if (!blob) throw new Error('missing credential blob');
          const credentials = decryptCredentials(blob);
          if (isLegacyCredentialBlob(blob)) {
            db.replaceConnectionCredentials(connection.id, encryptCredentials(credentials));
          }
        } catch {
          credentialsUnavailable.push(connection.id);
          db.setConnectionSyncResult(connection.id, connection.lastSyncAt, 'CREDENTIALS_UNAVAILABLE');
        }
      }
      res.json({
        ok: true,
        parity: { tables: db.getTableCounts(), quickCheck: 'ok', credentialsUnavailable },
      });
    } catch (err) {
      logRedactedFailure('import', err);
      res.status(500).json({ errorType: 'IMPORT_FAILED' });
    } finally {
      operation.release();
    }
  });

  /** Main-process-only safety snapshot used immediately before an installed update. */
  router.post('/backup/automatic', async (req, res) => {
    if (
      options.desktopActionAuthorizationRequired
      && res.locals.desktopActionAuthorized !== true
    ) {
      res.status(403).json({ errorType: 'DESKTOP_ACTION_REQUIRED' });
      return;
    }
    if ((req.body as { reason?: unknown } | undefined)?.reason !== 'update') {
      res.status(400).json({ errorType: 'INVALID_INPUT' });
      return;
    }
    const operation = coordinator.tryBegin('backingUp');
    if (!operation) {
      rejectBusy(res, 'backingUp');
      return;
    }
    const file = automaticBackupFileName('update');
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      await db.backupTo(path.join(backupsDir, file));
      pruneAutomaticBackups(backupsDir);
      res.status(201).json({ file });
    } catch (err) {
      logRedactedFailure('automatic-backup', err);
      res.status(500).json({ errorType: 'BACKUP_FAILED' });
    } finally {
      operation.release();
    }
  });

  /** One-click insurance: a timestamped online snapshot of the whole database. */
  router.post('/backup', async (_req, res) => {
    const operation = coordinator.tryBegin('backingUp');
    if (!operation) {
      rejectBusy(res, 'backingUp');
      return;
    }
    const file = manualBackupFileName();
    try {
      fs.mkdirSync(backupsDir, { recursive: true });
      await db.backupTo(path.join(backupsDir, file));
      // `profileId` lets main resolve profiles/<id>/backups/<file>; `file` stays a bare basename.
      res.status(201).json({ file, profileId: options.profileId });
    } catch (err) {
      logRedactedFailure('backup', err);
      res.status(500).json({ errorType: 'BACKUP_FAILED' });
    } finally {
      operation.release();
    }
  });

  router.get('/backups', (_req, res) => {
    if (!fs.existsSync(backupsDir)) {
      res.json({ backups: [] });
      return;
    }
    const backups = fs
      .readdirSync(backupsDir)
      .filter(isManualBackupFile)
      .map((f) => {
        const st = fs.statSync(path.join(backupsDir, f));
        return { file: f, size: st.size, createdAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.file.localeCompare(a.file));
    res.json({ backups });
  });

  /** Restores a named backup over the live data (per-table replace, one transaction). */
  router.post('/backups/restore', async (req, res) => {
    const { file } = (req.body ?? {}) as { file?: unknown };
    if (typeof file !== 'string' || !isManualBackupFile(file)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'unknown backup file name' });
      return;
    }
    const p = path.join(backupsDir, file);
    if (!fs.existsSync(p)) {
      res.status(404).json({ errorType: 'NOT_FOUND' });
      return;
    }
    const operation = coordinator.tryBegin('restoring');
    if (!operation) {
      rejectBusy(res, 'restoring');
      return;
    }
    try {
      const preRestoreFile = automaticBackupFileName('restore');
      await db.restoreFrom(p, { preRestorePath: path.join(backupsDir, preRestoreFile) });
      pruneAutomaticBackups(backupsDir);
      res.json({ ok: true });
    } catch (err) {
      logRedactedFailure('restore', err);
      res.status(500).json({ errorType: 'RESTORE_FAILED' });
    } finally {
      operation.release();
    }
  });

  /** Issuer sector strings NO automatic tier understands — exact map, sector vocabulary and
   *  user mappings all missed. One click in Settings maps such a sector for history + future,
   *  so a new card company's vocabulary never requires a code change. */
  router.get('/issuer-sectors', (_req, res) => {
    const overrides = new Set(db.getSectorOverrides().map((o) => o.sector));
    const sectors = db.getIssuerSectors().filter(
      (s) => sectorToCategory(s.sector) === null && !overrides.has(s.sector.trim()),
    );
    res.json({ sectors });
  });

  /** Map an issuer sector to a category — stored in the DB, applied retroactively to every
   *  machine-categorized row of that sector, and honored by every future sync. */
  router.post('/issuer-sectors/map', (req, res) => {
    const { sector, category } = (req.body ?? {}) as { sector?: unknown; category?: unknown };
    if (
      typeof sector !== 'string' || sector.trim().length === 0 ||
      typeof category !== 'string' || !CATEGORY_IDS.has(category)
    ) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'sector and a valid category required' });
      return;
    }
    const trimmed = sector.trim();
    db.setSectorOverride(trimmed, category);
    const updated = db.applySectorOverride(trimmed, category);
    res.json({ sector: trimmed, category, updated });
  });

  /** The engine showing its own blind spots, in BOTH directions. `candidates`: large bank
   *  movements that still count as income or expense. Keyed on MONEY SHAPE, not on a category
   *  basis — one user rule ('פיקדון' → העברות) would resolve every row of a deposit renewal to
   *  'rule' and blind a category-based filter while the fiction kept counting. `excluded` retires
   *  a pattern from it: everything the vocabulary understands and everything the user teaches
   *  drops out on the next read. A salary legitimately appears here — the Hebrew label says so.
   *  `savingsExcluded`: what the vocabulary took OUT of the flows on its own. Kept out of
   *  `candidates` so the feed still retires, but visible and reversible, because a wrong exclusion
   *  is money the app hid and 'flow' is the only lever that returns it. */
  router.get('/flow-candidates', (_req, res) => {
    const overrides = flowOverrides();
    const flagged = readLensed();
    const round = (n: number) => Math.round(n * 100) / 100;

    type Group = {
      pattern: string; sampleDescription: string; count: number; total: number;
      inflow: number; outflow: number; lastDate: string; weakBasis: boolean;
    };
    const add = (groups: Map<string, Group>, pattern: string, r: FlaggedTxn, weak: boolean) => {
      const g = groups.get(pattern);
      if (!g) {
        groups.set(pattern, {
          pattern, sampleDescription: r.description, count: 1, total: r.amount,
          inflow: r.amount > 0 ? r.amount : 0, outflow: r.amount < 0 ? r.amount : 0,
          lastDate: r.date, weakBasis: weak,
        });
        return;
      }
      g.count += 1;
      g.total += r.amount;
      if (r.amount > 0) g.inflow += r.amount;
      else g.outflow += r.amount;
      g.weakBasis = g.weakBasis && weak;
      if (r.date > g.lastDate) {
        g.lastDate = r.date;
        g.sampleDescription = r.description;
      }
    };

    const groups = new Map<string, Group>();
    const excludedGroups = new Map<string, Group>();
    for (const r of flagged) {
      if (r.status !== 'completed' || companyKind(r.company) !== 'bank') continue;
      if (Math.abs(r.amount) < 5000) continue;
      const pattern = normalizePattern(r.description);
      if (pattern.length < 2 || overrides.has(pattern)) continue;
      if (r.excluded) {
        // The vocabulary is a vocabulary, not an oracle: פיקדון is also a rental deposit, and
        // tier 3 is deliberately sign-agnostic and pairing-free, so it WILL take real money by
        // mistake. What it excluded on its own must stay findable and reversible — otherwise
        // teaching runs in one direction only and a false positive is money the app hid with no
        // remedy anywhere, which is the same disease as the double count.
        if (r.excludeReason === 'savings') add(excludedGroups, pattern, r, false);
        continue;
      }
      // the naive positive-credit fallback, or the refinable floor: a weak basis for counting
      // real money. It ranks the feed — it cannot filter it, because a rule can overwrite it.
      const weak = r.categorySource === 'income' || (r.category === 'other' && r.categorySource === 'auto');
      add(groups, pattern, r, weak);
    }

    // The harm is GROSS, not net. Both legs of a renewal collapse to ONE pattern — they are both
    // principal — so a signed total cancels them: the ₪40,000 of fiction this feed exists to
    // surface reports ₪0 and sorts below every salary. Σ|amount| is what ranks it.
    const gross = (g: Group) => g.inflow - g.outflow;
    const candidates = [...groups.values()]
      .sort((a, b) => Number(b.weakBasis) - Number(a.weakBasis) || gross(b) - gross(a))
      .map((g) => ({ ...g, total: round(g.total), inflow: round(g.inflow), outflow: round(g.outflow) }));
    const savingsExcluded = [...excludedGroups.values()]
      .sort((a, b) => gross(b) - gross(a))
      .map((g) => ({
        pattern: g.pattern, sampleDescription: g.sampleDescription, count: g.count,
        total: round(g.total), inflow: round(g.inflow), outflow: round(g.outflow), lastDate: g.lastDate,
      }));

    // Card debits we cannot attribute to a company. Read-only ON PURPOSE: the only class that
    // fits is 'internal', which is unconditional and permanent, while settlement exclusion is
    // conditional (it needs the card connected, and a partial first cycle must count the bank
    // row). A static 'internal' would delete real spending — an undercount, the same disease as
    // the double count. And normalizePattern destroys the last-4, the only thing telling two
    // physical cards apart. Surfacing this with no answer is honest; a wrong answer is not.
    const suspects = new Map<string, { pattern: string; sampleDescription: string; count: number; total: number }>();
    if (connectedCardCompanies(db).size > 0) {
      for (const r of flagged) {
        if (r.status !== 'completed' || companyKind(r.company) !== 'bank' || r.amount >= 0) continue;
        if (settlementCompany(r.description) !== null || !isSettlementShaped(r.description, r.memo)) continue;
        const pattern = normalizePattern(r.description);
        const s = suspects.get(pattern);
        if (!s) suspects.set(pattern, { pattern, sampleDescription: r.description, count: 1, total: r.amount });
        else {
          s.count += 1;
          s.total += r.amount;
        }
      }
    }
    const settlementSuspects = [...suspects.values()]
      .map((s) => ({ ...s, total: round(s.total) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));

    res.json({ candidates, savingsExcluded, settlementSuspects });
  });

  /** Full transaction export — the data is the user's, always. UTF-8 BOM so Excel reads Hebrew.
   *  The exclusion pipeline runs at export time: without the excluded/exclude_reason columns,
   *  summing the file in Excel would double-count card settlements — the exact error the app
   *  exists to prevent. flow_month is the month under the active lens/anchor. */
  router.get('/export.csv', (_req, res) => {
    const labels = new Map(db.getConnections().map((c) => [c.id, c.nickname || companyNameHe(c.company)]));
    const raw = db.getTxnsSinceMonth('0000-00');
    const calendarMonth = new Map(raw.map((t) => [t.key, t.month]));
    const rows = readAll().rows;
    const esc = (v: unknown) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = 'date,month,flow_month,description,amount,currency,category,status,type,installments,company,connection,account,excluded,exclude_reason';
    const lines = rows.map((t) =>
      [
        t.date, calendarMonth.get(t.key) ?? t.month, t.month, esc(t.description), t.amount, t.currency ?? '', t.category ?? '',
        t.status, t.type,
        t.installmentNumber && t.installmentTotal ? `${t.installmentNumber}/${t.installmentTotal}` : '',
        t.company, esc(labels.get(t.connectionId) ?? ''), esc(t.account),
        t.excluded ? 'true' : 'false', t.excludeReason ?? '',
      ].join(','),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="misgeret-transactions.csv"');
    res.send('﻿' + [header, ...lines].join('\n'));
  });

  router.get('/months/:month/txns', (req, res) => {
    const month = req.params.month;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({ errorType: 'INVALID_INPUT', errorMessage: 'month must be YYYY-MM' });
      return;
    }
    const labels = new Map(db.getConnections().map((c) => [c.id, c.nickname || companyNameHe(c.company)]));
    // the per-merchant verdict rolled up from the user's per-transaction marks — drives the
    // inline "מנוי"/"קבוע" toggle state on each row (and the legacy subscription tag)
    const merchantMark = deriveMerchantMarks(db.getTxnMarks(), analysisData().rows);
    const subMerchants = subscriptionMerchants(merchantMark, db.getManualRecurring());
    // flag over ALL data: transfer pairs, settlement/card coverage and lens/anchor shifts can
    // straddle month boundaries; the drill-down must agree with the summary
    const flagged = readLensed().filter((t) => t.month === month);
    res.json({
      txns: flagged.map((t) => {
        const mk = merchantKey(t.description, t.memo);
        // only a genuine already-left-the-account outflow may be classified inline; income, card
        // double-counts and not-yet-charged rows carry no buttons
        const classifiable = isClassifiableExpense(t);
        // the payee/purpose the bank buried in the memo — meaningful only for generic transfers
        // (rent-by-transfer reads "העברה דיגיטל"); for a normal merchant it equals the description
        const label = merchantLabel(t.description, t.memo);
        return {
          key: t.key,
          date: t.date,
          description: t.description,
          merchant: mk,
          merchantName: label !== t.description ? label : null,
          amount: t.amount,
          company: t.company,
          connectionLabel: labels.get(t.connectionId) ?? companyNameHe(t.company),
          status: t.status,
          excluded: t.excluded,
          excludeReason: t.excludeReason ?? null,
          category: t.category,
          categorySource: t.categorySource,
          installments: t.installmentNumber && t.installmentTotal ? `${t.installmentNumber}/${t.installmentTotal}` : null,
          classifiable,
          mark: classifiable ? (merchantMark.get(mk) ?? null) : null,
          subscription: subMerchants.has(mk),
        };
      }),
    });
  });

  return router;
}
