/**
 * P19 task 7 — `prefers-reduced-motion: reduce` end to end.
 *
 * `nav.spec.ts` already pins the demo modal's static case (duck hidden, bar
 * still readable) and is left alone. This spec covers the parts that only
 * exist during real work: the ingest/run progress surfaces, the WAAPI
 * reveal/collapse helpers that must still END in `[hidden]`, and the Studio
 * rail collapse whose fade is skipped.
 *
 * The rule throughout: reduced motion removes MOVEMENT, never information or
 * state. Every assertion here is "the end state is still correct".
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

/** Elements that must not be mid-animation at any point we assert. */
const animationCount = (page: Page, selector: string): Promise<number> =>
  page.locator(selector).evaluateAll((els) => els.flatMap((el) => el.getAnimations()).length);

test('progress surfaces render un-animated and still reach their end states', async ({ page }) => {
  // Emulated per test, as nav.spec does — the media query is read at call time
  // by the WAAPI helpers, so it has to be in place before the first render.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();

  // The ingest DuckProgress is indeterminate — the duck is gone and its fill
  // carries no animation, but the bar itself is still there and still says
  // what is happening.
  const bar = page.locator('.q-duckprogress').first();
  await expect(bar).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(page.locator('.q-duckprogress-duck').first()).toBeHidden();
  expect(await animationCount(page, '.q-duckprogress-fill')).toBe(0);

  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  await page.locator('.q-runbar-button').click();
  const runCard = page.locator('.q-run-progress');
  await expect(runCard).toBeVisible({ timeout: 30_000 });
  // revealProgressSurface early-returns under reduced motion: shown, not grown.
  expect(await animationCount(page, '.q-run-progress')).toBe(0);
  // The run bar stays determinate — aria-valuenow is the state, not the motion.
  await expect(runCard.locator('[role="progressbar"]')).toHaveAttribute('aria-valuenow', /\d+/);

  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  // collapseProgressSurface must still END in [hidden] — the attribute is the
  // authority for visibility, animated or not.
  await expect(runCard).toBeHidden({ timeout: RUN_TIMEOUT });
});

test('the Studio rail collapses with no animation and keeps its state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  const toggle = page.locator('.q-studio-railtoggle');
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await toggle.click();
  await expect(page.locator('.q-studio-layout--railclosed')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // Expanding is the direction that fades (studioWorkspace.ts) — and the fade
  // is the thing reduced motion drops.
  await toggle.click();
  expect(await animationCount(page, '.q-studio-rail, .q-studio-rail *')).toBe(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Collapsed or not, every file stays reachable.
  await expect(page.locator('.q-filebtn')).toHaveCount(3);
});
