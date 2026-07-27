/**
 * UX-01 (2026-07-26 manual review): the product's core loop — run QC, fix the
 * data, load the fixed file, run again — when the fixed file has a DIFFERENT
 * column set.
 *
 * The failure this guards: after a run, replacing the dataset with one of a
 * different shape left the report grid on data-table's "Load data to see the
 * table" placeholder with raw DuckDB text in the toasts ("No magic bytes
 * found at end of file 'quac_display.parquet'"), and Re-run QC could not
 * recover it — only a page reload could. The panels stayed correct
 * throughout, so only the grid told the truth about being broken.
 *
 * No other spec loads a SECOND, differently shaped dataset after a run:
 * runQc re-runs the same file, clearInputs clears and re-uploads the same
 * file, pertinence swaps datasets but never runs. Hence this one.
 *
 * Shapes, deliberately four: 266 cols (example) → 265 (one column fewer, the
 * review's repro) → 5 (tiny/people.csv, the worse variant) → 266 again (the
 * same-shape replacement that always worked and must keep working).
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const CORS = 'http://localhost:4199';
const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
const GRID_TIMEOUT = 60_000;
test.describe.configure({ timeout: 300_000 });

/** The library's own empty state — a lie while a dataset IS loaded. */
const GRID_PLACEHOLDER = 'Load data to see the table';
/** QuaC's build-failure note (reportGrid.ts), the honest version of it. */
const GRID_FAILED = 'could not be built';

const datasetCard = (page: Page): Locator => page.locator('[data-slot="data"]');
const datasetBadge = (page: Page): Locator => datasetCard(page).locator('.q-badge');
const datasetSummary = (page: Page): Locator => datasetCard(page).locator('.q-slotcard-summary');
const runButton = (page: Page): Locator => page.locator('.q-runbar-button');
const gridHost = (page: Page): Locator => page.locator('.q-report-gridhost');
const errorToast = (page: Page): Locator => page.locator('.q-toast--error');

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

/** Replace the dataset by URL, the way the review's repro does. */
async function fetchDataset(page: Page, url: string, summary: string): Promise<void> {
  await page.locator('.q-tab', { hasText: 'Load' }).click();
  await page.getByLabel('Dataset URL').fill(url);
  await datasetCard(page).getByRole('button', { name: 'Fetch' }).click();
  await expect(datasetSummary(page)).toContainText(summary, { timeout: INGEST_TIMEOUT });
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
}

/**
 * Run, then assert the grid is REALLY there: rendered body cells, neither the
 * library placeholder nor QuaC's build-failure note, and the panel numbers
 * describing the dataset actually on screen.
 */
async function runAndExpectLiveGrid(page: Page, rows: number, columns: number): Promise<void> {
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await waitForRunDone(page);

  expect(await statValue(page, 'Rows')).toBe(rows);
  expect(await statValue(page, 'Columns')).toBe(columns);

  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({
    timeout: GRID_TIMEOUT,
  });
  await expect(gridHost(page)).not.toContainText(GRID_PLACEHOLDER);
  await expect(gridHost(page)).not.toContainText(GRID_FAILED);
}

test('a dataset replaced with a different column set re-runs into a live grid', async ({
  page,
}) => {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  // Run 1 — the baseline the review recorded (101 × 266, grid populated).
  await runAndExpectLiveGrid(page, 101, 266);
  await expect(page.locator('.dt-cell--annotated').first()).toBeVisible({ timeout: GRID_TIMEOUT });

  // Run 2 — ONE COLUMN FEWER. The exact failure the review filed, including
  // its toasts: nothing may reach the user as raw engine text.
  await fetchDataset(page, `${CORS}/hesp/data/hesp_valid_100.csv`, 'hesp_valid_100.csv');
  await runAndExpectLiveGrid(page, 100, 265);
  expect(await statValue(page, 'Errors')).toBe(0);
  await expect(errorToast(page)).toHaveCount(0);

  // Run 3 — the worse variant: 266 → 5 columns, a different dataset entirely.
  await fetchDataset(page, `${CORS}/tiny/people.csv`, 'people.csv');
  await runAndExpectLiveGrid(page, 12, 5);

  // Run 4 — back to the original shape: the case that always worked must not
  // have regressed, and its annotations must paint again.
  await fetchDataset(page, `${CORS}/hesp/data/hesp_dirty_100.tsv`, 'hesp_dirty_100.tsv');
  await runAndExpectLiveGrid(page, 101, 266);
  await expect(page.locator('.dt-cell--annotated').first()).toBeVisible({ timeout: GRID_TIMEOUT });

  // …and a same-dataset re-run still refreshes in place (the loadData path,
  // which was never broken and must not be "fixed" into a shared table name).
  await page.locator('.q-btn', { hasText: 'Re-run QC' }).click();
  await waitForRunDone(page);
  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({
    timeout: GRID_TIMEOUT,
  });
  await expect(gridHost(page)).not.toContainText(GRID_PLACEHOLDER);
});

test('the Studio sample grid rebuilds after the dataset is reshaped', async ({ page }) => {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  // The Studio's preview is a second data-table instance with the same
  // lifecycle; before UX-01's fix it died on a reshape too, with the sibling
  // error "TProtocolException … read_parquet('quac_studio_display.parquet')".
  await page.locator('.q-tab', { hasText: 'Rule Studio' }).click();
  const sampleGrid = page.locator('.q-studio-samplegrid');
  await expect(sampleGrid.locator('.dt-cell').first()).toBeVisible({ timeout: GRID_TIMEOUT });

  await fetchDataset(page, `${CORS}/tiny/people.csv`, 'people.csv');
  await page.locator('.q-tab', { hasText: 'Rule Studio' }).click();
  await expect(sampleGrid.locator('.dt-cell').first()).toBeVisible({ timeout: GRID_TIMEOUT });
  await expect(sampleGrid).not.toContainText(GRID_PLACEHOLDER);
  await expect(errorToast(page)).toHaveCount(0);
});
