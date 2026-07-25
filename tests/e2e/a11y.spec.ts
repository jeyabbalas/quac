/**
 * P19 task 9 — axe over every surface QuaC ships. CI already runs
 * `npm run test:e2e`, so this spec IS "axe in CI"; no workflow edit needed.
 *
 * Gate: serious + critical only, per `ui-design.md §7`.
 *
 * Third-party DOM is excluded from the gate (user decision): QuaC does not
 * author data-table's `.dt-root` or CodeMirror's `.cm-editor` markup and cannot
 * fix violations inside them from here. They are not ignored, though — every
 * scan that has one of those subtrees on screen also runs a NON-GATING
 * diagnostic pass scoped to it and logs what it finds, so the upstream to-do
 * list in `phase-19-polish-a11y.md`'s Deferred notes stays honest.
 *
 * Timeouts and the vocabulary for driving the app (`.q-example-load`,
 * `.q-runbar-button`) are borrowed from `runQc.spec.ts`.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Result } from 'axe-core';
import type { Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const CORS = 'http://localhost:4199';

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

/** ui-design.md §7 gates here; moderate/minor are reported, never fatal. */
const GATED = new Set(['serious', 'critical']);

/** Subtrees QuaC does not author. Excluded from the gate, scanned separately. */
const THIRD_PARTY = ['.dt-root', '.cm-editor'] as const;

/**
 * One readable line per violation. Asserting on THESE rather than on the raw
 * Result[] is deliberate: a failed `toEqual([])` prints its diff, and axe's
 * node objects carry ~60 lines of check metadata each, which buries the one
 * fact you need — which rule broke, and where.
 */
function describeViolations(violations: Result[]): string[] {
  return violations.map((v) => {
    const where = v.nodes
      .slice(0, 4)
      .map((n) => n.target.join(' '))
      .join(' | ');
    return `[${v.impact ?? 'n/a'}] ${v.id} — ${v.help} @ ${where}`;
  });
}

/**
 * Scan `page` and fail on any serious/critical violation outside the
 * third-party subtrees. Returns nothing — the assertion is the point.
 */
async function expectNoSeriousViolations(page: Page, surface: string): Promise<void> {
  let builder = new AxeBuilder({ page });
  for (const selector of THIRD_PARTY) builder = builder.exclude(selector);
  const { violations } = await builder.analyze();

  const gated = violations.filter((v) => GATED.has(v.impact ?? ''));
  const rest = violations.filter((v) => !GATED.has(v.impact ?? ''));
  if (rest.length > 0) {
    console.log(
      `axe [${surface}] — below the gate (FYI):\n  ${describeViolations(rest).join('\n  ')}`,
    );
  }
  expect(describeViolations(gated), `axe serious/critical on ${surface}`).toEqual([]);
}

/**
 * Non-gating: scan ONLY the third-party subtrees present on the page and log
 * everything, so the upstream list can be pasted into the phase file.
 */
async function diagnoseThirdParty(page: Page, surface: string): Promise<void> {
  for (const selector of THIRD_PARTY) {
    if ((await page.locator(selector).count()) === 0) continue;
    const { violations } = await new AxeBuilder({ page }).include(selector).analyze();
    const header = `axe DIAGNOSTIC [${surface} → ${selector}] — upstream, not gated`;
    console.log(
      violations.length === 0
        ? `${header}: clean`
        : `${header}:\n  ${describeViolations(violations).join('\n  ')}`,
    );
  }
}

async function loadExample(page: Page): Promise<void> {
  await page.locator('.q-example-load').click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );
}

test('Load view — first run, all slots filled, and the Share modal', async ({ page }) => {
  await page.goto('/quac/');
  await expect(page.locator('.q-example-load')).toBeVisible();
  await expectNoSeriousViolations(page, 'Load (first run)');

  await loadExample(page);
  // The preview table and the input-consistency line are both on screen by now.
  await expect(page.locator('.q-preview-pertinence-text')).toBeVisible({
    timeout: INGEST_TIMEOUT,
  });
  await expectNoSeriousViolations(page, 'Load (populated)');

  // axe skips [hidden] subtrees, so each Preview panel must be ACTIVATED
  // before it is scanned — otherwise two thirds of the component (the
  // dictionary's twelve tables, its search field, the rules surface) escape
  // the gate entirely.
  for (const name of ['JSON Schema', 'QC rules']) {
    await page.locator('.q-preview .q-paneltab', { hasText: name }).click();
    if (name === 'JSON Schema') {
      await expect(page.locator('.q-dd-cat')).toHaveCount(12, { timeout: 30_000 });
    } else {
      // The highlighter is a lazy chunk; its spans are QuaC-authored markup
      // and must clear colour contrast, so wait for them before scanning.
      await expect(page.locator('.q-rp-file')).toHaveCount(3, { timeout: 30_000 });
      await expect(page.locator('.q-rp-expr .tok-keyword').first()).toBeVisible({
        timeout: 30_000,
      });
    }
    await expectNoSeriousViolations(page, `Load → ${name}`);
  }

  // Collapsed is a state of its own — a stack of <summary> controls and
  // nothing else — and by the same rule each panel needs its own scan.
  await page.locator('.q-rp-toggleall').click();
  await expect(page.locator('.q-rp-table:visible')).toHaveCount(0);
  await expectNoSeriousViolations(page, 'Load → QC rules (collapsed)');

  await page.locator('.q-preview .q-paneltab', { hasText: 'JSON Schema' }).click();
  await page.locator('.q-dd-toggleall').click();
  await expect(page.locator('.q-dd-table:visible')).toHaveCount(0);
  await expectNoSeriousViolations(page, 'Load → JSON Schema (collapsed)');

  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('dialog', { name: 'Share this configuration' })).toBeVisible();
  await expectNoSeriousViolations(page, 'Share modal');
});

