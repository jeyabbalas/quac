/**
 * P22 task 1, browser leg — the error-injection sweep.
 *
 * One dataset slot, nine ways to break it, and the same three questions each
 * time:
 *
 *   1. **Is QuaC's own sentence on screen?** Not a badge alone, not a console
 *      line — a message a data steward can act on.
 *   2. **Is the app still there?** Header, tabs, and the drop zone still
 *      enabled, so the next file can go straight in. A failure that requires
 *      a reload is a failure twice.
 *   3. **Did any engine text escape?** `body` is scanned with the same marker
 *      list the unit tier uses, so DuckDB's binder, Thrift's exceptions, V8's
 *      stack vocabulary and QuaC's internal table names cannot reach a user
 *      through any surface — toast, slot card, panel or grid.
 *
 * Plus a `pageerror` collector asserted empty after every test: the phase
 * file's "never a blank screen or console-only failure" has two halves, and
 * this is the second one.
 *
 * Every input is synthesized in-test with `setInputFiles([{name, mimeType,
 * buffer}])`. Nothing lands in `tests/fixtures/`, so the byte-for-byte
 * `fixtures:check` gate is untouched by a spec whose whole subject is
 * malformed bytes.
 *
 * Oversize is deliberately absent — `ingest.spec.ts:170` already owns it. So
 * is the hung-fetch timeout: `hungFetch.spec.ts` owns the UX, and pinning the
 * 30 s timeout here would cost 30 s of e2e for copy the unit tier can assert.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { findEngineText } from '../unit/support/designedMessage';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 180_000 });

const datasetCard = (page: Page): Locator => page.locator('[data-slot="data"]');
const datasetBadge = (page: Page): Locator => datasetCard(page).locator('.q-badge');
const datasetSummary = (page: Page): Locator => datasetCard(page).locator('.q-slotcard-summary');
const fileInput = (page: Page): Locator => datasetCard(page).locator('input[type="file"]');

/** Uncaught page errors, collected per test and asserted empty in afterEach. */
let pageErrors: string[] = [];

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
});

test.afterEach(() => {
  expect(pageErrors, 'uncaught page errors — a console-only failure').toEqual([]);
});

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer): Promise<void> {
  await fileInput(page).setInputFiles([{ name, mimeType, buffer }]);
}

/** The whole rendered page, as a user would read it. */
async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText()).replaceAll(' ', ' ');
}

/** Question 3, for any state of the app. */
async function expectNoEngineText(page: Page): Promise<void> {
  const leaked = findEngineText(await bodyText(page));
  expect(leaked, 'raw engine text reached the page').toEqual([]);
}

/** Question 2 — the shell survived and the slot is ready for another file. */
async function expectShellUsable(page: Page): Promise<void> {
  await expect(page.locator('.q-header')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Load' })).toBeVisible();
  await expect(datasetCard(page).locator('.q-dropzone')).toBeEnabled();
}

/** The full triple, for the cases that must end in a refusal. */
async function expectDesignedRefusal(page: Page, contains: string): Promise<void> {
  await expect(datasetBadge(page)).toHaveText('Error', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText(contains);
  await expectShellUsable(page);
  await expectNoEngineText(page);
}

test('a corrupt workbook is refused as a workbook, not as a zip', async ({ page }) => {
  // A zip magic and nothing that follows it — sniffFormat routes on the magic,
  // so this reaches SheetJS as an xlsx and dies inside it.
  const bytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('not really a workbook'.repeat(8)),
  ]);
  await page.goto('/quac/');
  await upload(page, 'broken.xlsx', 'application/vnd.ms-excel', bytes);

  await expectDesignedRefusal(page, 'could not be read as an Excel workbook');
});

test('a JSON object at the root is refused with the shape QuaC wants', async ({ page }) => {
  await page.goto('/quac/');
  await upload(page, 'object.json', 'application/json', Buffer.from('{"person_id":"P001"}\n'));

  await expectDesignedRefusal(page, 'not a top-level array');
});

