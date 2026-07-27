/**
 * P16 golden journey 4: load an ambiguous-root schema by URL, resolve the index
 * via the modal, upload a rules file, then open Share — the assembled link
 * carries index= (so recipients skip the modal) and the uploaded rules file is
 * listed excluded with the "host it by URL" explanation.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const CORS = 'http://localhost:4199';
const LOAD_TIMEOUT = 60_000;
test.describe.configure({ timeout: 180_000 });

test('resolve ambiguous index → Share link has index=, uploaded rules excluded', async ({
  page,
}) => {
  await page.goto('/quac/');

  // Load both roots by URL (space-separated) → ambiguous → IndexPickerModal.
  const a = `${CORS}/synthetic/two-roots/a.schema.json`;
  const b = `${CORS}/synthetic/two-roots/b.schema.json`;
  await page.locator('[data-slot="schema"]').getByLabel('Schema URL').fill(`${a} ${b}`);
  await page.locator('[data-slot="schema"]').getByRole('button', { name: 'Fetch' }).click();

  const modal = page.getByRole('dialog', { name: 'Choose the index schema' });
  await expect(modal).toBeVisible({ timeout: LOAD_TIMEOUT });
  await modal.getByRole('radio', { name: /Root A/ }).check();
  await modal.getByRole('button', { name: 'Use this file' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText('Valid');

  // Upload a rules file (an upload → excluded from any link).
  await page
    .locator('[data-slot="rules"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'tiny', 'people_rules.quac.csv'));
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).not.toHaveText(
    'Empty',
    { timeout: LOAD_TIMEOUT },
  );

  // Open Share.
  await page.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share this configuration' });
  await expect(share).toBeVisible();

  // The assembled link carries both schema bases + index= (the resolved root A).
  const link = share.locator('.q-share-link-input');
  await expect(link).toHaveValue(/index=/);
  await expect(link).toHaveValue(new RegExp(encodeURIComponent('a.schema.json')));
  // The index-included callout is shown.
  await expect(share).toContainText("recipients won't be asked to pick");

  // The uploaded rules file is listed excluded with the explanation.
  const rulesRow = share.locator('.q-share-item', { hasText: 'people_rules.quac.csv' });
  await expect(rulesRow).toHaveClass(/q-share-item--out/);
  await expect(rulesRow).toContainText("Uploaded files can't travel in a link");

  // Under the limit, the manifest is not offered at all.
  await expect(share.getByRole('button', { name: 'Download config manifest' })).toHaveCount(0);
  await expect(share.locator('.q-share-overlimit')).toHaveCount(0);
});

/**
 * UX-07: past 2,000 chars the modal used to REPLACE the link with the manifest
 * path, leaving `×` and a Download button as the only controls. The bundled
 * example's own link measures 2062 on the deployed origin, so the flagship
 * "Load example files → Share" path landed there. The offer must ADD, not
 * substitute. Length is driven by a query-padded dataset URL — the fixture
 * server ignores the query, and a long signed download URL is what this looks
 * like in the wild.
 */
test('an over-length link keeps its link and Copy, and offers the manifest as well', async ({
  page,
}) => {
  await page.goto('/quac/');

  const padded = `${CORS}/tiny/people.csv?token=${'x'.repeat(2000)}`;
  await page.locator('[data-slot="data"]').getByLabel('Dataset URL').fill(padded);
  await page.locator('[data-slot="data"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: LOAD_TIMEOUT,
  });

  await page.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share this configuration' });
  await expect(share).toBeVisible();

  // The regression: before the fix neither of these existed past the limit.
  const link = share.locator('.q-share-link-input');
  await expect(link).toBeVisible();
  await expect(link).toHaveValue(new RegExp(encodeURIComponent('people.csv')));
  await expect(share.locator('.q-share-copy')).toBeVisible();

  const length = (await link.inputValue()).length;
  expect(length).toBeGreaterThan(2000);
  await expect(share.locator('.q-share-count')).toHaveText(`${String(length)} characters`);

  // ...and the manifest is offered alongside, with the warning demoted to advice.
  await expect(share.locator('.q-share-overlimit')).toContainText(
    `This link is ${String(length)} characters`,
  );
  await expect(share.locator('.q-share-overlimit')).toContainText('it will work in most places');
  await expect(share.getByRole('button', { name: 'Download config manifest' })).toBeVisible();
});
