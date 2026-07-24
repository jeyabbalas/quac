/**
 * P17 Rule Studio journey — ONE long test on purpose (the example load is the
 * expensive setup): workspace mount → new file → new rule with live draft
 * lint (real DuckDB binder error via the mirrored diagnostics list — CM hover
 * tooltips are not assertable), assertion-snippet completion (typed `in_`
 * prefix, never bare Ctrl-Space), the (type,scope) matrix with auto-snap, and
 * save-to-grid with the dirty rail marker + the pinned reorder tooltip.
 */
import { expect, test } from '@playwright/test';

const INGEST_TIMEOUT = 90_000;
const LINT_TIMEOUT = 20_000; // 400 ms debounce + EXPLAIN round-trip, retried
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';

test.describe.configure({ timeout: 240_000 });

test('create a rule in the studio: draft lint, completions, matrix, save', async ({ page }) => {
  await page.goto('/quac/');

  // ---- setup: example files; wait until rules linted WITH the dataset ----
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  const rulesSummary = page.locator('[data-slot="rules"] .q-slotcard-summary');
  await expect(rulesSummary).toContainText('3 files · 22 rules', { timeout: INGEST_TIMEOUT });
  // "data checks pending" clears exactly when the dataset lint context is
  // installed — the studio's EXPLAIN draft lint depends on it.
  await expect(rulesSummary).not.toContainText('data checks pending', {
    timeout: INGEST_TIMEOUT,
  });

  // ---- studio workspace ----
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(3, { timeout: 30_000 });

  // ---- new file ----
  await page.locator('.q-studio-newfile').click();
  const newFileModal = page.getByRole('dialog', { name: 'New rules file' });
  await expect(newFileModal.locator('#q-newfile-name')).toHaveValue('my_rules');
  await newFileModal.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.q-filebtn[aria-current="true"]')).toContainText('my_rules');
  await expect(page.locator('.q-studio-gridtitle')).toHaveText('my_rules.quac.csv');
  await expect(page.locator('.q-studio-gridbody .q-panel-note')).toHaveText(
    'No rules in this file yet.',
  );

  // ---- new rule ----
  await page.locator('.q-studio-addrule').click();
  const drawer = page.locator('.q-studio-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.locator('#q-rf-id')).toBeFocused();
  await page.locator('#q-rf-id').fill('E2E1');

  // Target FIRST: with no (or unknown) targets, missing-field/pertinence
  // exempt the rule from the stage-4 dry-run — the binder assertion below
  // needs a valid target so the EXPLAIN actually executes.
  await page.locator('#q-rf-targets').click();
  await page.keyboard.type('record_id');
  await page.keyboard.press('Enter');
  await expect(page.locator('.q-chip', { hasText: 'record_id' })).toBeVisible();

  // ---- draft lint: typo'd column → real DuckDB binder error ----
  const conditionContent = page.locator('.q-rf-field--condition .cm-content');
  const conditionDiags = page.locator('.q-rf-field--condition .q-editor-diags');
  await conditionContent.click();
  await page.keyboard.type('recrd_id IS NULL');
  await expect(conditionDiags).toContainText('condition failed the SQL dry-run', {
    timeout: LINT_TIMEOUT,
  });
  await expect(conditionDiags).toContainText('recrd_id', { timeout: LINT_TIMEOUT });

  // ---- scope=column → assertion snippets complete on the in_ prefix ----
  await page.locator('#q-rf-scope').selectOption('column');
  await conditionContent.click();
  await page.keyboard.press(SELECT_ALL);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('in_');
  const autocomplete = page.locator('.cm-tooltip-autocomplete');
  await expect(autocomplete).toContainText('in_range', { timeout: 10_000 });
  await expect(autocomplete).toContainText('assertion');
  await page.keyboard.press('Escape'); // close the completion popup only

  // ---- (type,scope) matrix: correct blocks column/dataset, auto-snaps ----
  await page.locator('#q-rf-type').selectOption('correct');
  await expect(page.locator('#q-rf-scope')).toHaveValue('row'); // auto-snap
  await expect(page.locator('#q-rf-scope option[value="column"]')).toBeDisabled();
  await expect(page.locator('#q-rf-scope option[value="dataset"]')).toBeDisabled();
  await expect(page.locator('#q-rf-severity')).toHaveValue('info'); // correct default
  await expect(page.locator('.q-rf-correction')).toBeVisible();

  // ---- restore a clean validate rule and save ----
  await page.locator('#q-rf-type').selectOption('validate');
  await expect(page.locator('#q-rf-severity')).toHaveValue('error');
  await conditionContent.click();
  await page.keyboard.press(SELECT_ALL);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('record_id IS NULL');
  await page.locator('#q-rf-comment').fill('Record id must be present.');
  await expect(conditionDiags).toBeHidden({ timeout: LINT_TIMEOUT }); // lint settles clean
  await page.getByRole('button', { name: 'Add to file' }).click();

  // ---- saved: grid row, dirty rail marker, pinned reorder tooltip ----
  await expect(drawer).toBeHidden();
  const row = page.locator('.q-rulegrid tbody tr', { hasText: 'E2E1' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('validate');
  await expect(row).toContainText('record_id');
  await expect(
    page.locator('.q-filebtn', { hasText: 'my_rules' }).locator('.q-filebtn-dirty'),
  ).toBeVisible();
  await expect(row.getByRole('button', { name: 'Move rule E2E1 up' })).toHaveAttribute(
    'title',
    'Row order = correction order',
  );
  await expect(row.getByRole('button', { name: 'Move rule E2E1 down' })).toHaveAttribute(
    'title',
    'Row order = correction order',
  );
});
