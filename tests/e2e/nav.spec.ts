import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Raw fragment from href — location.hash percent-decodes in some browsers,
// and these tests assert byte-for-byte preservation.
const rawHash = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const href = window.location.href;
    const i = href.indexOf('#');
    return i === -1 ? '' : href.slice(i);
  });

test('default view is Load with the privacy line and hidden siblings', async ({ page }) => {
  await page.goto('/quac/');

  await expect(page.getByRole('link', { name: 'Load' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'JSON Schema' })).toBeVisible();
  await expect(page.getByText('No flags yet.')).toBeHidden();
  await expect(page.getByText('Compose, test, and export QC rules')).toBeHidden();
  // Exactly one instance in the DOM (strict mode) — it lives in the footer.
  await expect(
    page.getByText('Your data never leaves this browser. No uploads, no servers, no storage.'),
  ).toBeVisible();
});

test('tab clicks update the hash and the visible view', async ({ page }) => {
  await page.goto('/quac/');

  await page.getByRole('link', { name: 'QC Report' }).click();
  expect(await rawHash(page)).toBe('#/report');
  await expect(page.getByText('No flags yet.')).toBeVisible();
  await expect(page.getByText('Run QC and see what floats up.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'JSON Schema' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'QC Report' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('link', { name: 'Load' })).not.toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  expect(await rawHash(page)).toBe('#/studio');
  await expect(page.getByText('Compose, test, and export QC rules', { exact: false })).toBeVisible();
});

test('deep link #/studio lands on Studio', async ({ page }) => {
  await page.goto('/quac/#/studio');

  await expect(page.getByRole('link', { name: 'Rule Studio' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('Compose, test, and export QC rules', { exact: false })).toBeVisible();
});

test('unknown routes render Load without rewriting the address bar', async ({ page }) => {
  await page.goto('/quac/#/nope?keep=1');

  await expect(page.getByRole('heading', { name: 'JSON Schema' })).toBeVisible();
  expect(await rawHash(page)).toBe('#/nope?keep=1'); // read-only: no normalization

  await page.getByRole('link', { name: 'QC Report' }).click();
  expect(await rawHash(page)).toBe('#/report?keep=1');
});

test('navigation preserves repeated keys, order, and percent escapes', async ({ page }) => {
  await page.goto('/quac/#/load?schema=b&schema=a&x=%2F%25');

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  expect(await rawHash(page)).toBe('#/studio?schema=b&schema=a&x=%2F%25');
});

test('browser history walks back and forward through tabs', async ({ page }) => {
  await page.goto('/quac/');
  await page.getByRole('link', { name: 'QC Report' }).click();
  await page.getByRole('link', { name: 'Rule Studio' }).click();

  await page.goBack();
  expect(await rawHash(page)).toBe('#/report');
  await expect(page.getByText('No flags yet.')).toBeVisible();

  await page.goForward();
  expect(await rawHash(page)).toBe('#/studio');
  await expect(page.getByText('Compose, test, and export QC rules', { exact: false })).toBeVisible();
});

test('keyboard: disabled Share is skipped; Enter activates a tab and keeps focus', async ({
  page,
}) => {
  await page.goto('/quac/');

  await page.keyboard.press('Tab'); // Share is disabled → first stop is the GitHub link
  await expect(page.getByRole('link', { name: 'QuaC on GitHub' })).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Load' })).toBeFocused();

  await page.keyboard.press('Tab');
  const reportTab = page.getByRole('link', { name: 'QC Report' });
  await expect(reportTab).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.getByText('No flags yet.')).toBeVisible();
  await expect(reportTab).toBeFocused(); // focus does not jump on view switch
});

test('report pill stays hidden at zero findings', async ({ page }) => {
  await page.goto('/quac/');

  await expect(page.locator('.q-pill')).toBeHidden();
  // Accessible name is a stable "QC Report" while the pill is hidden.
  await expect(page.getByRole('link', { name: 'QC Report', exact: true })).toBeVisible();
});

test('demo modal traps focus, closes on Esc, and restores focus', async ({ page }) => {
  await page.goto('/quac/');

  const studioTab = page.getByRole('link', { name: 'Rule Studio' });
  await studioTab.focus();
  await page.evaluate(() => {
    window.__quac?.openDemoModal();
  });

  const dialog = page.getByRole('dialog', { name: 'QuaC preview' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  const closeButton = dialog.getByRole('button', { name: 'Close' });
  const gotIt = dialog.getByRole('button', { name: 'Got it' });
  await expect(closeButton).toBeFocused(); // initial focus = first focusable

  await page.keyboard.press('Tab');
  await expect(gotIt).toBeFocused();
  await page.keyboard.press('Tab'); // wraps forward
  await expect(closeButton).toBeFocused();
  await page.keyboard.press('Shift+Tab'); // wraps backward
  await expect(gotIt).toBeFocused();

  // Both DuckProgress modes render; the determinate one reports 62%.
  await expect(page.getByRole('progressbar')).toHaveCount(2);
  await expect(page.locator('[role="progressbar"][aria-valuenow="62"]')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(studioTab).toBeFocused(); // restored to the opener
});

test('reduced motion hides the duck but keeps the progress bar', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/quac/');
  await page.evaluate(() => {
    window.__quac?.openDemoModal();
  });

  await expect(page.getByRole('dialog', { name: 'QuaC preview' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(2);
  const ducks = page.locator('.q-duckprogress-duck');
  await expect(ducks).toHaveCount(2);
  for (const duck of await ducks.all()) {
    await expect(duck).toBeHidden();
  }
  await expect(page.locator('[role="progressbar"][aria-valuenow="62"]')).toBeVisible();
});
