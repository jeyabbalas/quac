/**
 * P14 demo affordance (user-approved scope): the "Load example files" button
 * fills all three slots from the site-hosted /quac/examples/ bundle — the
 * exact journey the deployed prototype demos. UIX-10 adds the second half: the
 * example loads through the stores like any other URL load, so the one click
 * also writes the whole set into the address bar and a reload restores it.
 */
import { expect, test } from '@playwright/test';

const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 180_000 });

test('one click fills all three slots and enables Run QC', async ({ page }) => {
  await page.goto('/quac/');

  await page.locator('.q-example-load').click();

  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toContainText(
    'hesp_dirty_100.csv',
  );
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toContainText(
    '3 files · 22 rules',
  );

  await expect(page.locator('.q-runbar-button')).toBeEnabled();
  // The Preview head confirms the example set matches itself, on all three edges.
  await expect(page.locator('.q-preview-pertinence .q-badge')).toHaveText('OK', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('.q-preview-pertinence-text')).toHaveText(
    'Inputs look consistent — the dataset, JSON Schema, and QC rules all describe the same variables.',
  );
});

test('the one click also fills the address bar, and a reload restores all three slots', async ({
  page,
}) => {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
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

  // UIX-10: the hero bypasses the schema and rules cards and writes the stores
  // directly — the store-driven writer covers it anyway. Accepted consequence
  // of decision 1: a reload restores the example rather than showing first-run.
  await expect(page).toHaveURL(/schema=/);
  await expect(page).toHaveURL(/rules=/);
  await expect(page).toHaveURL(/data=/);

  // UX-07: exactly ONE schema crawl base. The other 13 files are $ref-reachable
  // from the root, so listing them all bought nothing and cost the deployed
  // link 2062 chars — over the 2,000-char portability limit. The schema slot
  // still resolves the whole set, which the summary below proves.
  expect(page.url().match(/schema=/g)).toHaveLength(1);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-summary')).toContainText(
    '14 files · root: core/core.schema.json',
  );

  await page.reload();
  await expect(page.locator('.q-example')).toBeHidden();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toContainText(
    'hesp_dirty_100.csv',
  );
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toContainText(
    '3 files · 22 rules',
  );
});
