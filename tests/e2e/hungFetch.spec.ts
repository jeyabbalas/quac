/**
 * Golden journey 12 (UX-04): a slow fetch is visible, and the way out is on
 * screen. The review's repro, with a route that never fulfills standing in for
 * the throwaway host that never answered. Both check-source slots, each in two
 * halves: while the request hangs the card must read `Loading…` with its Clear
 * showing and ENABLED (`ingestion.md` §1, `ui-design.md` §5 — that Clear IS the
 * cancel for a no-timeout fetch); and pressing it must return the slot AND its
 * URL field to a usable empty state, since a hung request's settle never comes.
 *
 * Before the fix both cards sat at `Empty` with the Clear hidden for as long as
 * the host held the response — the schema slot with no other signal at all, and
 * the rules slot with a `Fetching…` latch that a clear could not release.
 */
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const HUNG_SCHEMA = 'http://localhost:4173/hung/core.schema.json';
const HUNG_RULES = 'http://localhost:4173/hung/rules.quac.csv';

const LOADING_TIMEOUT = 30_000;
test.describe.configure({ timeout: 120_000 });

const badge = (page: Page, slot: string): Locator =>
  page.locator(`[data-slot="${slot}"] .q-slotcard-header .q-badge`).first();
const summary = (page: Page, slot: string): Locator =>
  page.locator(`[data-slot="${slot}"] .q-slotcard-summary`);
const fetchButton = (page: Page, slot: string): Locator =>
  page.locator(`[data-slot="${slot}"] .q-urlfield-btn`);
const urlInput = (page: Page, slot: string): Locator =>
  page.locator(`[data-slot="${slot}"] .q-urlfield-input`);

/** Hold the request open for the life of the test — never fulfilled, never
 *  aborted, which is precisely the condition the Clear exists for. */
async function routeIntoTheVoid(page: Page, url: string): Promise<void> {
  await page.route(url, () => {
    /* deliberately no fulfill/abort */
  });
}

test('a hung schema fetch shows Loading, and Clear cancels it', async ({ page }) => {
  await routeIntoTheVoid(page, HUNG_SCHEMA);
  await page.goto('/quac/');

  await page.getByLabel('Schema URL').fill(HUNG_SCHEMA);
  await page.locator('[data-slot="schema"]').getByRole('button', { name: 'Fetch' }).click();

  // The whole point: while the host holds the response, the card says so.
  await expect(badge(page, 'schema')).toHaveText('Loading…', { timeout: LOADING_TIMEOUT });
  await expect(summary(page, 'schema')).toHaveText('Loading schema files…');
  await expect(fetchButton(page, 'schema')).toHaveText('Fetching…');

  // Clear is VISIBLE and ENABLED — hidden here was the review's finding, and
  // disabled would be just as useless.
  const clear = page.getByRole('button', { name: 'Clear JSON Schema' });
  await expect(clear).toBeVisible();
  await expect(clear).toBeEnabled();

  await clear.click();

  // Cancelled: the slot is empty again and the field is typeable, even though
  // the request it belonged to will never settle.
  await expect(badge(page, 'schema')).toHaveText('Empty');
  await expect(clear).toBeHidden();
  await expect(fetchButton(page, 'schema')).toHaveText('Fetch');
  await expect(fetchButton(page, 'schema')).toBeEnabled();
  await expect(urlInput(page, 'schema')).toBeEnabled();
});

test('a hung rules fetch shows Loading, and Clear releases its busy latch', async ({ page }) => {
  await routeIntoTheVoid(page, HUNG_RULES);
  await page.goto('/quac/');

  await page.getByLabel('Rules URL').fill(HUNG_RULES);
  await page.locator('[data-slot="rules"]').getByRole('button', { name: 'Fetch' }).click();

  // addRuleUrls used to publish nothing until the bytes were in hand, so this
  // window projected as `empty` no matter how the projection was ordered.
  await expect(badge(page, 'rules')).toHaveText('Loading…', { timeout: LOADING_TIMEOUT });
  await expect(summary(page, 'rules')).toHaveText('Loading rules files…');

  const clear = page.getByRole('button', { name: 'Clear QC rules' });
  await expect(clear).toBeVisible();
  await expect(clear).toBeEnabled();

  await clear.click();

  await expect(badge(page, 'rules')).toHaveText('Empty');
  await expect(clear).toBeHidden();
  // The card's own busy latch releases too: its finally() belongs to a fetch
  // that never settles, so without the cancel the field stays dead at
  // `Fetching…` over an Empty card — two surfaces disagreeing again.
  await expect(fetchButton(page, 'rules')).toHaveText('Fetch');
  await expect(fetchButton(page, 'rules')).toBeEnabled();
  await expect(urlInput(page, 'rules')).toBeEnabled();

  // And it is genuinely usable: a second fetch starts rather than being
  // refused by a latch nobody released.
  await page.getByLabel('Rules URL').fill(HUNG_RULES);
  await page.locator('[data-slot="rules"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(badge(page, 'rules')).toHaveText('Loading…', { timeout: LOADING_TIMEOUT });
});