test('a JSON array of scalars is refused for the right reason', async ({ page }) => {
  await page.goto('/quac/');
  await upload(page, 'scalars.json', 'application/json', Buffer.from('[1, 2, 3]\n'));

  await expectDesignedRefusal(page, 'does not contain row objects');
});

test('a truncated JSON array survives the prefix check and still gets a sentence', async ({
  page,
}) => {
  // This is the interesting one: the prefix check passes (it opens `[{`), so
  // the failure happens inside DuckDB, which is where the raw text used to
  // come from.
  await page.goto('/quac/');
  await upload(
    page,
    'truncated.json',
    'application/json',
    Buffer.from('[{"person_id":"P001","age":36},{"person_id":"P002","age'),
  );

  await expectDesignedRefusal(
    page,
    'This JSON file could not be read — it looks truncated or malformed.',
  );
});

test('a truncated Parquet file does not toast "No magic bytes"', async ({ page }) => {
  const whole = readFileSync(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.parquet'));
  // Parquet keeps its footer at the END, so a prefix is always unreadable —
  // and the engine says so in words no data steward should have to meet.
  const head = whole.subarray(0, Math.floor(whole.length / 2));

  await page.goto('/quac/');
  await upload(page, 'truncated.parquet', 'application/octet-stream', head);

  await expectDesignedRefusal(
    page,
    'This Parquet file could not be read — it looks truncated or damaged.',
  );
});

test('binary garbage named .csv ends in a decision, never in limbo', async ({ page }) => {
  // Deliberately NOT asserting a refusal: a delimited parser is entitled to
  // find one junk column in junk bytes, and QuaC showing that honestly is a
  // legitimate outcome. What is not legitimate is a stuck badge, a dead
  // shell, or engine text — so those are what this pins.
  const bytes = Buffer.from(
    Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256).map((b) => (b === 10 ? 7 : b)),
  );
  await page.goto('/quac/');
  await upload(page, 'garbage.csv', 'text/csv', bytes);

  await expect(datasetBadge(page)).toHaveText(/Valid|Warning|Error/, { timeout: INGEST_TIMEOUT });
  await expectShellUsable(page);
  await expectNoEngineText(page);
});

test('an empty file is a decision too, and never a parser error', async ({ page }) => {
  await page.goto('/quac/');
  await upload(page, 'empty.csv', 'text/csv', Buffer.alloc(0));

  await expect(datasetBadge(page)).toHaveText(/Valid|Warning|Error/, { timeout: INGEST_TIMEOUT });
  await expectShellUsable(page);
  await expectNoEngineText(page);
});

test('a 404 names the status, not the exception', async ({ page }) => {
  await page.route('**/missing.csv', (route) => {
    void route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' });
  });

  await page.goto('/quac/');
  await page.getByLabel('Dataset URL').fill('http://localhost:4173/data/missing.csv');
  await datasetCard(page).getByRole('button', { name: 'Fetch' }).click();

  await expect(datasetBadge(page)).toHaveText('Error', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText('404');
  await expectShellUsable(page);
  await expectNoEngineText(page);
});

test('a blocked cross-origin fetch explains CORS instead of showing a TypeError', async ({
  page,
}) => {
  // `route.abort` reproduces exactly what a missing ACAO header produces in
  // the page: an opaque TypeError with no status to read.
  await page.route('**/blocked.csv', (route) => {
    void route.abort('failed');
  });

  await page.goto('/quac/');
  await page.getByLabel('Dataset URL').fill('https://elsewhere.example.org/blocked.csv');
  await datasetCard(page).getByRole('button', { name: 'Fetch' }).click();

  await expect(datasetBadge(page)).toHaveText('Error', { timeout: INGEST_TIMEOUT });
  // The slot keeps the one-liner; the way OUT of a CORS failure is advice, and
  // advice lives on the toast's hint line (`reportError` parks only
  // `userMessage` on the slot).
  await expect(datasetSummary(page)).toContainText("Couldn't fetch elsewhere.example.org");
  await expect(page.locator('.q-toast--error .q-toast-hint')).toContainText('CORS');
  await expect(page.locator('.q-toast--error .q-toast-hint')).toContainText('upload it here');
  await expectShellUsable(page);
  await expectNoEngineText(page);
});
