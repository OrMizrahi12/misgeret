/**
 * Fills a mock profile with everything a scrape cannot produce, so every tab has something to show.
 *
 * A bank sync can only ever create transactions. Savings goals, net-worth holdings, the savings
 * target and the pattern verdicts are all DECLARED by the household — which means a freshly synced
 * profile leaves four tabs empty, and screenshots of empty tabs sell nothing.
 *
 * Run against an ISOLATED dev server with MOCK_BANK=1 and MOCK_PROFILE=showcase:
 *
 *     $env:SEED_SYNTHETIC_DATA='1'; node scripts/seed_showcase.mjs
 *
 * Idempotent by name: re-running skips connections, goals and assets that already exist, so it is
 * safe to run repeatedly against the same dev profile.
 */

const API = process.env.SEED_API ?? 'http://localhost:3001/api';

if (process.env.SEED_SYNTHETIC_DATA !== '1') {
  throw new Error('Refusing to seed without SEED_SYNTHETIC_DATA=1. Use an isolated DATA_DIR and MOCK_BANK=1.');
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return json;
}

const log = (m) => console.log(`seed: ${m}`);

// ── 1. identity + settings — every visible detail is fictional and deterministic ──────────────
const registry = await call('GET', '/profiles');
const active = registry.profiles.find((p) => p.id === registry.activeId);
if (!active) throw new Error('No active profile exists.');
if (active.name !== 'משפחת ישראלי — הדגמה' || active.color !== '#4fd1c5') {
  await call('PUT', `/profiles/${encodeURIComponent(active.id)}`, {
    name: 'משפחת ישראלי — הדגמה',
    color: '#4fd1c5',
  });
  log('fictional demo profile named');
}
await call('PUT', '/settings', {
  months: 24,
  monthLens: 'charge',
  monthStartDay: 9,
  overdraftLimit: 10000,
  autoSyncOnOpen: false,
  primaryCurrency: 'ILS',
});
log('24-month view and demo preferences saved');

// ── 2. connections — one bank, one card, so the dedup story is real ────────────────────────────
const existing = await call('GET', '/connections');
const have = new Set(existing.map((c) => c.company));
const CONNECTIONS = [
  { company: 'leumi', nickname: 'העו״ש שלנו', credentials: { username: 'demo', password: 'demo' } },
  { company: 'isracard', nickname: 'ישראכרט', credentials: { id: '000000000', card6Digits: '123456', password: 'demo' } },
];
for (const c of CONNECTIONS) {
  if (have.has(c.company)) { log(`connection ${c.company} already there`); continue; }
  await call('POST', '/connections', c);
  log(`connection ${c.company} created`);
}

// ── 3. sync — pulls the full history the mock scraper generates ────────────────────────────────
log('syncing…');
await call('POST', '/sync');
const summary = await call('GET', '/summary');
log(`synced · ${summary.summary?.length ?? 0} months of visible history`);

// ── 4. the one declaration — what share of income to keep ──────────────────────────────────────
await call('PUT', '/target', { rate: 0.2 });
log('savings target 20%');

// ── 5. current planning goals — all three shapes the plan understands ──────────────────────────
const plan = await call('GET', '/plan/advice');
const haveGoals = new Set((plan.goals ?? []).map((g) => g.name));
const GOALS = [
  { type: 'buffer', name: 'קרן חירום משפחתית', targetAmount: 75000, monthlyAmount: 2500 },
  { type: 'set-aside', name: 'חופשה משפחתית', targetAmount: 24000, monthlyAmount: 1200 },
  { type: 'reduction', name: 'מסעדות עד 1,200 ₪', category: 'restaurants', categoryCeiling: 1200 },
];
for (const g of GOALS) {
  if (haveGoals.has(g.name)) { log(`goal "${g.name}" already there`); continue; }
  await call('POST', '/goals', g);
  log(`goal "${g.name}" created`);
}

// ── 6. net worth — the holdings no bank sync can see ───────────────────────────────────────────
const nw = await call('GET', '/networth');
const haveAssets = new Set((nw.assets ?? []).map((a) => a.name));
const ASSETS = [
  // the mortgage has to have something on the other side of it, or the household reads as
  // half a million in the hole — which is what a liability without its asset always looks like
  { name: 'הדירה', kind: 'asset', amount: 1850000, liquid: false, type: 'other', institution: 'נכס' },
  { name: 'קרן השתלמות', kind: 'asset', amount: 96400, liquid: false, type: 'securities', institution: 'אלטשולר שחם' },
  { name: 'פיקדון שקלי', kind: 'asset', amount: 45000, liquid: true, type: 'deposit', institution: 'בנק לאומי' },
  { name: 'תיק ניירות ערך', kind: 'asset', amount: 63200, liquid: true, type: 'securities', institution: 'IBI' },
  { name: 'משכנתא', kind: 'liability', amount: 612000, type: 'loan', institution: 'בנק לאומי', monthlyPayment: 6250 },
  { name: 'הלוואת רכב', kind: 'liability', amount: 38400, type: 'loan', institution: 'כאל', monthlyPayment: 1150 },
];
for (const a of ASSETS) {
  if (haveAssets.has(a.name)) { log(`asset "${a.name}" already there`); continue; }
  await call('POST', '/assets', a);
  log(`asset "${a.name}" created`);
}

// ── 7. pattern verdicts — nothing counts as committed until the household says so ──────────────
// (the curated-commitments law: detections are proposals, never facts)
const MARKS = [
  { merchant: 'NETFLIX.COM', mark: 'subscription' },
  { merchant: 'SPOTIFY', mark: 'subscription' },
  { merchant: 'YES', mark: 'subscription' },
  { merchant: 'הולמס פלייס', mark: 'subscription' },
  { merchant: 'סלקום', mark: 'subscription' },
  { merchant: 'משכנתא', mark: 'fixed' },
  { merchant: 'ארנונה', mark: 'fixed' },
  { merchant: 'גן ילדים', mark: 'fixed' },
  { merchant: 'ביטוח בריאות', mark: 'fixed' },
  { merchant: 'מסעדות שף', mark: 'habit' },
  { merchant: 'פז יילו', mark: 'habit' },
];
for (const m of MARKS) {
  try {
    await call('POST', '/setup/txn-mark/apply-merchant', m);
    log(`marked ${m.merchant} → ${m.mark}`);
  } catch (e) {
    log(`skip ${m.merchant}: ${e.message.slice(0, 80)}`);
  }
}

const patterns = await call('GET', '/patterns');
log(`done · ${patterns.patterns?.length ?? 0} patterns known`);
