/**
 * Golden journey 11: clicking an offender shows the rows it flagged.
 *
 * The review's exact repro, over the cross-origin fixture host: HESP dirty CSV
 * + the 14-file schema + 3 rules files → Run QC → Offenders. On that run the
 * panel lists 28 offenders, and this spec walks the four kinds it contains:
 *
 * - `Q003` — plain row-scope SQL. The only kind that ever worked.
 * - `Q002` — `COUNT(*) OVER (PARTITION BY …) > 1`. A window function is illegal
 *   in a WHERE clause, so re-running the condition could not express it; its
 *   flagged row ids can.
 * - `H004` — `interview_date IS NOT NULL AND TRY_CAST(interview_date AS DATE)
 *   IS NULL`. Re-running it against the grid's own copy matched ZERO rows,
 *   because that copy types `interview_date` as DATE (QuaC's `data` view types
 *   it VARCHAR) and the one bad calendar date is already null there (UX-03).
 *   Row identity does not re-evaluate anything, so the row shows.
 * - `schema:prop:record_id:value` — a schema rule, which has no SQL condition
 *   at all and so used to render as unclickable plain text.
 *
 * And the row that still cannot be focused: a `schema:advisory:*` finding names
 * no row, so it offers no button and says why in a title.
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
const offenderRow = (page: Page, ruleId: string): Locator =>
  page.locator('.q-offenders tbody tr', { hasText: ruleId });
const focusButton = (page: Page, ruleId: string): Locator =>
  page.locator('.q-offender-focus', { hasText: ruleId });

/** Click the rule and assert the grid narrowed to exactly its flagged rows. */
async function expectFocus(page: Page, ruleId: string, counter: string): Promise<void> {
  await focusButton(page, ruleId).click();
  await expect(rowCounter(page)).toHaveText(counter, { timeout: GRID_TIMEOUT });
  await expect(filterChips(page)).toHaveCount(1);
  await expect(filterChips(page).first()).toHaveAttribute('title', `SQL ${ruleId}`);
  // The panel marks which rule the grid is showing — the chip is a column away.
  await expect(offenderRow(page, ruleId)).toHaveClass(/is-focused/);
  await expect(focusButton(page, ruleId)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.q-toast')).toHaveCount(0);
}

test('offender focus: every rule that flagged rows can show them', async ({ page }) => {
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

  // The kind that always worked.
  await expectFocus(page, 'Q003', '4 / 101 rows');
  // Window function — `unfilterable` before, and the previous rule's chip has
  // to be gone, not merely joined.
  await expectFocus(page, 'Q002', '4 / 101 rows');
  // UX-03's zero-match divergence: the row shows now.
  await expectFocus(page, 'H004', '1 / 101 rows');
  // A schema rule: no SQL condition exists, and it focuses anyway.
  await expectFocus(page, 'schema:prop:record_id:value', '1 / 101 rows');
  // A column-scope assertion (`unique`), likewise.
  await expectFocus(page, 'Q001', '2 / 101 rows');

  // Clear focus returns the grid whole and drops the panel's marker.
  await page.locator('.q-btn', { hasText: 'Clear focus' }).click();
  await expect(filterChips(page)).toHaveCount(0);
  await expect(rowCounter(page)).toHaveText('101 rows');
  await expect(page.locator('.q-offenders tbody tr.is-focused')).toHaveCount(0);

  // The row is a click target too — the whole thing tints on hover, so the
  // whole thing takes the press. This clicks the Count cell, not the rule id.
  await offenderRow(page, 'Q003').locator('td').nth(3).click();
  await expect(rowCounter(page)).toHaveText('4 / 101 rows', { timeout: GRID_TIMEOUT });
  await expect(offenderRow(page, 'Q003')).toHaveClass(/is-focused/);

  // A finding that names no rows offers no button, and says why.
  const advisory = page.locator('.q-offenders tbody tr', { hasText: 'schema:advisory:' }).first();
  await expect(advisory).toBeVisible();
  await expect(advisory.locator('.q-offender-focus')).toHaveCount(0);
  await expect(advisory.locator('.q-offenders-ruleid')).toHaveAttribute(
    'title',
    'Not tied to individual rows — nothing to focus.',
  );
});
