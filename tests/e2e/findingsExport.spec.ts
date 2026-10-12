/**
 * The findings without data, end to end in the app (qc-report-spec.md §7):
 * run the example, take each of the three downloads from the Summary panel,
 * and read what they say — every check that failed, by its place in the
 * schema or its rule, with its count — and what they never say: the values
 * the example seeded (seeded-violations.json), which the QC report itself
 * prints.
 *
 * The exhaustive proof that no value can reach the findings is the node
 * test (tests/unit/report/findingsNoData.test.ts), whose dataset marks every
 * value; this pins the app's wiring to it.
 */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import type { Workbook } from 'exceljs';
import { loadExampleSession } from './support/exampleSession';

const RUN_TIMEOUT = 180_000;
test.describe.configure({ timeout: 360_000 });

/** Values seeded into hesp_dirty_100.csv that the QC report quotes back. */
const SEEDED = ['HH1234_W01', 'twelve hundred', '412.75', '2150', '-555', 'n_rows='];

async function runExample(page: Page): Promise<void> {
  await page.goto('/quac/');
  await loadExampleSession(page);
  await expect(page.locator('.q-runbar-button')).toBeEnabled();
  await page.locator('.q-runbar-button').click();
  await expect(page).toHaveURL(/#\/report/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

const group = (page: Page) => page.getByRole('group', { name: 'Findings without data' });

async function download(page: Page, label: 'Excel' | 'Markdown' | 'JSON'): Promise<Download> {
  const pending = page.waitForEvent('download');
  await group(page)
    .getByRole('button', { name: new RegExp(`^${label}:`) })
    .click();
  return pending;
}

test('Markdown and JSON: every failed check with its count, and none of the seeded values', async ({
  page,
}) => {
  await runExample(page);
  await expect(group(page)).toBeVisible();
  await expect(group(page)).toContainText('no values from the dataset');

  const md = await download(page, 'Markdown');
  expect(md.suggestedFilename()).toMatch(/^quac-findings_hesp_dirty_100_\d{8}-\d{4}\.md$/);
  const markdown = await readFile(await md.path(), 'utf8');
  expect(markdown).toContain('# QC findings: hesp_dirty_100.csv');
  expect(markdown).toContain('**They contain no data:**');
  // A schema check by its exact place, through a `$ref` into another file.
  expect(markdown).toContain('`common/defs.json#/$defs/record_id/pattern`');
  // A skip pattern, worded from the schema's own conditional.
  expect(markdown).toContain(
    'When baseline_record = 1, must be -666 (Not applicable / structural skip)',
  );
  // A rule, its result, and its definition.
  expect(markdown).toContain('| `Q003` | error | 4 records (4.0%) |');
  expect(markdown).toContain('```sql\nCOUNT(*) OVER (PARTITION BY household_id, wave) > 1\n```');
  for (const value of SEEDED) expect(markdown).not.toContain(value);

  const js = await download(page, 'JSON');
  expect(js.suggestedFilename()).toMatch(/^quac-findings_hesp_dirty_100_\d{8}-\d{4}\.json$/);
  const text = await readFile(await js.path(), 'utf8');
  for (const value of SEEDED) expect(text).not.toContain(value);
  const findings = JSON.parse(text) as {
    findingsSchemaVersion: number;
    containsData: boolean;
    overview: { records: number; recordsWithErrors: number; schemaChecksFailed: number };
    schemaChecks: { ruleId: string; keyword: string | null; records: number | null }[];
    rules: { ruleId: string; outcome: string; records: number | null }[];
  };
  expect(findings.findingsSchemaVersion).toBe(1);
  expect(findings.containsData).toBe(false);
  expect(findings.overview).toMatchObject({ records: 101, schemaChecksFailed: 11 });
  expect(findings.schemaChecks).toContainEqual(
    expect.objectContaining({
      ruleId: 'schema:prop:reference_year:value',
      keyword: 'maximum',
      records: 1,
    }),
  );
  expect(findings.rules).toHaveLength(22);
  expect(findings.rules).toContainEqual(
    expect.objectContaining({ ruleId: 'Q002', outcome: 'failed', records: 4 }),
  );
  expect(findings.rules).toContainEqual(
    expect.objectContaining({ ruleId: 'Q044', outcome: 'not-evaluated' }),
  );
});

test('Excel: four sheets to sort and filter, and none of the seeded values', async ({ page }) => {
  await runExample(page);
  const xlsx = await download(page, 'Excel');
  expect(xlsx.suggestedFilename()).toMatch(/^quac-findings_hesp_dirty_100_\d{8}-\d{4}\.xlsx$/);
  const { default: ExcelJS } = await import('exceljs');
  const wb: Workbook = new ExcelJS.Workbook();
  await wb.xlsx.readFile(await xlsx.path());
  expect(wb.worksheets.map((w) => w.name)).toEqual([
    'Summary',
    'Schema checks',
    'QC rules',
    'Notes',
  ]);
  expect(wb.getWorksheet('Schema checks')?.rowCount).toBe(12); // header + 11 checks
  expect(wb.getWorksheet('QC rules')?.rowCount).toBe(23); // header + 22 rules
  const everything = wb.worksheets.map((w) => JSON.stringify(w.getSheetValues())).join('\n');
  for (const value of SEEDED) expect(everything).not.toContain(value);
});
