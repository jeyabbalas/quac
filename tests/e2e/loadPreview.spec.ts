/**
 * UIX-4: the Load view's tabbed Preview over all three inputs. Driven from the
 * bundled example (loadExample.spec's idiom) because the data dictionary needs
 * a real 14-file schema set to be worth asserting on.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 240_000 });

const tab = (page: Page, name: string) =>
  page.locator('.q-preview .q-paneltab', { hasText: name });

async function loadExample(page: Page): Promise<void> {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(page.locator('.q-pertinence-text')).toContainText('265/265', {
    timeout: INGEST_TIMEOUT,
  });
}

test('the section appears with all three tabs, Dataset selected', async ({ page }) => {
  await page.goto('/quac/');
  // Hidden on first run — the hero owns the page.
  await expect(page.locator('.q-preview')).toBeHidden();

  await loadExample(page);

  await expect(page.locator('.q-preview')).toBeVisible();
  for (const name of ['Dataset', 'Data dictionary', 'QC rules']) {
    await expect(tab(page, name)).toBeVisible();
  }
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.q-preview').getByText('Preview', { exact: true })).toBeVisible();
});

test('the dataset type row flips from VARCHAR to the schema cast', async ({ page }) => {
  // The typedRevision regression: installTypedSync re-points the `data` view at
  // CAST columns without bumping dataset.generation, so a generation-only key
  // left every column reading VARCHAR for ever after a schema loaded.
  await loadExample(page);

  const typeRow = page.locator('.q-preview-table thead tr').nth(1);
  await expect(typeRow.locator('td').first()).toHaveText('VARCHAR'); // record_id stays text
  await expect(typeRow).toContainText('BIGINT', { timeout: INGEST_TIMEOUT });
  await expect(typeRow).toContainText('DOUBLE', { timeout: INGEST_TIMEOUT });

  await expect(page.getByText('first 50 of 101 rows · 266 columns')).toBeVisible();
  // Numeric columns right-align whole, header and type cell included.
  await expect(page.locator('.q-preview-table thead th.q-num').first()).toBeVisible();
});

test('the data dictionary lists 265 variables under 12 categories', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Data dictionary').click();

  await expect(page.locator('.q-dd-cat')).toHaveCount(12, { timeout: 30_000 });
  await expect(page.locator('.q-dd-count')).toHaveText('265 variables');

  const first = page.locator('.q-dd-cat').first();
  await expect(first.locator('.q-dd-cattitle')).toHaveText(
    'HESP CORE - Identification and survey administration',
  );
  await expect(first.locator('.q-dd-catcount')).toHaveText('16 variables');

  // The scroller is its own tab stop with its own name (axe:
  // scrollable-region-focusable), named distinctly from the tab panel.
  const scroll = page.locator('.q-dd-scroll');
  await expect(scroll).toHaveAttribute('aria-label', 'Data dictionary variables');
  await expect(scroll).toHaveAttribute('tabindex', '0');
});

test('a coded variable shows its range, sentinels and unit', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Data dictionary').click();
  await expect(page.locator('.q-dd-cat')).toHaveCount(12, { timeout: 30_000 });

  const row = page
    .locator('.q-dd-table tbody tr')
    .filter({ has: page.locator('.q-dd-name', { hasText: 'household_size' }) })
    .first();
  await expect(row).toContainText('integer + coded values');
  await expect(row).toContainText('1–20');
  await expect(row).toContainText('persons');
  // Byte-identical to tooltips.ts, so QuaC says the same thing in both places.
  await expect(row).toContainText('Missing-value codes');
  await expect(row).toContainText('-888');
});

test('search narrows the count, hides empty categories, and clears', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'Data dictionary').click();
  await expect(page.locator('.q-dd-cat')).toHaveCount(12, { timeout: 30_000 });

  const search = page.getByLabel('Search variables');
  await search.fill('household_size');
  await expect(page.locator('.q-dd-count')).toHaveText('1 of 265 variables');
  await expect(page.locator('.q-dd-cat:visible')).toHaveCount(1);
  await expect(page.locator('.q-dd-table tbody tr:visible')).toHaveCount(1);

  await search.fill('zzzz');
  await expect(page.getByText("No variables match 'zzzz'.")).toBeVisible();
  await expect(page.locator('.q-dd-cat:visible')).toHaveCount(0);

  await search.fill('');
  await expect(page.locator('.q-dd-count')).toHaveText('265 variables');
  await expect(page.locator('.q-dd-cat:visible')).toHaveCount(12);
});

test('the QC rules panel shows its placeholder and rule counts', async ({ page }) => {
  await loadExample(page);
  await tab(page, 'QC rules').click();

  const panel = page.locator('#q-preview-panel-rules');
  await expect(panel.locator('.q-preview-meta')).toHaveText('3 files · 22 rules');
  await expect(panel.getByText('A preview of your QC rules will appear here.')).toBeVisible();
});

test('empty slots show notes rather than hiding their tabs', async ({ page }) => {
  await page.goto('/quac/');
  // Dataset only: the other two tabs must still exist, each explaining itself.
  await page
    .locator('[data-slot="data"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'tiny', 'people.csv'));
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  await expect(page.locator('.q-preview')).toBeVisible();
  // The whole dataset fits, so the meta line drops the "first N of".
  await expect(page.getByText('12 rows · 5 columns')).toBeVisible();

  await tab(page, 'Data dictionary').click();
  await expect(page.getByText('Load a JSON Schema to see its data dictionary.')).toBeVisible();
  await tab(page, 'QC rules').click();
  await expect(page.getByText('Load a QC rules file to see it here.')).toBeVisible();
});

test('the tablist is one tab stop and the arrow keys move and select', async ({ page }) => {
  await loadExample(page);

  await tab(page, 'Dataset').focus();
  await expect(tab(page, 'Dataset')).toHaveAttribute('tabindex', '0');
  await expect(tab(page, 'Data dictionary')).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Data dictionary')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Data dictionary')).toBeFocused();

  await page.keyboard.press('End');
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowRight'); // wraps
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Home');
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');
});

test('the first click on a non-default tab sticks', async ({ page }) => {
  // Regression: the visibility effect used to read the signal it wrote, so
  // active.set() re-entered it while `pinned` was still false and bounced the
  // very first selection back to Dataset.
  await loadExample(page);

  await tab(page, 'QC rules').click();
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1000); // outlast any late store settling
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');
});
