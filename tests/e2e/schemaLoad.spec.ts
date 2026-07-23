import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const HESP_DIR = fileURLToPath(new URL('../fixtures/hesp/json_schema', import.meta.url));
const SYNTHETIC_DIR = fileURLToPath(new URL('../fixtures/synthetic', import.meta.url));

/** The 14 schema files, as absolute paths (flat multi-select simulation). */
function hespSchemaPaths(): string[] {
  const paths = [
    join(HESP_DIR, 'core', 'core.schema.json'),
    join(HESP_DIR, 'common', 'defs.json'),
    ...readdirSync(join(HESP_DIR, 'core', 'categories')).map((name) =>
      join(HESP_DIR, 'core', 'categories', name),
    ),
  ];
  expect(paths).toHaveLength(14);
  return paths;
}

const card = (page: Page): Locator => page.locator('.q-schemaslot');
const badge = (page: Page): Locator => card(page).locator('.q-badge');
const detail = (page: Page): Locator => card(page).locator('.q-schemaslot-detail');

test.beforeEach(async ({ page }) => {
  await page.goto('/quac/');
});

test('14 HESP files via multi-file browse → Valid, auto root core.schema.json', async ({
  page,
}) => {
  await page.getByLabel('Browse schema files').setInputFiles(hespSchemaPaths());

  await expect(badge(page)).toHaveText('Valid');
  await expect(detail(page)).toHaveText(/14 files · root: (core\/)?core\.schema\.json/);
});

test('HESP folder via webkitdirectory → Valid, ignored files listed', async ({ page }) => {
  await page.getByLabel('Browse schema folder').setInputFiles(HESP_DIR);

  await expect(badge(page)).toHaveText('Valid');
  await expect(detail(page)).toHaveText('14 files · root: core/core.schema.json');

  await card(page).locator('summary').click();
  const details = card(page).locator('.q-schemaslot-detailsbody');
  await expect(details).toContainText('README.md (unsupported extension)');
  await expect(details).toContainText('manifest.json (non schema)');
  await expect(details).toContainText(
    'index id: https://schemas.example.org/hesp/core/core.schema.json',
  );
});

test('synthetic drop of the mini schema → Valid (dt.files fallback path)', async ({ page }) => {
  const raw = readFileSync(join(SYNTHETIC_DIR, 'mini', 'mini.schema.json'), 'utf8');
  await card(page).evaluate((element, content) => {
    const dt = new DataTransfer();
    dt.items.add(new File([content], 'mini.schema.json', { type: 'application/json' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
  }, raw);

  await expect(badge(page)).toHaveText('Valid');
  await expect(detail(page)).toHaveText('1 file · root: mini.schema.json');
});

test('two-roots set → IndexPickerModal; selection resolves the slot', async ({ page }) => {
  await page
    .getByLabel('Browse schema files')
    .setInputFiles(
      ['a.schema.json', 'b.schema.json', 'shared.defs.json'].map((name) =>
        join(SYNTHETIC_DIR, 'two-roots', name),
      ),
    );

  const dialog = page.getByRole('dialog', { name: 'Choose the index schema' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("More than one unreferenced file could be the table's index");
  const rows = dialog.locator('.q-idxpick-row');
  await expect(rows).toHaveCount(2);
  await expect(dialog.locator('.q-badge', { hasText: 'array of objects' })).toHaveCount(2);

  await rows.filter({ hasText: 'a.schema.json' }).locator('input[type=radio]').check();
  await dialog.getByRole('button', { name: 'Use this file' }).click();

  await expect(dialog).toBeHidden();
  await expect(badge(page)).toHaveText('Valid');
  await expect(detail(page)).toHaveText('3 files · root: a.schema.json');
});

test('dismissing the picker leaves a Warning slot with a re-open button', async ({ page }) => {
  await page
    .getByLabel('Browse schema files')
    .setInputFiles(
      ['x.json', 'y.json'].map((name) => join(SYNTHETIC_DIR, 'cycle', name)),
    );

  const dialog = page.getByRole('dialog', { name: 'Choose the index schema' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'These files reference each other in a cycle; choose the entry point.',
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect(badge(page)).toHaveText('Warning');
  await expect(detail(page)).toHaveText('2 files · choose the index schema');

  await card(page).getByRole('button', { name: 'Choose index…' }).click();
  await expect(page.getByRole('dialog', { name: 'Choose the index schema' })).toBeVisible();
});

test('malformed JSON → Error badge with the E_PARSE copy', async ({ page }) => {
  await page.getByLabel('Browse schema files').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ nope'),
  });

  await expect(badge(page)).toHaveText('Error');
  // Fatal findings auto-open the details area; assert the stable copy prefix.
  await expect(card(page).locator('.q-schemaslot-findings')).toContainText(
    '`broken.json` is not valid JSON',
  );
});
