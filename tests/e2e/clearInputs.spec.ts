/**
 * UIX-7 golden journey 9: every input is clearable, and an explicit clear
 * invalidates the run, the hash, and the tables. Six passes over the tiny/
 * fixtures: (1) rules clear after a run strips run paint but keeps the data
 * grid; (2) dataset clear → same-file re-upload builds a FRESH grid (the
 * monotonic-generation regression); (3) per-file ✕ keeps the lint context;
 * (4) unsaved Studio work gates the rules clear behind a confirm; (5) clear
 * all resets the session to first-run; (6) a cleared share link stays cleared
 * across reload (history.replaceState rewrite from live sources).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const DATA = join(FIXTURES, 'tiny', 'people.csv');
const SCHEMA = join(FIXTURES, 'tiny', 'people.schema.json');
const RULES = join(FIXTURES, 'tiny', 'people_rules.quac.csv');
const CORS = 'http://localhost:4199';

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');
const datasetBadge = (page: Page): Locator => page.locator('[data-slot="data"] .q-badge');
const rulesInput = (page: Page): Locator =>
  page.locator('[data-slot="rules"] input[type="file"]');
const rulesBadge = (page: Page): Locator =>
  page.locator('[data-slot="rules"] .q-slotcard-header .q-badge');
const rulesSummary = (page: Page): Locator =>
  page.locator('[data-slot="rules"] .q-slotcard-summary');
const schemaBadge = (page: Page): Locator =>
  page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first();
const runButton = (page: Page): Locator => page.locator('.q-runbar-button');
const reportPill = (page: Page): Locator =>
  page.locator('.q-tab', { hasText: 'QC Report' }).locator('.q-pill');

// The clear controls, by their DISTINCT accessible names (bare 'Clear' would
// substring-collide with 'Clear focus' / 'Clear preview filter').
const clearRulesButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Clear QC rules' });
const clearDatasetButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Clear dataset' });
const clearSchemaButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Clear JSON Schema' });
const clearAllButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Clear all inputs' });

const goToLoad = async (page: Page): Promise<void> => {
  await page.locator('.q-tab', { hasText: 'Load' }).click();
};
const goToReport = async (page: Page): Promise<void> => {
  await page.locator('.q-tab', { hasText: 'QC Report' }).click();
};

async function loadDatasetAndRules(page: Page): Promise<void> {
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(RULES);
  // Schema-less CSV → all-VARCHAR → R003/R005 fail the EXPLAIN dry-run:
  // Warning badge, 4 of 6 executable (pinned by partialRun.spec).
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  // The dataset lint context is installed once 'data checks pending' clears —
  // journeys that assert context survival depend on this settled state.
  await expect(rulesSummary(page)).not.toContainText('data checks pending', {
    timeout: INGEST_TIMEOUT,
  });
}

async function runToCompletion(page: Page): Promise<void> {
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
  await expect(page.locator('.dt-cell--annotated').first()).toBeVisible({ timeout: 30_000 });
}

test('run → clear rules: run paint strips, the data grid survives', async ({ page }) => {
  await page.goto('/quac/');
  await loadDatasetAndRules(page);
  await runToCompletion(page);
  await expect(reportPill(page)).toBeVisible();

  await goToLoad(page);
  await clearRulesButton(page).click(); // no unsaved Studio work → no confirm
  await expect(page.getByText('QC rules cleared.')).toBeVisible();
  await expect(rulesBadge(page)).toHaveText('Empty');
  await expect(reportPill(page)).toBeHidden();
  // With the schema slot never loaded, no check source remains.
  await expect(page.locator('.q-runbar-reason')).toHaveText(
    'Load a JSON Schema or a QC rules file to run QC.',
  );

  await goToReport(page);
  // The dataset survives the rules clear: grid intact, view-level empty
  // hidden, but every trace of the run is gone.
  await expect(page.locator('.q-report-grid')).toBeVisible();
  await expect(page.getByText('No flags yet.')).toBeHidden();
  await expect(page.locator('.dt-cell--annotated')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText('No findings yet.', { exact: false }).first()).toBeVisible();
});

test('clear dataset → same-file re-upload builds a fresh grid (generation regression)', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadDatasetAndRules(page);
  await runToCompletion(page);

  await goToLoad(page);
  await clearDatasetButton(page).click();
  await expect(page.getByText('Dataset cleared.')).toBeVisible();
  await expect(datasetBadge(page)).toHaveText('Empty');
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toHaveText('');
  await goToReport(page);
  await expect(page.getByText('No flags yet.')).toBeVisible();

  // Same file again: the grid must be built FRESH — a reused generation would
  // resurrect the previous instance, annotations and all.
  await goToLoad(page);
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await goToReport(page);
  await expect(page.locator('.q-report-grid')).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(page.locator('.dt-cell--annotated')).toHaveCount(0, { timeout: 30_000 });

  await goToLoad(page);
  await runToCompletion(page);
  await expect(reportPill(page)).toBeVisible();
});

test('per-file ✕ removes one rules file and keeps the lint context', async ({ page }) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  const inline =
    'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n' +
    'S001,validate,row,name,name IS NULL,sql,,error,inline check,true\n';
  await rulesInput(page).setInputFiles([
    { name: 'people_rules.quac.csv', mimeType: 'text/csv', buffer: readFileSync(RULES) },
    { name: 'inline.quac.csv', mimeType: 'text/csv', buffer: Buffer.from(inline) },
  ]);
  await expect(rulesSummary(page)).toContainText('2 files · 7 rules', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(rulesSummary(page)).not.toContainText('data checks pending', {
    timeout: INGEST_TIMEOUT,
  });

  await page.locator('[data-slot="rules"] .q-slotcard-details > summary').click();
  await expect(page.locator('.q-rulesfile')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove rules file inline.quac.csv' }).click();
  await expect(page.getByText('Removed inline.quac.csv.')).toBeVisible();
  await expect(page.locator('.q-rulesfile')).toHaveCount(1);
  await expect(rulesSummary(page)).toContainText('1 file · 6 rules');
  // The context survived the remove: survivors relinted WITH data, so the
  // pending marker must not regress into the summary.
  await expect(rulesSummary(page)).not.toContainText('data checks pending');
});

test('unsaved Studio work gates the rules clear behind a confirm', async ({ page }) => {
  await page.goto('/quac/');
  await loadDatasetAndRules(page);

  // Studio: edit R001's comment, test (the save gate wants a passing test
  // with a dataset present), save — the file is now session-dirty.
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await page.locator('.q-rulegrid tbody tr', { hasText: 'R001' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
  await page.locator('#q-rf-comment').fill('Edited for the clear journey.');
  await page.locator('.q-rf-test').click();
  await expect(page.locator('.q-rf-teststatus')).toHaveText('Tested ✓', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeHidden();

  await goToLoad(page);
  await clearRulesButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Clear the QC rules?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.q-panel-note')).toContainText('people_rules.quac.csv');

  // Cancel preserves everything.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(rulesBadge(page)).toHaveText('Warning');

  // Confirm empties the slot.
  await clearRulesButton(page).click();
  await page
    .getByRole('dialog', { name: 'Clear the QC rules?' })
    .getByRole('button', { name: 'Clear rules' })
    .click();
  await expect(rulesBadge(page)).toHaveText('Empty');
});

test('clear all inputs resets the session to first-run', async ({ page }) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(DATA);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Browse schema files').setInputFiles(SCHEMA);
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(page.locator('.q-preview')).toBeVisible();

  await clearAllButton(page).click();
  const dialog = page.getByRole('dialog', { name: 'Clear all inputs?' });
  await expect(dialog).toBeVisible();
  // Always asks — and Cancel is a full no-op.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(datasetBadge(page)).toHaveText('Valid');

  await clearAllButton(page).click();
  await page
    .getByRole('dialog', { name: 'Clear all inputs?' })
    .getByRole('button', { name: 'Clear all inputs' })
    .click();

  await expect(page.getByText('All inputs cleared.')).toBeVisible();
  await expect(datasetBadge(page)).toHaveText('Empty');
  await expect(schemaBadge(page)).toHaveText('Empty');
  await expect(rulesBadge(page)).toHaveText('Empty');
  // First-run state returns: hero back, preview gone, Share dark, button gone.
  await expect(page.locator('.q-example')).toBeVisible();
  await expect(page.locator('.q-preview')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Share' })).toBeDisabled();
  await expect(clearAllButton(page)).toBeHidden();
});

test('a cleared share link stays cleared across reload', async ({ page }) => {
  const params = new URLSearchParams();
  params.append('schema', `${CORS}/tiny/people.schema.json`);
  params.append('rules', `${CORS}/tiny/people_rules.quac.csv`);
  await page.goto(`/quac/#/load?${params.toString()}`);
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  // Clear the schema: the address bar loses schema= but keeps rules=,
  // via replaceState (no history entry, no hashchange).
  await clearSchemaButton(page).click();
  await expect(page).toHaveURL(/#\/load\?rules=/);
  expect(page.url()).not.toContain('schema=');

  // Reload: the schema STAYS cleared; the surviving rules param re-fetches.
  await page.reload();
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(schemaBadge(page)).toHaveText('Empty');

  // Clear the rules too: a bare #/load, and a reload lands on first-run.
  await clearRulesButton(page).click();
  await expect(rulesBadge(page)).toHaveText('Empty');
  await expect(page).toHaveURL(/#\/load$/);
  await page.reload();
  await expect(page.locator('.q-example')).toBeVisible();
});
