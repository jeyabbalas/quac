/**
 * The data dictionary's Semantic search switch, end to end: the LEAF model
 * loads from this site into its worker, the dictionary is embedded, and a
 * search lists variables related in meaning that share no word with the query.
 * Headless Chromium has no WebGPU adapter, so this is the WebAssembly path
 * (q8 weights); the WebGPU path (fp16) was checked by hand in Chrome.
 *
 * Then the switch's promises about what it keeps (semanticSearch.ts): its
 * position survives a reload; the vectors live in QuaC's own `quac-semantic`
 * database only while it is on, and go when it goes off or the JSON Schema is
 * cleared.
 *
 * The query is "getting fired": no HESP variable has either word, and LEAF-IR
 * puts the two layoff variables 0.05 above the library's 0.25 floor on q8
 * (0.306 and 0.300, measured), so this does not hang on a rounding error.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const INGEST_TIMEOUT = 90_000;
// Model load + embedding 417 texts single-threaded: 9 s on an M-series
// laptop; CI runners are slower.
const SEMANTIC_TIMEOUT = 180_000;
test.describe.configure({ timeout: 420_000 });

const QUERY = 'getting fired';

const dictionary = (page: Page): Locator => page.locator('.q-dd json-data-dictionary');
const semanticSwitch = (page: Page): Locator =>
  page.getByRole('checkbox', { name: 'Semantic search' });
const status = (page: Page): Locator => dictionary(page).locator('[data-dd-semantic-status]');
const search = (page: Page): Locator =>
  dictionary(page).getByRole('searchbox', { name: 'Search variables' });
const relatedRow = (page: Page, name: string): Locator =>
  dictionary(page)
    .locator('[data-dd-results] [data-dd-row][data-dd-match="related"]')
    .filter({ hasText: name });

const databases = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? ''));

async function openDictionary(page: Page): Promise<void> {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(page.locator('.q-preview-pertinence-text')).toContainText(
    'the dataset, JSON Schema, and QC rules all describe the same variables',
    { timeout: INGEST_TIMEOUT },
  );
  await page.locator('.q-preview .q-paneltab', { hasText: 'JSON Schema' }).click();
  await expect(dictionary(page).locator('[data-dd-category]')).toHaveCount(12, {
    timeout: 30_000,
  });
}

test('off by default; on, a search also lists variables related in meaning', async ({ page }) => {
  await openDictionary(page);

  // Off: keyword search only, and nothing matches these words.
  await expect(semanticSwitch(page)).not.toBeChecked();
  await expect(status(page)).toHaveCount(0);
  await search(page).fill(QUERY);
  await expect(dictionary(page).locator('[data-dd-count]')).toHaveText('0 / 265 variables');

  // On: the typed query runs again once the model is in.
  await semanticSwitch(page).check();
  await expect(status(page)).toHaveText('Semantic search on', { timeout: SEMANTIC_TIMEOUT });
  await expect(search(page)).toHaveValue(QUERY);
  await expect(relatedRow(page, 'resp_laid_off_12m')).toHaveCount(1);
  await expect(relatedRow(page, 'partner_laid_off_12m')).toHaveCount(1);
  await expect(dictionary(page).locator('[data-dd-count]')).toHaveText(/ · \d+ related$/);
  expect(await databases(page)).toContain('quac-semantic');

  // The switch is a preference: a reload finds it on, and the dictionary
  // searchable again — from the vectors QuaC kept, without embedding anew.
  await page.reload();
  await page.locator('.q-preview .q-paneltab', { hasText: 'JSON Schema' }).click();
  await expect(semanticSwitch(page)).toBeChecked({ timeout: INGEST_TIMEOUT });
  await expect(status(page)).toHaveText('Semantic search on', { timeout: SEMANTIC_TIMEOUT });
  await search(page).fill(QUERY);
  await expect(relatedRow(page, 'resp_laid_off_12m')).toHaveCount(1);

  // Off: the related rows go, the query stays, and so do the vectors' store
  // and the preference.
  await semanticSwitch(page).uncheck();
  await expect(status(page)).toHaveCount(0);
  await expect(search(page)).toHaveValue(QUERY);
  await expect(dictionary(page).locator('[data-dd-count]')).toHaveText('0 / 265 variables');
  await expect.poll(() => databases(page)).not.toContain('quac-semantic');
  expect(
    await page.evaluate(() => localStorage.getItem('quac.dictionary.semanticSearch')),
  ).toBeNull();
});

test('clearing the JSON Schema deletes its vectors; the switch stays on', async ({ page }) => {
  await openDictionary(page);
  await semanticSwitch(page).check();
  await expect(status(page)).toHaveText('Semantic search on', { timeout: SEMANTIC_TIMEOUT });
  expect(await databases(page)).toContain('quac-semantic');

  await page.getByRole('button', { name: 'Clear JSON Schema' }).click();
  await expect(page.getByText('Load a JSON Schema to see it here.')).toBeVisible();
  await expect.poll(() => databases(page)).not.toContain('quac-semantic');
  expect(await page.evaluate(() => localStorage.getItem('quac.dictionary.semanticSearch'))).toBe(
    '1',
  );
});
