/**
 * UIX-4: the Load view's tabbed Preview over all three inputs. Driven from the
 * bundled example (loadExample.spec's idiom) because the data dictionary needs
 * a real 14-file schema set to be worth asserting on.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { Workbook } from 'exceljs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const INGEST_TIMEOUT = 90_000;
test.describe.configure({ timeout: 240_000 });

const tab = (page: Page, name: string) =>
  page.locator('.q-preview .q-paneltab', { hasText: name });

async function loadExample(page: Page): Promise<void> {
  await page.goto('/quac/');
  await page.locator('.q-example-load').click();
  // The consistency line is the last thing the head resolves, so its
  // three-input verdict is the readiness signal for the whole section.
  await expect(page.locator('.q-preview-pertinence-text')).toContainText(
    'the dataset, JSON Schema, and QC rules all describe the same variables',
    { timeout: INGEST_TIMEOUT },
  );
}

test('the section appears with all three tabs, Dataset selected', async ({ page }) => {
  await page.goto('/quac/');
  // Hidden on first run — the hero owns the page.
  await expect(page.locator('.q-preview')).toBeHidden();

  await loadExample(page);

  await expect(page.locator('.q-preview')).toBeVisible();
  for (const name of ['Dataset', 'JSON Schema', 'QC rules']) {
    await expect(tab(page, name)).toBeVisible();
  }
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.q-preview').getByText('Preview', { exact: true })).toBeVisible();
});

test('the dataset type row flips from VARCHAR to the schema cast', async ({ page }) => {
  // The typedRevision regression: installTypedSync re-points the `data` view at
  // CAST columns without bumping dataset.generation, so a generation-only key
  // left every column reading VARCHAR for ever after a schema loaded.
  await loadExample(page);

  const typeRow = page.locator('.q-preview-table thead tr').nth(1);
  await expect(typeRow.locator('td').first()).toHaveText('VARCHAR'); // record_id stays text
  await expect(typeRow).toContainText('BIGINT', { timeout: INGEST_TIMEOUT });
  await expect(typeRow).toContainText('DOUBLE', { timeout: INGEST_TIMEOUT });

  await expect(page.getByText('first 50 of 101 rows · 266 columns')).toBeVisible();
  // Numeric columns right-align whole, header and type cell included.
  await expect(page.locator('.q-preview-table thead th.q-num').first()).toBeVisible();
});

// ---- JSON Schema → data dictionary ------------------------------------------
// The panel is json-schema-data-dictionary's <json-data-dictionary>; its
// markup sits in an open shadow root, which Playwright's CSS locators pierce.
// What QuaC owns is pinned here — the head, the table it hands over, the look,
// running without semantic search. The component's own interactions (section
// toggles, Expand/Collapse, resizing, ranking) are the package's to test.

const dictionary = (page: Page): Locator => page.locator('.q-dd json-data-dictionary');

/** A dictionary row by its variable name, exactly. */
const dictRow = (page: Page, name: string): Locator =>
  dictionary(page)
    .locator('[data-dd-row]')
    .filter({ has: page.locator('th.dd-col-name code', { hasText: new RegExp(`^${name}$`) }) })
    .first();

async function openDictionary(page: Page): Promise<void> {
  await loadExample(page);
  await tab(page, 'JSON Schema').click();
  await expect(dictionary(page).locator('[data-dd-category]')).toHaveCount(12, {
    timeout: 30_000,
  });
}

test('the data dictionary lists 265 variables under 12 categories', async ({ page }) => {
  await openDictionary(page);

  // QuaC's head carries the shape, where every Preview panel puts it…
  await expect(page.locator('.q-preview-meta', { hasText: 'categories' })).toHaveText(
    '12 categories · 265 variables',
  );
  await expect(page.getByText('JSON Schema formatted as a data dictionary')).toBeVisible();

  // …and the component its live readout, under the schema's own title.
  const dd = dictionary(page);
  await expect(dd.locator('[data-dd-count]')).toHaveText('265 variables');
  await expect(dd.locator('.dd-title')).toHaveText(
    'HESP - Household Economic Security Panel CORE table',
  );
  const first = dd.locator('[data-dd-category]').first();
  await expect(first.locator('[data-dd-category-toggle]')).toContainText(
    'HESP CORE - Identification and survey administration',
  );
  await expect(first.locator('[data-dd-cat-count]')).toHaveText('16');
  // HESP is under the component's lazy-paging threshold, so every row renders.
  await expect(dd.locator('[data-dd-row]')).toHaveCount(265);
});

