/**
 * P12 golden journeys: the QC Rules slot through the real UI — multi-file
 * browse, lint counts on the badge/summary, the inapplicable-targets warning
 * against a mismatched dataset, a structurally broken file, and the
 * dataset↔rules edge of the Preview head's consistency line. Dataset-dependent
 * lint EXPLAINs through DuckDB-WASM, so post-ingest expectations carry
 * generous timeouts.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const RULES = (name: string): string => join(FIXTURES, 'hesp', 'rules', name);
const HESP_RULE_FILES = [
  RULES('hesp_keys_and_structure.quac.csv'),
  RULES('hesp_consistency.quac.csv'),
  RULES('hesp_corrections.quac.csv'),
];
const INGEST_TIMEOUT = 90_000;

test.describe.configure({ timeout: 180_000 });

const rulesCard = (page: Page): Locator => page.locator('[data-slot="rules"]');
// Header badge only — the detail area carries per-file .q-badge minis too.
const rulesBadge = (page: Page): Locator =>
  rulesCard(page).locator('.q-slotcard-header .q-badge');
const rulesSummary = (page: Page): Locator => rulesCard(page).locator('.q-slotcard-summary');
const rulesInput = (page: Page): Locator => rulesCard(page).locator('input[type="file"]');
const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');

/**
 * Parquet on purpose: it lands with native column types. A schema-less CSV
 * ingest keeps every column VARCHAR (raw fidelity, ingestion.md §2), so
 * arithmetic-heavy rules genuinely cannot bind and the dry-run would —
 * correctly — report sql-errors instead of the clean path this suite pins.
 */
async function ingestHesp(page: Page): Promise<void> {
  await datasetInput(page).setInputFiles(join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.parquet'));
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
}

test('the 3 HESP rule files load with pending data checks, then lint clean once data arrives', async ({
  page,
}) => {
  await page.goto('/quac/');

  await rulesInput(page).setInputFiles(HESP_RULE_FILES);
  await expect(rulesBadge(page)).toHaveText('Valid');
  await expect(rulesSummary(page)).toHaveText('3 files · 22 rules · data checks pending');

  // Detail area groups by file; the js correction (H006) is the pending note.
  await rulesCard(page).locator('.q-slotcard-details summary').click();
  await expect(rulesCard(page).locator('.q-rulesfile')).toHaveCount(3);

  await ingestHesp(page);

  // Dataset arrival re-lints: all targets present, dry-run clean → pending gone.
  await expect(rulesSummary(page)).toHaveText('3 files · 22 rules', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(rulesBadge(page)).toHaveText('Valid');

  // The Preview head checks the dataset↔rules edge with no schema loaded, and
  // says what consistency MEANS for that pair rather than reciting its counts.
  const consistency = page.locator('.q-preview-pertinence');
  await expect(consistency).toBeVisible();
  await expect(consistency.locator('.q-badge')).toHaveText('OK');
  await expect(consistency.locator('.q-preview-pertinence-text')).toHaveText(
    'Inputs look consistent — every rule target is a column in the dataset.',
  );
});

test('a rules file targeting missing columns shows the inapplicable warning', async ({ page }) => {
  await page.goto('/quac/');

  await rulesInput(page).setInputFiles(join(FIXTURES, 'tiny', 'people_rules.quac.csv'));
  await expect(rulesBadge(page)).toHaveText('Valid');
  await expect(rulesSummary(page)).toHaveText('1 file · 6 rules · data checks pending');

  await ingestHesp(page);

  // None of the people-rules targets exist in HESP: 6 unknown-target warnings
  // + the file-level pertinence banner.
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await expect(rulesSummary(page)).toHaveText('1 file · 6 rules · 7 lint warnings');

  await rulesCard(page).locator('.q-slotcard-details summary').click();
  await expect(
    rulesCard(page).locator('.q-rulesissue--warning', { hasText: 'inapplicable' }).first(),
  ).toBeVisible();
  await expect(rulesCard(page).locator('.q-rulesfile-pertinence')).toHaveText(
    /^Targets: 0\/5 present in the dataset · missing: /,
  );

  // Two inputs disagreeing name no suspect — it takes a third to say which of
  // them is the stranger. `.q-rulesfile-pertinence` above is the linter's
  // per-file line, a different feature on a different surface.
  await expect(page.locator('.q-preview-pertinence .q-badge')).toHaveText('Mismatch');
  await expect(page.locator('.q-preview-pertinence-text')).toHaveText(
    'Only 0 of 5 rule targets found in the dataset. ' +
      'One of these inputs may be from a different project.',
  );
});

test('a structurally broken rules file shows the Error badge with lint counts', async ({
  page,
}) => {
  await page.goto('/quac/');

  await rulesInput(page).setInputFiles({
    name: 'broken.quac.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('rule_id,rule_type,rule_scope,target_variables,comment\nR1,validate,row,a,c\n'),
  });

  await expect(rulesBadge(page)).toHaveText('Error');
  await expect(rulesSummary(page)).toHaveText('1 file · 1 rule · 1 lint error');

  await rulesCard(page).locator('.q-slotcard-details summary').click();
  await expect(
    rulesCard(page).locator('.q-rulesissue--error', {
      hasText: 'Required column "condition" is missing',
    }),
  ).toBeVisible();

  // Re-dropping a fixed file with the same name replaces it in place.
  await rulesInput(page).setInputFiles({
    name: 'broken.quac.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'rule_id,rule_type,rule_scope,target_variables,condition,comment\nR1,validate,row,a,a > 1,c\n',
    ),
  });
  await expect(rulesBadge(page)).toHaveText('Valid');
  await expect(rulesSummary(page)).toHaveText('1 file · 1 rule · data checks pending');
});
