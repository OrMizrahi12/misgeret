/**
 * Documentation screenshots captured from the real app against synthetic mock-bank data.
 *
 * Usage — the development server must already be running with MOCK_BANK=1 and PORT=3001:
 *
 *     node scripts/capture_site_shots.mjs                 # every surface
 *     node scripts/capture_site_shots.mjs month year      # only these
 *
 * Capture contract:
 *   • `prefers-reduced-motion: reduce` is forced. Without it, reveal animations and count-ups land
 *     mid-flight and every re-capture differs.
 *   • deviceScaleFactor 2 — the site renders these at ~1100px wide on a HiDPI display.
 *   • Each tab gets a settle delay: the app fetches per tab, and charts measure on a layout pass
 *     after that. Screenshotting on `networkidle` alone catches empty cards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'assets', 'screenshots');
const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173';
const WIDTH = 1440;
const HEIGHT = 900;

/** One entry per current app surface. `settle` is extra ms for tabs that compute a lot. */
const SURFACES = [
  { name: 'home', hash: '#/home', settle: 900 },
  { name: 'month', hash: '#/month', settle: 1500 },
  { name: 'plan', hash: '#/plan', settle: 1200 },
  { name: 'year', hash: '#/year', settle: 1400 },
  { name: 'overview', hash: '#/overview', settle: 1400 },
  { name: 'patterns', hash: '#/patterns', settle: 1400 },
  { name: 'future', hash: '#/future', settle: 1600 },
  { name: 'health', hash: '#/health', settle: 1400 },
  { name: 'networth', hash: '#/networth', settle: 1400 },
  { name: 'connections', hash: '#/connections', settle: 1000 },
  { name: 'settings', hash: '#/settings', settle: 1200 },
  { name: 'profiles', hash: '#/profiles', settle: 1000 },
  { name: 'review', hash: '#/review', settle: 1000 },
];

const only = process.argv.slice(2);
const wanted = only.length ? SURFACES.filter((s) => only.includes(s.name)) : SURFACES;
if (wanted.length === 0) {
  console.error(`No surface matched ${only.join(', ')}. Known: ${SURFACES.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('misgeret-theme', 'light');
    localStorage.setItem('misgeret-sidebar-rail', '0');
  });

  // One load, then hash navigation: the app is a SPA and a full reload per tab costs a boot each.
  await page.goto(`${BASE}/${SURFACES[0].hash}`, { waitUntil: 'networkidle0', timeout: 60_000 });
  await page.waitForSelector('.shell', { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '* { cursor: none !important; }' });

  for (const s of wanted) {
    await page.evaluate((h) => { window.location.hash = h; }, s.hash);
    await page.waitForSelector(`.view-${s.name}`, { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, s.settle));
    // charts re-measure on a resize pass; a non-painting headless page can starve ResizeObserver
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.dispatchEvent(new Event('resize'));
    });
    await new Promise((r) => setTimeout(r, 450));
    await page.screenshot({ path: path.join(outDir, `${s.name}.png`), type: 'png' });
    console.log(`shot: ${s.name}.png`);
  }
} finally {
  await browser.close();
}
