import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, test, vi } from 'vitest';
import { createApp } from './app.js';
import { FinanceDb } from './db.js';
import { flowMonthOf, monthsBack } from './flow.js';
import { OperationCoordinator } from './operation-coordinator.js';
import { syncWindowMonths } from './companies.js';
import { createApi, windowStart } from './routes.js';
import { MockScraper, mockSettlementAmount, type BankScraper, type ScrapeOutcome, type ScrapeTarget } from './scraper.js';
import { row } from './test-helpers.js';

function makeApp(scraper: BankScraper = new MockScraper()) {
  const db = new FinanceDb(':memory:');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-test-'));
  // tests must never touch the real rate providers — a fixed fake keeps FX deterministic:
  // 1 ILS buys 0.25 USD / 0.2 EUR, so one dollar is exactly ₪4 and one euro exactly ₪5
  const rateFetcher = async () => ({ ok: true, json: async () => ({ rates: { USD: 0.25, EUR: 0.2 } }) });
  const app = createApp({ db, scraper, dataDir, rateFetcher });
  return { app, db, dataDir };
}

const LEUMI = { company: 'leumi', credentials: { username: 'u', password: 'p' } };
const ISRACARD = { company: 'isracard', credentials: { id: '012345678', card6Digits: '123456', password: 'p' } };
const VISA_CAL = { company: 'visaCal', credentials: { username: 'u', password: 'p' } };

/** App with a leumi + isracard mock connection already configured. */
async function mockAppWithConnections() {
  const { app, db, dataDir } = makeApp();
  await request(app).post('/api/connections').send(LEUMI);
  await request(app).post('/api/connections').send(ISRACARD);
  return { app, db, dataDir };
}

describe('companies + connections API', () => {
  test('GET /api/companies lists institutions without OTP companies', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/companies');
    expect(res.status).toBe(200);
    const ids = res.body.map((c: { id: string }) => c.id);
    expect(ids).toContain('leumi');
    expect(ids).toContain('isracard');
    expect(ids).not.toContain('oneZero');
  });

  test('POST /api/connections validates company and required fields', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/api/connections').send({ company: 'noSuchBank', credentials: {} })).status).toBe(400);
    expect((await request(app).post('/api/connections').send({ company: 'leumi', credentials: { username: 'u' } })).status).toBe(400);
    expect((await request(app).post('/api/connections').send({ company: 'oneZero', credentials: {} })).status).toBe(400);

    const ok = await request(app).post('/api/connections').send({ ...LEUMI, nickname: 'העו"ש' });
    expect(ok.status).toBe(201);
    expect(typeof ok.body.id).toBe('number');

    const list = await request(app).get('/api/connections');
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ company: 'leumi', nameHe: 'בנק לאומי', nickname: 'העו"ש' });
    expect('credentials' in list.body[0]).toBe(false);

    const status = await request(app).get('/api/status');
    expect(status.body).toEqual({ connectionCount: 1, lastSyncAt: null, autoSyncOnOpen: true });
  });

  test('PUT updates nickname/credentials; DELETE removes connection and its txns', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/connections').send(LEUMI)).body.id;

    expect((await request(app).put('/api/connections/999').send({ nickname: 'x' })).status).toBe(404);
    expect((await request(app).put(`/api/connections/${id}`).send({ credentials: { username: 'u' } })).status).toBe(400);
    expect((await request(app).put(`/api/connections/${id}`).send({ nickname: 'חדש' })).status).toBe(200);
    expect((await request(app).get('/api/connections')).body[0].nickname).toBe('חדש');

    await request(app).post('/api/sync');
    expect((await request(app).get('/api/summary')).body.summary.length).toBeGreaterThan(0);

    expect((await request(app).delete(`/api/connections/${id}`)).status).toBe(204);
    expect((await request(app).delete(`/api/connections/${id}`)).status).toBe(404);
    expect((await request(app).get('/api/summary')).body.summary).toHaveLength(0);
  });
});

describe('sync', () => {
  test('sync without connections is a 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/sync');
    expect(res.status).toBe(400);
    expect(res.body.errorType).toBe('NO_CONNECTIONS');
  });

  test('multi-connection sync reports per-connection results and is idempotent', async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/connections').send(ISRACARD);

    const sync1 = await request(app).post('/api/sync');
    expect(sync1.status).toBe(200);
    expect(sync1.body.results).toHaveLength(2);
    for (const r of sync1.body.results) {
      expect(r.success).toBe(true);
      expect(r.added).toBeGreaterThan(0);
    }

    const sync2 = await request(app).post('/api/sync');
    for (const r of sync2.body.results) expect(r.added).toBe(0);
  });

  test('one failing connection does not block the others', async () => {
    class FlakyScraper implements BankScraper {
      private mock = new MockScraper();
      scrape(target: ScrapeTarget, creds: Record<string, string>, startDate: Date): Promise<ScrapeOutcome> {
        if (target.company === 'isracard') {
          return Promise.resolve({ success: false, errorType: 'INVALID_PASSWORD' });
        }
        return this.mock.scrape(target, creds, startDate);
      }
    }
    const { app } = makeApp(new FlakyScraper());
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/connections').send(ISRACARD);

    const res = await request(app).post('/api/sync');
    const byCompany = Object.fromEntries(res.body.results.map((r: { company: string }) => [r.company, r]));
    expect(byCompany.leumi.success).toBe(true);
    expect(byCompany.isracard).toMatchObject({ success: false, errorType: 'INVALID_PASSWORD' });

    const conns = (await request(app).get('/api/connections')).body;
    const isracard = conns.find((c: { company: string }) => c.company === 'isracard');
    expect(isracard.lastError).toBe('INVALID_PASSWORD');

    expect((await request(app).get('/api/summary')).body.summary.length).toBeGreaterThan(0);
  });

  test('a hang at a bank with a known outage is stored as an outage, not as "try again"', async () => {
    class HangingScraper implements BankScraper {
      scrape(): Promise<ScrapeOutcome> {
        return Promise.resolve({ success: false, errorType: 'TIMEOUT' });
      }
    }
    const { app } = makeApp(new HangingScraper());
    await request(app).post('/api/connections')
      .send({ company: 'hapoalim', credentials: { userCode: 'u', password: 'p' } }).expect(201);
    await request(app).post('/api/connections').send(LEUMI).expect(201);

    const res = await request(app).post('/api/sync');
    const byCompany = Object.fromEntries(res.body.results.map((r: { company: string }) => [r.company, r]));
    expect(byCompany.hapoalim.errorType).toBe('PROVIDER_OUTAGE');
    // the same hang at a bank with no outage stays a plain timeout — retrying there really may work
    expect(byCompany.leumi.errorType).toBe('TIMEOUT');

    const conns = (await request(app).get('/api/connections')).body;
    const hapoalim = conns.find((c: { company: string }) => c.company === 'hapoalim');
    expect(hapoalim.lastError).toBe('PROVIDER_OUTAGE');
    // the row carries the explanation itself, so no screen has to keep a second copy of it
    expect(hapoalim.outage.since).toBe('2026-06-02');
    expect(hapoalim.historyMonths).toBe(12);
    expect(conns.find((c: { company: string }) => c.company === 'leumi').outage).toBeNull();
  });

  test('each institution is asked for its own depth, never one number for all', async () => {
    const asked = new Map<string, Date>();
    class RecordingScraper implements BankScraper {
      private mock = new MockScraper();
      scrape(target: ScrapeTarget, creds: Record<string, string>, startDate: Date): Promise<ScrapeOutcome> {
        asked.set(target.company, startDate);
        return this.mock.scrape(target, creds, startDate);
      }
    }
    const { app } = makeApp(new RecordingScraper());
    await request(app).post('/api/connections').send(LEUMI).expect(201);
    await request(app).post('/api/connections').send(ISRACARD).expect(201);
    await request(app).post('/api/sync').expect(200);

    // Leumi gives three years, so our full window survives; Isracard caps at one and asking for
    // more is a number we would only be telling ourselves
    expect(asked.get('leumi')!.toISOString()).toBe(windowStart(24).toISOString());
    expect(asked.get('isracard')!.toISOString()).toBe(windowStart(12).toISOString());
  });
});

describe('card-settlement exclusion (end to end)', () => {
  test('connecting a card removes the double count; removing it restores the bank line', async () => {
    const { app } = makeApp();
    // charge lens on purpose: the with/without-card equality below holds only when the card
    // details land in the same month as the settlement they replace
    await request(app).put('/api/settings').send({ monthLens: 'charge' }).expect(200);
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/sync');
    const bankOnly = (await request(app).get('/api/summary')).body.summary[0];

    const cardId = (await request(app).post('/api/connections').send(ISRACARD)).body.id;
    await request(app).post('/api/sync');
    const withCard = (await request(app).get('/api/summary')).body.summary[0];

    // settlement excluded, card purchases (same total) counted instead → expenses unchanged
    expect(withCard.expenses).toBeCloseTo(bankOnly.expenses, 1);

    const txns = (await request(app).get(`/api/months/${withCard.month}/txns`)).body.txns;
    const settlement = txns.find((t: { description: string }) => t.description.includes('ישראכרט בעמ'));
    expect(settlement).toMatchObject({ excluded: true });
    const cardTxn = txns.find((t: { company: string }) => t.company === 'isracard');
    expect(cardTxn).toMatchObject({ excluded: false, connectionLabel: 'ישראכרט' });

    // retroactive un-exclusion on delete
    await request(app).delete(`/api/connections/${cardId}`);
    const reverted = (await request(app).get('/api/summary')).body.summary[0];
    expect(reverted.expenses).toBeCloseTo(bankOnly.expenses, 1);
  });
});

describe('data wipe', () => {
  test('DELETE /api/data clears txns and snapshots but keeps connections, rules and assets', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    db.addRule('סופרמרקט', 'groceries');
    await request(app).post('/api/assets').send({ name: 'פיקדון', kind: 'asset', amount: 1000 }).expect(201);

    const wiped = await request(app).delete('/api/data').expect(200);
    expect(wiped.body.txns).toBeGreaterThan(0);
    expect(wiped.body.snapshots).toBeGreaterThan(0);

    expect((await request(app).get('/api/summary')).body.summary).toHaveLength(0);
    expect((await request(app).get('/api/balances')).body.balances).toHaveLength(0);
    expect((await request(app).get('/api/status')).body).toMatchObject({ connectionCount: 2, lastSyncAt: null });
    expect((await request(app).get('/api/connections')).body.every((c: { lastSyncAt: string | null }) => c.lastSyncAt === null)).toBe(true);
    expect(db.getRules()).toHaveLength(1);
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(1);

    // one sync restores the full window
    await request(app).post('/api/sync').expect(200);
    expect((await request(app).get('/api/summary')).body.summary.length).toBeGreaterThan(0);
  });

  test('DELETE /api/data leaves the verdicts behind — the reason a plain wipe felt like a no-op', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const merchant = (await request(app).get('/api/patterns')).body.patterns[0].merchant as string;
    await request(app).post('/api/setup/txn-mark/apply-merchant').send({ merchant, mark: 'habit' }).expect(200);

    await request(app).delete('/api/data').expect(200);
    await request(app).post('/api/sync').expect(200);
    const after = (await request(app).get('/api/patterns')).body.patterns
      .find((p: { merchant: string }) => p.merchant === merchant);
    expect(after.userMarked).toBe(true);   // the verdict re-attached itself to the fresh rows
    expect(after.nature).toBe('habit');
  });

  test('DELETE /api/data/full clears the verdicts too, backs up first, and keeps assets + connections', async () => {
    const { app, dataDir } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/assets').send({ name: 'פיקדון', kind: 'asset', amount: 1000 }).expect(201);
    const merchant = (await request(app).get('/api/patterns')).body.patterns[0].merchant as string;
    await request(app).post('/api/setup/txn-mark/apply-merchant').send({ merchant, mark: 'habit' }).expect(200);

    const wiped = await request(app).delete('/api/data/full').expect(200);
    expect(wiped.body.txns).toBeGreaterThan(0);
    expect(wiped.body.verdicts).toBeGreaterThan(0);
    expect(wiped.body.backupFile).toMatch(/^auto-wipe-finance-[\d-]+\.db$/);
    expect(fs.existsSync(path.join(dataDir, 'backups', wiped.body.backupFile))).toBe(true);

    // what the user chose to keep survives
    expect((await request(app).get('/api/status')).body.connectionCount).toBe(2);
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(1);

    // and after a fresh sync the pattern comes back as a PROPOSAL, not as a verdict
    await request(app).post('/api/sync').expect(200);
    const after = (await request(app).get('/api/patterns')).body.patterns
      .find((p: { merchant: string }) => p.merchant === merchant);
    expect(after.userMarked).toBe(false);
    expect(after.countsAsHabit).toBe(false);
  });
});

describe('balance history (equity curve)', () => {
  test('reconstructs a continuous daily series ending exactly at the snapshot balance', async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/balance-history').expect(200);
    const series: { date: string; balance: number }[] = res.body.series;
    expect(series.length).toBeGreaterThan(60);
    expect(series.at(-1)!.balance).toBe(res.body.latestBankBalance);
    // strictly ascending, one point per day, no invented history before the first bank txn
    const dayMs = 86_400_000;
    for (let i = 1; i < series.length; i++) {
      expect(new Date(`${series[i].date}T00:00Z`).getTime() - new Date(`${series[i - 1].date}T00:00Z`).getTime()).toBe(dayMs);
    }
    const spanDays = (Date.now() - new Date(`${series[0].date}T00:00Z`).getTime()) / dayMs;
    expect(spanDays).toBeLessThan(760); // sync depth is 24 months — nothing flat beyond the data
  });

  test('no bank connection → empty series, null balance', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/balance-history').expect(200);
    expect(res.body).toEqual({ latestBankBalance: null, series: [] });
  });
});

describe('month drill-down', () => {
  test('validates month format and returns flagged rows', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/months/2026-5/txns')).status).toBe(400);
    expect((await request(app).get('/api/months/2026-05/txns')).body.txns).toEqual([]);

    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/sync');
    const month = (await request(app).get('/api/summary')).body.summary[0].month;
    const txns = (await request(app).get(`/api/months/${month}/txns`)).body.txns;
    expect(txns.length).toBeGreaterThan(0);
    expect(txns[0]).toHaveProperty('connectionLabel');
    expect(txns[0]).toHaveProperty('excluded');
    expect(txns[0]).toHaveProperty('status');
  });
});

describe('settings', () => {
  const DEFAULTS = {
    months: 6, monthLens: 'purchase', monthStartDay: 1,
    overdraftLimit: 0, autoSyncOnOpen: true, primaryCurrency: 'ILS', suggestedAnchorDay: null,
  };

  test('defaults, rejects invalid, persists valid — partial updates keep other keys', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/api/settings')).body).toEqual(DEFAULTS);
    expect((await request(app).put('/api/settings').send({ months: 5 })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ monthLens: 'nope' })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ monthStartDay: 31 })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ overdraftLimit: -100 })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ autoSyncOnOpen: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ primaryCurrency: 'XXX' })).status).toBe(400);
    expect((await request(app).put('/api/settings').send({ months: 12 })).body).toEqual({ ...DEFAULTS, months: 12 });
    expect((await request(app).put('/api/settings').send({ monthLens: 'purchase', monthStartDay: 10 })).body).toEqual({
      ...DEFAULTS, months: 12, monthLens: 'purchase', monthStartDay: 10,
    });
    // 0 = show everything we hold
    expect((await request(app).put('/api/settings').send({ months: 0 })).body.months).toBe(0);
    // the credit line and the auto-sync switch persist
    expect((await request(app).put('/api/settings').send({ overdraftLimit: 8000 })).body.overdraftLimit).toBe(8000);
    expect((await request(app).put('/api/settings').send({ autoSyncOnOpen: false })).body.autoSyncOnOpen).toBe(false);
    expect((await request(app).get('/api/status')).body.autoSyncOnOpen).toBe(false);
  });

  test('suggests anchoring the month to the detected salary day', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    // the mock salary lands on the 1st of every month
    expect((await request(app).get('/api/settings')).body.suggestedAnchorDay).toBe(1);
  });
});