test('a coded variable shows its range, special codes and unit', async ({ page }) => {
  await openDictionary(page);

  const row = dictRow(page, 'household_size');
  await expect(row).toContainText('integer + coded values');
  await expect(row).toContainText('1–20');
  await expect(row).toContainText('-888');
  await expect(row).toContainText('persons');
});

test('search ranks the exact name first, empties, and clears', async ({ page }) => {
  await openDictionary(page);
  const dd = dictionary(page);
  const search = dd.getByRole('searchbox', { name: 'Search variables' });

  // The variable itself, then the one whose constraint names it.
  await search.fill('household_size');
  await expect(dd.locator('[data-dd-count]')).toHaveText('2 / 265 variables');
  await expect(dd.locator('[data-dd-results] [data-dd-row]').first()).toContainText(
    'household_size',
  );

  // Semantic search is off until the head's switch turns it on
  // (semanticSearch.spec), so an empty result says so plainly and never
  // "looks for related".
  await search.fill('zzzz');
  await expect(dd.locator('[data-dd-count]')).toHaveText('0 / 265 variables');
  await expect(dd.locator('[data-dd-empty]')).toContainText('No variables match “zzzz”.');
  await expect(dd.locator('[data-dd-empty-semantic]')).toBeHidden();

  await search.fill('');
  await expect(dd.locator('[data-dd-count]')).toHaveText('265 variables');
  await expect(dd.locator('[data-dd-category]')).toHaveCount(12);
});

test('a skip pattern can be followed to the variable it sets', async ({ page }) => {
  await openDictionary(page);
  const dd = dictionary(page);

  const toggle = dd.locator('[data-dd-panel-toggle="rules"]');
  await expect(toggle).toHaveText(/Skip logic\s*171/);
  await toggle.click();
  const panel = dd.locator('[data-dd-panel="rules"]');
  await expect(panel).toBeVisible();

  // "if baseline_record = 1 → -666 → … move_reason": follow the link.
  await panel.locator('[data-dd-goto="move_reason"]').first().click();
  await expect(dictRow(page, 'move_reason')).toBeInViewport();
});

test('the download is the formatted Excel workbook, as json-schema-data-dictionary 0.8.0 builds it', async ({
  page,
}) => {
  await openDictionary(page);
  const button = dictionary(page).locator('[data-dd-action="download"]');
  await expect(button).toHaveText('Excel');

  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    'hesp-household-economic-security-panel-core-table.xlsx',
  );
  const path = await download.path();

  // The three sheets, and one row per variable under the header on the first.
  const { default: ExcelJS } = await import('exceljs');
  const wb: Workbook = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  expect(wb.worksheets.map((sheet) => sheet.name)).toEqual(['Data dictionary', 'Skip logic', 'About']);
  const sheet = wb.getWorksheet('Data dictionary');
  const names: string[] = [];
  sheet?.getColumn(1).eachCell((cell) => names.push(cell.text));
  expect(names).toContain('household_size');
  expect(names).toContain('move_reason');
});

test('the dictionary stays on QuaC’s light paper on a dark-OS machine', async ({ page }) => {
  // The component's default theme is 'auto' — the trap V22 records for
  // data-table's colorScheme: a dark panel inside QuaC's white work area.
  await page.emulateMedia({ colorScheme: 'dark' });
  await openDictionary(page);

  const root = dictionary(page).locator('.dd-root');
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(root).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // QuaC's typeface reaches the shadow root through --dd-font.
  await expect(root).toHaveCSS('font-family', /^Inter\b/);
});

async function rules(page: Page): Promise<void> {
  await loadExample(page);
  await tab(page, 'QC rules').click();
  await expect(page.locator('.q-rp-file')).toHaveCount(3, { timeout: 30_000 });
}

/** The row for a known rule, by its id in the row header. */
const ruleRow = (page: Page, id: string) =>
  page
    .locator('.q-rp-table tbody tr')
    .filter({ has: page.locator('.q-rp-id', { hasText: id }) })
    .first();

