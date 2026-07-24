/**
 * P14 demo affordance (user-approved scope): the "Load example files" button
 * fills all three slots from the site-hosted /quac/examples/ bundle — the
 * exact journey the deployed prototype demos.
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
  // The pertinence strip confirms the example set matches itself.
  await expect(page.locator('.q-pertinence-text')).toContainText('265/265', {
    timeout: INGEST_TIMEOUT,
  });
});
