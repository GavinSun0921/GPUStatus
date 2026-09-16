#!/usr/bin/env node
/**
 * Screenshot the dashboard, so the UI can actually be LOOKED at.
 *
 * Rendering to HTML (see web/src/ssr-check.tsx) proves the components do not
 * throw, and comparing API keys proves the data lines up -- neither shows what
 * the page looks like. Several real defects were invisible to both and only
 * showed up in a screenshot: an allocation ratio painted with the utilisation
 * alarm ramp (every busy machine showed a full RED bar), utilisation painted red
 * so a healthy cluster looked like it was on fire, and a host that had never
 * been polled reporting "0 / 0 占用" plus a "显卡 0/8" mismatch badge for a
 * machine whose card count was simply unknown.
 *
 * Usage
 *   node tools/screenshot.mjs                       # dark, full page
 *   node tools/screenshot.mjs --theme light         # light theme
 *   node tools/screenshot.mjs --viewport            # visible area only
 *   node tools/screenshot.mjs --selector ".summary" # one element, zoomed
 *   node tools/screenshot.mjs --tabs                # one shot per tab
 *   node tools/screenshot.mjs --expand              # open every 详情 panel first
 *   node tools/screenshot.mjs --url http://host:8787/
 *
 * Requires `playwright-core` (a 5 MB driver, no browser download) and a Chromium
 * build. Playwright caches browsers under ~/.cache/ms-playwright; if one is
 * already there, this script finds it and uses it:
 *
 *   npm install --no-save playwright-core
 *   node tools/screenshot.mjs
 *
 * It deliberately does NOT point at the full `chrome` binary: driving an older
 * cached Chromium with a newer driver makes Chrome's crashpad handler fail with
 * "--database is required". The `chrome-headless-shell` build has no crashpad
 * and works across versions.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const URL = value('--url', 'http://127.0.0.1:8787/');
const theme = value('--theme', 'dark');
const out = value('--out', `/tmp/gpustatus-${theme}.png`);
const selector = value('--selector', null);
const width = Number(value('--width', '1440'));
const height = Number(value('--height', '1000'));
const fullPage = !has('--viewport');
const allTabs = has('--tabs');

/** Find a usable headless-shell build in the Playwright browser cache. */
function findChromium() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;

  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) {
    throw new Error(
      `No Playwright browser cache at ${cache}.\n` +
        'Install one with:  npx playwright install chromium\n' +
        'or point CHROME_BIN at an existing chrome-headless-shell.',
    );
  }

  // Highest build number wins.
  const candidates = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const dir of candidates) {
    const bin = join(cache, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  throw new Error(`No chrome-headless-shell found under ${cache}`);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error(
    'playwright-core is not installed. Run:\n\n  npm install --no-save playwright-core\n',
  );
  process.exit(1);
}

const executablePath = findChromium();
const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
});
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2, // so small text survives being looked at
  colorScheme: theme === 'dark' ? 'dark' : 'light',
});
// The theme is applied from localStorage before first paint; seed it so the
// screenshot shows the requested theme rather than the system default.
await context.addInitScript(
  ([t]) => {
    try {
      localStorage.setItem('gpustatus:theme', t);
    } catch {
      /* storage disabled */
    }
  },
  [theme],
);

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
// The live stream keeps a connection open forever, so networkidle never fires.
// Waiting for a rendered row is the reliable signal that data has arrived.
await page.waitForSelector('.gpu-row', { timeout: 30_000 }).catch(() => {
  console.error('warning: no .gpu-row appeared; capturing whatever rendered');
});
await page.waitForTimeout(1200); // let fonts and bar transitions settle

if (selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`selector not found: ${selector}`);
  await el.screenshot({ path: out });
} else if (allTabs) {
  for (const label of ['总览', '用户', '用量', '事件', '管理']) {
    await page.getByRole('tab', { name: label }).click();
    await page.waitForTimeout(900);
    const file = `/tmp/gpustatus-${theme}-${label}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log(file);
  }
} else {
  await page.screenshot({ path: out, fullPage });
}

// Open every machine's detail panel, so a screenshot (and the layout check
// below) covers the chart and the machine-information grid.
if (has('--expand')) {
  for (const button of await page.locator('.detail-toggle').all()) {
    await button.click().catch(() => {});
  }
  await page.waitForTimeout(1500);
}

const info = await page.evaluate(() => ({
  machines: document.querySelectorAll('[id^="host-"]').length,
  gpuRows: document.querySelectorAll('.gpu-row').length,
  theme: document.documentElement.dataset.theme,
  title: document.title,
  pageHeight: document.documentElement.scrollHeight,
  // SVG text that spills outside its chart. This is the one class of defect
  // neither the type system nor the jsdom render check can see: jsdom does no
  // layout, so every rectangle it reports is zero. Two real bugs have been
  // exactly this -- a "100%" y-axis label 5px past the left edge (its leading
  // "1" cut off) and a GPU model column wrapping to two lines -- and both were
  // found by eye rather than by a check. Non-empty means something is clipped.
  clippedText: [...document.querySelectorAll('.recharts-wrapper')].flatMap((wrap) => {
    const wb = wrap.getBoundingClientRect();
    return [...wrap.querySelectorAll('svg text')]
      .filter((t) => {
        const r = t.getBoundingClientRect();
        return (
          r.left < wb.left - 0.5 ||
          r.right > wb.right + 0.5 ||
          r.top < wb.top - 0.5 ||
          r.bottom > wb.bottom + 0.5
        );
      })
      .map((t) => t.textContent);
  }),
}));
if (!allTabs) {
  console.log(JSON.stringify({ out, ...info, consoleErrors: errors }, null, 1));
} else {
  console.log(JSON.stringify({ ...info, consoleErrors: errors }, null, 1));
}

await browser.close();