test('the QC rules panel lists 22 rules, one table per file', async ({ page }) => {
  await rules(page);

  const panel = page.locator('#q-preview-panel-rules');
  await expect(panel.locator('.q-preview-meta')).toHaveText('3 files · 22 rules');
  await expect(panel.getByText('QC rules files, one table per file')).toBeVisible();
  await expect(page.locator('.q-rp-count')).toHaveText('22 rules');

  // Load order, which is the cross-file correction-order contract.
  await expect(page.locator('.q-rp-filetitle')).toHaveText([
    'hesp_consistency.quac.csv',
    'hesp_corrections.quac.csv',
    'hesp_keys_and_structure.quac.csv',
  ]);
  await expect(page.locator('.q-rp-filecount')).toHaveText(['5 rules', '7 rules', '10 rules']);

  await expect(page.locator('.q-rp-table').first().locator('thead th')).toHaveText([
    'Rule',
    'Targets',
    'Condition',
    'Update expression',
    'Severity',
    'Comment',
  ]);

  // The scroller is its own tab stop with its own name (axe:
  // scrollable-region-focusable), named distinctly from the tab panel.
  const scroll = page.locator('.q-rp-scroll');
  await expect(scroll).toHaveAttribute('aria-label', 'QC rules by file');
  await expect(scroll).toHaveAttribute('tabindex', '0');
});

test('a correction rule shows its scope, targets, language and severity', async ({ page }) => {
  await rules(page);

  const row = ruleRow(page, 'Q047');
  await expect(row.locator('.q-rp-typescope')).toHaveText('correct · row');
  await expect(row.locator('.q-rp-chip').first()).toHaveText('wage_income_annual');
  await expect(row.locator('.q-rp-lang')).toHaveText('sql');
  await expect(row.locator('.q-pill--info')).toHaveText('info');
  // The whole point of the panel: the Studio's rule grid has no room for
  // either expression, so this is the only place they are tabulated.
  await expect(row.locator('.q-rp-expr').first()).toContainText('__value__ IN (777');
  await expect(row.locator('.q-rp-expr').nth(1)).toContainText('CASE __value__ WHEN 777');
});

test('the expressions are syntax-highlighted, in the Studio editors’ colours', async ({ page }) => {
  await rules(page);

  // The tokenizer is a lazy chunk: the first paint is plain mono and upgrades
  // in place, so this is where it must have landed.
  const keywords = page.locator('.q-rp-expr .tok-keyword');
  await expect(keywords.first()).toBeVisible({ timeout: 30_000 });
  expect(await keywords.count()).toBeGreaterThan(20);

  const row = ruleRow(page, 'Q047');
  await expect(row.locator('.q-rp-expr').first().locator('.tok-keyword').first()).toHaveText('IN');
  await expect(row.locator('.q-rp-expr').first().locator('.tok-number').first()).toHaveText('777');
  // #0369a1 is --q-info, the .q-syntax primitive shared with the Studio.
  await expect(row.locator('.q-rp-expr .tok-keyword').first()).toHaveCSS(
    'color',
    'rgb(3, 105, 161)',
  );

  // js is highlighted by the other parser; external prose by neither.
  await expect(ruleRow(page, 'H006').locator('.q-rp-lang')).toHaveText('js');
  await expect(ruleRow(page, 'H006').locator('.tok-comment').first()).toBeVisible();
  await expect(ruleRow(page, 'Q044').locator('.tok-keyword')).toHaveCount(0);
});

test('off and external are row treatment, not two more columns', async ({ page }) => {
  await rules(page);

  const disabled = ruleRow(page, 'Q057');
  await expect(disabled).toHaveClass(/q-rp-row--off/);
  await expect(disabled.locator('.q-badge')).toHaveText('off');

  await expect(ruleRow(page, 'Q044').locator('.q-badge')).toHaveText('external');
  // Every OTHER rule carries neither.
  await expect(page.locator('.q-rp-id .q-badge')).toHaveCount(2);
});

test('a long condition folds its tail behind +N more', async ({ page }) => {
  await rules(page);

  // Q021's condition is 11 lines in the source file; six are shown. The tail
  // stays in the DOM (so `toContainText` would still find it — assert on the
  // disclosure state, which is what the reader actually sees).
  const cell = ruleRow(page, 'Q021').locator('.q-rp-expr').first();
  const overflow = cell.locator('details');
  await expect(overflow.locator('summary')).toBeVisible();
  await expect(overflow.locator('summary')).toHaveText('+5 more');
  await expect(overflow).not.toHaveAttribute('open', /.*/);

  await overflow.locator('summary').click();
  await expect(overflow).toHaveAttribute('open', /.*/);
  await expect(overflow).toContainText('GREATEST(50, 0.01 * total_household_income_annual)');
});

test('a file header collapses its table and keeps its count', async ({ page }) => {
  await rules(page);

  const first = page.locator('.q-rp-file').first();
  const fileHead = first.locator('.q-rp-filehead');
  await expect(first.locator('.q-rp-table')).toBeVisible();

  await fileHead.click();
  await expect(first.locator('.q-rp-table')).toBeHidden();
  await expect(first.locator('.q-rp-filecount')).toHaveText('5 rules');
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(2);

  await fileHead.click();
  await expect(first.locator('.q-rp-table')).toBeVisible();
});

