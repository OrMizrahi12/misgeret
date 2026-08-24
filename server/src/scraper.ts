import fs from 'node:fs';
import path from 'node:path';
import { createScraper, type CompanyTypes } from 'israeli-bank-scrapers';
import { companyKind } from './companies.js';
import { makeTxnKey, mapScrapedTxn, monthKey, type ScrapedTxn, type TxnRow } from './txns.js';

export interface ScrapedAccount {
  accountNumber: string;
  balance: number | null;
  balanceDate: string | null;
}

export type ScrapeOutcome =
  | { success: true; txns: TxnRow[]; accounts: ScrapedAccount[] }
  | { success: false; errorType: string; errorMessage?: string };

export interface ScrapeTarget {
  connectionId: number;
  company: string;
}

export interface BankScraper {
  scrape(target: ScrapeTarget, credentials: Record<string, string>, startDate: Date): Promise<ScrapeOutcome>;
  /** Cancels currently running browser work but keeps the scraper reusable. */
  cancel?(): Promise<void>;
  /** Permanently releases browser resources during application shutdown. */
  dispose?(): Promise<void>;
}

export interface RealScraperOptions {
  browserExecutablePath?: string;
  timeoutMs?: number;
  /** Where a failed scrape leaves its evidence. One file per connection, overwritten every run and
   *  deleted the moment that connection succeeds — the folder holds current problems, never a
   *  museum of old ones. Omit it and no screenshot is ever taken. */
  failureScreenshotDir?: string;
}

/** How many times the library may re-drive a navigation that did not land. Its own default is 0:
 *  one flaky redirect ends the whole sync with nothing to show for it. Two is enough to absorb a
 *  hiccup and small enough that a genuinely dead page still fails inside the timeout. */
const NAVIGATION_RETRIES = 2;

class ScrapeTimeoutError extends Error {}

interface ScreenshotablePage {
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
}

interface ManagedBrowser {
  readonly connected: boolean;
  close(): Promise<void>;
  once(event: 'disconnected', listener: () => void): unknown;
  pages(): Promise<ScreenshotablePage[]>;
}

/** Real scraper for any supported company via israeli-bank-scrapers (headless browser). */
export class RealScraper implements BankScraper {
  private readonly browsers = new Set<ManagedBrowser>();
  private readonly browserExecutablePath?: string;
  private readonly failureScreenshotDir?: string;
  private readonly timeoutMs: number;
  private disposed = false;

  constructor(options: RealScraperOptions = {}) {
    this.browserExecutablePath = options.browserExecutablePath;
    this.failureScreenshotDir = options.failureScreenshotDir;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  }

