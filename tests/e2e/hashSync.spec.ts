/**
 * UIX-10 golden journey 10 (UX-02): the address bar tracks the LIVE inputs, not
 * just the link you arrived on. Three passes against the CORS fixture host:
 * (1) a URL-loaded dataset REPLACED by another URL — the bar swaps too, and the
 * reload hands back the replacement; (2) the mirror — clear-all empties the
 * fragment, and a dataset loaded by URL afterwards puts `data=` back, surviving
 * a reload; (3) an upload over a URL-loaded slot DROPS `data=`, because an
 * upload contributes no source URL and must not leave a link that re-fetches
 * the file it replaced.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const LOCAL_DATA = join(FIXTURES, 'tiny', 'people.csv');
const CORS = 'http://localhost:4199';
const CSV = `${CORS}/hesp/data/hesp_dirty_100.csv`;
const PARQUET = `${CORS}/hesp/data/hesp_dirty_100.parquet`;

const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 300_000 });

const datasetBadge = (page: Page): Locator => page.locator('[data-slot="data"] .q-badge');
const datasetSummary = (page: Page): Locator =>
  page.locator('[data-slot="data"] .q-slotcard-summary');
const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');

async function fetchDatasetUrl(page: Page, url: string): Promise<void> {
  await page.getByLabel('Dataset URL').fill(url);
  await page.locator('[data-slot="data"]').getByRole('button', { name: 'Fetch' }).click();
}

test('a replaced dataset URL lands in the bar, and the reload keeps it', async ({ page }) => {
  await page.goto(`/quac/#/load?data=${encodeURIComponent(CSV)}`);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText('hesp_dirty_100.csv');

  // Replace it with the Parquet of the same data through the URL field.
  await fetchDatasetUrl(page, PARQUET);
  await expect(datasetSummary(page)).toContainText('hesp_dirty_100.parquet', {
    timeout: INGEST_TIMEOUT,
  });

  // The bar follows the card — the CSV is gone from it entirely (UX-02).
  await expect(page).toHaveURL(new RegExp(`data=${encodeURIComponent(PARQUET)}$`));
  expect(page.url()).not.toContain('.csv');

  // …and the reload restores the Parquet, not the link we arrived on.
  await page.reload();
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText('hesp_dirty_100.parquet');
});

test('clear all → load by URL: the fragment regains data= and survives a reload', async ({
  page,
}) => {
  await page.goto(`/quac/#/load?data=${encodeURIComponent(CSV)}`);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await page.getByRole('button', { name: 'Clear all inputs' }).click();
  await page
    .getByRole('dialog', { name: 'Clear all inputs?' })
    .getByRole('button', { name: 'Clear all inputs' })
    .click();
  await expect(datasetBadge(page)).toHaveText('Empty');
  await expect(page).toHaveURL(/#\/load$/);

  // The bare fragment must GAIN the param — before UIX-10 it stayed bare and
  // the reload lost an input that had been loaded by URL.
  await fetchDatasetUrl(page, CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(page).toHaveURL(new RegExp(`data=${encodeURIComponent(CSV)}$`));

  await page.reload();
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText('hesp_dirty_100.csv');
});

test('an upload over a URL-loaded slot drops data= — uploads cannot travel in a link', async ({
  page,
}) => {
  await page.goto(`/quac/#/load?data=${encodeURIComponent(CSV)}`);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await datasetInput(page).setInputFiles(LOCAL_DATA);
  await expect(datasetSummary(page)).toContainText('people.csv', { timeout: INGEST_TIMEOUT });

  await expect(page).toHaveURL(/#\/load$/);
});
