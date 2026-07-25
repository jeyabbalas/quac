/**
 * §E.5 input consistency, as the Preview head now reports it: one line saying
 * whether the three inputs describe the same table, and when they don't, which
 * one is the odd one out.
 *
 * The three suspects are the point. Two mismatched inputs can only tell you
 * that they disagree; it takes the third to say WHICH of them is from another
 * project, and each of the three cases below is a different pair of failing
 * edges sharing a different vertex. The old strip could express none of them —
 * it never compared the schema to the rules, and it returned early with no
 * dataset at all.
 *
 * There is no modal any more, and nothing is blocked: `Run QC` stays enabled
 * throughout, which every test asserts by not having a dialog to dismiss.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const HESP_SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
const HESP_DATA = join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv');
const HESP_RULES = ['hesp_keys_and_structure', 'hesp_consistency', 'hesp_corrections'].map(
  (name) => join(FIXTURES, 'hesp', 'rules', `${name}.quac.csv`),
);
const TINY_DATA = join(FIXTURES, 'tiny', 'people.csv');
const TINY_SCHEMA = join(FIXTURES, 'tiny', 'people.schema.json');
const TINY_RULES = join(FIXTURES, 'tiny', 'people_rules.quac.csv');
const INGEST_TIMEOUT = 90_000;

test.describe.configure({ timeout: 180_000 });

const line = (page: Page): Locator => page.locator('.q-preview-pertinence');
const badge = (page: Page): Locator => line(page).locator('.q-badge');
const text = (page: Page): Locator => line(page).locator('.q-preview-pertinence-text');

const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');
const rulesInput = (page: Page): Locator =>
  page.locator('[data-slot="rules"] input[type="file"]');

async function loadHespSchema(page: Page): Promise<void> {
  await page.getByLabel('Browse schema folder').setInputFiles(HESP_SCHEMA_DIR);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge')).toHaveText('Valid');
}

async function loadTinySchema(page: Page): Promise<void> {
  await page.getByLabel('Browse schema files').setInputFiles(TINY_SCHEMA);
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge')).toHaveText('Valid');
}

test('one input has nothing to compare; the matching pair says so without numbers', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadHespSchema(page);

  // The Preview section is up — the schema fills the dictionary tab — but a
  // lone input forms no pair, so there is no verdict to give.
  await expect(page.locator('.q-preview')).toBeVisible();
  await expect(line(page)).toBeHidden();

  await datasetInput(page).setInputFiles(HESP_DATA);

  await expect(line(page)).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(badge(page)).toHaveText('OK');
  await expect(text(page)).toHaveText(
    'Inputs look consistent — the dataset matches the JSON Schema.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('all three HESP inputs → the three-input consistent line', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await rulesInput(page).setInputFiles(HESP_RULES);
  await datasetInput(page).setInputFiles(HESP_DATA);

  await expect(badge(page)).toHaveText('OK', { timeout: INGEST_TIMEOUT });
  await expect(text(page)).toHaveText(
    'Inputs look consistent — the dataset, JSON Schema, and QC rules all describe the same variables.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a stranger DATASET is named: it fits neither the schema nor the rules', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await rulesInput(page).setInputFiles(HESP_RULES);
  await datasetInput(page).setInputFiles(TINY_DATA);

  await expect(badge(page)).toHaveText('Mismatch', { timeout: INGEST_TIMEOUT });
  await expect(text(page)).toHaveText(
    "The dataset doesn't look like it belongs with the other two inputs — only 0 of 265 " +
      'schema variables match. Check you loaded the right file.',
  );
  // A caution, not a gate: the run is still available.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.q-runbar-button')).toBeEnabled();
});

test('a stranger SCHEMA is named: the dataset and rules agree with each other', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await rulesInput(page).setInputFiles(TINY_RULES);
  await datasetInput(page).setInputFiles(TINY_DATA);

  await expect(badge(page)).toHaveText('Mismatch', { timeout: INGEST_TIMEOUT });
  await expect(text(page)).toHaveText(
    "The JSON Schema doesn't look like it belongs with the other two inputs — only 0 of 265 " +
      'schema variables match. Check you loaded the right file.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('stranger RULES are named, in the plural the slot takes', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await rulesInput(page).setInputFiles(TINY_RULES);
  await datasetInput(page).setInputFiles(HESP_DATA);

  await expect(badge(page)).toHaveText('Mismatch', { timeout: INGEST_TIMEOUT });
  await expect(text(page)).toHaveText(
    "The QC rules don't look like they belong with the other two inputs — only 0 of 5 rule " +
      'targets match. Check you loaded the right file.',
  );
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the schema↔rules edge is checked with no dataset loaded at all', async ({ page }) => {
  await page.goto('/quac/');
  await loadHespSchema(page);
  await rulesInput(page).setInputFiles(TINY_RULES);

  // Two inputs disagree and there is no third to break the tie, so nobody is
  // named — but the line appears, which is what the old strip could not do:
  // it returned early on a null dataset and showed nothing here.
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Empty');
  await expect(badge(page)).toHaveText('Mismatch');
  await expect(text(page)).toHaveText(
    'Only 0 of 5 rule targets found in the JSON Schema. ' +
      'One of these inputs may be from a different project.',
  );
});

test('a case near-miss is reported as a spelling difference, not a missing column', async ({
  page,
}) => {
  await page.goto('/quac/');
  await loadTinySchema(page);
  // people.csv with `age` capitalised — a real header the hygiene pass leaves
  // alone, and exactly the shape of a rename that silently drops a column out
  // of validation.
  await datasetInput(page).setInputFiles({
    name: 'people_shouty.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'person_id,name,AGE,city,score\nP001,Ada,36,LONDON,88\nP002,Alan,41,CAMBRIDGE,91\n',
    ),
  });

  await expect(badge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await expect(text(page)).toHaveText(
    '4 of 5 schema variables found in the dataset — missing age. ' +
      "Close match: 'AGE' vs 'age' — check for a spelling difference.",
  );
});
