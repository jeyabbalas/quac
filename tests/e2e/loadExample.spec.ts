/**
 * P14 demo affordance (user-approved scope): the "Load example files" button
 * fills all three slots from the site-hosted /quac/examples/ bundle — the
 * exact journey the deployed prototype demos. UIX-10 adds the second half: the
 * example loads through the stores like any other URL load, so the one click
 * also writes the whole set into the address bar and a reload restores it.
 */
import { expect, test } from '@playwright/test';
import {
  EXAMPLE_RULES_SUMMARY,
  expectExampleSettled,
  loadExampleSession,
} from './support/exampleSession';

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
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    {
      timeout: INGEST_TIMEOUT,
    },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  // `toHaveText`, not `toContainText`: the settled summary is the ONLY signal
  // that the rules have been re-linted against the typed table, and the looser
  // matcher also passes on `… · data checks pending` (see exampleSession.ts).
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toHaveText(
    EXAMPLE_RULES_SUMMARY,
    { timeout: INGEST_TIMEOUT },
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
  await loadExampleSession(page);

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
  // The restore replays the same load path, so it goes through the same
  // VARCHAR window — settle on it rather than on the badges alone.
  await expectExampleSettled(page);
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toContainText(
    'hesp_dirty_100.csv',
  );
});

/**
 * UIX-17 / golden journey 15 — UX-09. This is the only path that produces the
 * long ids: `Load example files` fetches by URL, so `fileId` is the retrieval
 * URL and `schema:advisory:<fileId>` runs to 106 characters. (runQc.spec
 * UPLOADS the 14 schema files, where `fileId` is the short relativePath, so it
 * cannot reach this case.) The advisory message already names the file in
 * short form, so the prefix printed it twice and pushed the sentence down.
 */
test('Findings: a URL-loaded schema id does not open the row (UX-09)', async ({ page }) => {
  await page.goto('/quac/');
  await loadExampleSession(page);
  await expect(page.locator('.q-runbar-button')).toBeEnabled({ timeout: INGEST_TIMEOUT });

  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: INGEST_TIMEOUT });
  await page.locator('.q-report-panels .q-paneltab', { hasText: 'Findings' }).click();

  const advisory = page
    .locator('.q-findings-list li')
    .filter({ has: page.locator('.q-finding-id', { hasText: 'schema:advisory:http' }) })
    .first();
  await expect(advisory).toBeVisible();

  // The sentence leads, and names the file ONCE — in its own short form.
  const message = advisory.locator('.q-finding-message');
  await expect(message).toHaveText(/^Schema note \(/);
  expect(await message.innerText()).not.toContain('http');
  // The full id survives, on its own line, still selectable.
  await expect(advisory.locator('.q-finding-id')).toHaveText(/^schema:advisory:https?:\/\//);

  // Pass E guard: the long id must not reintroduce horizontal overflow.
  for (const width of [1440, 1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => {
      const list = document.querySelector('.q-findings-list');
      return {
        list: list === null ? -1 : list.scrollWidth - list.clientWidth,
        page: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(overflow.list, `findings list @${String(width)}`).toBeLessThanOrEqual(1);
    expect(overflow.page, `page @${String(width)}`).toBeLessThanOrEqual(1);
  }
});
