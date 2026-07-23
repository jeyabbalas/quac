/**
 * P05 golden journeys: dataset ingestion through the real UI — drag-drop,
 * browse, the SheetPickerModal flow, the Report grid, the oversize guardrail,
 * and the URL fetch path. DuckDB-WASM boots per page, so expectations that
 * cross an ingest carry generous timeouts.
 */
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HESP = (ext: string): string => join(FIXTURES, 'hesp', 'data', `hesp_dirty_100.${ext}`);
const HESP_DIMS = '101 rows × 266 cols';
const INGEST_TIMEOUT = 90_000;

test.describe.configure({ timeout: 180_000 });

const datasetCard = (page: Page): Locator => page.locator('[data-slot="data"]');
const datasetBadge = (page: Page): Locator => datasetCard(page).locator('.q-badge');
const datasetSummary = (page: Page): Locator => datasetCard(page).locator('.q-slotcard-summary');
const fileInput = (page: Page): Locator => datasetCard(page).locator('input[type="file"]');

async function dropFile(page: Page, path: string, name: string): Promise<void> {
  const base64 = readFileSync(path).toString('base64');
  const dataTransfer = await page.evaluateHandle(
    ({ b64, fileName }) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], fileName));
      return dt;
    },
    { b64: base64, fileName: name },
  );
  await page.dispatchEvent('.q-dropzone', 'drop', { dataTransfer });
}

test('drag-drop CSV shows Valid badge, dims, and the 50-row preview', async ({ page }) => {
  await page.goto('/quac/');

  await dropFile(page, HESP('csv'), 'hesp_dirty_100.csv');

  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toHaveText(`hesp_dirty_100.csv · ${HESP_DIMS}`);

  await expect(page.getByText('Preview (first 50 rows)')).toBeVisible();
  const preview = page.locator('.q-preview-table');
  await expect(preview).toBeVisible();
  await expect(preview.locator('tbody tr')).toHaveCount(50);
  await expect(preview.locator('thead th').first()).toHaveText('record_id');
  // __row__ is engine-internal — never shown to users.
  await expect(preview.locator('thead')).not.toContainText('__row__');
});

for (const ext of ['tsv', 'json', 'parquet'] as const) {
  test(`browse ${ext} ingests to the same dimensions`, async ({ page }) => {
    await page.goto('/quac/');

    await fileInput(page).setInputFiles(HESP(ext));

    await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
    await expect(datasetSummary(page)).toHaveText(`hesp_dirty_100.${ext} · ${HESP_DIMS}`);
  });
}

test('multi-sheet xlsx opens the SheetPicker (Sheet 1 preselected); picking sheet 2 ingests it', async ({
  page,
}) => {
  await page.goto('/quac/');

  await fileInput(page).setInputFiles(join(FIXTURES, 'tiny', 'two_sheets.xlsx'));

  const dialog = page.getByRole('dialog', { name: 'Choose a sheet' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  // Sheet 1 preselected per the brief.
  await expect(dialog.getByRole('radio', { name: 'notes' })).toBeChecked();

  await dialog.getByRole('radio', { name: 'people' }).check();
  await dialog.getByRole('button', { name: 'Use this sheet' }).click();

  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toHaveText('two_sheets.xlsx · 4 rows × 3 cols');
  await expect(page.locator('.q-preview-table thead th').first()).toHaveText('pet_id');
  await expect(page.locator('.q-preview-table')).toContainText('Quackers');
});

test('cancelling the SheetPicker leaves the slot untouched', async ({ page }) => {
  await page.goto('/quac/');

  await fileInput(page).setInputFiles(join(FIXTURES, 'tiny', 'two_sheets.xlsx'));
  const dialog = page.getByRole('dialog', { name: 'Choose a sheet' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await expect(dialog).toBeHidden();
  await expect(datasetBadge(page)).toHaveText('Empty');
});

test('Report tab shows the display grid without __row__', async ({ page }) => {
  await page.goto('/quac/');

  await fileInput(page).setInputFiles(join(FIXTURES, 'tiny', 'people.csv'));
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await page.getByRole('link', { name: 'QC Report' }).click();

  const grid = page.locator('.q-report-grid');
  await expect(grid.locator('.dt-table, [class*="dt-"]').first()).toBeVisible({
    timeout: INGEST_TIMEOUT,
  });
  await expect(grid).toContainText('person_id', { timeout: INGEST_TIMEOUT });
  await expect(grid).not.toContainText('__row__');

  // P04 handoff check: QuaC's body-level --dt-annotation-* mapping must win
  // over data-table.css's :root defaults on a MOUNTED grid (nearer-ancestor
  // inheritance beats import order). --q-error-fill is #ffc7ce in tokens.css.
  const annotationBg = await grid
    .locator('[class*="dt-"]')
    .first()
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--dt-annotation-error-bg').trim());
  expect(annotationBg.toLowerCase()).toBe('#ffc7ce');
});

test('oversized file is rejected before any read', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'quac-oversize-'));
  const bigPath = join(dir, 'huge.csv');
  try {
    // Sparse 501 MB file — instant to create, never actually read.
    const fd = openSync(bigPath, 'w');
    ftruncateSync(fd, 501 * 2 ** 20);
    closeSync(fd);

    await page.goto('/quac/');
    await fileInput(page).setInputFiles(bigPath);

    await expect(datasetBadge(page)).toHaveText('Error', { timeout: 30_000 });
    await expect(datasetSummary(page)).toContainText('501 MB');
    // The UI stays responsive: the drop zone is re-enabled after the failure.
    await expect(page.locator('.q-dropzone')).toBeEnabled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('URL fetch loads a dataset into the slot', async ({ page }) => {
  const csv = readFileSync(join(FIXTURES, 'tiny', 'people.csv'));
  await page.route('**/testdata/people.csv', (route) => {
    void route.fulfill({ status: 200, contentType: 'text/csv', body: csv.toString('utf8') });
  });

  await page.goto('/quac/');
  await page.getByLabel('Dataset URL').fill('http://localhost:4173/testdata/people.csv');
  await page.getByRole('button', { name: 'Fetch' }).click();

  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toHaveText('people.csv · 12 rows × 5 cols');
});