/**
 * The populated scan above only ever sees the input-consistency line in its OK
 * tone, which carries no tint at all. Both tinted tones put text ON a severity
 * fill, and the strip this line replaced got exactly that pairing wrong —
 * --q-gray-800 on --q-error-fill, 4.7:1 — so the tints are the part that needs
 * a scan. Driven from the tiny fixtures: two columns and no schema set to
 * resolve, so it costs seconds rather than the example's minute.
 */
test('Load — the input-consistency line in its warning and mismatch tints', async ({ page }) => {
  await page.goto('/quac/');
  await page
    .getByLabel('Browse schema files')
    .setInputFiles(join(FIXTURES, 'tiny', 'people.schema.json'));
  const dataset = page.locator('[data-slot="data"] input[type="file"]');

  await dataset.setInputFiles({
    name: 'people_shouty.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('person_id,name,AGE,city,score\nP001,Ada,36,LONDON,88\n'),
  });
  await expect(page.locator('.q-preview-pertinence--warn')).toBeVisible({
    timeout: INGEST_TIMEOUT,
  });
  await expectNoSeriousViolations(page, 'Load → consistency warning');

  await dataset.setInputFiles({
    name: 'strangers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('alpha,beta,gamma\n1,2,3\n'),
  });
  await expect(page.locator('.q-preview-pertinence--alert')).toBeVisible({
    timeout: INGEST_TIMEOUT,
  });
  await expectNoSeriousViolations(page, 'Load → consistency mismatch');
});

test('QC Report — after a full run, grid mounted', async ({ page }) => {
  await page.goto('/quac/');
  await loadExample(page);

  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
  await expect(page.locator('.dt-cell--annotated').first()).toBeVisible({ timeout: 30_000 });

  await expectNoSeriousViolations(page, 'QC Report');
  await diagnoseThirdParty(page, 'QC Report');

  // Each panel is its own DOM; a scan of Summary alone would miss three.
  // Scoped to .q-report-panels: .q-paneltab now belongs to three tablists
  // (Report, Load Preview, the Studio language switch) and hasText is a
  // SUBSTRING match, so an unscoped locator is one label away from ambiguous.
  for (const tab of ['Missing vars', 'Findings', 'Offenders']) {
    await page.locator('.q-report-panels .q-paneltab', { hasText: tab }).click();
    await expectNoSeriousViolations(page, `QC Report → ${tab}`);
  }
});

test('Rule Studio — workspace open, editor mounted', async ({ page }) => {
  await page.goto('/quac/');
  await loadExample(page);

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(3, { timeout: 30_000 });
  await expectNoSeriousViolations(page, 'Rule Studio (browsing)');

  // Opening a rule swaps the editor into the work column — CodeMirror only
  // exists from here on, and so does the rule form.
  await page.locator('.q-rulegrid tbody tr').first().click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
  await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousViolations(page, 'Rule Studio (editing)');
  await diagnoseThirdParty(page, 'Rule Studio (editing)');
});

test('SheetPicker modal', async ({ page }) => {
  await page.goto('/quac/');
  await page
    .locator('[data-slot="data"] input[type="file"]')
    .setInputFiles(join(FIXTURES, 'tiny', 'two_sheets.xlsx'));

  await expect(page.getByRole('dialog', { name: 'Choose a sheet' })).toBeVisible({
    timeout: 30_000,
  });
  await expectNoSeriousViolations(page, 'SheetPicker modal');
});

test('IndexPicker modal', async ({ page }) => {
  await page.goto('/quac/');
  const a = `${CORS}/synthetic/two-roots/a.schema.json`;
  const b = `${CORS}/synthetic/two-roots/b.schema.json`;
  await page.locator('[data-slot="schema"]').getByLabel('Schema URL').fill(`${a} ${b}`);
  await page.locator('[data-slot="schema"]').getByRole('button', { name: 'Fetch' }).click();

  await expect(page.getByRole('dialog', { name: 'Choose the index schema' })).toBeVisible({
    timeout: 60_000,
  });
  await expectNoSeriousViolations(page, 'IndexPicker modal');
});