describe('deep sync + full-window reads (view range is display-only)', () => {
  test("sync pulls ~24 months regardless of the display setting; months=0 shows it all", async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).put('/api/settings').send({ months: 3 }).expect(200);
    await request(app).post('/api/sync').expect(200);

    expect((await request(app).get('/api/summary')).body.summary.length).toBeLessThanOrEqual(3);
    await request(app).put('/api/settings').send({ months: 0 }).expect(200);
    expect((await request(app).get('/api/summary')).body.summary.length).toBeGreaterThanOrEqual(24);
  });

  test('review inbox covers ALL data even when the display window is short', async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).put('/api/settings').send({ months: 3 }).expect(200);
    await request(app).post('/api/sync').expect(200);

    const res = await request(app).get('/api/review').expect(200);
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 4);
    expect(res.body.txns.some((t: { date: string }) => new Date(t.date) < cutoff)).toBe(true);
    // and the dashboard badge agrees with the inbox
    const summary = await request(app).get('/api/summary').expect(200);
    expect(summary.body.reviewCount).toBe(res.body.txns.length);
  });

  test('global search finds transactions across all held data', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get(`/api/search?q=${encodeURIComponent('משכורת')}`).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(20);
    expect(res.body.txns[0].description).toBe('משכורת');
    expect(res.body.txns[0]).toHaveProperty('connectionLabel');
    expect(res.body.txns[0]).toHaveProperty('excluded');
    await request(app).get('/api/search?q=x').expect(400);
  });

  test('search explains WHY a row is excluded — a bare grey tag on money he never spent is not an answer', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    db.insertTxns([
      row({ date: '2026-07-06T10:00:00.000Z', amount: -20700, description: 'חידוש פיקדון פק"מ משנה ומעלה', company: 'leumi' }),
    ]);
    const res = await request(app).get(`/api/search?q=${encodeURIComponent('פיקדון')}`).expect(200);
    const hit = res.body.txns.find((t: { amount: number }) => t.amount === -20700);
    expect(hit).toMatchObject({ excluded: true, excludeReason: 'savings' });
  });

  test('review flow: ruleId returned, preview counts, undo restores the inbox and reverts the rule', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    const preview = await request(app).get(`/api/rules/preview?pattern=${encodeURIComponent('חשבון חשמל')}`).expect(200);
    expect(preview.body.count).toBeGreaterThanOrEqual(20);
    await request(app).get('/api/rules/preview?pattern=x').expect(400);

    // the refine queue holds only auto-'other' rows — the electricity bill is the mock's unknown
    const review = await request(app).get('/api/review').expect(200);
    const target = review.body.txns.find((t: { description: string }) => t.description === 'חשבון חשמל');
    const put = await request(app)
      .put(`/api/txns/${target.key}/category`)
      .send({ category: 'bills', rulePattern: 'חשבון חשמל' })
      .expect(200);
    expect(typeof put.body.ruleId).toBe('number');

    // undo: clear the row, delete the rule WITH revert — everything returns to the refine queue
    await request(app).delete(`/api/txns/${target.key}/category`).expect(204);
    await request(app).delete(`/api/rules/${put.body.ruleId}?revert=1`).expect(204);
    const after = await request(app).get('/api/review').expect(200);
    expect(after.body.txns.some((t: { key: string }) => t.key === target.key)).toBe(true);
    const month = new Date().toISOString().slice(0, 7);
    // zero-uncategorized guarantee survives a full undo: floor category, never null
    expect(db.getTxnsForMonth(month).filter((t) => t.description === 'חשבון חשמל')
      .every((t) => t.category === 'other' && t.categorySource === 'auto')).toBe(true);
  });

  test('rule revert restores the automatic categories the rule had overwritten', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    // the supermarket auto-classifies via the semantic family on sync
    expect(db.getTxnsForMonth(month).filter((t) => t.description === 'סופרמרקט')
      .every((t) => t.category === 'groceries' && t.categorySource === 'auto')).toBe(true);

    const key = db.getTxnsForMonth(month).find((t) => t.description === 'סופרמרקט')!.key;
    const put = await request(app)
      .put(`/api/txns/${key}/category`)
      .send({ category: 'shopping', rulePattern: 'סופרמרקט' })
      .expect(200);
    // the rule overwrote the automatic classification everywhere
    expect(db.getTxnsForMonth(month).filter((t) => t.description === 'סופרמרקט')
      .every((t) => t.category === 'shopping')).toBe(true);

    await request(app).delete(`/api/rules/${put.body.ruleId}?revert=1`).expect(204);
    // revert restores the AUTOMATIC category — not null, and not the rule's
    expect(db.getTxnsForMonth(month).filter((t) => t.description === 'סופרמרקט' && t.categorySource !== 'user')
      .every((t) => t.category === 'groceries')).toBe(true);
  });

  test('sync progress reflects the finished run and rejects concurrent syncs politely', async () => {
    const { app } = await mockAppWithConnections();
    expect((await request(app).get('/api/sync/progress')).body).toEqual({ running: false, items: [] });
    await request(app).post('/api/sync').expect(200);
    const prog = await request(app).get('/api/sync/progress');
    expect(prog.body.running).toBe(false);
    expect(prog.body.items).toHaveLength(2);
    expect(prog.body.items.every((i: { status: string }) => i.status === 'ok')).toBe(true);
  });

  test('summary exposes a topInsight slot for the running month', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/summary').expect(200);
    expect('topInsight' in res.body).toBe(true);
  });

  test('manual cash transactions: created, counted, deletable — scraped rows are not', async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI);
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const before = (await request(app).get('/api/summary')).body.summary.find((m: { month: string }) => m.month === month);

    await request(app).post('/api/txns').send({ date: 'bad', description: 'x', amount: -50 }).expect(400);
    await request(app).post('/api/txns').send({ date: `${month}-05`, description: 'פ', amount: -50 }).expect(400);
    await request(app).post('/api/txns').send({ date: `${month}-05`, description: 'שוק', amount: 0 }).expect(400);
    await request(app).post('/api/txns').send({ date: `${month}-05`, description: 'שוק', amount: -50, category: 'nope' }).expect(400);

    const created = await request(app)
      .post('/api/txns')
      .send({ date: `${month}-05`, description: 'שוק הכרמל מזומן', amount: -150, category: 'groceries' })
      .expect(201);

    const after = (await request(app).get('/api/summary')).body.summary.find((m: { month: string }) => m.month === month);
    expect(after.expenses).toBeCloseTo(before.expenses + 150, 1);
    const txns = (await request(app).get(`/api/months/${month}/txns`)).body.txns;
    const manual = txns.find((t: { company: string }) => t.company === 'manual');
    expect(manual).toMatchObject({ description: 'שוק הכרמל מזומן', excluded: false, category: 'groceries', connectionLabel: 'ידני' });
    expect(typeof manual.key).toBe('string');

    // scraped rows are not deletable; the manual row is
    const scraped = txns.find((t: { company: string }) => t.company === 'leumi');
    await request(app).delete(`/api/txns/${scraped.key ?? 'none'}`).expect(404);
    await request(app).delete(`/api/txns/${created.body.key}`).expect(204);
    const reverted = (await request(app).get('/api/summary')).body.summary.find((m: { month: string }) => m.month === month);
    expect(reverted.expenses).toBeCloseTo(before.expenses, 1);
  });

  test('backup → wipe → restore brings the data back', async () => {
    const { app, dataDir } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = (await request(app).get('/api/summary')).body.summary;
    expect(before.length).toBeGreaterThan(0);

    const backup = await request(app).post('/api/backup').expect(201);
    expect(backup.body.file).toMatch(/^finance-[\d-]+\.db$/);
    const list = await request(app).get('/api/backups').expect(200);
    expect(list.body.backups.some((b: { file: string }) => b.file === backup.body.file)).toBe(true);

    await request(app).delete('/api/data').expect(200);
    expect((await request(app).get('/api/summary')).body.summary).toHaveLength(0);

    await request(app).post('/api/backups/restore').send({ file: backup.body.file }).expect(200);
    const restored = (await request(app).get('/api/summary')).body.summary;
    expect(restored).toEqual(before);
    expect(fs.readdirSync(path.join(dataDir, 'backups')).some((file) => /^auto-restore-finance-[\d-]+\.db$/.test(file)))
      .toBe(true);

    await request(app).post('/api/backups/restore').send({ file: '../evil.db' }).expect(400);
    await request(app).post('/api/backups/restore').send({ file: 'finance-1999-01-01-00-00-00.db' }).expect(404);
  });

  test('a concurrent database operation is rejected with APP_BUSY while sync is active', async () => {
    let startScrape!: () => void;
    let finishScrape!: () => void;
    const started = new Promise<void>((resolve) => { startScrape = resolve; });
    const finished = new Promise<void>((resolve) => { finishScrape = resolve; });
    const blockingScraper: BankScraper = {
      async scrape() {
        startScrape();
        await finished;
        return { success: false, errorType: 'CANCELLED' };
      },
    };
    const db = new FinanceDb(':memory:');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-busy-'));
    const coordinator = new OperationCoordinator();
    const app = createApp({ db, scraper: blockingScraper, dataDir, coordinator });
    await request(app).post('/api/connections').send(LEUMI).expect(201);

    const sync = request(app).post('/api/sync').then((response) => response);
    await started;
    const backup = await request(app).post('/api/backup').expect(409);
    expect(backup.body).toMatchObject({ errorType: 'APP_BUSY', operation: 'syncing' });
    finishScrape();
    expect((await sync).status).toBe(200);
    db.close();
  });

  test('backup setup failure releases its operation lease and redacts the raw error', async () => {
    const db = new FinanceDb(':memory:');
    const coordinator = new OperationCoordinator();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-lease-'));
    const app = createApp({ db, scraper: new MockScraper(), dataDir, coordinator });
    const rawSecret = 'SECRET-C:\\Users\\person\\bank.db';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error(rawSecret);
    });
    try {
      await request(app).post('/api/backup').expect(500, { errorType: 'BACKUP_FAILED' });
      expect(coordinator.state).toBe('idle');
      expect(JSON.stringify(log.mock.calls)).not.toContain(rawSecret);
    } finally {
      mkdir.mockRestore();
      log.mockRestore();
      db.close();
    }
  });

  test('desktop import accepts a selected SQLite file and returns local parity counts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-import-'));
    const sourcePath = path.join(dir, 'legacy.db');
    const source = new FinanceDb(sourcePath);
    source.setSetting('months', '24');
    source.close();
    const live = new FinanceDb(path.join(dir, 'live.db'));
    live.setSetting('months', '3');
    const app = createApp({ db: live, scraper: new MockScraper(), dataDir: dir });

    const imported = await request(app).post('/api/data/import').send({ sourcePath }).expect(200);
    expect(imported.body.ok).toBe(true);
    expect(imported.body.parity.quickCheck).toBe('ok');
    expect(imported.body.parity.tables.settings).toBeGreaterThan(0);
    expect((await request(app).get('/api/settings')).body.months).toBe(24);
    expect(fs.readdirSync(path.join(dir, 'backups')).some((file) => /^auto-import-finance-[\d-]+\.db$/.test(file)))
      .toBe(true);
    await request(app).post('/api/data/import').send({ sourcePath: '../legacy.db' }).expect(400);
    live.close();
  });

  test('secured desktop import rejects the renderer token alone and requires the main-process capability', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-privileged-import-'));
    const sourcePath = path.join(dir, 'legacy.db');
    const source = new FinanceDb(sourcePath);
    source.setSetting('months', '18');
    source.close();
    const live = new FinanceDb(path.join(dir, 'live.db'));
    live.setSetting('months', '3');
    const app = createApp({
      db: live,
      scraper: new MockScraper(),
      dataDir: dir,
      apiSecurity: {
        token: 'renderer-token',
        desktopActionToken: 'main-only-action-token',
      },
    });
    const authenticatedImport = () => request(app)
      .post('/api/data/import')
      .set('Host', '127.0.0.1')
      .set('Authorization', 'Bearer renderer-token')
      .send({ sourcePath });

    const directlyMountedRouter = express();
    directlyMountedRouter.use(express.json());
    directlyMountedRouter.use('/api', createApi(live, new MockScraper(), dir, {
      desktopActionAuthorizationRequired: true,
    }));
    await request(directlyMountedRouter)
      .post('/api/data/import')
      .send({ sourcePath })
      .expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    expect(live.getSetting('months')).toBe('3');

    await authenticatedImport().expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    expect(live.getSetting('months')).toBe('3');
    await request(app)
      .post('/api/DATA/IMPORT/')
      .set('Host', '127.0.0.1')
      .set('Authorization', 'Bearer renderer-token')
      .send({ sourcePath })
      .expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    expect(live.getSetting('months')).toBe('3');
    for (const encodedOrAmbiguousPath of ['/api/data/%69mport', '/api/data%2Fimport', '/api//data//import']) {
      const bypass = await request(app)
        .post(encodedOrAmbiguousPath)
        .set('Host', '127.0.0.1')
        .set('Authorization', 'Bearer renderer-token')
        .send({ sourcePath });
      expect([403, 404]).toContain(bypass.status);
      expect(bypass.status).not.toBe(200);
      expect(live.getSetting('months')).toBe('3');
    }
    await authenticatedImport()
      .set('X-Misgeret-Desktop-Action', 'wrong-action-token')
      .expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    expect(live.getSetting('months')).toBe('3');

    await request(app)
      .post('/api/backup/automatic')
      .set('Host', '127.0.0.1')
      .set('Authorization', 'Bearer renderer-token')
      .send({ reason: 'update' })
      .expect(403, { errorType: 'DESKTOP_ACTION_REQUIRED' });
    const automaticBackup = await request(app)
      .post('/api/backup/automatic')
      .set('Host', '127.0.0.1')
      .set('Authorization', 'Bearer renderer-token')
      .set('X-Misgeret-Desktop-Action', 'main-only-action-token')
      .send({ reason: 'update' })
      .expect(201);
    expect(automaticBackup.body.file).toMatch(/^auto-update-finance-[\d-]+\.db$/);

    const imported = await authenticatedImport()
      .set('X-Misgeret-Desktop-Action', 'main-only-action-token')
      .expect(200);
    expect(imported.body.ok).toBe(true);
    expect(live.getSetting('months')).toBe('18');
    live.close();
  });

  test('net worth history = daily bank curve + manual-asset timeline', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/assets').send({ name: 'קרן השתלמות', kind: 'asset', amount: 50000, liquid: true }).expect(201);
    await request(app).post('/api/assets').send({ name: 'הלוואה', kind: 'liability', amount: 20000 }).expect(201);

    const res = await request(app).get('/api/networth').expect(200);
    expect(res.body.history.length).toBeGreaterThan(60); // daily, not one dot per sync
    const last = res.body.history.at(-1);
    expect(last.balance).toBeCloseTo(res.body.bankTotal + 30000, 1);
    // liquid flag round-trips
    expect(res.body.assets.find((a: { name: string }) => a.name === 'קרן השתלמות').liquid).toBe(true);
    // and the liquid asset extends the health buffer
    const health = await request(app).get('/api/health').expect(200);
    const buffer = health.body.resilience.find((m: { id: string }) => m.id === 'buffer');
    expect(buffer.detailHe).toContain('נכסים שסומנו נזילים');
  });

  test('unmapped issuer sectors are listed; mapped ones are not', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    db.insertTxns([
      row({ date: '2026-06-05T10:00:00.000Z', amount: -80, description: 'עסק כלשהו', company: 'isracard', connectionId: 2, issuerCategory: 'שירותי דת' }),
      row({ date: '2026-06-06T10:00:00.000Z', amount: -90, description: 'עסק אחר', company: 'isracard', connectionId: 2, issuerCategory: 'שירותי דת' }),
    ]);
    const res = await request(app).get('/api/issuer-sectors').expect(200);
    const sectors = res.body.sectors.map((s: { sector: string }) => s.sector);
    expect(sectors).toContain('שירותי דת');
    expect(sectors).not.toContain('מסעדות'); // mapped → not a worklist item
    expect(res.body.sectors.find((s: { sector: string }) => s.sector === 'שירותי דת').count).toBe(2);
  });

  test('CSV export carries the exclusion flags and the lens month', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/export.csv').expect(200);
    const header = res.text.split('\n')[0];
    expect(header).toContain('flow_month');
    expect(header).toContain('excluded,exclude_reason');
    // the settlement rows are marked — summing the file can no longer double-count
    expect(res.text).toContain('true,settlement');
  });
});

