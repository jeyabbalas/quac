/**
 * P07 golden journeys: the PertinenceStrip under the slot cards and the §E.5
 * block modal. HESP schema + hesp_dirty_100.csv → OK strip (265/265, 1 extra
 * 'notes' column); HESP schema + tiny/people.csv → block modal, and
 * "Continue anyway" downgrades the strip to a warning.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const HESP_SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
const INGEST_TIMEOUT = 90_000;

test.describe.configure({ timeout: 180_000 });

const strip = (page: Page): Locator => page.locator('.q-pertinence');
const stripBadge = (page: Page): Locator => strip(page).locator('.q-badge');
const stripText = (page: Page): Locator => strip(page).locator('.q-pertinence-text');
const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');

async function loadHespSchema(page: Page): Promise<void> {
  await page.getByLabel('Browse schema folder').setInputFiles(HESP_SCHEMA_DIR);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge')).toHaveText('Valid');
}

test('HESP schema + hesp_dirty_100.csv → 265/265 OK strip', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await expect(strip(page)).toBeHidden(); // schema alone is not enough

  await datasetInput(page).setInputFiles(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv'));

  await expect(strip(page)).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(stripBadge(page)).toHaveText('OK');
  await expect(stripText(page)).toHaveText(
    'Pertinence: 265/265 schema variables present · 0 missing · 1 extra',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('tiny/people.csv against the HESP schema → block modal, continue → warning', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await datasetInput(page).setInputFiles(join(FIXTURES, 'tiny', 'people.csv'));

  const dialog = page.getByRole('dialog', { name: "This data doesn't match the schema" });
  await expect(dialog).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(dialog).toContainText("None of the schema's 265 variables appear in this dataset");

  await dialog.getByRole('button', { name: 'Continue anyway' }).click();
  await expect(dialog).toBeHidden();

  await expect(strip(page)).toBeVisible();
  await expect(stripBadge(page)).toHaveText('Warning');
  await expect(stripText(page)).toHaveText(
    'Pertinence: 0/265 schema variables present · 265 missing · 5 extra',
  );
});

test('block modal dismissal keeps the Blocked strip with an inline continue', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await datasetInput(page).setInputFiles(join(FIXTURES, 'tiny', 'people.csv'));

  const dialog = page.getByRole('dialog', { name: "This data doesn't match the schema" });
  await expect(dialog).toBeVisible({ timeout: INGEST_TIMEOUT });
  await dialog.getByRole('button', { name: 'Load a different file' }).click();
  await expect(dialog).toBeHidden();

  await expect(stripBadge(page)).toHaveText('Blocked');
  await strip(page).getByRole('button', { name: 'Continue anyway' }).click();
  await expect(stripBadge(page)).toHaveText('Warning');
});
