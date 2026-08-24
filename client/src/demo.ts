/* ——— מצב דמו לאתר ———
   The real client, running against a frozen recording of a real server's answers
   (MOCK_BANK data). Loaded only when the bundle is built with VITE_DEMO=1 — the
   desktop/web app never ships or executes this path. Reads come from the bundle;
   the few dynamic surfaces (search, rule preview, forecast what-if) are emulated
   here so the demo feels alive; every write explains itself with DEMO_MODE. */
import { ApiError } from './api';
import type { CashflowResponse, DayBalance, SearchTxn } from './types';

interface DemoBundle {
  capturedAt: string;
  months: string[];
  responses: Record<string, unknown>;
}

let bundlePromise: Promise<DemoBundle> | null = null;

function loadBundle(): Promise<DemoBundle> {
  bundlePromise ??= fetch(new URL('demo-data.json', document.baseURI)).then((r) => {
    if (!r.ok) throw new ApiError('DEMO_DATA_MISSING');
    return r.json() as Promise<DemoBundle>;
  });
  return bundlePromise;
}

/** structuredClone so a view mutating its response can never poison the next visit. */
function serve<T>(value: unknown): T {
  return structuredClone(value) as T;
}

function allTxns(b: DemoBundle): SearchTxn[] {
  const out: SearchTxn[] = [];
  for (const m of b.months) {
    const res = b.responses[`/api/months/${m}/txns`] as { txns?: SearchTxn[] } | undefined;
    if (res?.txns) out.push(...res.txns);
  }
  return out;
}

function searchDemo(b: DemoBundle, url: string): unknown {
  const q = (new URL(url, 'http://x').searchParams.get('q') ?? '').trim().toLowerCase();
  const hits = q
    ? allTxns(b).filter((t) => t.description.toLowerCase().includes(q)).sort((a, z) => z.date.localeCompare(a.date))
    : [];
  return { total: hits.length, txns: hits.slice(0, 60) };
}

function rulePreviewDemo(b: DemoBundle, url: string): unknown {
  const pattern = (new URL(url, 'http://x').searchParams.get('pattern') ?? '').trim().toLowerCase();
  const count = pattern ? allTxns(b).filter((t) => t.description.toLowerCase().includes(pattern)).length : 0;
  return { count };
}

const DAY_MS = 86_400_000;

/** The server computes what-if on the real engine; the demo approximates the same
 *  transforms on the recorded baseline — directionally faithful, clearly a demo. */
function cashflowDemo(b: DemoBundle, url: string): unknown {
  const params = new URL(url, 'http://x').searchParams;
  const days = params.get('days') ?? '';
  const baseKey = days ? `/api/cashflow?days=${days}` : '/api/cashflow';
  const base = serve<CashflowResponse>(b.responses[baseKey] ?? b.responses['/api/cashflow']);
  const extraMonthly = Number(params.get('extraMonthly') ?? 0);
  const oneOffAmount = Number(params.get('oneOffAmount') ?? 0);
  const oneOffMonth = params.get('oneOffMonth');
  const variableFactor = Number(params.get('variableFactor') ?? 1);
  const wantsScenario = extraMonthly !== 0 || (oneOffAmount !== 0 && oneOffMonth) || variableFactor !== 1;
  if (!wantsScenario || !base.forecast) return base;

  const path = base.forecast.path;
  const t0 = new Date(path[0]?.date ?? Date.now()).getTime();
  const adjusted: DayBalance[] = path.map((p) => {
    const dayIdx = Math.max(0, Math.round((new Date(p.date).getTime() - t0) / DAY_MS));
    let balance = p.balance;
    balance += extraMonthly * (dayIdx / 30.44);
    balance -= (variableFactor - 1) * base.forecast!.variableDaily * dayIdx;
    if (oneOffAmount && oneOffMonth && p.date >= `${oneOffMonth}-01`) balance -= oneOffAmount;
    return { date: p.date, balance: Math.round(balance) };
  });
  const trough = adjusted.reduce((min, p) => (p.balance < min.balance ? p : min), adjusted[0]);
  const endOfMonth = adjusted.find((p) => p.date === base.forecast!.endOfMonth.date) ?? adjusted[adjusted.length - 1];
  return { ...base, scenario: { path: adjusted, trough, endOfMonth } };
}

export async function demoRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const b = await loadBundle();

  if (method !== 'GET') {
    // boot safety: profile activation must succeed for the app to enter its world
    const activate = /^\/api\/profiles\/([^/]+)\/activate$/.exec(url);
    if (activate) return { activeId: decodeURIComponent(activate[1]) } as T;
    throw new ApiError('DEMO_MODE');
  }

  if (url.startsWith('/api/search?')) return searchDemo(b, url) as T;
  if (url.startsWith('/api/rules/preview?')) return rulePreviewDemo(b, url) as T;
  if (url === '/api/cashflow' || url.startsWith('/api/cashflow?')) return cashflowDemo(b, url) as T;
  if (url === '/api/status') {
    // the recording ages; the demo doesn't — "synced 20 minutes ago", always
    const status = serve<{ lastSyncAt: string | null }>(b.responses['/api/status']);
    return { ...status, lastSyncAt: new Date(Date.now() - 20 * 60_000).toISOString(), autoSyncOnOpen: false } as T;
  }

  const exact = b.responses[url];
  if (exact !== undefined) return serve<T>(exact);
  const base = b.responses[url.split('?')[0]];
  if (base !== undefined) return serve<T>(base);
  throw new ApiError('NOT_FOUND');
}