describe('month lens and anchor (end to end)', () => {
  function localMonth(d: Date): string {
    return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
  }

  test('the cross-month purchase counts in the purchase month by default, in the charge month under the charge lens', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const now = new Date();
    const currentMonth = localMonth(now);
    const prevMonth = localMonth(new Date(now.getFullYear(), now.getMonth() - 1, 15));

    // Under the purchase lens, this month's list shows THIS month's purchase
    // (made on the 25th, charged only next month)
    const purchaseTxns = (await request(app).get(`/api/months/${currentMonth}/txns`)).body.txns;
    const purchaseRow = purchaseTxns.find((t: { description: string }) => t.description === 'קניות אונליין');
    expect(purchaseRow.date.slice(0, 7)).toBe(currentMonth);

    // the settlement stays excluded under both lenses — reality does not depend on the view
    const settlement = purchaseTxns.find((t: { description: string }) => t.description.includes('ישראכרט'));
    expect(settlement.excluded).toBe(true);

    // charge lens: the purchase from the 25th of LAST month is charged — and counted — this month
    await request(app).put('/api/settings').send({ monthLens: 'charge' }).expect(200);
    const chargeTxns = (await request(app).get(`/api/months/${currentMonth}/txns`)).body.txns;
    const chargeRow = chargeTxns.find((t: { description: string }) => t.description === 'קניות אונליין');
    expect(chargeRow.date.slice(0, 7)).toBe(prevMonth);
  });

  test('anchor day 15: the current flow month is last month while today is before the 15th (and vice versa)', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).put('/api/settings').send({ monthStartDay: 15 }).expect(200);
    const res = await request(app).get('/api/summary').expect(200);
    const now = new Date();
    const localDay = Number(now.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(8, 10));
    const expected =
      localDay >= 15 ? localMonth(now) : localMonth(new Date(now.getFullYear(), now.getMonth() - 1, 15));
    expect(res.body.summary[0].month).toBe(expected);
  });
});

describe('sync categorization and snapshots', () => {
  test('sync auto-categorizes everything: issuer map, semantic families, income — zero nulls', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const txns = db.getTxnsForMonth(month);
    const salary = txns.find((t) => t.description === 'משכורת')!;
    expect(salary.category).toBe('income');
    const restaurant = txns.find((t) => t.description === 'מסעדות')!;
    expect(restaurant.category).toBe('restaurants');
    expect(restaurant.categorySource).toBe('issuer');
    const grocery = txns.find((t) => t.description === 'סופרמרקט')!;
    expect(grocery.category).toBe('groceries'); // semantic family, no issuer needed
    expect(grocery.categorySource).toBe('auto');
    const installment = txns.find((t) => t.type === 'installments')!;
    expect(installment.category).toBe('shopping'); // 'רהיטי הארץ' → furniture stem
    // THE guarantee: no transaction leaves a sync without a category
    expect(db.getTxnsForMonth(month).every((t) => t.category !== null)).toBe(true);
  });

  test('sync stores one balance snapshot per bank account, none for isracard', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const snaps = db.getLatestSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].balance).toBeGreaterThan(0);
    await request(app).post('/api/sync').expect(200);
    expect(db.getLatestSnapshots()).toHaveLength(1); // latest-per-account, history in table
  });

  test('sync applies existing rules before issuer mapping', async () => {
    const { app, db } = await mockAppWithConnections();
    db.addRule('סופרמרקט', 'groceries');
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const t = db.getTxnsForMonth(month).find((x) => x.description === 'סופרמרקט')!;
    expect(t.category).toBe('groceries');
    expect(t.categorySource).toBe('rule');
  });
});

describe('review and rules API', () => {
  test('GET /api/review lists uncategorized with hints and labels, excluding covered settlements', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/review').expect(200);
    expect(res.body.txns.length).toBeGreaterThan(0);
    const t = res.body.txns[0];
    expect(t).toHaveProperty('key');
    expect(t).toHaveProperty('description');
    expect(t).toHaveProperty('connectionLabel');

    // Leumi reaches back two years, Isracard only one — so the fixture's own history is lopsided,
    // exactly as the real ones are. Both halves of the settlement law are visible here:
    const settlements = (res.body.txns as { description: string; date: string }[])
      .filter((x) => x.description.includes('ישראכרט בעמ'));
    const cardStart = windowStart(syncWindowMonths('isracard')).toISOString();
    // where the card's own rows cover the month, the bank's debit is a second record of one payment
    // and is netted out — not the user's job to categorize
    expect(settlements.every((x) => x.date < cardStart)).toBe(true);
    // beyond the card's reach there is no detail at all, so the debit is the ONLY record of that
    // spending: hiding it there would delete real money from the month
    expect(settlements.length).toBeGreaterThan(0);
  });

  test('PUT category with rule creates rule, applies retroactively, shrinks review', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = await request(app).get('/api/review').expect(200);
    const target = before.body.txns.find((t: { description: string }) => t.description === 'חשבון חשמל');
    await request(app)
      .put(`/api/txns/${target.key}/category`)
      .send({ category: 'bills', rulePattern: 'חשבון חשמל' })
      .expect(200);
    expect(db.getRules().some((r) => r.pattern === 'חשבון חשמל')).toBe(true);
    const after = await request(app).get('/api/review').expect(200);
    expect(after.body.txns.some((t: { description: string }) => t.description === 'חשבון חשמל')).toBe(false);
    const month = new Date().toISOString().slice(0, 7);
    const others = db.getTxnsForMonth(month).filter((t) => t.description === 'חשבון חשמל');
    expect(others.every((t) => t.category === 'bills')).toBe(true);
  });

  test('mapping an unknown issuer sector is elastic: retroactive, persistent, and honored by future syncs', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    // a future card company's sector wording nobody hardcoded
    db.insertTxns([{
      ...row({ date: '2026-06-05T10:00:00.000Z', amount: -120, description: 'עסק חדש', company: 'max' }),
      issuerCategory: 'סקטור עלום לחלוטין', category: 'other', categorySource: 'auto',
    }]);

    const before = await request(app).get('/api/issuer-sectors').expect(200);
    expect(before.body.sectors.some((s: { sector: string }) => s.sector === 'סקטור עלום לחלוטין')).toBe(true);

    await request(app).post('/api/issuer-sectors/map').send({ sector: 'סקטור עלום לחלוטין', category: 'nope' }).expect(400);
    const mapped = await request(app).post('/api/issuer-sectors/map')
      .send({ sector: 'סקטור עלום לחלוטין', category: 'leisure' }).expect(200);
    expect(mapped.body.updated).toBe(1);

    const txn = db.getTxnsForMonth('2026-06').find((t) => t.description === 'עסק חדש')!;
    expect(txn.category).toBe('leisure');
    expect(txn.categorySource).toBe('issuer');

    const after = await request(app).get('/api/issuer-sectors').expect(200);
    expect(after.body.sectors.some((s: { sector: string }) => s.sector === 'סקטור עלום לחלוטין')).toBe(false);
  });

  describe('flow-candidates — teach it once, and the feed retires', () => {
    const RENEWAL = 'חידוש פיקדון פק"מ משנה ומעלה';
    const patternsOf = (body: { candidates: { pattern: string }[] }) => body.candidates.map((c) => c.pattern);

    /** A large bank credit no vocabulary tier understands — and, critically, one a user RULE has
     *  already categorized: the app itself offers that rule from the review queue. */
    async function appWithMystery(categorySource: 'income' | 'rule' = 'income') {
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        {
          ...row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: 'תקבול גדול ומסתורי 4471', company: 'leumi' }),
          category: categorySource === 'rule' ? 'transfers' : 'income',
          categorySource,
        },
      ]);
      return { app, db };
    }

    test('a large bank movement on a weak basis surfaces, with its total and a sample', async () => {
      const { app } = await appWithMystery();
      const res = await request(app).get('/api/flow-candidates').expect(200);
      const hit = res.body.candidates.find((c: { pattern: string }) => c.pattern === 'תקבול גדול ומסתורי');
      expect(hit).toMatchObject({ sampleDescription: 'תקבול גדול ומסתורי 4471', count: 1, total: 20000, weakBasis: true });
    });

    test('A USER RULE MUST NOT HIDE IT — the feed is keyed on money shape, not on a category', async () => {
      // the trap: one rule 'פיקדון → העברות' resolves every row of a renewal to 'rule', and a
      // category-based filter goes blind while the fiction keeps counting
      const { app } = await appWithMystery('rule');
      const res = await request(app).get('/api/flow-candidates').expect(200);
      const hit = res.body.candidates.find((c: { pattern: string }) => c.pattern === 'תקבול גדול ומסתורי');
      expect(hit).toBeDefined();
      expect(hit.weakBasis).toBe(false); // a rule demotes it in the ranking; it cannot erase it
    });

    test('what the vocabulary already understands never asks the user', async () => {
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: RENEWAL, company: 'leumi' }), category: 'income', categorySource: 'income' },
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: -20700, description: RENEWAL, company: 'leumi' }), category: 'other', categorySource: 'auto' },
      ]);
      const res = await request(app).get('/api/flow-candidates').expect(200);
      expect(patternsOf(res.body).some((p) => p.includes('פיקדון'))).toBe(false);
    });

    test('small movements are not the user\'s problem', async () => {
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 4999, description: 'תקבול קטנטן', company: 'leumi' }), category: 'income', categorySource: 'income' },
      ]);
      const res = await request(app).get('/api/flow-candidates').expect(200);
      expect(patternsOf(res.body)).not.toContain('תקבול קטנטן');
    });

    test('A ROUND-TRIP IS RANKED AND LABELLED BY ITS GROSS — its net is ₪0 and says nothing', async () => {
      // both legs of a renewal collapse to ONE pattern (both are principal), so a signed total
      // cancels them: the money the feed exists to surface reported ₪0 and sorted below every
      // salary. The harm is gross — income AND expenses are inflated by 20,000 each.
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: 'גלגול תוכנית 4471', company: 'leumi' }), category: 'income', categorySource: 'income' },
        { ...row({ date: '2026-07-06T11:00:00.000Z', amount: -20000, description: 'גלגול תוכנית 4471', company: 'leumi' }), category: 'other', categorySource: 'auto' },
        { ...row({ date: '2026-07-10T10:00:00.000Z', amount: 12400, description: 'משכורת חברה', company: 'leumi' }), category: 'income', categorySource: 'income' },
      ]);
      const res = await request(app).get('/api/flow-candidates').expect(200);
      const trip = res.body.candidates.find((c: { pattern: string }) => c.pattern === 'גלגול תוכנית');
      expect(trip).toMatchObject({ count: 2, total: 0, inflow: 20000, outflow: -20000 });

      // ₪40,000 of fabricated flow must outrank a ₪12,400 salary inside the weakBasis tier
      const weak = res.body.candidates.filter((c: { weakBasis: boolean }) => c.weakBasis);
      expect(weak[0].pattern).toBe('גלגול תוכנית');
      expect(weak.findIndex((c: { pattern: string }) => c.pattern === 'משכורת חברה')).toBeGreaterThan(0);
    });

    test("THE FATHER'S RENEWAL STILL RETIRES — what the vocabulary understands is not a question", async () => {
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: RENEWAL, company: 'leumi' }), category: 'income', categorySource: 'income' },
        { ...row({ date: '2026-07-06T11:00:00.000Z', amount: -20700, description: RENEWAL, company: 'leumi' }), category: 'other', categorySource: 'auto' },
      ]);
      const res = await request(app).get('/api/flow-candidates').expect(200);
      expect(patternsOf(res.body).some((p) => p.includes('פיקדון'))).toBe(false);
      // it is disclosed as understood, not asked about — one entry, both legs, gross visible
      expect(res.body.savingsExcluded).toHaveLength(1);
      expect(res.body.savingsExcluded[0]).toMatchObject({ count: 2, inflow: 20000, outflow: -20700 });
    });

    test('AN EVERYDAY DEBIT PURCHASE IS NOT A SUSPECTED DOUBLE COUNT', async () => {
      // 'כרטיס דביט' describes every Leumi debit-card purchase — a bare-כרטיס match listed a real
      // user's entire spending under "ייתכן ספירה כפולה", falsely, with no button and no exit.
      const { app, db } = await mockAppWithConnections();
      await request(app).post('/api/sync').expect(200);
      db.insertTxns([
        { ...row({ date: '2026-07-06T10:00:00.000Z', amount: -322, description: 'כרטיס דביט', memo: 'מתאריך 26/05/25 22:52 בכרטיס המסתיים ב-1649 ב-שופרסל', company: 'leumi' }), category: 'groceries', categorySource: 'auto' },
        { ...row({ date: '2026-07-07T10:00:00.000Z', amount: -95, description: 'כרטיס דביט', memo: 'מתאריך 27/05/25 10:00 בכרטיס המסתיים ב-1649 ב-ארומה', company: 'leumi' }), category: 'restaurants', categorySource: 'auto' },
        { ...row({ date: '2026-07-08T10:00:00.000Z', amount: -40, description: 'עמלת דמי כרטיס', company: 'leumi' }), category: 'fees', categorySource: 'auto' },
      ]);
      const res = await request(app).get('/api/flow-candidates').expect(200);
      expect(res.body.settlementSuspects).toEqual([]);

      // the real thing still surfaces: a brand with no company we can name
      db.insertTxns([
        { ...row({ date: '2026-07-09T10:00:00.000Z', amount: -6000, description: 'חיוב לכרטיס ויזה 5020', company: 'leumi' }), category: 'other', categorySource: 'auto' },
      ]);
      const after = await request(app).get('/api/flow-candidates').expect(200);
      expect(after.body.settlementSuspects.map((s: { pattern: string }) => s.pattern)).toEqual(['חיוב לכרטיס ויזה']);
    });

  });

  /** The motivating bug, end to end through the HTTP surface the user actually reads, on the data
   *  he actually has. companies.test.ts proves toMonthlySummary in isolation; this proves the whole
   *  stack agrees — and that the v2→v3 backfill delivers it on rows the OLD engine already stamped.
   *  Without the upgrade path the −105 stays 'אחר' forever and the headline is never delivered. */
  test("THE FATHER'S JULY, over HTTP, on his EXISTING data: +700 income, −105 tax", async () => {
    const RENEWAL = 'חידוש פיקדון פק"מ משנה ומעלה';
    const { app: _boot, db } = makeApp();
    void _boot;
    db.insertTxns([
      { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 20000, description: RENEWAL, company: 'discount' }), category: 'income', categorySource: 'income' as const },
      { ...row({ date: '2026-07-06T10:00:00.000Z', amount: 700, description: 'רווח מפיקדון מתחדש', company: 'discount' }), category: 'income', categorySource: 'income' as const },
      { ...row({ date: '2026-07-06T10:00:00.000Z', amount: -20700, description: RENEWAL, company: 'discount' }), category: 'other', categorySource: 'auto' as const },
      { ...row({ date: '2026-07-06T10:00:00.000Z', amount: -105, description: 'תשלום מס על רווח מפיקדון שחודש', company: 'discount' }), category: 'other', categorySource: 'auto' as const },
    ]);
    // his DB is at v2 with the old engine's stamps; the upgrade is what must re-resolve them
    db.setSetting('autoCategorize', 'v2');
    const app = createApp({ db, scraper: new MockScraper(), dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-father-')) });

    const july = (await request(app).get('/api/summary').expect(200))
      .body.summary.find((m: { month: string }) => m.month === '2026-07');
    expect(july).toMatchObject({ income: 700, expenses: 105, net: 595 });
    // the largest "spending category" of his month was money he never spent
    expect(july.byCategory).toEqual([{ category: 'fees', expenses: 105 }]);

    // The dashboard is intentionally scoped to the current month. Pin the clock so this
    // regression remains about the July data instead of expiring when the calendar advances.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      const dash = (await request(app).get('/api/dashboard').expect(200)).body;
      expect(dash.month.triple).toEqual({ income: 700, expenses: 105, net: 595 });
    } finally {
      vi.useRealTimers();
    }

    // and every row explains itself in the drill-down he can audit
    const txns = (await request(app).get('/api/months/2026-07/txns').expect(200)).body.txns;
    expect(txns.map((t: { amount: number; excluded: boolean; excludeReason: string | null; category: string }) =>
      [t.amount, t.excluded, t.excludeReason, t.category])).toEqual(
      expect.arrayContaining([
        [20000, true, 'savings', 'income'],
        [700, false, null, 'income'],
        [-20700, true, 'savings', 'other'],
        [-105, false, null, 'fees'], // tax, not 'אחר'
      ]),
    );
  });

  test('THE PULSE: a renewing deposit never announces itself as the upcoming card charge', async () => {
    // excluding the principal flips the exact bit the pulse's "nearest card debit" selector read.
    // Keyed on excludedFlow alone, this stream would win Math.min(knownSum, streamSum) and put a
    // phantom ₪20,700 charge on the dashboard's most prominent number — the fiction this engine
    // exists to delete, resurrected one layer up.
    const { app, db } = makeApp();
    await request(app).post('/api/connections').send(LEUMI).expect(201);
    db.insertTxns(
      ['02', '03', '04', '05', '06', '07'].map((m) => ({
        ...row({
          date: `2026-${m}-06T10:00:00.000Z`, amount: -20700,
          description: 'חידוש פיקדון פק"מ משנה ומעלה', company: 'leumi',
        }),
        category: 'other', categorySource: 'auto' as const,
      })),
    );

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      const d = (await request(app).get('/api/dashboard').expect(200)).body;
      expect(d.pulse.upcomingCharge).toBeNull();

      // the ₪20,700 counts as spending in no month at all
      const summary = (await request(app).get('/api/summary').expect(200)).body.summary;
      expect(summary.every((m: { expenses: number }) => m.expenses === 0)).toBe(true);

      // excluded from spending, NOT deleted from reality — the row survives, tagged, in the one
      // drill-down the user can audit. The cash really did leave the account.
      const txns = (await request(app).get('/api/months/2026-07/txns').expect(200)).body.txns;
      expect(txns).toHaveLength(1);
      expect(txns[0]).toMatchObject({ amount: -20700, excluded: true, excludeReason: 'savings' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('PUT category validates category id and txn existence', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).put('/api/txns/abc/category').send({ category: 'not-real' }).expect(400);
    await request(app).put('/api/txns/no-such-key/category').send({ category: 'other' }).expect(404);
  });

  test('duplicate rule pattern → 409; delete works', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const review = await request(app).get('/api/review').expect(200);
    const [t1, t2] = review.body.txns;
    await request(app).put(`/api/txns/${t1.key}/category`).send({ category: 'other', rulePattern: 'תבנית' }).expect(200);
    await request(app).put(`/api/txns/${t2.key}/category`).send({ category: 'other', rulePattern: 'תבנית' }).expect(409);
    const id = db.getRules().find((r) => r.pattern === 'תבנית')!.id;
    await request(app).delete(`/api/rules/${id}`).expect(204);
    await request(app).delete(`/api/rules/${id}`).expect(404);
    expect(db.getRules().some((r) => r.pattern === 'תבנית')).toBe(false);
  });
});

