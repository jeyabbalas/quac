/**
 * Running a JSON Schema against a dataset it shares NO column with.
 *
 * Found while verifying UX-01 (2026-07-26 manual review) and filed separately,
 * because it reproduces on a COLD boot with no reshape and no prior run: with
 * zero overlap the column list fed to the QC worker is empty, and the row loop
 * interpolated it straight into `SELECT ${selectList} FROM …`. DuckDB answered
 * `Parser Error: SELECT clause without selection list`, which reached the user
 * as raw engine text on a toast — with no report, on inputs the Load view had
 * already told them were mismatched but deliberately does not gate.
 *
 * The contract is that the run COMPLETES and explains itself: one dataset-scope
 * finding saying no record could be validated, the per-variable missing flags
 * that are the real detail, and nothing on a toast.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const CORS = 'http://localhost:4199';
const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
const GRID_TIMEOUT = 60_000;
test.describe.configure({ timeout: 300_000 });

/** The HESP schema describes 265 variables; tiny/people.csv has 5 columns, none shared. */
const HESP_SCHEMA = `${CORS}/hesp/json_schema/core/core.schema.json`;
const HESP_INDEX = 'https://schemas.example.org/hesp/core/core.schema.json';
const NO_OVERLAP_TEXT =
  "None of the schema's 265 variables are present among the dataset's 5 columns";

const runButton = (page: Page): Locator => page.locator('.q-runbar-button');
const errorToast = (page: Page): Locator => page.locator('.q-toast--error');
const panelTab = (page: Page, name: string): Locator =>
  page.locator('.q-report-panels .q-paneltab', { hasText: name });

const statValue = async (page: Page, label: string): Promise<number> => {
  const text = await page
    .locator('.q-statcard', { hasText: label })
    .locator('.q-statcard-value')
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
};

async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

/** Assert the run landed a real report — and said why it validated nothing. */
async function expectExplainedRun(page: Page): Promise<void> {
  await waitForRunDone(page);
  await expect(errorToast(page)).toHaveCount(0);

  expect(await statValue(page, 'Rows')).toBe(12);
  expect(await statValue(page, 'Columns')).toBe(5);
  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({
    timeout: GRID_TIMEOUT,
  });

  await panelTab(page, 'Findings').click();
  await expect(page.locator('.q-findings-list')).toContainText(NO_OVERLAP_TEXT);
  // The dataset-scope sentence explains the per-variable flags, it does not
  // replace them: every absent schema variable is still named.
  await panelTab(page, 'Missing vars').click();
  await expect(page.locator('.q-missing-list')).toContainText('adult_count');
}

test('a schema sharing no column with the dataset still produces a report', async ({ page }) => {
  const params = new URLSearchParams();
  params.append('data', `${CORS}/tiny/people.csv`);
  params.append('schema', HESP_SCHEMA);
  params.append('index', HESP_INDEX);
  await page.goto(`/quac/#/load?${params.toString()}`);

  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  // §E.5 cautions but never gates — the whole point is that this run happens.
  await expect(page.locator('.q-preview-pertinence')).toContainText('Only 0 of 265');
  await expect(runButton(page)).toBeEnabled();

  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await expectExplainedRun(page);

  // Re-run is idempotent: the guard must not double-count or start toasting.
  await panelTab(page, 'Summary').click();
  const errorsRun1 = await statValue(page, 'Errors');
  await page.locator('.q-btn', { hasText: 'Re-run QC' }).click();
  await waitForRunDone(page);
  expect(await statValue(page, 'Errors')).toBe(errorsRun1);
  await expect(errorToast(page)).toHaveCount(0);
});

test('zero overlap after a matching run: the report reshapes and re-explains', async ({ page }) => {
  // The review met this bug the other way round — as the third toast of the
  // UX-01 repro — so the reshape path is covered too: a good run first, then
  // a dataset the loaded schema knows nothing about.
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await waitForRunDone(page);
  expect(await statValue(page, 'Columns')).toBe(266);

  await page.locator('.q-tab', { hasText: 'Load' }).click();
  await page.getByLabel('Dataset URL').fill(`${CORS}/tiny/people.csv`);
  await page.locator('[data-slot="data"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toContainText('people.csv', {
    timeout: INGEST_TIMEOUT,
  });

  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await expectExplainedRun(page);
});
