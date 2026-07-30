/**
 * The one correct way to wait for "Load example files" to finish (P22 C1).
 *
 * The obvious wait — the three slot badges reading `Valid` — does not gate
 * anything, because `summarizeSlot` (`src/core/rules/rules-store.ts`) returns
 * `status: 'valid'` in TWO states, with a window between them:
 *
 *   1. files parsed, no dataset lint yet   → detail `… · data checks pending`
 *   2. the VARCHAR window — `rulesSlotCard.ts` installs the lint context
 *      against the all-VARCHAR `quac_work`, so 12 of the 22 example rules
 *      fail the SQL dry-run and are excluded (V23) → badge `Warning`
 *   3. `typedSync.ts` finishes the typed rebuild and reinstalls the context
 *      → all 22 rules lint clean → detail `3 files · 22 rules`
 *
 * A test that proceeds at state 1 can start its run inside state 2 and get a
 * report built from 10 rules instead of 22 — the `download.spec` flake
 * (4 failures in 6 repeats at `--workers=6`) that phase 17 first recorded.
 *
 * The summary text is the only signal that separates state 3 from state 1, so
 * that is what this waits on. `toHaveText` — not `toContainText` — is
 * load-bearing: the latter also matches state 1's `… · data checks pending`,
 * which is exactly the bug.
 */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** DuckDB init + a 14-file schema + three rules files, on CI hardware. */
export const EXAMPLE_INGEST_TIMEOUT = 90_000;

/** The example bundle's settled rules summary — reachable only post-rebuild. */
export const EXAMPLE_RULES_SUMMARY = '3 files · 22 rules';

/**
 * Wait for an example load already in flight to reach state 3 above: every
 * slot valid AND the rules re-linted against the typed table, so a run
 * started after this executes all 22 rules.
 */
export async function expectExampleSettled(page: Page): Promise<void> {
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: EXAMPLE_INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: EXAMPLE_INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    {
      timeout: EXAMPLE_INGEST_TIMEOUT,
    },
  );
  // The gate. Everything above it is satisfied by state 1 as well.
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toHaveText(
    EXAMPLE_RULES_SUMMARY,
    { timeout: EXAMPLE_INGEST_TIMEOUT },
  );
}

/** Click "Load example files" and wait for the session to settle. */
export async function loadExampleSession(page: Page): Promise<void> {
  await page.locator('.q-example-load').click();
  await expectExampleSettled(page);
}