describe('extended reads', () => {
  test('summary carries byCategory and reviewCount', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/summary').expect(200);
    expect(res.body.reviewCount).toBeGreaterThan(0);
    const current = res.body.summary[0];
    expect(Array.isArray(current.byCategory)).toBe(true);
    expect(current.byCategory.length).toBeGreaterThan(0);
    expect(current.byCategory[0]).toHaveProperty('category');
    expect(current.byCategory[0]).toHaveProperty('expenses');
  });

  test('GET /api/balances returns latest bank snapshots with labels', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/balances').expect(200);
    expect(res.body.balances).toHaveLength(1);
    expect(res.body.balances[0]).toMatchObject({ kind: 'bank' });
    expect(res.body.balances[0].balance).toBeGreaterThan(0);
    expect(typeof res.body.balances[0].label).toBe('string');
  });

  test('month txns carry category, installments string and excludeReason', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app).get(`/api/months/${month}/txns`).expect(200);
    const inst = res.body.txns.find((t: { installments?: string }) => t.installments === '2/6');
    expect(inst).toBeTruthy();
    const settlement = res.body.txns.find((t: { excludeReason?: string }) => t.excludeReason === 'settlement');
    expect(settlement).toBeTruthy();
    const categorized = res.body.txns.find((t: { category?: string }) => t.category === 'restaurants');
    expect(categorized).toBeTruthy();
  });
});