test('Collapse all folds every rules file and the label flips', async ({ page }) => {
  await rules(page);

  const toggle = page.locator('.q-rp-toggleall');
  await expect(toggle).toHaveText('Collapse all');

  await toggle.click();
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(0);
  await expect(page.locator('.q-rp-filehead:visible')).toHaveCount(3); // a table of contents
  await expect(toggle).toHaveText('Expand all');

  // The label is derived, so opening ONE by hand is enough to flip it back.
  await page.locator('.q-rp-filehead').first().click();
  await expect(toggle).toHaveText('Collapse all');

  await toggle.click();
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(0);
  await toggle.click();
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(3);
});

test('search reaches the conditions, and restores what was open', async ({ page }) => {
  await rules(page);

  const owner = page
    .locator('.q-rp-file')
    .filter({ has: page.locator('.q-rp-id', { hasText: 'Q047' }) })
    .first();
  await owner.locator('.q-rp-filehead').click();
  await expect(owner.locator('.q-rp-table')).toBeHidden();

  // A match you cannot see is a filter that lies — searching force-opens it.
  const search = page.getByLabel('Search rules');
  await search.fill('Q047');
  await expect(page.locator('.q-rp-count')).toHaveText('1 of 22 rules');
  await expect(page.locator('.q-rp-file:visible')).toHaveCount(1);
  await expect(owner.locator('.q-rp-table')).toBeVisible();
  await expect(page.locator('.q-rp-table tbody tr:visible')).toHaveCount(1);

  // The corpus covers the expressions, not just the ids: `lag` appears in no
  // rule id and in exactly two rules' SQL — Q008's window condition and Q055's
  // carry-forward, which uses it in both the condition and the update.
  await search.fill('lag');
  await expect(page.locator('.q-rp-count')).toHaveText('2 of 22 rules');
  await expect(page.locator('.q-rp-table tbody tr:visible')).toHaveCount(2);

  await search.fill('zzzz');
  await expect(page.getByText("No rules match 'zzzz'.")).toBeVisible();
  await expect(page.locator('.q-rp-file:visible')).toHaveCount(0);

  // Clearing hands back exactly what the user had open: this one shut.
  await search.fill('');
  await expect(page.locator('.q-rp-count')).toHaveText('22 rules');
  await expect(page.locator('.q-rp-file:visible')).toHaveCount(3);
  await expect(owner.locator('.q-rp-table')).toBeHidden();
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(2);
});

test('empty slots show notes rather than hiding their tabs', async ({ page }) => {
  await page.goto('/quac/');
  // Dataset only: the other two tabs must still exist, each explaining itself.
  await page
    .locator('[data-slot="data"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'tiny', 'people.csv'));
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  await expect(page.locator('.q-preview')).toBeVisible();
  // The whole dataset fits, so the meta line drops the "first N of".
  await expect(page.getByText('12 rows · 5 columns')).toBeVisible();

  await tab(page, 'JSON Schema').click();
  await expect(page.getByText('Load a JSON Schema to see it here.')).toBeVisible();
  // The caption names the rendering in EVERY state, empty included.
  await expect(page.getByText('JSON Schema formatted as a data dictionary')).toBeVisible();
  await tab(page, 'QC rules').click();
  await expect(page.getByText('Load a QC rules file to see it here.')).toBeVisible();
  await expect(page.getByText('QC rules files, one table per file')).toBeVisible();
});

test('the tablist is one tab stop and the arrow keys move and select', async ({ page }) => {
  await loadExample(page);

  await tab(page, 'Dataset').focus();
  await expect(tab(page, 'Dataset')).toHaveAttribute('tabindex', '0');
  await expect(tab(page, 'JSON Schema')).toHaveAttribute('tabindex', '-1');

  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'JSON Schema')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'JSON Schema')).toBeFocused();

  await page.keyboard.press('End');
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('ArrowRight'); // wraps
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Home');
  await expect(tab(page, 'Dataset')).toHaveAttribute('aria-selected', 'true');
});

test('the first click on a non-default tab sticks', async ({ page }) => {
  // Regression: the visibility effect used to read the signal it wrote, so
  // active.set() re-entered it while `pinned` was still false and bounced the
  // very first selection back to Dataset.
  await loadExample(page);

  await tab(page, 'QC rules').click();
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(1000); // outlast any late store settling
  await expect(tab(page, 'QC rules')).toHaveAttribute('aria-selected', 'true');
});
