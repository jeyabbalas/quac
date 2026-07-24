/**
 * P18 golden journey 5 — ONE long test (studio-edit precedent; the example
 * load is the expensive setup): compose a Q011-twin against the dirty example
 * dataset → Test shows the seeded violation count → "Filter preview to
 * matches" narrows the live sample → Add (gate satisfied only after the
 * test) → compose a Q052-style correction → Test captures the seeded
 * −1200 → 1200 → Add → Download → re-import the downloaded bytes → identical
 * lint state, dirty marker cleared, both rules listed in order.
 *
 * Fixture-reality note: the phase file's −2500 lives in the node-tier
 * qc_fixture seed (ruleTest.test.ts pins it there); the example dataset's own
 * seeded negative debt is −1200 (seeded-violations.json row 15).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const INGEST_TIMEOUT = 90_000;
const TEST_TIMEOUT = 30_000; // rule test + first sample-grid build, serialized

test.describe.configure({ timeout: 300_000 });

test('studio journey: test, filter, gate, download, re-import', async ({ page }) => {
  await page.goto('/quac/');

  // ---- setup: example files; wait until rules linted WITH the dataset ----
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  const rulesSummary = page.locator('[data-slot="rules"] .q-slotcard-summary');
  await expect(rulesSummary).toContainText('3 files · 22 rules', { timeout: INGEST_TIMEOUT });
  await expect(rulesSummary).not.toContainText('data checks pending', {
    timeout: INGEST_TIMEOUT,
  });

  // ---- studio: new file ----
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(3, { timeout: 30_000 });
  await page.locator('.q-studio-newfile').click();
  const newFileModal = page.getByRole('dialog', { name: 'New rules file' });
  await expect(newFileModal.locator('#q-newfile-name')).toHaveValue('my_rules');
  await newFileModal.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.q-studio-gridtitle')).toHaveText('my_rules.quac.csv');

  // ---- E2EQ11: Q011's guarded roster arithmetic ----
  await page.locator('.q-studio-addrule').click();
  const drawer = page.locator('.q-studio-drawer');
  await expect(drawer).toBeVisible();
  await page.locator('#q-rf-id').fill('E2EQ11');
  await page.locator('#q-rf-targets').click();
  for (const target of ['household_size', 'adult_count', 'child_count']) {
    await page.keyboard.type(target);
    await page.keyboard.press('Enter');
    await expect(page.locator('.q-chip', { hasText: target })).toBeVisible();
  }
  const conditionContent = page.locator('.q-rf-field--condition .cm-content');
  await conditionContent.click();
  await page.keyboard.type(
    'household_size >= 1 AND adult_count >= 0 AND child_count >= 0 ' +
      'AND adult_count + child_count <> household_size',
  );
  await page.keyboard.press('Escape'); // close any completion popup
  await page.locator('#q-rf-comment').fill('Roster arithmetic must add up.');

  // Gate: Add stays disabled until a test executes successfully.
  const addButton = page.getByRole('button', { name: 'Add to file' });
  await expect(addButton).toBeDisabled();
  const testResult = page.locator('.q-test-result');
  await page.locator('.q-rf-test').click();
  // The dirty fixture seeds exactly ONE roster break.
  await expect(testResult).toContainText('1 row', { timeout: TEST_TIMEOUT });
  await expect(page.locator('.q-rf-teststatus')).toHaveText('Tested ✓');

  // Filter the live preview to the matching rows (window-free condition).
  const filterToggle = page.locator('.q-test-filter');
  await expect(filterToggle).toHaveText('Filter preview to matches', { timeout: TEST_TIMEOUT });
  await filterToggle.click();
  await expect(filterToggle).toHaveText('Clear preview filter');

  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.q-rulegrid tbody tr', { hasText: 'E2EQ11' })).toBeVisible();

  // ---- E2EQ52: Q052-style correction on credit_card_balance ----
  await page.locator('.q-studio-addrule').click();
  await expect(drawer).toBeVisible();
  await page.locator('#q-rf-id').fill('E2EQ52');
  await page.locator('#q-rf-type').selectOption('correct');
  await expect(page.locator('#q-rf-severity')).toHaveValue('info');
  await page.locator('#q-rf-targets').click();
  await page.keyboard.type('credit_card_balance');
  await page.keyboard.press('Enter');
  await expect(page.locator('.q-chip', { hasText: 'credit_card_balance' })).toBeVisible();
  await conditionContent.click();
  await page.keyboard.type(
    '__value__ < 0 AND __value__ <> -666 AND __value__ <> -777 ' +
      'AND __value__ <> -888 AND __value__ <> -999',
  );
  await page.keyboard.press('Escape');
  const updateContent = page.locator('.q-rf-field--update .cm-content');
  await updateContent.click();
  await page.keyboard.type('ABS(__value__)');
  await page.keyboard.press('Escape');
  await page.locator('#q-rf-comment').fill('Debt balances are stored positive.');

  await page.locator('.q-rf-test').click();
  // Exactly one seeded non-sentinel negative debt: −1200 → 1200.
  await expect(testResult).toContainText('1 cell would change', { timeout: TEST_TIMEOUT });
  const captureBody = page.locator('.q-test-body');
  await expect(captureBody.locator('td').filter({ hasText: /^-1200$/ })).toBeVisible();
  await expect(captureBody.locator('td').filter({ hasText: /^1200$/ })).toBeVisible();
  await addButton.click();
  await expect(drawer).toBeHidden();

  const gridRows = page.locator('.q-rulegrid tbody tr');
  await expect(gridRows).toHaveCount(2);
  await expect(gridRows.nth(0)).toContainText('E2EQ11');
  await expect(gridRows.nth(1)).toContainText('E2EQ52');
  const dirtyMark = page
    .locator('.q-filebtn', { hasText: 'my_rules' })
    .locator('.q-filebtn-dirty');
  await expect(dirtyMark).toBeVisible();

  // ---- download the §7 writer's bytes ----
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.q-studio-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('my_rules.quac.csv');
  const downloadPath = await download.path();
  const bytes = readFileSync(downloadPath);
  expect(bytes[0]).toBe(0xef); // UTF-8 BOM
  expect(bytes[1]).toBe(0xbb);
  expect(bytes[2]).toBe(0xbf);
  await expect(dirtyMark).toBeVisible(); // download does NOT clear the dirty *

  // ---- re-import the downloaded file: same-name replace, lint re-runs ----
  await page.getByRole('link', { name: 'Load', exact: true }).click();
  await page.locator('[data-slot="rules"] input[type="file"]').setInputFiles({
    name: 'my_rules.quac.csv',
    mimeType: 'text/csv',
    buffer: bytes,
  });
  await expect(rulesSummary).toContainText('4 files · 24 rules', { timeout: INGEST_TIMEOUT });
  await expect(rulesSummary).not.toContainText('lint error');
  await expect(rulesSummary).not.toContainText('data checks pending', {
    timeout: INGEST_TIMEOUT,
  });

  // ---- identical lint state in the studio; dirty * gone; order kept ----
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(4);
  const myRulesButton = page.locator('.q-filebtn', { hasText: 'my_rules' });
  await expect(myRulesButton.locator('.q-filebtn-dirty')).toHaveCount(0);
  await expect(myRulesButton.locator('.q-badge')).toHaveText('OK');
  await myRulesButton.click();
  await expect(page.locator('.q-studio-gridtitle')).toHaveText('my_rules.quac.csv');
  await expect(gridRows).toHaveCount(2);
  await expect(gridRows.nth(0)).toContainText('E2EQ11');
  await expect(gridRows.nth(1)).toContainText('E2EQ52');
  await expect(gridRows.nth(0).locator('.q-badge')).toHaveText('OK');
  await expect(gridRows.nth(1).locator('.q-badge')).toHaveText('OK');
});