describe('cashflow, health, net worth, month review', () => {
  test('GET /api/cashflow detects salary and rent and forecasts a 60-day path', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow').expect(200);
    const merchants = res.body.recurring.map((r: { merchant: string }) => r.merchant);
    expect(merchants).toContain('משכורת');
    expect(merchants).toContain('שכר דירה');
    expect(res.body.forecast).not.toBeNull();
    expect(res.body.forecast.path.length).toBe(61);
    expect(res.body.forecast.path[0].balance).toBe(res.body.latestBankBalance);
    const salaryEvent = res.body.forecast.events.find((e: { merchant: string }) => e.merchant === 'משכורת');
    expect(salaryEvent).toBeTruthy();
    expect(res.body.overdraftLimit).toBe(0);
    expect(res.body.days).toBe(60);
    expect(Array.isArray(res.body.muted)).toBe(true);
  });

  test('the horizon is selectable (30/60/90) and salary projects on its day-of-month', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow?days=90').expect(200);
    expect(res.body.days).toBe(90);
    expect(res.body.forecast.path.length).toBe(91);
    // every projected salary lands on the 1st — day-of-month stepping, not +30-day drift
    const salaries = res.body.forecast.events.filter((e: { merchant: string }) => e.merchant === 'משכורת');
    expect(salaries.length).toBeGreaterThanOrEqual(2);
    for (const s of salaries) expect(s.date.slice(8)).toBe('01');
  });

  test('muting a recurring item removes it from the engines and unmuting restores it', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/recurring/mute').send({ merchant: 'שכר דירה', kind: 'expense' }).expect(200);
    const muted = await request(app).get('/api/cashflow').expect(200);
    expect(muted.body.recurring.some((r: { merchant: string }) => r.merchant === 'שכר דירה')).toBe(false);
    expect(muted.body.muted.some((r: { merchant: string }) => r.merchant === 'שכר דירה')).toBe(true);
    expect(muted.body.forecast.events.some((e: { merchant: string }) => e.merchant === 'שכר דירה')).toBe(false);

    await request(app).post('/api/recurring/unmute').send({ merchant: 'שכר דירה', kind: 'expense' }).expect(200);
    const restored = await request(app).get('/api/cashflow').expect(200);
    expect(restored.body.recurring.some((r: { merchant: string }) => r.merchant === 'שכר דירה')).toBe(true);
    expect(restored.body.muted).toHaveLength(0);
  });

  test('the forecast uses the REAL next-cycle card debit, not the historical median', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow').expect(200);
    const now = new Date();
    const nextIndex = now.getFullYear() * 12 + now.getMonth() + 1;
    const known = res.body.forecast.known;
    expect(known).toHaveLength(1);
    expect(known[0].company).toBe('isracard');
    expect(known[0].amount).toBeCloseTo(-mockSettlementAmount(nextIndex), 2);
    // and the projected settlement event carries the exact amount
    const event = res.body.forecast.events.find((e: { merchant: string }) => e.merchant === 'ישראכרט');
    expect(event.amount).toBeCloseTo(-mockSettlementAmount(nextIndex), 2);
  });

  test('the forecast ships its own explanation: start, variable blocks, config, band', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow').expect(200);
    // config rides along so the screen can render its controls without a second call
    expect(res.body.config).toMatchObject({ lookbackBlocks: 6, variableModel: 'median', showBand: true });
    const explain = res.body.forecast.explain;
    expect(explain.start.balance).toBe(res.body.latestBankBalance);
    expect(typeof explain.start.snapshotDate).toBe('string');
    expect(Array.isArray(explain.variable.blocks)).toBe(true);
    expect(explain.variable.daily).toBe(res.body.forecast.variableDaily);
    // the default config computes the envelope
    expect(res.body.forecast.bands).not.toBeNull();
    expect(res.body.forecast.bands.low.length).toBe(res.body.forecast.path.length);
    // every projected event names its source
    for (const e of res.body.forecast.events) expect(['recurring', 'known', 'pending']).toContain(e.source);
  });

  test('the forecast is calibrated to observed monthly nets — money the calendar cannot itemize still moves the path', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow').expect(200);
    const cal = res.body.forecast.explain.calibration;
    expect(cal).not.toBeNull();
    // only COMPLETE flow months vote — the current month never enters an average
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect(cal.months.length).toBeGreaterThanOrEqual(2);
    for (const m of cal.months) expect(m.month < thisMonth).toBe(true);
    // the drift is exactly the gap between a typical observed month and the calendar
    const nets = cal.months.map((m: { net: number }) => m.net).sort((a: number, b: number) => a - b);
    const mid = Math.floor(nets.length / 2);
    const median = nets.length % 2 ? nets[mid] : (nets[mid - 1] + nets[mid]) / 2;
    expect(cal.medianNet).toBeCloseTo(median, 2);
    expect(cal.driftDaily).toBeCloseTo((cal.medianNet - cal.impliedMonthly) / 30.44, 2);
    expect(res.body.forecast.driftDaily).toBe(cal.driftDaily);
    // the envelope comes from the observed frugal/spendy months
    expect(cal.p25Net).not.toBeNull();
    expect(cal.p75Net).toBeGreaterThanOrEqual(cal.p25Net);

    // the history basis drives the WHOLE forecast: a different window recalibrates the level
    await request(app).put('/api/cashflow/config').send({ lookbackBlocks: 3 }).expect(200);
    const narrow = await request(app).get('/api/cashflow').expect(200);
    expect(narrow.body.forecast.explain.calibration.windowMonths).toBe(3);
    expect(narrow.body.forecast.explain.calibration.months.length).toBeLessThanOrEqual(3);
  });

  test('PUT /api/cashflow/config: persists, reshapes the forecast, rejects junk', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    const updated = await request(app).put('/api/cashflow/config')
      .send({ variableModel: 'manual', manualDaily: 77, showBand: false, horizonDays: 45 }).expect(200);
    expect(updated.body).toMatchObject({ variableModel: 'manual', manualDaily: 77, showBand: false, horizonDays: 45 });

    const res = await request(app).get('/api/cashflow').expect(200);
    expect(res.body.days).toBe(45); // no ?days → the configured default horizon
    expect(res.body.forecast.path.length).toBe(46);
    expect(res.body.forecast.variableDaily).toBe(77); // the manual rate drives the path
    expect(res.body.forecast.explain.variable.basis).toBe('manual');
    expect(res.body.forecast.bands).toBeNull(); // band switched off

    // a custom horizon is honored beyond the classic pills
    const custom = await request(app).get('/api/cashflow?days=14').expect(200);
    expect(custom.body.days).toBe(14);

    await request(app).put('/api/cashflow/config').send({ lookbackBlocks: 61 }).expect(400); // above the 60-block cap
    await request(app).put('/api/cashflow/config').send({ variableModel: 'ai-magic' }).expect(400);
    // rejected patches change nothing
    const after = await request(app).get('/api/cashflow').expect(200);
    expect(after.body.config.lookbackBlocks).toBe(6);
  });

  test('GET /api/dashboard: pulse, day-adjusted month strip, ranked actions, trend, composition', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/dashboard').expect(200);
    const d = res.body;

    // pulse: liquid position + the truth AFTER the committed upcoming debit
    expect(typeof d.pulse.bankBalance).toBe('number');
    expect(typeof d.pulse.lastSyncAt).toBe('string');
    expect(d.pulse.syncAgeHours).toBeLessThan(24);
    if (d.pulse.upcomingCharge) {
      expect(d.pulse.upcomingCharge.amount).toBeLessThan(0);
      expect(d.pulse.afterCharge).toBeCloseTo(d.pulse.bankBalance + d.pulse.upcomingCharge.amount, 1);
    }

    // month strip: the plan hero + a triple whose baseline is the SAME day count last month
    expect(d.month.leftToSpend).toBeCloseTo(d.month.income.expectedTotal - d.month.expectation.total, 1);
    expect(d.month.triple.net).toBeCloseTo(d.month.triple.income - d.month.triple.expenses, 1);
    expect(d.month.prevTriple.net).toBeCloseTo(d.month.prevTriple.income - d.month.prevTriple.expenses, 1);
    // day-adjusted: the partial-prev-month baseline can never exceed the full prev month
    const prevFull = d.trend.monthsNet.find((m: { month: string }) => m.month !== d.month.month);
    if (prevFull) expect(d.month.prevTriple.income).toBeLessThanOrEqual(prevFull.income + 0.01);

    // actions: ranked red → yellow → info, capped at 5
    expect(Array.isArray(d.actions)).toBe(true);
    expect(d.actions.length).toBeLessThanOrEqual(5);
    const ranks = d.actions.map((a: { severity: string }) => ({ red: 0, yellow: 1, info: 2 }[a.severity]));
    expect([...ranks].sort((a: number, b: number) => a - b)).toEqual(ranks);

    // trend + composition
    expect(d.trend.greenStreak).toBeGreaterThanOrEqual(0);
    expect(d.trend.monthsNet.length).toBeGreaterThan(0);
    // the health verdict lives in ONE place — /api/health. The dashboard used to carry a second,
    // computed on a different window and rendered by nothing.
    expect(d.trend).not.toHaveProperty('health');
    expect(d.composition.categories.length).toBeGreaterThan(0);
    for (const c of d.composition.categories) {
      expect(typeof c.spent).toBe('number');
      expect(typeof c.median3m).toBe('number');
    }
  });

  test('GET /api/cashflow/plan: expected income − what the month is expected to cost = left to spend', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/cashflow/plan').expect(200);
    const p = res.body;

    const currentMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }).slice(0, 7);
    expect(p.month).toBe(currentMonth);
    expect(p.daysLeft).toBeGreaterThanOrEqual(1);
    expect(p.daysElapsed).toBeGreaterThanOrEqual(1);

    // the mock salary (12,400 on the 1st) is counted exactly once — received, never also "expected"
    expect(p.income.expectedTotal).toBeGreaterThanOrEqual(12400);
    expect(p.income.expectedRemaining.every((e: { merchant: string }) => e.merchant !== 'משכורת')).toBe(true);

    // rent is a fixed commitment (already down or still expected — but in the total either way)
    expect(p.fixed.total).toBeGreaterThanOrEqual(4300);
    // settlement streams are the CASH view of card spending — they must never enter the plan
    const planMerchants = [
      ...p.fixed.expectedRemaining.map((e: { merchant: string }) => e.merchant),
    ];
    expect(planMerchants.every((m: string) => !m.includes('ישראכרט'))).toBe(true);

    // the transparent equation holds to the agora — and it stands on the month's EXPECTED
    // cost, not on month-to-date: a household is not free to spend the rent because the rent
    // has not gone out yet.
    expect(p.leftToSpend).toBeCloseTo(p.income.expectedTotal - p.expectation.total, 1);
    expect(p.leftPerDay).toBeCloseTo(p.leftToSpend / p.daysLeft, 1);
    // the expectation is never smaller than what already happened, and its parts reconcile
    expect(p.expectation.total).toBeGreaterThanOrEqual(p.fixed.soFar + p.variable.soFar - 0.01);
    expect(p.expectation.spent).toBeCloseTo(p.fixed.soFar + p.variable.soFar, 1);
    expect(p.expectation.ahead).toBeCloseTo(p.expectation.total - p.expectation.spent, 1);
    for (const r of p.expectation.rows) {
      expect(r.expected).toBeCloseTo(Math.max(r.spent, r.typical), 1);
      expect(r.ahead).toBeCloseTo(r.expected - r.spent, 1);
    }
    // the close is the same statement without the target — never a second, competing forecast
    expect(p.paceEndOfMonth).toBeCloseTo(p.income.expectedTotal - p.expectation.total, 1);

    // history: newest-first flow months, current month included
    expect(Array.isArray(p.history)).toBe(true);
    expect(p.history[0].month).toBe(currentMonth);
    expect(p.history[0]).toHaveProperty('income');
    expect(p.history[0]).toHaveProperty('expenses');
    expect(p.history[0]).toHaveProperty('net');

    // the ledger's arithmetic bridge: "יצא עד כה" = card purchases + everything else, to the
    // agora, always — this is what lets the ledger point at the chart's own figure instead of
    // merely near-matching it.
    expect(p.spendSplit.card + p.spendSplit.other).toBeCloseTo(p.fixed.soFar + p.variable.soFar, 1);
    expect(p.spendSplit.card).toBeGreaterThanOrEqual(0);
    expect(p.spendSplit.other).toBeGreaterThanOrEqual(0);
    // and the ledger itself is present, with its two facts distinct
    expect(p.cardOutlook).toHaveProperty('settled');
    expect(p.cardOutlook).toHaveProperty('upcoming');
    expect(p.cardOutlook.settled.amount).toBe(p.cardSettlements.amount);
  });

  test('המסגרת: declare → plan and review measure against it; earlier months are not re-judged', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    // before any declaration — no frame anywhere
    const before = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(before.frame).toBeNull();

    // invalid declarations bounce
    await request(app).put('/api/frame').send({ amount: 0 }).expect(400);
    await request(app).put('/api/frame').send({ amount: -50 }).expect(400);
    await request(app).put('/api/frame').send({ amount: 'הרבה' }).expect(400);
    await request(app).put('/api/frame').send({}).expect(400);

    // declare — fractions round to whole shekels (a frame is a round intention)
    const put = await request(app).put('/api/frame').send({ amount: 6000.4 }).expect(200);
    expect(put.body.amount).toBe(6000);

    const p = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(p.frame.amount).toBe(6000);
    // the frame measures variable spend with the plan's own split — the two cards can never disagree
    expect(p.frame.spent).toBeCloseTo(p.variable.soFar, 2);
    expect(p.frame.left).toBeCloseTo(6000 - p.variable.soFar, 1);
    expect(p.frame.projectedSpend).toBeCloseTo(p.variable.perDayPace * p.daysInMonth, 1);

    // the current month's review agrees with the plan to the agora
    const review = (await request(app).get(`/api/months/${p.month}/review`).expect(200)).body;
    expect(review.frame.amount).toBe(6000);
    expect(review.frame.spent).toBeCloseTo(p.frame.spent, 2);
    expect(review.frame.left).toBeCloseTo(p.frame.left, 1);

    // a month BEFORE the declaration keeps its truth: no frame governed it, none is invented
    if (review.previous) {
      const prev = (await request(app).get(`/api/months/${review.previous.month}/review`).expect(200)).body;
      expect(prev.frame).toBeNull();
    }

    // switching off is a declaration too
    await request(app).put('/api/frame').send({ amount: null }).expect(200);
    const off = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(off.frame).toBeNull();
  });

  test('המסגרת מציעה את עצמה: the plan carries a derived proposal, never an empty box', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    const p = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(p).toHaveProperty('proposal');
    const prop = p.proposal;
    expect(typeof prop.available).toBe('boolean');
    if (!prop.available) {
      // thin data must SAY so rather than invent a ceiling
      expect(prop.reasonHe.length).toBeGreaterThan(0);
      expect(prop.recommended).toBe(0);
      return;
    }
    // three stances, ordered, each with a meaning
    expect(prop.stances.map((s: { id: string }) => s.id)).toEqual(['tight', 'recommended', 'comfortable']);
    for (const s of prop.stances) expect(s.meaningHe.length).toBeGreaterThan(0);
    expect(prop.stances[0].amount).toBeLessThanOrEqual(prop.stances[1].amount);
    expect(prop.stances[1].amount).toBeLessThanOrEqual(prop.stances[2].amount);
    expect(prop.recommended).toBe(prop.stances[1].amount);
    expect(prop.rationaleHe.length).toBeGreaterThan(0);

    // the derivation reconciles: what comes in, minus what is already spoken for
    const plus = prop.derivation.filter((d: { sign: string }) => d.sign === 'plus')
      .reduce((s: number, d: { amount: number }) => s + d.amount, 0);
    const minus = prop.derivation.filter((d: { sign: string }) => d.sign === 'minus')
      .reduce((s: number, d: { amount: number }) => s + d.amount, 0);
    const total = prop.derivation.find((d: { sign: string }) => d.sign === 'total');
    expect(total.amount).toBe(plus - minus);
    expect(total.amount).toBe(Math.round(prop.observed.freeSpace));

    // the split always sums to the number it splits
    if (prop.split.length > 0) {
      const sum = prop.split.reduce((s: number, r: { amount: number }) => s + r.amount, 0);
      expect(sum).toBe(prop.recommended);
    }
  });

  test('המסגרת: the declared frame splits into categories, and each is paced on its own', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).put('/api/frame').send({ amount: 6000 }).expect(200);

    const p = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(Array.isArray(p.frame.split)).toBe(true);
    if (p.frame.split.length > 0) {
      // the split follows the DECLARED number, not the recommendation
      expect(p.frame.split.reduce((s: number, r: { amount: number }) => s + r.amount, 0)).toBe(6000);
      for (const r of p.frame.split) {
        expect(r.projected).toBe(Math.round(r.spent * (p.daysInMonth / p.daysElapsed)));
        expect(r.over).toBe(r.projected > r.amount);
      }
      // every shekel of variable spend lands in exactly one row — nothing quietly vanishes
      const counted = p.frame.split.reduce((s: number, r: { spent: number }) => s + r.spent, 0);
      expect(counted).toBeCloseTo(p.variable.soFar, 1);
    }
  });

  test('המסגרת מול המציאות: a month that earned less than usual overrules the standing frame', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    // a frame far above what this month can carry — the ceiling and the cash must not disagree
    // silently, because the household reads them one under the other
    const before = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    const generous = Math.round(before.variable.soFar + Math.max(5000, before.leftToSpend + 5000));
    await request(app).put('/api/frame').send({ amount: generous }).expect(200);

    const p = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(p.frame.reality).not.toBeNull();
    // the reality figure IS the plan's own honest number — one truth, quoted once
    expect(p.frame.reality.safeLeft).toBeCloseTo(p.leftToSpend, 2);
    expect(p.frame.reality.monthIncome).toBeCloseTo(p.income.expectedTotal, 2);
    // the cause is checked, never assumed: "this month came in low" and "the frame is too big"
    // are different problems, and only one of them is true at a time
    expect(['thin-month', 'over-declared']).toContain(p.frame.reality.cause);
    const thin = p.frame.reality.typicalIncome > 0
      && p.frame.reality.monthIncome < p.frame.reality.typicalIncome * 0.9;
    expect(p.frame.reality.cause).toBe(thin ? 'thin-month' : 'over-declared');
    // and the daily pace follows the SMALLER constraint: a pace drawn from an unaffordable
    // ceiling is an instruction to overdraw
    expect(p.frame.perDayAllowed).toBeCloseTo(Math.max(0, Math.min(p.frame.left, p.leftToSpend)) / p.daysLeft, 1);
    expect(p.frame.perDayAllowed).toBeLessThan(p.frame.left / p.daysLeft);

    // a frame the month CAN carry raises no objection — silence is still a feature
    const tight = Math.round(before.variable.soFar + Math.max(1, before.leftToSpend / 2));
    await request(app).put('/api/frame').send({ amount: tight }).expect(200);
    const tightPlan = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(tightPlan.frame.reality).toBeNull();
    expect(tightPlan.frame.perDayAllowed).toBeCloseTo(Math.max(0, tightPlan.frame.left) / tightPlan.daysLeft, 1);
  });

  test('היעד שלי: one declared share, held back before anything else is called spendable', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    const before = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(before.keep.rate).toBeNull();
    expect(before.keep.target).toBe(0);
    expect(before.target).toHaveProperty('suggestedRate');

    // a SHARE, never a percent number — a unit that changes between the wire and the
    // arithmetic is how a figure ends up a hundred times too large
    await request(app).put('/api/target').send({ rate: 15 }).expect(400);
    await request(app).put('/api/target').send({ rate: 0 }).expect(400);
    await request(app).put('/api/target').send({ rate: 'שליש' }).expect(400);

    await request(app).put('/api/target').send({ rate: 0.15 }).expect(200);
    const after = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(after.keep.rate).toBe(0.15);
    expect(after.keep.target).toBeCloseTo(after.income.expectedTotal * 0.15, 1);

    // ── the elastic law: the plan tab's shekels are THIS month's, identical to the month tab ──
    // The two screens quote the same actual-income base and bottom line — no typical-month money.
    const planTab = (await request(app).get('/api/plan').expect(200)).body;
    expect(planTab.thisMonth.income).toBeCloseTo(after.income.expectedTotal, 1);
    // Aligned on certainties: the plan
    // tab's fixed is the vouched expectation — the exact base of "צפוי לצאת" — never the
    // detector's calendar, so the two tabs cannot disagree on free money.
    expect(planTab.thisMonth.fixed).toBeCloseTo(after.expectation.fixed.expected, 1);
    expect(planTab.thisMonth.variableSoFar).toBeCloseTo(after.expectation.variable.spent, 1);
    expect(planTab.thisMonth.keep.applied).toBeCloseTo(after.keep.applied, 1);
    expect(planTab.thisMonth.leftToSpend).toBeCloseTo(after.leftToSpend, 1);
    // declared savings plans are a FLOOR under the target, never a second subtraction
    expect(after.keep.applied).toBeCloseTo(after.keep.target, 1);
    expect(after.leftToSpend).toBeCloseTo(before.leftToSpend - (after.keep.applied - before.keep.applied), 1);
    expect(after.target.rate).toBe(0.15);

    // ── the projection is CASH and must not move when a target is declared ────────────────
    // A target is an intention, not a bill. Computing the close off the target-net figure
    // made the app announce a deficit to a household heading for money in the bank.
    expect(after.paceEndOfMonth).toBeCloseTo(before.paceEndOfMonth, 1);
    expect(after.leftBeforeTarget).toBeCloseTo(before.leftToSpend, 1);
    expect(after.paceEndOfMonth).toBeCloseTo(
      after.leftBeforeTarget - after.variable.perDayPace * after.daysLeft, 1,
    );
    // the target gets its own figure, and it is a DIFFERENT one
    expect(after.paceVsTarget).toBeCloseTo(
      after.leftToSpend - after.variable.perDayPace * after.daysLeft, 1,
    );
    expect(after.paceVsTarget).toBeLessThan(after.paceEndOfMonth);
    expect(before.paceVsTarget).toBeNull();

    // clearing is a legitimate answer, not a failure state: nothing is held back
    await request(app).put('/api/target').send({ rate: null }).expect(200);
    const cleared = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(cleared.keep.rate).toBeNull();
    expect(cleared.leftToSpend).toBeCloseTo(before.leftToSpend, 1);
    expect(cleared.paceVsTarget).toBeNull();
  });

  test('"צפוי לצאת" holds certainties only: a habit reserves nothing, a vouched-for charge does', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const month = (n: number) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() - n);
      return d.toISOString().slice(0, 7);
    };
    // a rock-solid monthly habit — supermarket, every month, same size — and a monthly gym
    // charge with the exact same rhythm. Only one of them will ever be vouched for.
    const rows = [1, 2, 3].flatMap((n) => [
      row({ date: `${month(n)}-05T10:00:00.000Z`, amount: -900, description: 'סופר יום יום', company: 'leumi', category: 'groceries' }),
      row({ date: `${month(n)}-06T10:00:00.000Z`, amount: -220, description: 'חדר כושר אואזיס', company: 'leumi' }),
    ]);
    db.insertTxns(rows);

    const before = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    const aheadFor = (p: { expectation: { rows: Array<{ labelHe: string; ahead: number }> } }, needle: string) =>
      p.expectation.rows.filter((r) => r.labelHe.includes(needle)).reduce((s, r) => s + r.ahead, 0);
    // nothing is vouched for yet → neither reserves a shekel, however regular it looks
    expect(aheadFor(before, 'סופר')).toBe(0);
    expect(aheadFor(before, 'כושר')).toBe(0);
    // ...but the habit is still MEASURED, and offered as an estimate that stays outside every total
    expect(before.expectation.habitEstimate).toBeGreaterThan(0);
    expect(before.expectation.total).toBeCloseTo(before.expectation.spent + before.expectation.ahead, 1);
    expect(before.leftToSpend).toBeCloseTo(
      before.income.expectedTotal - before.expectation.total, 1);

    // the household vouches for the gym — and ONLY then does it hold money back
    await request(app).post('/api/setup/txn-mark/apply-merchant')
      .send({ merchant: 'חדר כושר אואזיס', mark: 'fixed' }).expect(200);

    const after = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    expect(aheadFor(after, 'כושר')).toBeGreaterThan(0);
    expect(aheadFor(after, 'סופר')).toBe(0); // the habit is STILL only an estimate
    expect(after.leftToSpend).toBeLessThan(before.leftToSpend);
  });

  test('anchor 10, RiseUp-exact: the early salary waits for its month; the rent of the 9th closes the old one', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).put('/api/settings').send({ monthStartDay: 10 }).expect(200);

    // the real-world shape: "my month starts on the 10th", the employer pays on the 8th every
    // month, and rent goes out on the 9th — RiseUp's own worked example, on our engine
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const M = flowMonthOf(today, 10);
    const salaryAt = (m: string) => `${m}-08T10:00:00.000Z`;
    db.insertTxns([
      ...[0, 1, 2, 3].map((n) =>
        row({ date: salaryAt(monthsBack(M, n)), amount: 12_000, description: 'משכורת חודש', company: 'leumi' })),
      row({ date: `${M}-09T10:00:00.000Z`, amount: -3_500, description: 'העברה שכר דירה', company: 'leumi' }),
      // a small one-off near the anchor must obey the hard window
      row({ date: `${M}-07T10:00:00.000Z`, amount: 250, description: 'החזר', company: 'leumi' }),
    ]);

    const plan = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    // the window is nominal — but the salary of the 8th funds it
    expect(plan.month).toBe(M);
    expect(plan.monthStart).toBe(`${M}-10`);
    expect(plan.income.soFar).toBeCloseTo(12_000, 1);
    const summary = (await request(app).get('/api/summary').expect(200)).body;
    const cur = summary.summary.find((s: { month: string }) => s.month === M)!;
    expect(cur.income).toBeCloseTo(12_000, 1);
    // the rent of the 9th belongs to the month that ENDED on the 9th — exactly like RiseUp
    expect(cur.expenses).toBeCloseTo(0, 1);
    const prev = summary.summary.find((s: { month: string }) => s.month === monthsBack(M, 1))!;
    expect(prev.income).toBeCloseTo(12_250, 1); // its own waiting salary + the one-off refund
    expect(prev.expenses).toBeCloseTo(3_500, 1);
    // the NEXT salary funds the NEXT month — never projected into this one's expected income
    // (the double-count read "expectedTotal 27,168" on a 13k-income month before the fix)
    expect(plan.income.expectedTotal).toBeCloseTo(plan.income.soFar, 1);
  });

  test('התוכנית שלי: the queue is data-derived, the verdict is stored, and the ledger only counts certain savings', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    // the tab's own route holds ONE decision and nothing else — the queue is dormant, and the
    // screen a user actually opens never pays for assembling it
    const lean = (await request(app).get('/api/plan').expect(200)).body;
    expect(Object.keys(lean).sort()).toEqual(['daysLeft', 'month', 'target', 'thisMonth']);

    const first = (await request(app).get('/api/plan/advice').expect(200)).body;
    expect(first).toHaveProperty('target');
    expect(Array.isArray(first.advice.items)).toBe(true);
    expect(Array.isArray(first.goals)).toBe(true);
    expect(first.ledger.monthlySaved).toBe(0);

    for (const a of first.advice.items) {
      expect(typeof a.key).toBe('string');
      expect(['saving', 'resilience', 'accuracy']).toContain(a.valueKind);
      expect(['easy', 'medium', 'hard']).toContain(a.effort);
      expect(a.observationHe.length).toBeGreaterThan(0);
      expect(a.actionHe.length).toBeGreaterThan(0);
      expect(a.detailHe.length).toBeGreaterThan(0);
      expect(a.state).toBeNull();
      // every labelled figure carries its own subject — two entities never share a sentence
      for (const line of a.lines) expect(line.labelHe.length).toBeGreaterThan(0);
    }

    // acting needs a real item
    await request(app).post('/api/advice/act').send({ key: 'nope', action: 'done' }).expect(404);
    await request(app).post('/api/advice/act').send({ key: 'x', action: 'sing' }).expect(400);
    await request(app).post('/api/advice/act').send({ action: 'done' }).expect(400);

    if (first.advice.items.length === 0) return;

    // dismissing removes it from the queue for good
    const dismissed = first.advice.items[0];
    await request(app).post('/api/advice/act').send({ key: dismissed.key, action: 'dismiss' }).expect(200);
    const afterDismiss = (await request(app).get('/api/plan/advice').expect(200)).body;
    expect(afterDismiss.advice.items.find((a: { key: string }) => a.key === dismissed.key)).toBeUndefined();
    expect(afterDismiss.ledger.dismissedCount).toBe(1);

    // ...and can be put back: changing your mind is a decision too
    await request(app).post('/api/advice/act').send({ key: dismissed.key, action: 'reset' }).expect(200);
    const afterReset = (await request(app).get('/api/plan/advice').expect(200)).body;
    expect(afterReset.advice.items.find((a: { key: string }) => a.key === dismissed.key)).toBeDefined();

    // accepting KEEPS it in the queue, carrying its state
    await request(app).post('/api/advice/act').send({ key: dismissed.key, action: 'accept' }).expect(200);
    const accepted = (await request(app).get('/api/plan/advice').expect(200)).body
      .advice.items.find((a: { key: string }) => a.key === dismissed.key);
    expect(accepted.state).toBe('accepted');

    // marking done pays into the ledger — but only certain SAVINGS ever count
    await request(app).post('/api/advice/act').send({ key: dismissed.key, action: 'done' }).expect(200);
    const afterDone = (await request(app).get('/api/plan/advice').expect(200)).body;
    const shouldCount = dismissed.valueKind === 'saving' && dismissed.valueCertain;
    expect(afterDone.ledger.monthlySaved).toBeCloseTo(shouldCount ? dismissed.monthlyValue : 0, 2);
    expect(afterDone.ledger.annualSaved).toBeCloseTo(afterDone.ledger.monthlySaved * 12, 2);
    expect(afterDone.ledger.doneCount).toBe(1);
  }, 15_000);

  test('המטרות: three shapes, each measured by what tells the truth about it', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    // validation
    await request(app).post('/api/goals').send({ type: 'nonsense', name: 'משהו' }).expect(400);
    await request(app).post('/api/goals').send({ type: 'buffer', name: 'א' }).expect(400);
    await request(app).post('/api/goals').send({ type: 'reduction', name: 'פחות מסעדות' }).expect(400);

    // a buffer goal measures REAL liquid money — it never starts a ring at zero
    const buffer = await request(app).post('/api/goals')
      .send({ type: 'buffer', name: 'כרית חירום', targetAmount: 18000, monthlyAmount: 1000 }).expect(201);
    expect(buffer.body.savingsGoalId).toBeNull();

    // a set-aside goal opens the envelope that funds it
    const setAside = await request(app).post('/api/goals')
      .send({ type: 'set-aside', name: 'ביטוח רכב', targetAmount: 3600, monthlyAmount: 300 }).expect(201);
    expect(setAside.body.savingsGoalId).toBeNull();

    // a reduction goal has no envelope at all — there is nothing to deposit
    const reduction = await request(app).post('/api/goals')
      .send({ type: 'reduction', name: 'להוריד מסעדות', category: 'restaurants', categoryCeiling: 600 }).expect(201);
    expect(reduction.body.savingsGoalId).toBeNull();

    const goals = (await request(app).get('/api/plan/advice').expect(200)).body.goals;
    expect(goals).toHaveLength(3);
    const bufferGoal = goals.find((g: { type: string }) => g.type === 'buffer');
    expect(bufferGoal.target).toBe(18000);
    expect(bufferGoal.standingHe.length).toBeGreaterThan(0);
    const reductionGoal = goals.find((g: { type: string }) => g.type === 'reduction');
    expect(reductionGoal.categoryNameHe).toBe('מסעדות');
    // a goal created today has judged nothing yet — it never claims credit for the past
    expect(reductionGoal.monthsJudged).toBe(0);

    // update + close
    await request(app).put(`/api/goals/${reduction.body.id}`).send({ categoryCeiling: 500 }).expect(200);
    await request(app).put('/api/goals/9999').send({ name: 'רפאים' }).expect(404);
    const updated = (await request(app).get('/api/plan/advice').expect(200)).body.goals
      .find((g: { id: number }) => g.id === reduction.body.id);
    expect(updated.target).toBe(500);

    // deleting an intention must never delete shekels
    await request(app).delete(`/api/goals/${setAside.body.id}`).expect(204);
    await request(app).delete(`/api/goals/${setAside.body.id}`).expect(404);
  });

  test('הריטואל החודשי: the review carries the drift verdict and judges the month by its own frame', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).put('/api/frame').send({ amount: 6000 }).expect(200);

    const p = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    const review = (await request(app).get(`/api/months/${p.month}/review`).expect(200)).body;
    expect(review).toHaveProperty('drift');
    // fewer than three judged months can never produce a verdict
    expect(review.drift).toBeNull();
    expect(review.frame.amount).toBe(6000);
    expect(review.frame.spent).toBeCloseTo(p.frame.spent, 2);
    expect(Array.isArray(review.frame.split)).toBe(true);
    if (review.frame.split.length > 0) {
      // a finished month is fully elapsed: the projection IS the outcome
      for (const r of review.frame.split) expect(r.projected).toBe(Math.round(r.spent));
    }
  });

  test('נוכחות שקטה: pending alerts are well-formed, and an acked key never fires again', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const first = (await request(app).get('/api/alerts/pending').expect(200)).body;
    expect(Array.isArray(first.alerts)).toBe(true);
    for (const a of first.alerts) {
      expect(typeof a.key).toBe('string');
      expect(['duplicate-charge', 'price-hike', 'forecast-floor']).toContain(a.type);
      expect(a.titleHe.length).toBeGreaterThan(0);
      expect(['month', 'future']).toContain(a.target);
    }

    await request(app).post('/api/alerts/ack').send({ keys: [] }).expect(400);
    await request(app).post('/api/alerts/ack').send({}).expect(400);
    await request(app).post('/api/alerts/ack').send({ keys: [12] }).expect(400);

    const keys: string[] = first.alerts.map((a: { key: string }) => a.key);
    if (keys.length > 0) {
      await request(app).post('/api/alerts/ack').send({ keys }).expect(200);
      const after = (await request(app).get('/api/alerts/pending').expect(200)).body;
      expect(after.alerts.filter((a: { key: string }) => keys.includes(a.key))).toHaveLength(0);
    } else {
      await request(app).post('/api/alerts/ack').send({ keys: ['synthetic'] }).expect(200);
    }
  });

  test('GET /api/health returns 12 metrics across two axes with the math shown', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.level.length + res.body.resilience.length).toBe(12);
    expect(['בריא', 'מסתדר', 'פגיע']).toContain(res.body.overall.statusHe);
    for (const m of [...res.body.level, ...res.body.resilience]) {
      expect(['green', 'yellow', 'red', 'na']).toContain(m.band);
      expect(m.detailHe.length).toBeGreaterThan(10);
      if (m.band === 'na') expect(m.visual).toBeNull();
      else expect(m.visual).toEqual(expect.objectContaining({ kind: expect.any(String) }));
    }
    const buffer = res.body.resilience.find((m: { id: string }) => m.id === 'buffer');
    expect(buffer.band).not.toBe('na'); // mock has balance + essential spend
  });

  test('the health time basis is the caller\'s to choose, and the report names it', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const wide = await request(app).get('/api/health?months=12').expect(200);
    expect(wide.body.windowMonths).toBe(12);
    const narrow = await request(app).get('/api/health?months=3').expect(200);
    expect(narrow.body.windowMonths).toBe(3);
    expect(narrow.body.level.length + narrow.body.resilience.length).toBe(12);
    // a 3-month basis cannot satisfy 6-month metrics — they must degrade to na, not lie
    const volatility = narrow.body.resilience.find((m: { id: string }) => m.id === 'income-volatility');
    expect(volatility.band).toBe('na');
    // savings rate reads from the window it names
    const rate = narrow.body.level.find((m: { id: string }) => m.id === 'savings-rate');
    if (rate.band !== 'na') expect(rate.detailHe).toContain('3 חודשים שלמים');
    // a bogus value falls back to 12
    const fallback = await request(app).get('/api/health?months=5').expect(200);
    expect(fallback.body.windowMonths).toBe(12);
  });

  test('net worth combines bank balances with manual assets and liabilities', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = await request(app).get('/api/networth').expect(200);
    expect(before.body.bankTotal).toBeGreaterThan(0);
    expect(before.body.cardTotal).toBe(0); // isracard mock reports no balance
    expect(before.body.history.length).toBeGreaterThan(0);

    const a = await request(app).post('/api/assets').send({ name: 'קרן השתלמות', kind: 'asset', amount: 50000 }).expect(201);
    await request(app).post('/api/assets').send({ name: 'הלוואה', kind: 'liability', amount: 20000 }).expect(201);
    await request(app).post('/api/assets').send({ name: 'x', kind: 'nope', amount: 1 }).expect(400);

    const after = await request(app).get('/api/networth').expect(200);
    expect(after.body.netWorth).toBeCloseTo(before.body.bankTotal + 30000, 1);

    await request(app).put(`/api/assets/${a.body.id}`).send({ name: 'קרן השתלמות', amount: 60000 }).expect(200);
    await request(app).delete(`/api/assets/${a.body.id}`).expect(204);
    await request(app).delete(`/api/assets/${a.body.id}`).expect(404);
  });

  test('month review returns merchants and insights for the current month', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app).get(`/api/months/${month}/review`).expect(200);
    expect(res.body.current.month).toBe(month);
    expect(res.body.previous).not.toBeNull();
    expect(res.body.topMerchants.length).toBeGreaterThan(0);
    expect(res.body.topMerchants[0].total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.insights)).toBe(true);
    // pending rows are outside every summary figure, but the review names them
    expect(res.body.pending).toEqual({
      count: expect.any(Number),
      net: expect.any(Number),
    });
    await request(app).get('/api/months/1999-01/review').expect(404);
    await request(app).get('/api/months/bad/review').expect(400);
  });

  test('a what-if scenario rides the same engine and shifts the projected path honestly', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const base = await request(app).get('/api/cashflow?days=60').expect(200);
    expect(base.body.scenario).toBeNull();
    expect(base.body.forecast).not.toBeNull();

    // a one-off expense next month must LOWER the end balance vs baseline
    const nextMonth = base.body.forecast.path[40].date.slice(0, 7);
    const hit = await request(app)
      .get(`/api/cashflow?days=60&oneOffAmount=5000&oneOffMonth=${nextMonth}`)
      .expect(200);
    expect(hit.body.scenario).not.toBeNull();
    const baseEnd = base.body.forecast.path[base.body.forecast.path.length - 1].balance;
    const hitEnd = hit.body.scenario.path[hit.body.scenario.path.length - 1].balance;
    expect(hitEnd).toBeCloseTo(baseEnd - 5000, 0);
    // and the baseline in the same response is untouched
    expect(hit.body.forecast.path[hit.body.forecast.path.length - 1].balance).toBeCloseTo(baseEnd, 0);

    // extra monthly income raises the path; garbage params mean no scenario
    const raise = await request(app).get('/api/cashflow?days=60&extraMonthly=1000').expect(200);
    expect(raise.body.scenario.path[raise.body.scenario.path.length - 1].balance).toBeGreaterThan(baseEnd);
    const garbage = await request(app).get('/api/cashflow?days=60&extraMonthly=abc&variableFactor=99').expect(200);
    expect(garbage.body.scenario).toBeNull();
  });

  test('every successful sync leaves forecast receipts, and the audit matures with time', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const snaps = db.listForecastSnapshots();
    expect(snaps.length).toBe(2); // +30 and +90 days
    expect(new Set(snaps.map((s: { horizonDays: number }) => s.horizonDays))).toEqual(new Set([30, 90]));
    for (const s of snaps) expect(typeof s.predictedBalance).toBe('number');

    // nothing has matured yet — the audit says so instead of inventing
    const fresh = await request(app).get('/api/forecast/accuracy').expect(200);
    expect(fresh.body.entries).toEqual([]);

    // a receipt whose target date has passed is compared against the reconstructed reality
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    db.saveForecastSnapshot('2026-05-01', 30, today <= '2026-05-31' ? '2026-05-01' : '2026-05-31', 12345);
    const matured = await request(app).get('/api/forecast/accuracy').expect(200);
    expect(matured.body.entries.length).toBe(1);
    expect(matured.body.entries[0]).toMatchObject({
      horizonDays: 30,
      predicted: 12345,
      actual: expect.any(Number),
      error: expect.any(Number),
    });
  });

  test('overview returns the longitudinal conduct payload with the partial month fenced off', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/overview?months=6').expect(200);
    expect(res.body.monthsRequested).toBe(6);
    const series = res.body.series;
    expect(series.length).toBeGreaterThan(1);
    // exactly one partial month, and it is the newest entry
    expect(series.filter((r: { partial: boolean }) => r.partial)).toHaveLength(1);
    expect(series[series.length - 1].partial).toBe(true);
    expect(res.body.completeMonths).toBe(series.length - 1);
    expect(typeof res.body.verdict.avgNet).toBe('number');
    expect(res.body.kpis.avgIncome.value).not.toBeNull();
    expect(res.body.minus).toMatchObject({ rate: expect.any(Number), covered: expect.any(Boolean) });
    expect(res.body.insights).toBeUndefined();
    // a bad months param falls back to 12
    const fallback = await request(app).get('/api/overview?months=7').expect(200);
    expect(fallback.body.monthsRequested).toBe(12);
  });

  test('CSV export returns every transaction with a BOM and Hebrew intact', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const res = await request(app).get('/api/export.csv').expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.startsWith('﻿')).toBe(true);
    expect(res.text).toContain('משכורת');
    expect(res.text.split('\n').length).toBeGreaterThan(30);
  });
});