  async scrape(target: ScrapeTarget, credentials: Record<string, string>, startDate: Date): Promise<ScrapeOutcome> {
    if (this.disposed) {
      return { success: false, errorType: 'CANCELLED', errorMessage: 'scraper has been disposed' };
    }
    let browserForRun: ManagedBrowser | null = null;
    const failureShot = this.failurePath(target);
    const scraper = createScraper({
      companyId: target.company as CompanyTypes,
      startDate,
      combineInstallments: false,
      showBrowser: false,
      executablePath: this.browserExecutablePath,
      navigationRetryCount: NAVIGATION_RETRIES,
      ...(failureShot ? { storeFailureScreenShotPath: failureShot } : {}),
      prepareBrowser: async (browser) => {
        browserForRun = browser;
        this.browsers.add(browser);
        browser.once('disconnected', () => this.browsers.delete(browser));
        if (this.disposed) await browser.close();
      },
    });
    // the library types credentials per-company; our validated Record<string,string> carries exactly those fields
    const scrapePromise = scraper.scrape(credentials as never);
    let timer: NodeJS.Timeout | undefined;
    let result: Awaited<typeof scrapePromise>;
    try {
      result = await Promise.race([
        scrapePromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ScrapeTimeoutError('bank scrape timed out')), this.timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      if (err instanceof ScrapeTimeoutError) {
        // The library only photographs failures inside its OWN error path, and killing the browser
        // here means that path is never reached — so the one failure we most need to see (a login
        // page that changed under the scraper, which hangs rather than errors) would leave nothing
        // behind at all. Take the picture ourselves, while there is still something to photograph.
        if (browserForRun) {
          await this.captureFailure(browserForRun, failureShot);
          await this.closeBrowser(browserForRun);
        }
        return { success: false, errorType: 'TIMEOUT', errorMessage: err.message };
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (browserForRun) this.browsers.delete(browserForRun);
    }

    if (!result.success) {
      return {
        success: false,
        errorType: result.errorType ?? 'GENERIC',
        errorMessage: result.errorMessage,
      };
    }
    // A connection that works again must stop looking broken: stale evidence from a fixed problem
    // is read as a current one.
    this.clearFailure(failureShot);
    const accounts = result.accounts ?? [];
    const chargeMonth = companyKind(target.company) === 'card';
    return {
      success: true,
      txns: accounts.flatMap((a) =>
        a.txns.map((t) =>
          mapScrapedTxn(target.company, target.connectionId, a.accountNumber, t as unknown as ScrapedTxn, { chargeMonth }),
        ),
      ),
      accounts: accounts.map((a) => {
        const acc = a as { accountNumber: string; balance?: number; balanceDate?: string };
        return {
          accountNumber: acc.accountNumber,
          balance: typeof acc.balance === 'number' ? acc.balance : null,
          balanceDate: acc.balanceDate ?? null,
        };
      }),
    };
  }

  async cancel(): Promise<void> {
    await Promise.allSettled([...this.browsers].map((browser) => this.closeBrowser(browser)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.cancel();
  }

  private async closeBrowser(browser: ManagedBrowser): Promise<void> {
    this.browsers.delete(browser);
    try {
      if (browser.connected) await browser.close();
    } catch {
      // Closing is best-effort: Chromium may already have exited or been killed by Windows.
    }
  }

  /** One file per connection, so a second failure replaces the first instead of piling up. The id
   *  is ours and the company is a library enum key, but this string becomes a filesystem path —
   *  it is sanitised because paths built from data are sanitised, not because this one is suspect. */
  private failurePath(target: ScrapeTarget): string | undefined {
    if (!this.failureScreenshotDir) return undefined;
    try {
      fs.mkdirSync(this.failureScreenshotDir, { recursive: true });
    } catch {
      return undefined; // no evidence is better than a crashed sync
    }
    const safeCompany = target.company.replace(/[^A-Za-z0-9]/g, '') || 'unknown';
    return path.join(this.failureScreenshotDir, `${safeCompany}-${target.connectionId}.png`);
  }

  private async captureFailure(browser: ManagedBrowser, file: string | undefined): Promise<void> {
    if (!file) return;
    try {
      const pages = await browser.pages();
      // the scrape drives the last-opened page; the first is Chromium's own blank tab
      const page = pages[pages.length - 1];
      if (page) await page.screenshot({ path: file, fullPage: true });
    } catch {
      // Evidence is best-effort: a browser already gone cannot be photographed.
    }
  }

  private clearFailure(file: string | undefined): void {
    if (!file) return;
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Housekeeping never fails a successful sync.
    }
  }
}

/** The mock settlement debited from the bank account each month; the mock card's
 *  purchases for the same month sum to exactly this amount. */
export function mockSettlementAmount(monthIndex: number): number {
  return 3500 + ((monthIndex * 53) % 250);
}

/**
 * A fuller household — `MOCK_PROFILE=showcase`.
 *
 * The default dataset below is deliberately thin, and it must stay that way: tests pin its exact
 * figures. But a thin household shows a thin app — one salary, four charges, no subscriptions, no
 * instalments, nothing for the patterns map or the year staircases to rank. This dataset exists so
 * the product can be SEEN, in screenshots and while building: two earners, a mortgage, real
 * subscriptions, an instalment plan mid-way through, and a standing transfer to savings.
 *
 * Nothing here is read by a test. It is sample data and the site says so.
 */
const SHOWCASE_BANK: { day: string; amount: number; desc: string; jitter?: number }[] = [
  { day: '09', amount: 18400, desc: 'משכורת' },
  { day: '10', amount: 9300, desc: 'משכורת חברה בע"מ' },
  { day: '02', amount: -6250, desc: 'משכנתא' },
  { day: '03', amount: -1180, desc: 'ארנונה' },
  { day: '04', amount: -1650, desc: 'גן ילדים' },
  { day: '05', amount: -420, desc: 'חשמל', jitter: 180 },
  { day: '05', amount: -190, desc: 'תאגיד המים', jitter: 60 },
  { day: '06', amount: -259, desc: 'סלקום' },
  { day: '07', amount: -1850, desc: 'שופרסל', jitter: 420 },
  { day: '08', amount: -740, desc: 'ביטוח בריאות' },
  // 'חיסכון' in the description is what the savings vocabulary keys on — this leaves the
  // expenses entirely, which is the behaviour the site describes
  { day: '16', amount: -2000, desc: 'העברה לתוכנית חיסכון' },
];

/** The purchases behind the card settlement. They sum to it exactly, so the dedup nets to zero.
 *  A subscription's amount is FIXED — that is what makes it a subscription, and the patterns
 *  engine is entitled to see the difference between Netflix and a restaurant. */
const SHOWCASE_CARD: { day: string; amount: number; desc: string; issuer: string; jitter?: number }[] = [
  { day: '02', amount: 1850, desc: 'מסעדות שף', issuer: 'מסעדות', jitter: 620 },
  { day: '04', amount: 1400, desc: 'פז יילו', issuer: 'דלק ותחבורה', jitter: 380 },
  { day: '06', amount: 1250, desc: 'רמי לוי', issuer: 'סופרמרקטים', jitter: 460 },
  { day: '11', amount: 1100, desc: 'קניות אונליין', issuer: 'אופנה', jitter: 740 },
  { day: '13', amount: 780, desc: 'קסטרו', issuer: 'אופנה', jitter: 520 },
  { day: '15', amount: 430, desc: 'סופר פארם', issuer: 'בריאות', jitter: 240 },
  { day: '19', amount: 620, desc: 'הום סנטר', issuer: 'לבית', jitter: 900 },
  { day: '21', amount: 340, desc: 'סינמה סיטי', issuer: 'פנאי', jitter: 210 },
  { day: '22', amount: 249, desc: 'הולמס פלייס', issuer: 'ספורט' },
  { day: '24', amount: 55, desc: 'NETFLIX.COM', issuer: 'מנויים' },
  { day: '24', amount: 22, desc: 'SPOTIFY', issuer: 'מנויים' },
  { day: '26', amount: 104, desc: 'YES', issuer: 'מנויים' },
];
const SHOWCASE_INSTALMENT = 480;

/** Two coprime multipliers per row index keep each line's drift out of phase with its neighbours —
 *  one shared seed makes every category rise and fall together, which no household ever does. */
const showcaseDrift = (monthIndex: number, row: number, span: number | undefined) =>
  span ? ((monthIndex * (37 + row * 11) + row * 53) % span) - Math.round(span / 2) : 0;

/** This month's card rows and the settlement that pays for them — always equal, by construction. */
function showcaseCycle(monthIndex: number) {
  const rows = SHOWCASE_CARD.map((r, k) => ({
    ...r, amount: Math.max(20, r.amount + showcaseDrift(monthIndex, k, r.jitter)),
  }));
  return { rows, settlement: rows.reduce((s, r) => s + r.amount, 0) + SHOWCASE_INSTALMENT };
}

/** Deterministic fake data for development and tests (MOCK_BANK=1). Never touches any bank.
 *  Bank connections get salary/rent/bills + a monthly 'ישראכרט' settlement debit;
 *  card connections get the detailed purchases behind that settlement. */
export class MockScraper implements BankScraper {
  async scrape(target: ScrapeTarget, _credentials: Record<string, string>, startDate: Date): Promise<ScrapeOutcome> {
    const kind = companyKind(target.company);
    const txns: TxnRow[] = [];
    const now = new Date();
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const account = `mock-${target.company}`;

    const push = (
      y: number,
      m: string,
      day: string,
      amount: number,
      description: string,
      status: 'completed' | 'pending' = 'completed',
      extras: Partial<TxnRow> = {},
    ) => {
      // 10:00 UTC is midday in Israel — safely inside the same local day
      const date = `${y}-${m}-${day}T10:00:00.000Z`;
      txns.push({
        key: makeTxnKey(account, date, amount, description, null),
        account,
        date,
        month: monthKey(date),
        processedDate: status === 'completed' ? date : null,
        amount,
        originalAmount: amount,
        currency: 'ILS',
        description,
        memo: null,
        status,
        company: target.company,
        connectionId: target.connectionId,
        type: 'normal',
        installmentNumber: null,
        installmentTotal: null,
        chargedCurrency: 'ILS',
        issuerCategory: null,
        category: null,
        categorySource: null,
        ...extras,
      });
    };

    const showcase = process.env.MOCK_PROFILE === 'showcase';

    // like the real scrapers, the card also delivers its NEXT billing cycle in advance
    const end = kind === 'card' ? new Date(now.getFullYear(), now.getMonth() + 1, 1) : now;
    while (cursor <= end) {
      const y = cursor.getFullYear();
      const m = String(cursor.getMonth() + 1).padStart(2, '0');
      // index by absolute calendar month so a month's data is identical
      // no matter which window it was scraped in (like real bank data)
      const i = y * 12 + cursor.getMonth();
      const settlement = showcase ? showcaseCycle(i).settlement : mockSettlementAmount(i);
      if (showcase) {
        if (kind === 'bank') {
          for (const [k, r] of SHOWCASE_BANK.entries()) {
            const drift = showcaseDrift(i, k, r.jitter);
            push(y, m, r.day, r.amount > 0 ? r.amount + drift : r.amount - drift, r.desc);
          }
          push(y, m, '11', -settlement, 'ישראכרט בעמ');
        } else {
          const debit = { month: `${y}-${m}`, processedDate: `${y}-${m}-11T10:00:00.000Z` };
          for (const r of showcaseCycle(i).rows) {
            push(y, m, r.day, -r.amount, r.desc, 'completed', { issuerCategory: r.issuer, ...debit });
          }
          // a plan mid-way through, so the instalment track has something to draw
          const n = ((i % 6) + 1);
          push(y, m, '18', -SHOWCASE_INSTALMENT, `מחסני חשמל תשלום ${n} מתוך 6`, 'completed', {
            type: 'installments', installmentNumber: n, installmentTotal: 6, issuerCategory: 'חשמל ואלקטרוניקה', ...debit,
          });
        }
        cursor.setMonth(cursor.getMonth() + 1);
        continue;
      }
      if (kind === 'bank') {
        push(y, m, '01', 12400, 'משכורת');
        push(y, m, '03', -4300, 'שכר דירה');
        push(y, m, '07', -(1450 + ((i * 137) % 400)), 'סופרמרקט');
        push(y, m, '10', -settlement, 'ישראכרט בעמ');
        push(y, m, '12', -(320 + ((i * 61) % 150)), 'חשבון חשמל');
        push(y, m, '14', -350, 'העברה ב BIT');
        push(y, m, '15', 350, 'העברה ב BIT');
      } else {
        // every row of a cycle debits on the SAME day — the 10th — exactly like real card data
        const debit = { month: `${y}-${m}`, processedDate: `${y}-${m}-10T10:00:00.000Z` };
        const a = Math.round(settlement * 0.5 * 100) / 100;
        const b = Math.round(settlement * 0.3 * 100) / 100;
        const inst = 180;
        const c = Math.round((settlement - a - b - inst) * 100) / 100;
        push(y, m, '02', -a, 'מסעדות', 'completed', { issuerCategory: 'מסעדות', ...debit });
        push(y, m, '09', -b, 'דלק', 'completed', { issuerCategory: 'דלק ותחבורה', ...debit });
        // purchased near the end of the previous month, charged in this month's cycle —
        // month follows the CHARGE date so it cancels this month's settlement
        const prev = new Date(y, cursor.getMonth() - 1, 25);
        const py = prev.getFullYear();
        const pm = String(prev.getMonth() + 1).padStart(2, '0');
        push(py, pm, '25', -c, 'קניות אונליין', 'completed', { issuerCategory: 'אופנה', ...debit });
        push(y, m, '18', -inst, 'רהיטי הארץ תשלום 2 מתוך 6', 'completed', {
          type: 'installments',
          installmentNumber: 2,
          installmentTotal: 6,
          ...debit,
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    if (kind === 'bank') {
      const cy = now.getFullYear();
      const cm = String(now.getMonth() + 1).padStart(2, '0');
      push(cy, cm, '25', showcase ? -640 : -200, showcase ? 'ארומה' : 'עסקה ממתינה', 'pending');
    }

    const nowIndex = now.getFullYear() * 12 + now.getMonth();
    return {
      success: true,
      txns,
      accounts: [
        {
          accountNumber: account,
          balance: kind === 'bank'
            ? (showcase ? 41800 : 24000) + ((nowIndex * 137) % 2000)
            // only Cal reports a next-debit balance; Max/Isracard/Amex structurally do not (A1),
            // so the mock must give tests both paths — a figure, and אין נתון.
            : target.company === 'visaCal' ? -mockSettlementAmount(nowIndex) : null,
          // date-only so repeated scrapes stay deterministic (mock invariant)
          balanceDate: now.toISOString().slice(0, 10),
        },
      ],
    };
  }
}

export function createBankScraper(options: RealScraperOptions = {}): BankScraper {
  return process.env.MOCK_BANK === '1' ? new MockScraper() : new RealScraper(options);
}
