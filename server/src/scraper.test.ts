import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { MockScraper, RealScraper, mockSettlementAmount, type ScrapeTarget } from './scraper.js';

const BANK = { connectionId: 1, company: 'leumi' };
const CARD = { connectionId: 2, company: 'isracard' };

describe('MockScraper', () => {
  test('bank data covers the window and includes a settlement row per month', async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const out = await new MockScraper().scrape(BANK, {}, start);

    expect(out.success).toBe(true);
    if (!out.success) return;

    const months = new Set(out.txns.filter((t) => t.status === 'completed').map((t) => t.month));
    expect(months.size).toBe(6);
    expect(new Set(out.txns.map((t) => t.key)).size).toBe(out.txns.length);
    expect(out.txns.every((t) => t.company === 'leumi' && t.connectionId === 1)).toBe(true);
    expect(out.txns.some((t) => t.status === 'pending')).toBe(true);

    const settlements = out.txns.filter((t) => t.description.includes('ישראכרט'));
    expect(settlements).toHaveLength(6);
    expect(settlements.every((t) => t.amount < 0)).toBe(true);
  });

  test('card txns for a month sum exactly to that month settlement amount', async () => {
    const start = new Date(2026, 0, 1);
    const out = await new MockScraper().scrape(CARD, {}, start);
    expect(out.success).toBe(true);
    if (!out.success) return;

    const jan = out.txns.filter((t) => t.month === '2026-01');
    expect(jan.length).toBeGreaterThan(1);
    const total = jan.reduce((s, t) => s + t.amount, 0);
    expect(-total).toBeCloseTo(mockSettlementAmount(2026 * 12 + 0), 2);
    expect(out.txns.every((t) => t.company === 'isracard' && t.connectionId === 2)).toBe(true);
  });

  test('is deterministic across calls', async () => {
    const start = new Date(2026, 0, 1);
    expect(await new MockScraper().scrape(BANK, {}, start)).toEqual(await new MockScraper().scrape(BANK, {}, start));
  });
});

describe('MockScraper phase-3 data', () => {
  const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1); // current month only

  test('bank scrape returns account balance and a deterministic BIT pair', async () => {
    const out = await new MockScraper().scrape(BANK, {}, start);
    if (!out.success) throw new Error('expected success');
    expect(out.accounts).toHaveLength(1);
    expect(out.accounts[0].balance).toBeGreaterThan(0);
    const bits = out.txns.filter((t) => t.description === 'העברה ב BIT');
    expect(bits.map((t) => t.amount).sort((a, b) => a - b)).toEqual([-350, 350]);
  });

  test('card scrape carries issuer categories and one installments txn per month', async () => {
    const out = await new MockScraper().scrape(CARD, {}, start);
    if (!out.success) throw new Error('expected success');
    expect(out.accounts[0].balance).toBeNull();
    const cats = new Set(out.txns.map((t) => t.issuerCategory).filter(Boolean));
    expect(cats).toEqual(new Set(['מסעדות', 'דלק ותחבורה', 'אופנה']));
    const month = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    const inst = out.txns.filter((t) => t.type === 'installments' && t.month === month);
    expect(inst).toHaveLength(1);
    expect(inst[0].installmentNumber).toBe(2);
    expect(inst[0].installmentTotal).toBe(6);
    expect(inst[0].issuerCategory).toBeNull();
  });

  test('card purchases of the current cycle sum exactly to the bank settlement', async () => {
    const scraper = new MockScraper();
    const bank = await scraper.scrape(BANK, {}, start);
    const card = await scraper.scrape(CARD, {}, start);
    if (!bank.success || !card.success) throw new Error('expected success');
    const settlement = bank.txns.find((t) => t.description === 'ישראכרט בעמ')!;
    const cardSum = card.txns.filter((t) => t.month === settlement.month).reduce((s, t) => s + t.amount, 0);
    expect(Math.round(cardSum * 100)).toBe(Math.round(settlement.amount * 100));
  });

  test('the card delivers its next cycle in advance, all rows debiting on one future day', async () => {
    const out = await new MockScraper().scrape(CARD, {}, start);
    if (!out.success) throw new Error('expected success');
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    const nextRows = out.txns.filter((t) => t.month === nextMonth);
    expect(nextRows.length).toBeGreaterThan(0);
    const debitDays = new Set(nextRows.map((t) => t.processedDate));
    expect(debitDays.size).toBe(1); // one cycle, one debit date
    expect([...debitDays][0]!.slice(0, 10)).toBe(`${nextMonth}-10`);
  });
});

/** The evidence path. A packaged app that fails on a stranger's machine leaves nothing behind
 *  unless it takes the picture itself — and the library only photographs failures inside its own
 *  error path, which our timeout never reaches. These reach the private helpers deliberately:
 *  driving a real browser here would be a live navigation to a bank, which a test must not do. */
interface ScraperInternals {
  failurePath(target: ScrapeTarget): string | undefined;
  captureFailure(browser: unknown, file: string | undefined): Promise<void>;
  clearFailure(file: string | undefined): void;
}
const internals = (s: RealScraper) => s as unknown as ScraperInternals;

describe('RealScraper — failure evidence', () => {
  test('takes no picture at all when no directory was configured', () => {
    expect(internals(new RealScraper()).failurePath(BANK)).toBeUndefined();
  });

  test('one file per connection, so a second failure replaces the first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-shot-'));
    const scraper = new RealScraper({ failureScreenshotDir: dir });
    expect(internals(scraper).failurePath(BANK)).toBe(path.join(dir, 'leumi-1.png'));
    expect(internals(scraper).failurePath(CARD)).toBe(path.join(dir, 'isracard-2.png'));
    // the same connection failing twice overwrites rather than accumulating
    expect(internals(scraper).failurePath(BANK)).toBe(internals(scraper).failurePath(BANK));
    expect(fs.existsSync(dir)).toBe(true);
  });

  test('the company never escapes the folder it names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-shot-'));
    const file = internals(new RealScraper({ failureScreenshotDir: dir }))
      .failurePath({ connectionId: 7, company: '../../etc/passwd' })!;
    expect(path.dirname(file)).toBe(dir);
    expect(file).toBe(path.join(dir, 'etcpasswd-7.png'));
  });

  test('photographs the live page, and a success clears the old evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-shot-'));
    const scraper = new RealScraper({ failureScreenshotDir: dir });
    const file = internals(scraper).failurePath(BANK)!;
    const shot: string[] = [];
    const browser = {
      // the scrape drives the last-opened tab; the first is Chromium's own blank one
      pages: async () => [
        { screenshot: async () => shot.push('blank') },
        { screenshot: async (o: { path: string; fullPage: boolean }) => { shot.push(o.path); fs.writeFileSync(o.path, 'png'); } },
      ],
    };
    await internals(scraper).captureFailure(browser, file);
    expect(shot).toEqual([file]);
    expect(fs.existsSync(file)).toBe(true);

    internals(scraper).clearFailure(file);
    expect(fs.existsSync(file)).toBe(false);
    // clearing what was never written is not an error — most syncs never fail
    expect(() => internals(scraper).clearFailure(file)).not.toThrow();
  });

  test('a browser already gone does not turn a failure into a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'misgeret-shot-'));
    const scraper = new RealScraper({ failureScreenshotDir: dir });
    const dead = { pages: async () => { throw new Error('Session closed'); } };
    await expect(internals(scraper).captureFailure(dead, internals(scraper).failurePath(BANK)))
      .resolves.toBeUndefined();
  });
});
