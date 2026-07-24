/**
 * P14 golden journey 1 (minus the Excel download): HESP dirty CSV + 14-file
 * schema + 3 rules files → Run QC → progress stages → annotated grid with
 * popovers → Summary counts sane against seeded-violations.json (≥ semantics
 * — later phases refine the manifest into exact QCFlag expectations) →
 * severity toggles → panels → re-run idempotence → dataset re-upload resets.
 * Plus: cooperative cancel mid-run on a 20×-replicated dataset.
 *
 * Every expectation that crosses an ingest or a run carries generous
 * timeouts: DuckDB-WASM boots per page and the schema worker walks 266
 * columns × 171 conditionals per row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const DATA = join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv');
const SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
const SCHEMA_FILES = [
  'common/defs.json',
  'core/core.schema.json',
  'core/categories/assets.json',
  'core/categories/debts_credit.json',
  'core/categories/derived_measures.json',
  'core/categories/employment.json',
  'core/categories/financial_services.json',
  'core/categories/hardship_shocks.json',
  'core/categories/household_composition.json',
  'core/categories/housing.json',
  'core/categories/identification.json',
  'core/categories/income.json',
  'core/categories/panel_status.json',
  'core/categories/social_programs.json',
].map((p) => join(SCHEMA_DIR, p));
const RULE_FILES = [
  'hesp_keys_and_structure.quac.csv',
  'hesp_consistency.quac.csv',
  'hesp_corrections.quac.csv',
].map((name) => join(FIXTURES, 'hesp', 'rules', name));

const SEEDED = JSON.parse(
  readFileSync(join(FIXTURES, 'hesp', 'data', 'seeded-violations.json'), 'utf8'),
) as { dirtyRows: number; columns: number; injections: { expectedRuleIds: string[] }[] };

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');
const datasetBadge = (page: Page): Locator => page.locator('[data-slot="data"] .q-badge');
const rulesInput = (page: Page): Locator =>
  page.locator('[data-slot="rules"] input[type="file"]');
const rulesBadge = (page: Page): Locator =>
  page.locator('[data-slot="rules"] .q-slotcard-header .q-badge');
const runButton = (page: Page): Locator => page.locator('.q-runbar-button');

const statValue = async (page: Page, label: string): Promise<number> => {
  const text = await page
    .locator('.q-statcard', { hasText: label })
    .locator('.q-statcard-value')
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
};

const panelTab = (page: Page, name: string): Locator =>
  page.locator('.q-paneltab', { hasText: name });

async function loadAllThreeSlots(page: Page): Promise<void> {
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Browse schema files').setInputFiles(SCHEMA_FILES);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await rulesInput(page).setInputFiles(RULE_FILES);
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
}

async function waitForRunDone(page: Page): Promise<void> {
  // The progress overlay hides and the Summary stat cards land.
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

test('full run: progress → annotated grid + popover → counts → panels → re-run → reset', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadAllThreeSlots(page);

  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();

  // Navigates to the report; the duck progress runs through the stages.
  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.locator('.q-run-progress')).toBeVisible({ timeout: 30_000 });
  await waitForRunDone(page);

  // ---- Summary counts vs the seeded manifest (≥ semantics) ----
  expect(await statValue(page, 'Rows')).toBe(SEEDED.dirtyRows);
  expect(await statValue(page, 'Columns')).toBe(SEEDED.columns);
  expect(await statValue(page, 'Errors')).toBeGreaterThanOrEqual(10);
  expect(await statValue(page, 'Corrections applied')).toBeGreaterThanOrEqual(3);
  expect(await statValue(page, 'Rules run')).toBeGreaterThanOrEqual(10);
  expect(await statValue(page, 'Rules skipped')).toBeGreaterThanOrEqual(1); // Q044 external
  const errorsRun1 = await statValue(page, 'Errors');
  const correctionsRun1 = await statValue(page, 'Corrections applied');

  // The report-tab pill lights up.
  await expect(page.locator('.q-tab', { hasText: 'QC Report' }).locator('.q-pill')).toBeVisible();

  // ---- Annotated cells + popover "{ruleId}: …" ----
  const annotated = page.locator('.dt-cell--annotated');
  await expect(annotated.first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500); // let the virtual scroller settle post-paint
  await annotated.first().scrollIntoViewIfNeeded();
  await annotated.first().hover();
  const popover = page.locator('.dt-annotation-popover'); // role="tooltip" portal
  await expect(popover.first()).toBeVisible({ timeout: 10_000 });
  await expect(popover.first()).toContainText(/[\w:.-]+: .+/);
  await page.keyboard.press('Escape'); // popover dismisses on Esc

  // ---- Severity toggle drives the annotation filter ----
  const errorCells = page.locator('.dt-cell--annotation-error');
  await expect(errorCells.first()).toBeVisible({ timeout: 20_000 });
  const errorToggle = page
    .locator('.q-sevfilter label', { hasText: 'errors' })
    .locator('input[type="checkbox"]');
  await errorToggle.uncheck();
  await expect(errorCells).toHaveCount(0, { timeout: 20_000 });
  await errorToggle.check();
  await expect(errorCells.first()).toBeVisible({ timeout: 20_000 });

  // ---- Panels ----
  await panelTab(page, 'Missing vars').click();
  await expect(page.getByText('All schema variables are present in the dataset.')).toBeVisible();

  await panelTab(page, 'Findings').click();
  await expect(page.getByText('identical records', { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Column 'notes'", { exact: false }).first()).toBeVisible();
  await expect(page.getByText('external reference data', { exact: false }).first()).toBeVisible();

  await panelTab(page, 'Offenders').click();
  const offenders = page.locator('.q-offenders tbody tr');
  await expect(offenders.first()).toBeVisible();
  await expect(page.locator('.q-offenders td', { hasText: 'Q003' }).first()).toBeVisible();
  await expect(page.locator('.q-offenders td', { hasText: 'H004' }).first()).toBeVisible();

  // ---- Re-run: corrections idempotent, counts identical ----
  await panelTab(page, 'Summary').click();
  await page.locator('.q-btn', { hasText: 'Re-run QC' }).click();
  await expect(page.locator('.q-run-progress')).toBeVisible({ timeout: 30_000 });
  await waitForRunDone(page);
  expect(await statValue(page, 'Errors')).toBe(errorsRun1);
  expect(await statValue(page, 'Corrections applied')).toBe(correctionsRun1);

  // ---- Dataset re-upload resets run state ----
  await page.locator('.q-tab', { hasText: 'Load' }).click();
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(
    page.locator('.q-tab', { hasText: 'QC Report' }).locator('.q-pill'),
  ).toBeHidden();
  await page.locator('.q-tab', { hasText: 'QC Report' }).click();
  await expect(page.getByText('No findings yet.')).toBeVisible();
  await expect(page.locator('.q-tab', { hasText: 'Load' })).toBeVisible();
});

test('cancel mid-run leaves a sane partial state', async ({ page }) => {
  await page.goto('/quac/');

  // 20× the dirty rows (~2k rows × 266 cols) makes the schema stage span many
  // seconds — a deterministic cancel window once its progress label shows.
  // Replicated via the JSON ingest path: the CSV path's wrapped-JSON CTAS
  // (json_extract_string × 266 per row) OOMs duckdb-wasm at this scale.
  const rows = JSON.parse(
    readFileSync(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.json'), 'utf8'),
  ) as unknown[];
  const big = JSON.stringify(Array.from({ length: 20 }, () => rows).flat());
  await datasetInput(page).setInputFiles({
    name: 'hesp_big.json',
    mimeType: 'application/json',
    buffer: Buffer.from(big),
  });
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Browse schema files').setInputFiles(SCHEMA_FILES);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  await runButton(page).click();
  await expect(page.getByText('Validating against the schema')).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await page.locator('.q-run-cancel').click();

  await expect(page.getByText('Run cancelled — showing partial results.')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.q-partial-banner')).toBeVisible({ timeout: 60_000 });
  // The grid still presents the partial state.
  await expect(page.locator('.q-report-grid')).toBeVisible({ timeout: 60_000 });
  // And a fresh run can start again afterwards.
  await expect(page.locator('.q-btn', { hasText: 'Re-run QC' })).toBeEnabled();
});
