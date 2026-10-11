/**
 * The nested-data example end to end (examples/nested/): one click fills all
 * three slots; the Preview shows the nested columns' DuckDB types and the
 * dictionary their fields; a run finds every planted problem and names where
 * inside the value it is; the grid renders the columns nested; the workbook
 * holds each nested cell as its exact JSON text.
 *
 * The totals are the ones examples/nested/README.md promises — and the CLI
 * produces (tests/unit/headless/nestedParity.test.ts).
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Workbook } from 'exceljs';

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 180_000;
test.describe.configure({ timeout: 300_000 });

const statValue = async (page: Page, label: string): Promise<number> => {
  const text = await page
    .locator('.q-statcard', { hasText: label })
    .locator('.q-statcard-value')
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
};

async function loadNestedExample(page: Page): Promise<void> {
  await page.goto('/quac/');
  await page.locator('.q-example-load-nested').click();
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toContainText(
    'participants.json · 40 rows × 11 cols',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  // Exact text: `… · data checks pending` is the state BEFORE the rules are
  // linted against the dataset (see support/exampleSession.ts).
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toHaveText(
    '1 file · 10 rules',
    { timeout: INGEST_TIMEOUT },
  );
}

test('one click loads the nested example; the Preview shows its types and fields', async ({ page }) => {
  await loadNestedExample(page);
  await expect(page.locator('.q-preview-pertinence .q-badge')).toHaveText('OK', {
    timeout: INGEST_TIMEOUT,
  });

  // Dataset: a nested column keeps its DuckDB type, its cells their JSON.
  const table = page.locator('.q-preview-table');
  const header = (await table.locator('thead tr').first().locator('th').allInnerTexts()).map((t) => t.trim());
  const types = await table.locator('.q-preview-typerow td').allInnerTexts();
  const typeOf = (column: string): string => types[header.indexOf(column)] ?? '';
  expect(typeOf('phones')).toBe('VARCHAR[]');
  expect(typeOf('address')).toMatch(/^STRUCT\(street VARCHAR, city VARCHAR/);
  expect(typeOf('notes')).toBe('JSON');
  const firstAddress = table.locator('tbody tr').first().locator('td').nth(header.indexOf('address'));
  await expect(firstAddress).toHaveText(/^\{"street":"[^"]+","city":"[^"]+",/);
  await expect(firstAddress).toHaveClass(/q-preview-nested/);

  // JSON Schema: the dictionary lists each nested variable's fields under it.
  await page.locator('.q-preview .q-paneltab', { hasText: 'JSON Schema' }).click();
  await expect(page.locator('.q-preview-meta').filter({ hasText: 'categories' })).toHaveText(
    '5 categories · 11 variables · 15 nested fields',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('json-data-dictionary')).toContainText('visits[].date');
});

test('a run finds every planted problem, says where, and writes nested cells as JSON', async ({
  page,
}) => {
  await loadNestedExample(page);
  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({ timeout: RUN_TIMEOUT });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });

  expect(await statValue(page, 'Errors')).toBe(25);
  expect(await statValue(page, 'Warnings')).toBe(5);
  expect(await statValue(page, 'Info')).toBe(5);
  expect(await statValue(page, 'Corrections applied')).toBe(3);
  expect(await statValue(page, 'Rules run')).toBe(10);

  // The grid renders the columns nested — data-table's outline in the header.
  await expect(page.locator('.dt-col-header', { hasText: 'household' })).toContainText('[struct(3)]');

  // The first annotated household cell is P0005's: the second member is 130.
  const household = page.locator('.dt-cell--annotated[data-column="household"]').first();
  await expect(household).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(500); // let the virtual scroller settle post-paint
  // Click, not hover: a nested cell is inspectable, and data-table opens its
  // annotation popover on the keyboard cursor rather than under the pointer.
  await household.click();
  const popover = page.locator('.dt-annotation-popover');
  await expect(popover.first()).toBeVisible({ timeout: 10_000 });
  await expect(popover.locator('.dt-annotation-message').first()).toHaveText(
    '130 exceeds the maximum 120 (at household[2].age).',
  );
  await page.keyboard.press('Escape');

  // A correction inside a struct names the field it changed.
  const corrected = page.locator('.dt-cell--annotated[data-column="address"]').nth(1); // P0004
  await corrected.click();
  await expect(popover.locator('.dt-annotation-message').first()).toHaveText(
    "Country code upper-cased. (corrected: country: 'us' → 'US')",
  );
  await page.keyboard.press('Escape');

  // The workbook: nested cells are their JSON text, dates and all.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.q-btn--primary', { hasText: 'Download QC Report' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^quac-report_participants_\d{8}-\d{4}\.xlsx$/);
  const { default: ExcelJS } = await import('exceljs');
  const wb: Workbook = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await download.path());
  const data = wb.getWorksheet('Data');
  if (data === undefined) throw new Error('missing Data sheet');
  const columns: string[] = [];
  data.getRow(1).eachCell((cell, col) => {
    columns[col] = cell.text;
  });
  const cell = (row: number, column: string): string =>
    data.getRow(row + 2).getCell(columns.indexOf(column)).text;
  expect(cell(0, 'visits')).toMatch(/^\[\{"date":"\d{4}-\d{2}-\d{2}","weight_kg":/);
  expect(cell(3, 'address')).toContain('"country":"US"'); // corrected before export
  expect(cell(4, 'household__review')).toContain('130 exceeds the maximum 120 (at household[2].age).');
  expect(cell(8, 'phones')).toBe('["+15550102030"]');
});
