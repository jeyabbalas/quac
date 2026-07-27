/**
 * UIX-6 golden journey 8: full QC runs with only ONE check source loaded.
 * Schema-only and rules-only both complete on the tiny/ fixtures (12×5
 * people.csv; single-root people.schema.json — no index modal; 6-rule
 * people_rules.quac.csv), and every degraded surface says the right thing:
 * em-dash rules cards + scope note, the split Missing-variables empties, the
 * filterable-aware Offenders hint, annotated cells. Excel workbook shape in
 * partial modes is unit-tier (reportModel/excelRoundtrip); download plumbing
 * is download.spec's.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const DATA = join(FIXTURES, 'tiny', 'people.csv');
const SCHEMA = join(FIXTURES, 'tiny', 'people.schema.json');
const RULES = join(FIXTURES, 'tiny', 'people_rules.quac.csv');

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
const schemaBadge = (page: Page): Locator =>
  page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first();
const runButton = (page: Page): Locator => page.locator('.q-runbar-button');

const statCard = (page: Page, label: string): Locator =>
  page.locator('.q-statcard', { hasText: label });

const statValue = async (page: Page, label: string): Promise<number> => {
  const text = await statCard(page, label).locator('.q-statcard-value').textContent();
  return Number((text ?? '').replaceAll(',', ''));
};

const statText = (page: Page, label: string): Locator =>
  statCard(page, label).locator('.q-statcard-value');

const panelTab = (page: Page, name: string): Locator =>
  page.locator('.q-report-panels .q-paneltab', { hasText: name });

const offenderHint = (page: Page): Locator =>
  page.getByText('Click a row-level SQL rule', { exact: false });

async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

test('schema-only full run: dash cards, scope note, no offender focus hint', async ({ page }) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Browse schema files').setInputFiles(SCHEMA);
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  // One usable check source is enough — no disabled reason shows.
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report$/);
  await waitForRunDone(page);

  // Seeded schema violations land: age 130 > maximum, empty name, lowercase
  // enum city (no rules loaded, so no UPPER correction rescues it).
  expect(await statValue(page, 'Errors')).toBeGreaterThanOrEqual(2);

  // The three rules-stage cards dash out instead of claiming a zero…
  await expect(statText(page, 'Corrections applied')).toHaveText('—');
  await expect(statText(page, 'Rules run')).toHaveText('—');
  await expect(statText(page, 'Rules skipped')).toHaveText('—');
  // …and the scope note says why.
  await expect(
    page.getByText('No QC rules were loaded for this run — the rules stage was skipped.'),
  ).toBeVisible();

  // The tiny schema's variables all exist in people.csv.
  await panelTab(page, 'Missing vars').click();
  await expect(page.getByText('All schema variables are present in the dataset.')).toBeVisible();

  // Offenders: schema rules produce rows, but none is grid-filterable — the
  // click hint (and its Clear focus) must not render.
  await panelTab(page, 'Offenders').click();
  await expect(page.locator('.q-offenders tbody tr').first()).toBeVisible();
  await expect(offenderHint(page)).toHaveCount(0);

  // The grid carries annotations from the schema stage.
  await expect(page.locator('.dt-cell--annotated').first()).toBeVisible({ timeout: 30_000 });
});

test('rules-only full run: corrections apply, schema note, no-schema missing vars', async ({
  page,
}) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(RULES);

  // Observed (not assumed): a schema-less CSV run stores every column as
  // VARCHAR, and DuckDB's binder refuses VARCHAR↔INTEGER comparison and
  // arithmetic WITHOUT implicit casts — R003 (in_range) and R005 (score >
  // age*10) fail the stage-4 EXPLAIN dry-run and are excluded pre-run
  // (partial acceptance ⇒ Warning badge, 4 of 6 executable).
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toHaveText(
    '1 file · 6 rules · 2 lint errors',
  );

  // UX-08: the two exclusions above explain themselves in plain language. This
  // is the only tier that runs the classifier against duckdb-wasm's OWN binder
  // strings — the node tiers use @duckdb/node-api.
  await page.locator('[data-slot="rules"] .q-slotcard-details summary').click();
  const lintErrors = page.locator('[data-slot="rules"] .q-rulesissue--error');
  await expect(lintErrors).toHaveCount(2);
  // R003 (in_range on age) names one column, so it gets the real cast; R005
  // (score > age * 10) names two, so the cast example is the placeholder.
  await expect(lintErrors.filter({ hasText: 'R003' })).toContainText(
    'age is stored as text in this dataset',
  );
  await expect(lintErrors.filter({ hasText: 'R003' })).toContainText('TRY_CAST(age AS DOUBLE)');
  await expect(lintErrors.filter({ hasText: 'R005' })).toContainText(
    'score, age are stored as text in this dataset',
  );
  await expect(lintErrors.filter({ hasText: 'R003' })).toContainText('Load a JSON Schema to type it');
  // The engine's words stay in `detail` (the title) — never on the card's face.
  await expect(lintErrors.filter({ hasText: 'R003' })).not.toContainText('Binder Error');
  await expect(lintErrors.filter({ hasText: 'R005' })).not.toContainText('Binder Error');

  // Four executable rules still satisfy the rules leg — the button enables.
  await expect(runButton(page)).toBeEnabled();
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report$/);
  await waitForRunDone(page);

  // R001 (duplicate person_id P007) is typing-immune: ≥1 error regardless of
  // the all-VARCHAR storage.
  expect(await statValue(page, 'Errors')).toBeGreaterThanOrEqual(1);
  // R006 uppercases 'newport news' (string ops are typing-immune too).
  expect(await statValue(page, 'Corrections applied')).toBeGreaterThanOrEqual(1);
  // Exactly the four survivors run: R001, R002, R004, R006.
  expect(await statValue(page, 'Rules run')).toBe(4);
  expect(await statValue(page, 'Rules skipped')).toBe(0);

  // The schema-side scope note names the skipped stage.
  await expect(
    page.getByText('No JSON Schema was loaded for this run — schema validation was skipped.'),
  ).toBeVisible();

  // Missing variables: the no-schema empty, not the generic one.
  await panelTab(page, 'Missing vars').click();
  await expect(
    page.getByText('No JSON Schema loaded — nothing to compare.', { exact: false }),
  ).toBeVisible();

  // Offenders: rows exist, but every surviving rule is column-scope or a
  // correction — nothing is grid-filterable, so the click hint stays hidden
  // here too (the visible case is pinned by runQc.spec's full-input run,
  // where H004 row-scope SQL fires).
  await panelTab(page, 'Offenders').click();
  await expect(page.locator('.q-offenders tbody tr').first()).toBeVisible();
  await expect(offenderHint(page)).toHaveCount(0);
});
