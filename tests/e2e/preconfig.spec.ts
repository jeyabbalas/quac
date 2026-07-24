/**
 * P16 golden journey 2: a pre-configured link auto-loads Schema + Rules from the
 * cross-origin fixture host (schema= is a single core.schema.json URL that crawls
 * the 14-file tree over HTTP; index= names the root), leaves the Dataset slot
 * empty + highlighted, then the user uploads the dataset and runs QC. Never
 * auto-runs.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const CORS = 'http://localhost:4199';
const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

test('preconfigured link: auto-load schema/rules → upload data → run', async ({ page }) => {
  const params = new URLSearchParams();
  params.append('schema', `${CORS}/hesp/json_schema/core/core.schema.json`);
  params.append('rules', `${CORS}/hesp/rules/hesp_keys_and_structure.quac.csv`);
  params.append('rules', `${CORS}/hesp/rules/hesp_consistency.quac.csv`);
  params.append('rules', `${CORS}/hesp/rules/hesp_corrections.quac.csv`);
  params.append('index', 'https://schemas.example.org/hesp/core/core.schema.json');

  await page.goto(`/quac/#/load?${params.toString()}`);

  // Schema crawls categories + common/defs over HTTP; no index modal (matched).
  await expect(page.locator('.q-schemaslot .q-badge').first()).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.getByRole('dialog', { name: 'Choose the index schema' })).toHaveCount(0);
  await expect(page.locator('.q-schemaslot-detail')).toContainText('root: core/core.schema.json');

  // Rules land Valid (data checks pending until a dataset loads).
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toContainText('3 files');

  // Partial config: Dataset empty + highlighted nudge; Run disabled (no auto-run).
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Empty');
  await expect(page.locator('.q-preconfig-hint')).toBeVisible();
  await expect(page.locator('.q-preconfig-hint')).toContainText('Add your dataset to run QC');
  await expect(page.locator('.q-runbar-button')).toBeDisabled();

  // Upload the dataset → nudge clears → Run enabled.
  await page
    .locator('[data-slot="data"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv'));
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('.q-preconfig-hint')).toBeHidden();
  await expect(page.locator('.q-runbar-button')).toBeEnabled();

  // Run completes on the Report.
  await page.locator('.q-runbar-button').click();
  await expect(page).toHaveURL(/#\/report/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
});
