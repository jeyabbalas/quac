/**
 * P16 golden journey 6: a data= URL pointing at a host without CORS headers
 * fails with the typed FETCH_CORS message + the "which hosts work?" table, and
 * the drop zone stays active so a manual upload recovers.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const CORS = 'http://localhost:4199';
const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 180_000 });

test('non-CORS data= URL → typed message + hosts popover → manual upload succeeds', async ({
  page,
}) => {
  const blocked = `${CORS}/no-cors/hesp/data/hesp_dirty_100.csv`;
  await page.goto(`/quac/#/load?data=${encodeURIComponent(blocked)}`);

  const dataCard = page.locator('[data-slot="data"]');
  // The cross-origin fetch is blocked → FETCH_CORS surfaces on the slot.
  await expect(dataCard.locator('.q-badge')).toHaveText('Error', { timeout: INGEST_TIMEOUT });
  await expect(dataCard.locator('.q-slotcard-summary')).toContainText("Couldn't fetch");

  // The "which hosts work?" table is offered and lists a known-good host.
  const help = dataCard.locator('.q-corshelp');
  await expect(help).toBeVisible();
  await help.locator('summary', { hasText: 'Which hosts work?' }).click();
  await expect(help).toContainText('raw.githubusercontent.com');

  // The drop zone stayed active: a manual upload recovers.
  await expect(dataCard.locator('.q-dropzone')).toBeEnabled();
  await dataCard
    .locator('input[type="file"]')
    .setInputFiles(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv'));
  await expect(dataCard.locator('.q-badge')).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(dataCard.locator('.q-corshelp')).toHaveCount(0); // cleared on the new attempt
});