const FIXTURE = fs.readFileSync(new URL('../test/fixtures/discount-account-state.txt', import.meta.url), 'utf8');
const LOAN = { name: 'הלוואות', kind: 'liability', amount: 45678.90, type: 'loan' };
const DEPOSIT = { name: 'פקדונות וחסכונות', kind: 'asset', amount: 12345.67, type: 'deposit' };

/** The panel's rows keyed by line id, for readable assertions. */
function byLine(rows: { line: string }[]): Record<string, Record<string, any>> {
  return Object.fromEntries(rows.map((r) => [r.line, r]));
}

describe('מצב החשבון — the bank rows mirrored line for line', () => {
  test('POST /api/assets and PUT round-trip type, institution and monthlyPayment', async () => {
    const { app } = makeApp();
    const created = await request(app).post('/api/assets')
      .send({ ...LOAN, institution: 'בנק לאומי', monthlyPayment: 700 }).expect(201);

    const one = (await request(app).get('/api/networth').expect(200)).body.assets[0];
    expect(one).toMatchObject({ type: 'loan', institution: 'בנק לאומי', monthlyPayment: 700, kind: 'liability' });

    await request(app).put(`/api/assets/${created.body.id}`)
      .send({ name: 'הלוואות', amount: 20000, type: 'loan', monthlyPayment: null }).expect(200);
    const after = (await request(app).get('/api/networth').expect(200)).body.assets[0];
    expect(after).toMatchObject({ amount: 20000, monthlyPayment: null, institution: 'בנק לאומי' });

    await request(app).post('/api/assets').send({ ...LOAN, type: 'nope' }).expect(400);
    await request(app).post('/api/assets').send({ ...LOAN, monthlyPayment: -5 }).expect(400);
  });

  test('kind follows type: a row typed as a loan is a liability whatever the caller claimed', async () => {
    const { app } = makeApp();
    // a client that posts kind:'asset' with type:'loan' must not ADD 21k to net worth
    await request(app).post('/api/assets').send({ ...LOAN, kind: 'asset' }).expect(201);
    const res = await request(app).get('/api/networth').expect(200);
    expect(res.body.assets[0].kind).toBe('liability');
    expect(res.body.netWorth).toBe(-45678.90);
  });

  test('the panel mirrors the bank line for line, and אין נתון is never a zero', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/assets').send({ ...LOAN, monthlyPayment: 700 }).expect(201);
    await request(app).post('/api/assets').send(DEPOSIT).expect(201);

    const res = await request(app).get('/api/networth').expect(200);
    const rows = byLine(res.body.accountState.rows);
    expect(res.body.accountState.rows.map((r: { line: string }) => r.line))
      .toEqual(['checking', 'card', 'loan', 'deposit', 'securities']);

    expect(rows.checking.signedAmount).toBe(res.body.bankTotal);
    expect(rows.checking.labelHe).toBe('יתרת עו"ש');

    // isracard reports no balance, so we have no card figure at all — not a zero one
    expect(res.body.cardBalanceAvailable).toBe(false);
    expect(rows.card.signedAmount).toBeNull();
    expect(rows.card.noteHe).toContain('לא מדווחים יתרה לחיוב');
    // never the bank's label for our own, narrower number
    expect(rows.card.labelHe).toBe('יתרה לחיוב בכרטיסים המחוברים');
    expect(rows.card.labelHe).not.toBe('כרטיסי אשראי');

    expect(rows.loan.signedAmount).toBe(-45678.90); // kind carries the sign
    expect(rows.loan.source).toBe('manual');
    expect(rows.loan.remainingPaymentsHe).toBe('לפחות 66 תשלומים · ריבית אינה מחושבת — המספר האמיתי גבוה יותר');
    expect(rows.deposit.signedAmount).toBe(12345.67);
    expect(rows.deposit.noteHe).toBe('הפקדה לפקדון נספרת כהוצאה בתקציב החודשי — ההון נשאר נכון');
    // no securities holding: אין, not 0
    expect(rows.securities.signedAmount).toBeNull();
    expect(rows.securities.source).toBe('none');

    // netBank is the five rows only — the bank picture, not net worth
    expect(res.body.accountState.netBank).toBeCloseTo(res.body.bankTotal - 45678.90 + 12345.67, 2);
  });

  test("netBank is not netWorth once a type='other' asset exists", async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/assets')
      .send({ name: 'דירה', kind: 'asset', amount: 2_000_000, type: 'other' }).expect(201);
    const res = await request(app).get('/api/networth').expect(200);
    expect(res.body.accountState.netBank).toBeCloseTo(res.body.netWorth - 2_000_000, 2);
  });

  test('history ends at netWorth — the invariant holds when the last bank snapshot is from today', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200); // the mock stamps takenAt = now
    await request(app).post('/api/account-state/apply').send({
      rows: [
        { line: 'loan', action: 'create', assetId: null, amount: 45678.90 },
        { line: 'deposit', action: 'create', assetId: null, amount: 12345.67 },
      ],
    }).expect(200);

    const res = await request(app).get('/api/networth').expect(200);
    expect(res.body.history.at(-1).balance).toBeCloseTo(res.body.netWorth, 2);
  });

  test('the balance-sheet layer: layers sum to the history, attribution closes on today, gross carries the identity', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/account-state/apply').send({
      rows: [
        { line: 'loan', action: 'create', assetId: null, amount: 45678.90 },
        { line: 'deposit', action: 'create', assetId: null, amount: 12345.67 },
      ],
    }).expect(200);

    const res = (await request(app).get('/api/networth').expect(200)).body;
    // every class series is aligned with the history and they sum back to it — one arithmetic
    const keys = ['checking', 'card', 'deposit', 'securities', 'otherAsset', 'loan', 'otherLiability'];
    for (const key of keys) expect(res.layers[key]).toHaveLength(res.history.length);
    const last = res.history.length - 1;
    const sum = keys.reduce((s, k) => s + res.layers[k][last], 0);
    expect(sum).toBeCloseTo(res.history[last].balance, 1);
    expect(res.layers.deposit[last]).toBeCloseTo(12345.67, 2);
    expect(res.layers.loan[last]).toBeCloseTo(-45678.90, 2);

    // attribution ends at the running flow month, marked partial, closing on the latest point
    const current = res.attribution.at(-1);
    expect(current.partial).toBe(true);
    expect(current.close).toBeCloseTo(res.history.at(-1).balance, 2);
    expect(current.revaluation).toBeCloseTo(current.close - current.open - (current.income - current.expenses), 1);

    // the identity the hero Sankey draws
    expect(res.gross.assets - res.gross.liabilities).toBeCloseTo(res.netWorth, 2);
    // both created holdings got a value timeline for their sparklines
    expect(Object.keys(res.assetHistories)).toHaveLength(2);
  });

  test('the widened taxonomy on /networth: a flat and its mortgage, each on the right side and layer', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = (await request(app).get('/api/networth').expect(200)).body;

    const flatId = (await request(app).post('/api/assets')
      .send({ name: 'דירה בחולון', kind: 'asset', amount: 1_850_000, type: 'realEstate', institution: 'רחוב סוקולוב 12' })
      .expect(201)).body.id;
    // kind follows type — a mortgage is a liability even when the caller says asset
    await request(app).post('/api/assets')
      .send({ name: 'משכנתא', kind: 'asset', amount: 920_000, type: 'mortgage', monthlyPayment: 4_600 })
      .expect(201);
    await request(app).post('/api/assets')
      .send({ name: 'קרן השתלמות', kind: 'asset', amount: 88_000, type: 'pension' })
      .expect(201);
    expect((await request(app).post('/api/assets')
      .send({ name: 'רעיון', kind: 'asset', amount: 1, type: 'startup' })).status).toBe(400);

    const res = (await request(app).get('/api/networth').expect(200)).body;
    expect(res.netWorth).toBeCloseTo(before.netWorth + 1_850_000 - 920_000 + 88_000, 1);
    const flat = res.assets.find((a: { id: number }) => a.id === flatId);
    expect(flat).toMatchObject({ type: 'realEstate', kind: 'asset' });
    const mortgage = res.assets.find((a: { name: string }) => a.name === 'משכנתא');
    expect(mortgage).toMatchObject({ type: 'mortgage', kind: 'liability' });
    // layers: the flat and the pension ride their own classes, the mortgage joins loan
    expect(res.layers.realEstate.at(-1)).toBeCloseTo(1_850_000, 1);
    expect(res.layers.pension.at(-1)).toBeCloseTo(88_000, 1);
    expect(res.layers.loan.at(-1)).toBeCloseTo(-920_000, 1);
    // the identity holds with all ten layers
    const keys = Object.keys(res.layers);
    const last = res.history.length - 1;
    const sum = keys.reduce((s, k) => s + res.layers[k][last], 0);
    expect(sum).toBeCloseTo(res.history[last].balance, 1);
    expect(res.gross.assets - res.gross.liabilities).toBeCloseTo(res.netWorth, 2);
  });

  test('a foreign-currency holding: raw amount stays raw, the cached rate powers every figure', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = (await request(app).get('/api/networth').expect(200)).body;

    // an unsupported code never reaches the DB
    expect((await request(app).post('/api/assets')
      .send({ name: 'ביטקוין', kind: 'asset', amount: 1, currency: 'BTC' })).status).toBe(400);

    // PayPal savings in dollars — the driving use case (test rate: $1 = ₪4 exactly)
    const id = (await request(app).post('/api/assets')
      .send({ name: 'פייפל', kind: 'asset', amount: 5000, type: 'deposit', currency: 'USD', liquid: true })
      .expect(201)).body.id;

    const res = (await request(app).get('/api/networth').expect(200)).body;
    const asset = res.assets.find((a: { id: number }) => a.id === id);
    expect(asset.currency).toBe('USD');
    expect(asset.amount).toBe(5000); // raw, exactly as PayPal prints it
    expect(asset.value).toBeCloseTo(20_000, 2);
    expect(res.netWorth).toBeCloseTo(before.netWorth + 20_000, 1);
    expect(res.history.at(-1).balance).toBeCloseTo(res.netWorth, 1);
    expect(res.rates.find((r: { currency: string }) => r.currency === 'USD').rate).toBe(4);
    expect(res.missingRates).toEqual([]);

    // the bank mirror prints shekels — a dollar holding never joins its five lines or netBank
    expect(res.accountState.rows.find((r: { line: string }) => r.line === 'deposit').signedAmount).toBeNull();
    expect(res.accountState.netBank).toBeCloseTo(before.accountState.netBank, 1);
    // ...and an ILS paste cannot see it either: the deposit line offers to CREATE, not update
    const preview = (await request(app).post('/api/account-state/preview')
      .send({ text: 'פקדונות וחסכונות ₪1,000.00' }).expect(200)).body;
    expect(preview.rows.find((r: { line: string }) => r.line === 'deposit').action).toBe('create');

    // the primary-currency lens: the same sheet, expressed in dollars; raw stays raw
    await request(app).put('/api/settings').send({ primaryCurrency: 'USD' }).expect(200);
    const usd = (await request(app).get('/api/networth').expect(200)).body;
    expect(usd.currency).toBe('USD');
    expect(usd.netWorth).toBeCloseTo(res.netWorth / 4, 1);
    expect(usd.assets.find((a: { id: number }) => a.id === id).amount).toBe(5000);
  });

  test('a card balance joins the history through its own timeline, not as a cliff on the last point', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const cardConn = db.getConnections().find((c) => c.company === 'isracard')!;
    const before = (await request(app).get('/api/networth').expect(200)).body;
    const mid = before.history[Math.floor(before.history.length / 2)];

    // a Cal-style next-debit balance, recorded on a day in the middle of the series
    db.insertSnapshot(cardConn.id, 'card-1', -1234.56, mid.date, `${mid.date}T12:00:00.000Z`);

    const after = (await request(app).get('/api/networth').expect(200)).body;
    expect(after.cardBalanceAvailable).toBe(true);
    expect(after.cardTotal).toBe(-1234.56);
    // back-filled before its first record and carried to the end — not pinned onto one point
    expect(after.history[0].balance).toBeCloseTo(before.history[0].balance - 1234.56, 2);
    expect(after.history.at(-1).balance).toBeCloseTo(after.netWorth, 2);
    expect(byLine(after.accountState.rows).card.signedAmount).toBe(-1234.56);
  });

  test('a card that reports nothing is named, even when another card does report (A1)', async () => {
    const { app } = await mockAppWithConnections(); // leumi + isracard
    await request(app).post('/api/connections').send(VISA_CAL).expect(201);
    await request(app).post('/api/sync').expect(200);

    // Cal reports, so a `some(kind === 'card')` flag calls the picture complete — while isracard's
    // whole next debit is missing from netWorth, missing from the row, and absent from `accounts`
    const res = (await request(app).get('/api/networth').expect(200)).body;
    expect(res.cardBalanceAvailable).toBe(true);
    expect(res.cardsMissingBalance).toEqual(['ישראכרט']);
    expect(byLine(res.accountState.rows).card.noteHe).toContain('ישראכרט');
    expect(byLine(res.accountState.rows).card.noteHe).toContain('רק את שאר הכרטיסים');
  });

  test('with no card connected, nobody is blamed for not reporting (A1)', async () => {
    const { app } = makeApp();
    await request(app).post('/api/connections').send(LEUMI).expect(201);
    await request(app).post('/api/sync').expect(200);

    const res = (await request(app).get('/api/networth').expect(200)).body;
    expect(res.cardsMissingBalance).toEqual([]);
    const card = byLine(res.accountState.rows).card;
    expect(card.signedAmount).toBeNull(); // אין ≠ 0 still holds
    // the panel must not explain a scraper limitation of three issuers this user never connected
    expect(card.noteHe).not.toContain('מקס');
    expect(card.noteHe).toBe('אין כרטיס אשראי מחובר — אין לנו מספר משלנו לשורה הזו');

    const preview = (await request(app).post('/api/account-state/preview')
      .send({ text: FIXTURE }).expect(200)).body;
    expect(byLine(preview.rows).card.noteHe).not.toContain('ישראכרט');
  });

  test('the mock mirrors reality: Cal reports a next-debit balance, Isracard structurally does not (A1)', async () => {
    const { app } = await mockAppWithConnections(); // leumi + isracard
    await request(app).post('/api/sync').expect(200);

    // isracard/max/amex build accounts with no balance field, so no card snapshot is ever written:
    // the father's likely case, and the reason the row must say אין נתון rather than ₪0.00
    const withoutCal = (await request(app).get('/api/networth').expect(200)).body;
    expect(withoutCal.cardBalanceAvailable).toBe(false);
    expect(withoutCal.cardTotal).toBe(0);
    expect(byLine(withoutCal.accountState.rows).card.signedAmount).toBeNull();

    await request(app).post('/api/connections').send(VISA_CAL).expect(201);
    await request(app).post('/api/sync').expect(200);

    const now = new Date();
    const nowIndex = now.getFullYear() * 12 + now.getMonth();
    const withCal = (await request(app).get('/api/networth').expect(200)).body;
    expect(withCal.cardBalanceAvailable).toBe(true);
    // stored negative by the scraper, so it is added, never subtracted
    expect(withCal.cardTotal).toBe(-mockSettlementAmount(nowIndex));
    expect(byLine(withCal.accountState.rows).card.signedAmount).toBe(-mockSettlementAmount(nowIndex));
  });

  test('reclassifying a holding does not carve a cliff into a day when nothing happened', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    // the first thing an existing type='other' user does: tell the app what the row always was
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואה', kind: 'asset', amount: 45678.90, type: 'other' }).expect(201)).body.id;
    const before = (await request(app).get('/api/networth').expect(200)).body;
    expect(before.history.at(-1).balance).toBeCloseTo(before.bankTotal + 45678.90, 2);

    await request(app).put(`/api/assets/${id}`)
      .send({ name: 'הלוואה', amount: 45678.90, type: 'loan' }).expect(200);

    const after = (await request(app).get('/api/networth').expect(200)).body;
    // the whole curve re-signs: the correction applies to what the row always was, with no step
    expect(after.history.at(-1).balance).toBeCloseTo(after.bankTotal - 45678.90, 2);
    expect(after.history[0].balance).toBeCloseTo(before.history[0].balance - 2 * 45678.90, 2);
    expect(after.history.at(-1).balance).toBeCloseTo(after.netWorth, 2);
  });

  test('manualFrom marks where the invented era ends, and is null with no manual holdings', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    expect((await request(app).get('/api/networth').expect(200)).body.manualFrom).toBeNull();

    await request(app).post('/api/assets').send(DEPOSIT).expect(201);
    const res = await request(app).get('/api/networth').expect(200);
    expect(res.body.manualFrom).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }));
  });
});

