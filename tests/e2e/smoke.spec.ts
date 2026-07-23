import { expect, test } from '@playwright/test';

test('shell serves under /quac/ with header, logo, and favicon', async ({ page }) => {
  const notFound: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });

  await page.goto('/quac/');

  await expect(page).toHaveTitle('QuaC');
  await expect(page.getByRole('heading', { name: 'QuaC' })).toBeVisible();
  await expect(page.getByText('in-browser data quality control')).toBeVisible();
  await expect(
    page.getByText('Your data never leaves this browser. No uploads, no servers, no storage.'),
  ).toBeVisible();

  // .q-logo: the header gained a second img (GitHub icon) in P04 — keep strict mode happy
  const logo = page.locator('header img.q-logo');
  await expect(logo).toBeVisible();
  await expect
    .poll(() => logo.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  const favicon = await page.request.get('/quac/favicon.svg');
  expect(favicon.status()).toBe(200);

  expect(notFound).toEqual([]);
});
