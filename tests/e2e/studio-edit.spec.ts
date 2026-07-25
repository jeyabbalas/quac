/**
 * P17 Rule Studio journey — ONE long test on purpose (the example load is the
 * expensive setup): workspace mount → new file → new rule with live draft
 * lint (real DuckDB binder error via the mirrored diagnostics list — CM hover
 * tooltips are not assertable), assertion-snippet completion (typed `in_`
 * prefix, never bare Ctrl-Space), the (type,scope) matrix with auto-snap, and
 * save-to-grid with the dirty rail marker + the pinned reorder tooltip.
 *
 * Also pins the UIX-2 browse⇄edit swap: opening a rule hides the table, the
 * "← Rules" affordance brings it back, and it goes through the same
 * discard guard as Cancel once the draft is dirty.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

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
  const gridCard = page.locator('.q-studio-gridcard');
  await expect(drawer).toBeVisible();
  // UIX-2: the editor REPLACES the rule table in the work column, so the form
  // and the live test result end up side by side instead of a page apart.
  await expect(gridCard).toBeHidden();
  await expect(page.locator('#q-rf-id')).toBeFocused();

  // "← Rules" is the way back out of the swap; nothing typed yet, so it
  // returns straight to the table.
  await page.locator('.q-studio-back').click();
  await expect(drawer).toBeHidden();
  await expect(gridCard).toBeVisible();
  await page.locator('.q-studio-addrule').click();
  await expect(drawer).toBeVisible();

  await page.locator('#q-rf-id').fill('E2E1');

  // Dirty now — "← Rules" goes through the discard guard, same as Cancel.
  await page.locator('.q-studio-back').click();
  const discardDialog = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(discardDialog).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(page.locator('#q-rf-id')).toHaveValue('E2E1');

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

  // ---- P18 gate: Add stays disabled until a test executes successfully ----
  // (0 matches still counts — record_id IS NULL matches no example rows).
  await expect(page.getByRole('button', { name: 'Add to file' })).toBeDisabled();
  await page.locator('.q-rf-test').click();
  await expect(page.locator('.q-test-result')).toBeVisible({ timeout: LINT_TIMEOUT });
  await expect(page.locator('.q-rf-teststatus')).toHaveText('Tested ✓');
  await expect(page.getByRole('button', { name: 'Add to file' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add to file' }).click();

  // ---- saved: grid row, dirty rail marker, pinned reorder tooltip ----
  await expect(drawer).toBeHidden();
  await expect(gridCard).toBeVisible(); // the table takes the column back
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

  // ---- UIX-3: collapsing the rail hands its width to the live preview ----
  // Explicit viewport: this block asserts measured track widths, so it must not
  // inherit whatever the default happens to be.
  await page.setViewportSize({ width: 1440, height: 900 });
  const layout = page.locator('.q-studio-layout');
  const railToggle = page.locator('.q-studio-railtoggle');
  await expect(railToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(railToggle).toHaveAttribute('aria-controls', 'q-studio-files');
  const previewBefore = (await page.locator('.q-studio-preview').boundingBox())?.width ?? 0;
  const gridHeightBefore = (await page.locator('.q-studio-samplegrid').boundingBox())?.height ?? 0;
  // ≥1280 the card fills the viewport, so the grid is tall enough to clear
  // data-table's own 273–306px header with rows to spare.
  expect(gridHeightBefore).toBeGreaterThan(400);

  await railToggle.click();
  await expect(railToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(railToggle).toHaveAttribute('aria-label', 'Expand rule files');
  await expect(page.locator('.q-studio-railtitle')).toBeHidden();
  await expect(page.locator('.q-studio-newfile')).toBeHidden();
  // The files survive as dots — still visible, still clickable, so switching
  // files never needs a round trip through expand.
  await expect(page.locator('.q-filebtn')).toHaveCount(4);
  await expect(page.locator('.q-filebtn').first()).toBeVisible();
  await expect(page.locator('.q-filebtn-group').first()).toBeHidden();

  // The freed width lands in the preview: the work track pins to its 600px floor.
  const previewAfter = (await page.locator('.q-studio-preview').boundingBox())?.width ?? 0;
  expect(previewAfter - previewBefore).toBeGreaterThan(150);
  expect((await page.locator('.q-studio-work').boundingBox())?.width ?? 0).toBeGreaterThan(595);
  expect((await page.locator('.q-studio-work').boundingBox())?.width ?? 0).toBeLessThan(605);
  // The pinned regression: the work surface must never scroll sideways.
  expect(
    await page.locator('.q-studio-gridbody').evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(0);
  // Collapsing changes the preview's WIDTH, never its height. Before the preview
  // column became a flex column the grid kept a fixed clamp while data-table's
  // header grew with the pane, which squeezed the body to a row or two.
  expect((await page.locator('.q-studio-samplegrid').boundingBox())?.height).toBe(gridHeightBefore);
  expect(await page.evaluate(() => localStorage.getItem('quac.studio.railCollapsed'))).toBe('1');

  // Switching files while collapsed works — the dot is the file button.
  await page.locator('.q-filebtn').first().click();
  await expect(page.locator('.q-filebtn[aria-current="true"]')).toHaveAttribute(
    'aria-label',
    /rules?$/,
  );

  // ≤1023 the rail is already a horizontal strip, so the preference goes inert:
  // remembered, but not honoured, and the control is not offered.
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(layout).toHaveClass(/q-studio-layout--railclosed/);
  await expect(railToggle).toBeHidden();
  await expect(page.locator('.q-studio-railtitle')).toBeVisible();
  await expect(page.locator('.q-filebtn-group').first()).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.q-studio-railtitle')).toBeHidden();
  await railToggle.click();
  await expect(railToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.q-studio-railtitle')).toBeVisible();
  await page.locator('.q-filebtn', { hasText: 'my_rules' }).click();
  await expect(page.locator('.q-studio-gridtitle')).toHaveText('my_rules.quac.csv');

  // ---- UIX-3: deleting a rule asks first (delete has no undo) ----
  const deleteButton = row.getByRole('button', { name: 'Delete rule E2E1' });
  await deleteButton.click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete rule?' });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText('Delete E2E1 from my_rules.quac.csv?');
  await expect(deleteDialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(deleteDialog).toBeHidden();
  await expect(row).toBeVisible(); // cancelling keeps the rule

  await deleteButton.click();
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole('button', { name: 'Delete rule' }).click();
  await expect(deleteDialog).toBeHidden();
  await expect(page.locator('.q-studio-gridbody .q-panel-note')).toHaveText(
    'No rules in this file yet.',
  );
});

test('the rail remembers that it was collapsed', async ({ page }) => {
  // The one sanctioned localStorage key (architecture.md §5 — trivial UI prefs
  // only). Rules alone mount the workspace, so this skips the 90 s ingest.
  await page.addInitScript(() => {
    localStorage.setItem('quac.studio.railCollapsed', '1');
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/quac/');
  await page
    .locator('[data-slot="rules"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'tiny', 'people_rules.quac.csv'));
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('.q-studio-railtoggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.q-studio-railtitle')).toBeHidden();
  await expect(page.locator('.q-filebtn').first()).toBeVisible();
});