describe('הדבקת מצב חשבון — preview and apply', () => {
  test('preview understands the real paste and writes nothing', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);

    const res = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    expect(res.body.understood).toBe(5);
    expect(res.body.ignored).toBe(0);
    const rows = byLine(res.body.rows);
    // the two scraped lines are shown to prove the paste parsed, and are terminal
    expect(rows.checking.action).toBe('readonly');
    expect(rows.card.action).toBe('readonly');
    // the bank's card line sits BESIDE our own figure and may differ visibly — that is the point
    expect(rows.card.amount).toBe(1234.56);
    expect(rows.card.current).toBeNull();
    expect(rows.checking.current).toBeCloseTo((await request(app).get('/api/networth')).body.bankTotal, 2);
    for (const line of ['loan', 'deposit', 'securities']) {
      expect(rows[line].action).toBe('create');
      expect(rows[line].assetId).toBeNull();
      expect(rows[line].current).toBeNull();
    }
    expect(rows.loan.amount).toBe(45678.90);
    expect(rows.loan.labelHe).toBe('הלוואות');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(0);
  });

  test('preview reports the app own figure for comparison, and flags ambiguity', async () => {
    const { app } = makeApp();
    await request(app).post('/api/assets')
      .send({ name: 'הלוואת רכב', kind: 'liability', amount: 5000, type: 'loan' }).expect(201);
    const one = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    expect(byLine(one.body.rows).loan).toMatchObject({ action: 'update', current: 5000 });

    await request(app).post('/api/assets')
      .send({ name: 'הלוואת דירה', kind: 'liability', amount: 9000, type: 'loan' }).expect(201);
    const two = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const loan = byLine(two.body.rows).loan;
    expect(loan.action).toBe('ambiguous');
    expect(loan.assetId).toBeNull();
    expect(loan.current).toBe(14000); // the app's total, so the user can see why we cannot pick
    expect(loan.noteHe).toContain('יותר מהחזקה אחת');
  });

  test("the first paste of a legacy type='other' user never doubles the loan or the deposit", async () => {
    const { app } = makeApp();
    // exactly what the הון screen has always advertised ("השתלמות, פיקדון, הלוואה…"), and what the
    // `type` migration back-fills to 'other' — so this IS the existing user's first paste
    await request(app).post('/api/assets')
      .send({ name: 'הלוואה בלאומי', kind: 'liability', amount: 45678.90 }).expect(201);
    await request(app).post('/api/assets')
      .send({ name: 'פיקדון בלאומי', kind: 'asset', amount: 12345.67 }).expect(201);
    const before = (await request(app).get('/api/networth').expect(200)).body.netWorth;
    expect(before).toBeCloseTo(-33333.23, 2);

    const preview = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const rows = byLine(preview.body.rows);
    expect(rows.loan.action).toBe('ambiguous');
    expect(rows.loan.noteHe).toContain('ללא סוג');
    expect(rows.deposit.action).toBe('ambiguous');

    // and the guard is the server's, not the disabled checkbox: a client posting `create` anyway
    // would otherwise write a second ₪45,678.90 liability — netWorth −₪91,357.80
    const forced = await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'create', assetId: null, amount: 45678.90 }] }).expect(409);
    expect(forced.body.errorType).toBe('AMBIGUOUS_HOLDING');
    expect(forced.body.errorMessage).toContain('ללא סוג');

    const after = (await request(app).get('/api/networth').expect(200)).body;
    expect(after.netWorth).toBeCloseTo(before, 2);
    expect(after.assets).toHaveLength(2);
  });

  test('classifying the legacy row is what unblocks the paste — and it updates, never creates', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואה בלאומי', kind: 'liability', amount: 22000 }).expect(201)).body.id;

    // the (already shipped) edit form: tell the app what the row always was
    await request(app).put(`/api/assets/${id}`).send({ type: 'loan' }).expect(200);

    const preview = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const loan = byLine(preview.body.rows).loan;
    expect(loan).toMatchObject({ action: 'update', assetId: id, current: 22000 });

    await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'update', assetId: id, amount: 45678.90 }] }).expect(200);
    const after = (await request(app).get('/api/networth').expect(200)).body;
    expect(after.assets).toHaveLength(1); // the user's own row, corrected — not a second one
    expect(after.netWorth).toBeCloseTo(-45678.90, 2);
  });

  test('an overdrafted עו"ש reaches the review with the sign the bank printed', async () => {
    const { app, db } = makeApp();
    await request(app).post('/api/connections').send(LEUMI).expect(201);
    const conn = db.getConnections()[0];
    const today = new Date().toLocaleDateString('en-CA');
    db.insertSnapshot(conn.id, 'acct-1', -3456.78, today, new Date().toISOString());

    // עו"ש is not a holding, so no `kind` carries its sign and only the paste knows it. Dropping it
    // printed +₪3,456.78 beside our −₪3,456.78: a phantom ₪6,913.56 gap on the one row whose whole
    // job is to prove the paste was understood.
    const res = await request(app).post('/api/account-state/preview')
      .send({ text: 'יתרת עו"ש\n₪3,456.78-' }).expect(200);
    expect(res.body.rows[0]).toMatchObject({
      line: 'checking', amount: 3456.78, printedSign: -1, current: -3456.78, action: 'readonly',
    });
    // A8 is intact: the amount itself never goes negative
    expect(res.body.rows[0].amount).toBeGreaterThan(0);

    // the three applicable lines still carry a magnitude regardless of what the bank printed
    const loan = await request(app).post('/api/account-state/preview')
      .send({ text: 'הלוואות\n₪45,678.90-' }).expect(200);
    expect(loan.body.rows[0]).toMatchObject({ line: 'loan', amount: 45678.90 });
  });

  test('the card note explains the gap it has, not the one it does not', async () => {
    const { app, db } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    // no card balance at all: say so
    const none = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    expect(byLine(none.body.rows).card.noteHe).toContain('לא מדווחים יתרה לחיוב');

    // a Cal-style figure exists and differs from the bank's line — legitimately, so explain WHY
    const cardConn = db.getConnections().find((c) => c.company === 'isracard')!;
    db.insertSnapshot(cardConn.id, 'card-1', -500, null, new Date().toISOString());
    const some = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const card = byLine(some.body.rows).card;
    expect(card.action).toBe('readonly');
    expect(card.amount).toBe(1234.56); // the bank's line
    expect(card.current).toBe(-500); // ours, narrower — shown beside it
    expect(card.noteHe).toContain('רק את הכרטיסים המחוברים');
    expect(card.noteHe).not.toContain('לא מדווחים יתרה לחיוב');
  });

  test('preview requires text', async () => {
    const { app } = makeApp();
    await request(app).post('/api/account-state/preview').send({}).expect(400);
    await request(app).post('/api/account-state/preview').send({ text: 42 }).expect(400);
    const empty = await request(app).post('/api/account-state/preview').send({ text: 'שלום' }).expect(200);
    expect(empty.body).toEqual({ rows: [], understood: 0, ignored: 0 });
  });

  test('apply creates the three user-maintained rows exactly as specified', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const preview = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const rows = preview.body.rows
      .filter((r: { action: string }) => r.action !== 'readonly')
      .map((r: Record<string, unknown>) => ({ line: r.line, action: r.action, assetId: r.assetId, amount: r.amount, labelHe: r.labelHe }));

    const res = await request(app).post('/api/account-state/apply').send({ rows }).expect(200);
    expect(res.body).toEqual({ applied: 3, created: 3, updated: 0, confirmed: 0 });

    const assets = (await request(app).get('/api/networth').expect(200)).body.assets;
    expect(assets).toHaveLength(3);
    const created = Object.fromEntries(assets.map((a: { type: string }) => [a.type, a])) as Record<string, Record<string, unknown>>;
    // a breakable deposit IS an emergency buffer: the app must not report a zero buffer beside it
    expect(created.deposit).toMatchObject({ name: 'פקדונות וחסכונות', kind: 'asset', liquid: true, institution: 'בנק לאומי', amount: 12345.67 });
    expect(created.loan).toMatchObject({ name: 'הלוואות', kind: 'liability', liquid: false, amount: 45678.90 });
    expect(created.securities).toMatchObject({ name: 'תיק ניירות ערך', kind: 'asset', liquid: false, amount: 0 });
    // paste never invents a monthly payment: the bank's summary does not carry one
    for (const a of assets) expect(a.monthlyPayment).toBeNull();

    // the buffer metric must SEE the deposit: reporting no emergency buffer on the same screen
    // that displays 12,345.67 is exactly what liquid=1 on a created פקדון prevents
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.resilience.find((m: { id: string }) => m.id === 'buffer').detailHe)
      .toContain('נכסים שסומנו נזילים');
  });

  test('the scraped lines can never be applied, whatever the client posts', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const before = (await request(app).get('/api/networth').expect(200)).body;

    for (const line of ['checking', 'card', 'other', 'nope']) {
      const res = await request(app).post('/api/account-state/apply')
        .send({ rows: [{ line, action: 'create', assetId: null, amount: 3456.78 }] }).expect(400);
      expect(res.body.errorType).toBe('INVALID_INPUT');
      expect(res.body.errorMessage).toContain('deposit|loan|securities');
    }
    // nothing written: the עו"ש is scraped truth and must never be double-counted as an asset
    const after = (await request(app).get('/api/networth').expect(200)).body;
    expect(after.assets).toHaveLength(0);
    expect(after.netWorth).toBe(before.netWorth);
  });

  test('apply rejects a negative amount rather than flipping the sign of the biggest number', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'create', assetId: null, amount: -45678.90 }] }).expect(400);
    expect(res.body.errorType).toBe('INVALID_INPUT');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(0);
  });

  test('apply rejects a malformed action or payload', async () => {
    const { app } = makeApp();
    await request(app).post('/api/account-state/apply').send({}).expect(400);
    await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'readonly', assetId: null, amount: 1 }] }).expect(400);
    await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'ambiguous', assetId: null, amount: 1 }] }).expect(400);
    await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'create', assetId: null, amount: 'הרבה' }] }).expect(400);
  });

  test('a second holding created between preview and apply is a 409, not a duplicate liability', async () => {
    const { app } = makeApp();
    await request(app).post('/api/assets')
      .send({ name: 'הלוואת רכב', kind: 'liability', amount: 5000, type: 'loan' }).expect(201);
    const preview = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const row = preview.body.rows.find((r: { line: string }) => r.line === 'loan');
    expect(row.action).toBe('update');

    // the user opens another loan in the bank's own app while the review table is on screen
    await request(app).post('/api/assets')
      .send({ name: 'הלוואת דירה', kind: 'liability', amount: 9000, type: 'loan' }).expect(201);

    const res = await request(app).post('/api/account-state/apply').send({
      rows: [{ line: row.line, action: row.action, assetId: row.assetId, amount: row.amount }],
    }).expect(409);
    expect(res.body.errorType).toBe('AMBIGUOUS_HOLDING');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(2); // nothing created
  });

  test('the ambiguity guard is server-side: a client claiming create cannot force a duplicate', async () => {
    const { app } = makeApp();
    await request(app).post('/api/assets')
      .send({ name: 'הלוואת רכב', kind: 'liability', amount: 5000, type: 'loan' }).expect(201);
    await request(app).post('/api/assets')
      .send({ name: 'הלוואת דירה', kind: 'liability', amount: 9000, type: 'loan' }).expect(201);
    const res = await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'create', assetId: null, amount: 45678.90 }] }).expect(409);
    expect(res.body.errorType).toBe('AMBIGUOUS_HOLDING');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(2);
  });

  test('a holding deleted between preview and apply is a 409, not a silent re-create', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 5000, type: 'loan' }).expect(201)).body.id;
    const preview = await request(app).post('/api/account-state/preview').send({ text: FIXTURE }).expect(200);
    const row = preview.body.rows.find((r: { line: string }) => r.line === 'loan');

    await request(app).delete(`/api/assets/${id}`).expect(204);

    const res = await request(app).post('/api/account-state/apply').send({
      rows: [{ line: row.line, action: row.action, assetId: row.assetId, amount: row.amount }],
    }).expect(409);
    expect(res.body.errorType).toBe('ACCOUNT_STATE_CHANGED');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(0);
  });

  test('the same line twice in one payload is rejected, not written twice', async () => {
    const { app } = makeApp();
    // both rows would resolve against the same untouched holdings: 2 x 45,678.90 = a 42k liability
    const res = await request(app).post('/api/account-state/apply').send({
      rows: [
        { line: 'loan', action: 'create', assetId: null, amount: 45678.90 },
        { line: 'loan', action: 'create', assetId: null, amount: 45678.90 },
      ],
    }).expect(400);
    expect(res.body.errorType).toBe('INVALID_INPUT');
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(0);
  });

  test('apply is atomic: a rejected row late in the list leaves nothing written', async () => {
    const { app } = makeApp();
    await request(app).post('/api/account-state/apply').send({
      rows: [
        { line: 'deposit', action: 'create', assetId: null, amount: 12345.67 },
        { line: 'securities', action: 'create', assetId: null, amount: 0 },
        { line: 'loan', action: 'create', assetId: null, amount: -1 }, // the poison, last
      ],
    }).expect(400);
    expect((await request(app).get('/api/networth')).body.assets).toHaveLength(0);
  });

  test('apply writes a snapshot for a real change, and none for a confirm', async () => {
    const { app, db } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 25000, type: 'loan' }).expect(201)).body.id;
    expect(db.getAssetSnapshots()).toHaveLength(1);

    // the balance moved: the value timeline must record it
    const update = await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'update', assetId: id, amount: 45678.90 }] }).expect(200);
    expect(update.body).toEqual({ applied: 1, created: 0, updated: 1, confirmed: 0 });
    expect(db.getAssetSnapshots()).toHaveLength(2);
    expect(db.getAssetSnapshots().at(-1)!.amount).toBe(45678.90);

    // "still true": moves updated_at, pads nothing
    const confirm = await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'loan', action: 'unchanged', assetId: id, amount: 45678.90 }] }).expect(200);
    expect(confirm.body).toEqual({ applied: 1, created: 0, updated: 0, confirmed: 1 });
    expect(db.getAssetSnapshots()).toHaveLength(2);
  });

  test('apply never overwrites the user own liquid, name or institution', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הפקדון של סבתא', kind: 'asset', amount: 20000, type: 'deposit', institution: 'בנק אחר', liquid: false }).expect(201)).body.id;

    await request(app).post('/api/account-state/apply')
      .send({ rows: [{ line: 'deposit', action: 'update', assetId: id, amount: 12345.67 }] }).expect(200);

    expect((await request(app).get('/api/networth')).body.assets[0]).toMatchObject({
      name: 'הפקדון של סבתא', institution: 'בנק אחר', liquid: false, amount: 12345.67,
    });
  });

  test('PUT /api/assets/:id is patch-shaped — a lone amount is the panel\'s whole inline edit (A10)', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 45678.90, type: 'loan', institution: 'בנק לאומי' })
      .expect(201)).body.id;

    // the edit this feature exists for: the user read a new balance off the bank and typed it
    await request(app).put(`/api/assets/${id}`).send({ amount: 20348.48 }).expect(200);
    const one = (await request(app).get('/api/networth').expect(200)).body.assets[0];
    // everything not sent survives untouched
    expect(one).toMatchObject({ name: 'הלוואות', amount: 20348.48, type: 'loan', institution: 'בנק לאומי', kind: 'liability' });

    // a lone name, too — and each field is still validated when it IS present
    await request(app).put(`/api/assets/${id}`).send({ name: 'הלוואת רכב' }).expect(200);
    expect((await request(app).get('/api/networth')).body.assets[0]).toMatchObject({ name: 'הלוואת רכב', amount: 20348.48 });
    await request(app).put(`/api/assets/${id}`).send({ amount: -1 }).expect(400);
    await request(app).put(`/api/assets/${id}`).send({ name: '  ' }).expect(400);
    await request(app).put(`/api/assets/${id}`).send({ type: 'nope' }).expect(400);
    await request(app).put('/api/assets/9999').send({ amount: 5 }).expect(404);
  });

  test('a rename writes no value-timeline point — only a real balance change does', async () => {
    const { app, db } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 45678.90, type: 'loan' }).expect(201)).body.id;
    await request(app).put(`/api/assets/${id}`).send({ name: 'הלוואת רכב', amount: 45678.90 }).expect(200);
    expect(db.getAssetSnapshots()).toHaveLength(1);
    expect((await request(app).get('/api/networth')).body.assets[0].name).toBe('הלוואת רכב');
  });
});

