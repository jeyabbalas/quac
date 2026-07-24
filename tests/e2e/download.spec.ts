/**
 * P15 golden journey (the Excel half of journey 1): load the example files →
 * Run QC → Download QC Report → capture the download → parse the .xlsx bytes
 * in-test with exceljs and assert seeded-violation review text, the corrected
 * suffix + fill, and that sheets 2–5 exist.
 *
 * Uses the one-click example bundle (hesp_dirty_100.csv + 14-file schema + 3
 * rules files) so the run matches seeded-violations.json.
 */
import { expect, test } from '@playwright/test';
import type { Workbook } from 'exceljs';

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 180_000;
test.describe.configure({ timeout: 360_000 });

/** __row__ n lands on Excel row n + 2 (header is row 1). */
const excelRow = (row: number): number => row + 2;

async function loadRunAndOpenSummary(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('.q-schemaslot .q-badge').first()).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  await expect(page.locator('.q-runbar-button')).toBeEnabled();
  await page.locator('.q-runbar-button').click();
  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

test('download: full run → parse the .xlsx → seeded review text, corrected fill, sheets 2–5', async ({
  page,
}) => {
  await loadRunAndOpenSummary(page);

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.q-btn--primary', { hasText: 'Download QC Report' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^quac-report_hesp_dirty_100_\d{8}-\d{4}\.xlsx$/);

  const path = await download.path();
  const { default: ExcelJS } = await import('exceljs');
  const wb: Workbook = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  // Sheet order.
  expect(wb.worksheets.map((w) => w.name)).toEqual([
    'Data',
    'Missing Variables',
    'Dataset Findings',
    'Repeat Offenders',
    'Run Info',
  ]);

  const data = wb.getWorksheet('Data');
  if (data === undefined) throw new Error('missing Data sheet');
  const header = data.getRow(1);
  const colOf = (name: string): number => {
    let index = -1;
    header.eachCell((cell, col) => {
      if (cell.text === name) index = col;
    });
    if (index < 0) throw new Error(`column not found: ${name}`);
    return index;
  };

  // Seeded pattern break at __row__ 10 (record_id → 'HH1234_W01'): the schema
  // pattern flag and the row-scope rule Q003 (which emits a cell flag on each
  // target column) both merge into the one record_id__review cell.
  const recordReview = data.getRow(excelRow(10)).getCell(colOf('record_id__review')).text;
  expect(recordReview).toContain('schema:prop:record_id:value');
  expect(recordReview).toContain('Q003');

  // Seeded legacy sentinel at __row__ 8 (wage 999 → corrected to -999 by Q047):
  //   review text carries the corrected suffix; the source cell gets the green fill.
  const wageReview = data.getRow(excelRow(8)).getCell(colOf('wage_income_annual__review')).text;
  expect(wageReview).toContain('Q047:');
  expect(wageReview).toContain('(corrected: 999 → -999)');
  const wageFill = data.getRow(excelRow(8)).getCell(colOf('wage_income_annual')).fill;
  expect((wageFill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FFC6EFCE');

  // Sheets 2–5 carry their expected header rows / content.
  expect(wb.getWorksheet('Missing Variables')?.getRow(1).getCell(1).text).toBe('Variable');
  const findings = JSON.stringify(wb.getWorksheet('Dataset Findings')?.getSheetValues());
  expect(findings).toContain('external reference data'); // Q044 external
  const runInfo = JSON.stringify(wb.getWorksheet('Run Info')?.getSheetValues());
  expect(runInfo).toContain('QuaC version');
});
