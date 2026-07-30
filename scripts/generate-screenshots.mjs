/**
 * Regenerate the README screenshots into `docs/images/` (P22 task 4).
 *
 *     npm run screenshots
 *
 * Committed rather than done by hand, for the same reason `generate-fixtures`
 * is: a screenshot is a claim about what the app looks like, and a claim
 * nobody can re-derive rots silently. This one builds `dist/`, serves it,
 * drives the BUNDLED HESP EXAMPLE through a real run, and captures three
 * frames — so every pixel is the current code doing the thing the README says
 * it does, on data anyone reading this can load with one click.
 *
 * The three frames are the three surfaces the README describes:
 *   1. `load.png`   — the three input slots filled and consistent
 *   2. `report.png` — the QC report: stat cards, panels, annotated grid
 *   3. `studio.png` — the Rule Studio editor with a real rule open
 *
 * **The settle wait is load-bearing and is not the badges.** `summarizeSlot`
 * reports `valid` both before and after the rules are re-linted against the
 * typed table, and in between 12 of the 22 example rules are lint-excluded
 * (V23). A shot taken in that window shows a truthful-looking screen with the
 * wrong numbers on it. `RULES_SETTLED` below is the only text that separates
 * the two states — the same gate `tests/e2e/support/exampleSession.ts` uses,
 * duplicated here because `scripts/` may not import from `tests/`.
 *
 * Animations are disabled at the context level, so nothing is captured
 * mid-transition.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'images');

/** Fixed by `preview.strictPort` in vite.config.ts. */
const BASE_URL = 'http://localhost:4173/quac/';

/** The example bundle's settled rules summary — reachable only post-rebuild. */
const RULES_SETTLED = '3 files · 22 rules';

/** DuckDB init, a 14-file schema set, three rules files, then a 100-row run. */
const SETTLE_TIMEOUT = 120_000;

/**
 * A desktop the README's readers actually have, at 2× so the PNGs stay legible
 * when GitHub scales them into the page.
 *
 * Every shot is a VIEWPORT shot, never `fullPage`. The run bar and the footer
 * are `position: sticky`, and a full-page capture stitches them into the
 * middle of the image, over the data grid — a picture of a layout bug the app
 * does not have. The Load view gets a taller viewport instead, which is the
 * honest way to fit more of it in: it is what a taller window shows.
 */
const VIEWPORT = { width: 1440, height: 900 };
const LOAD_VIEWPORT = { width: 1440, height: 1080 };
const SCALE = 2;

/** @param {string} message */
function log(message) {
  console.log(`generate-screenshots: ${message}`);
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {Promise<void>}
 */
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}`));
    });
  });
}

/**
 * Start `vite preview` and resolve once it answers, with a kill handle.
 * @returns {Promise<() => void>}
 */
async function startPreview() {
  const child = spawn('npm', ['run', 'preview'], { cwd: ROOT, stdio: 'ignore' });
  const stop = () => {
    child.kill('SIGTERM');
  };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok) return stop;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  stop();
  throw new Error(`vite preview did not answer ${BASE_URL} within 60 s`);
}

/**
 * Poll one element's text until it equals `expected`. Equality, not
 * containment — see the module docstring.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {string} expected
 * @returns {Promise<void>}
 */
async function waitForText(page, selector, expected) {
  const deadline = Date.now() + SETTLE_TIMEOUT;
  let seen = '(nothing)';
  while (Date.now() < deadline) {
    const text = await page.locator(selector).first().textContent();
    if (text !== null) {
      seen = text.trim();
      if (seen === expected) return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `timed out waiting for ${selector} to read ${JSON.stringify(expected)}; last saw ${JSON.stringify(seen)}`,
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} name
 * @returns {Promise<void>}
 */
async function shoot(page, name) {
  const path = join(OUT_DIR, name);
  await page.screenshot({ path });
  log(`wrote docs/images/${name}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Always rebuild. A screenshot of a stale `dist/` is worse than no
  // screenshot: it looks current and cannot be told apart from one.
  log('building dist/ …');
  await run('npm', ['run', 'build']);
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('build produced no dist/index.html');
  }

  log('starting preview …');
  const stopPreview = await startPreview();

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: LOAD_VIEWPORT,
      deviceScaleFactor: SCALE,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();

    // ---- 1. Load: the three slots, filled from the bundled example --------
    await page.goto(BASE_URL);
    await page.locator('.q-example-load').click();
    await waitForText(page, '[data-slot="data"] .q-badge', 'Valid');
    await waitForText(page, '[data-slot="schema"] .q-slotcard-header .q-badge', 'Valid');
    await waitForText(page, '[data-slot="rules"] .q-slotcard-header .q-badge', 'Valid');
    // The gate: everything above is also true of the pre-rebuild state.
    await waitForText(page, '[data-slot="rules"] .q-slotcard-summary', RULES_SETTLED);
    await waitForText(page, '.q-preview-pertinence .q-badge', 'OK');
    await page.waitForTimeout(400);
    await shoot(page, 'load.png');
    await page.setViewportSize(VIEWPORT);

    // ---- 2. Report: a real run over the 100-row dirty HESP fixture --------
    log('running QC …');
    await page.locator('.q-runbar-button').click();
    await page
      .locator('.q-statcard')
      .first()
      .waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await page.locator('.q-run-progress').waitFor({ state: 'hidden', timeout: SETTLE_TIMEOUT });
    await page
      .locator('.q-report-grid .dt-cell')
      .first()
      .waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await page.waitForTimeout(600);
    await shoot(page, 'report.png');

    // ---- 3. Rule Studio: one real rule open in the editor ----------------
    log('opening Rule Studio …');
    await page.getByRole('link', { name: 'Rule Studio' }).click();
    await page.locator('.q-filebtn').first().waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await page.locator('.q-filebtn').first().click();
    // Opening the FILE lists its rules; opening a RULE is what mounts the
    // editor, and the editor is what this frame is for.
    const firstRule = page.locator('.q-rulegrid tbody tr').first();
    await firstRule.waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await firstRule.click();
    await page.locator('.q-studio-drawer').waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await page.locator('.cm-editor').first().waitFor({ state: 'visible', timeout: SETTLE_TIMEOUT });
    await page.waitForTimeout(800);
    await shoot(page, 'studio.png');

    await context.close();
  } finally {
    await browser.close();
    stopPreview();
  }
  log('OK — 3 images in docs/images/');
}

try {
  await main();
} catch (error) {
  console.error(
    `generate-screenshots: FAIL — ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
