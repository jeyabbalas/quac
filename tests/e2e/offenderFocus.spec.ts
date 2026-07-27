/**
 * Golden journey 11 (UX-03): the Offenders focus click is best effort, and
 * when the best effort fails the grid is left alone and QuaC says why.
 *
 * The review's exact repro, over the cross-origin fixture host: HESP dirty
 * CSV + the 14-file schema + 3 rules files → Run QC → Offenders. `Q003`
 * (Count 4) focuses to 4 of 101 rows. `H004` (Count 1) is the divergence —
 * its condition `interview_date IS NOT NULL AND TRY_CAST(interview_date AS
 * DATE) IS NULL` parses against the grid's own copy and matches zero rows
 * there, because that copy types `interview_date` as DATE (QuaC's `data` view
 * types it VARCHAR) and the one bad calendar date is already null. Clicking
 * it used to leave `Active filters: SQL H004` over an empty grid.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const CORS = 'http://localhost:4199';
const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
const GRID_TIMEOUT = 60_000;
test.describe.configure({ timeout: 300_000 });

const runButton = (page: Page): Locator => page.locator('.q-runbar-button');
const panelTab = (page: Page, name: string): Locator =>
  page.locator('.q-report-panels .q-paneltab', { hasText: name });
/** data-table's own "Active filters" chips, titled `SQL <ruleId>`. */
const filterChips = (page: Page): Locator => page.locator('.q-report-grid .dt-filter-chip');
/** Any column header's row counter: "101 rows" unfiltered, "4 / 101 rows" filtered. */
const rowCounter = (page: Page): Locator => page.locator('.q-report-grid .dt-stats-line1').first();
const focusButton = (page: Page, ruleId: string): Locator =>
  page.locator('.q-offender-focus', { hasText: ruleId });

test('offender focus: a rule that matches no grid rows explains itself', async ({ page }) => {
  const params = new URLSearchParams();
  params.append('data', `${CORS}/hesp/data/hesp_dirty_100.csv`);
  params.append('schema', `${CORS}/hesp/json_schema/core/core.schema.json`);
  params.append('index', 'https://schemas.example.org/hesp/core/core.schema.json');
  params.append('rules', `${CORS}/hesp/rules/hesp_keys_and_structure.quac.csv`);
  params.append('rules', `${CORS}/hesp/rules/hesp_consistency.quac.csv`);
  params.append('rules', `${CORS}/hesp/rules/hesp_corrections.quac.csv`);
  await page.goto(`/quac/#/load?${params.toString()}`);

  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
  await expect(rowCounter(page)).toHaveText('101 rows', { timeout: GRID_TIMEOUT });

  await panelTab(page, 'Offenders').click();

  // Q003 (Count 4): the feature working. Four of 101 rows, one chip.
  await focusButton(page, 'Q003').click();
  await expect(rowCounter(page)).toHaveText('4 / 101 rows', { timeout: GRID_TIMEOUT });
  await expect(filterChips(page)).toHaveCount(1);
  await expect(filterChips(page).first()).toHaveAttribute('title', 'SQL Q003');
  await expect(page.locator('.q-toast')).toHaveCount(0);

  // H004 (Count 1): accepted by the grid, matches none of its rows. The grid
  // must come back whole — including losing Q003's now-misleading chip.
  await focusButton(page, 'H004').click();
  const toast = page.locator('.q-toast');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('H004 matches no rows in the grid, so it was left unfiltered.');
  await expect(toast.locator('.q-toast-hint')).toContainText('still annotated');
  await expect(filterChips(page)).toHaveCount(0);
  await expect(rowCounter(page)).toHaveText('101 rows');

  // …and the panel still works afterwards: focus, then Clear focus.
  await focusButton(page, 'Q003').click();
  await expect(rowCounter(page)).toHaveText('4 / 101 rows', { timeout: GRID_TIMEOUT });
  await page.locator('.q-btn', { hasText: 'Clear focus' }).click();
  await expect(filterChips(page)).toHaveCount(0);
  await expect(rowCounter(page)).toHaveText('101 rows');
});