describe('staleness — a manual balance is a fact with a decay rate', () => {
  test("one info item for all rotted holdings, ranked above the later info items; 'other' never rots", async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 45678.90, type: 'loan', monthlyPayment: 700 }).expect(201);
    await request(app).post('/api/assets')
      .send({ name: 'פקדונות וחסכונות', kind: 'asset', amount: 12345.67, type: 'deposit' }).expect(201);
    // stale by design, and no paste can ever refresh it — including it would pin the item forever
    await request(app).post('/api/assets')
      .send({ name: 'דירה', kind: 'asset', amount: 2_000_000, type: 'other' }).expect(201);

    const fresh = await request(app).get('/api/dashboard').expect(200);
    expect(fresh.body.actions.find((a: { id: string }) => a.id === 'manual-stale')).toBeUndefined();
    expect((await request(app).get('/api/networth')).body.manualStale).toBe(false);

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // day 31: the loan is being paid every month, so it is already wrong. The deposit drifts slowly.
      vi.setSystemTime(new Date(t0 + 31 * 86_400_000));
      const res = await request(app).get('/api/dashboard').expect(200);
      const stale = res.body.actions.filter((a: { id: string }) => a.id === 'manual-stale');
      expect(stale).toHaveLength(1);
      expect(stale[0].severity).toBe('info'); // a rot warning is not a duplicate charge
      expect(stale[0].target).toBe('networth');
      expect(stale[0].textHe).toContain('יתרות ידניות');
      expect((await request(app).get('/api/networth')).body.manualStale).toBe(true);

      // day 46: both have rotted — still ONE item, never one per holding
      vi.setSystemTime(new Date(t0 + 46 * 86_400_000));
      const both = await request(app).get('/api/dashboard').expect(200);
      expect(both.body.actions.filter((a: { id: string }) => a.id === 'manual-stale')).toHaveLength(1);
      // and it outranks the info items pushed after it, so the slice cannot drop it
      const ids = both.body.actions.map((a: { id: string }) => a.id);
      for (const later of ['sectors', 'refine']) {
        if (ids.includes(later)) expect(ids.indexOf('manual-stale')).toBeLessThan(ids.indexOf(later));
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('a confirm clears the nag: the user who pastes and sees no change is not warned forever', async () => {
    const { app } = makeApp();
    const id = (await request(app).post('/api/assets')
      .send({ name: 'תיק ניירות ערך', kind: 'asset', amount: 0, type: 'securities' }).expect(201)).body.id;

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(t0 + 46 * 86_400_000));
      expect((await request(app).get('/api/networth')).body.manualStale).toBe(true);

      // day 46: reads the bank, pastes, every row still true. A static holding must be refreshable.
      await request(app).post('/api/account-state/apply')
        .send({ rows: [{ line: 'securities', action: 'unchanged', assetId: id, amount: 0 }] }).expect(200);
      expect((await request(app).get('/api/networth')).body.manualStale).toBe(false);

      vi.setSystemTime(new Date(t0 + 47 * 86_400_000));
      expect((await request(app).get('/api/networth')).body.manualStale).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('double-count rules', () => {
  test('a loan monthly payment is display-only: it never reaches the forecast or the plan', async () => {
    const { app } = await mockAppWithConnections();
    await request(app).post('/api/sync').expect(200);
    const cashflowBefore = (await request(app).get('/api/cashflow').expect(200)).body;
    const planBefore = (await request(app).get('/api/cashflow/plan').expect(200)).body;
    const dashboardBefore = (await request(app).get('/api/dashboard').expect(200)).body.month;

    // the payment is already a transaction and the recurring engine already detects it; adding it
    // to the forecast or to the plan's fixed commitments would charge the user for it twice
    await request(app).post('/api/assets')
      .send({ name: 'הלוואות', kind: 'liability', amount: 45678.90, type: 'loan', monthlyPayment: 5000 }).expect(201);

    expect((await request(app).get('/api/cashflow').expect(200)).body).toEqual(cashflowBefore);
    expect((await request(app).get('/api/cashflow/plan').expect(200)).body).toEqual(planBefore);
    expect((await request(app).get('/api/dashboard').expect(200)).body.month).toEqual(dashboardBefore);
  });

});
