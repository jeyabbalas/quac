/**
 * P22 task 2 — the performance gate: a 100,000 × 20 run completes in under
 * 60 seconds, the annotation cap engages cleanly, and every count stays exact.
 *
 * **It runs in the default `npm run test:e2e`**, which is what "gated in CI"
 * has to mean, but as its own serial Playwright project (`perf`, with
 * `fullyParallel: false` and `dependencies: ['chromium']`). A stopwatch that
 * shares a machine with five competing workers measures the machine, not the
 * app.
 *
 * **The dataset is deterministic** (`support/perfDataset.mjs`, no PRNG), so
 * this asserts exact numbers rather than ranges — including the cap banner's
 * exact sentence, which is the whole point of the cap arithmetic: 24,000 error
 * error cells (three rules of 8,000, because a single rule is capped at 10,000
 * flags) and 9,000 correction cells is 33,000 candidates against an
 * `ANNOTATION_CAP` of 20,000 (the banner must engage) and a `FLAG_CAP_DEFAULT`
 * of 200,000 (nothing truncates, so every count on screen is real).
 *
 * **Parquet, and that is a finding.** V20's delimited ceiling is
 * `rows × cols × rowJsonBytes ≈ 10⁹`; 100k × 20 is ~380× past it. The CSV
 * route cannot reach this gate — not marginally, at all — which is the
 * follow-up recorded with the phase.
 *
 * **What is gated and what is only recorded.** The 60 s wall-clock is the
 * gate. Per-stage milliseconds and the JS heap are printed, never asserted:
 * they are the numbers the progress log wants, and turning hardware variance
 * into a red build would make the suite lie about the app.
 *
 * The harness timeout is 300 s deliberately — five times the gate — so a slow
 * run REPORTS ITS NUMBER instead of dying opaquely at the boundary with
 * nothing to diagnose.
 *
 * Download is asserted enabled but never clicked: exceljs has no browser
 * streaming writer (V21) and a 100k-row in-memory workbook is not what this
 * gate is for. The headless leg writes that file and its wall-clock is
 * recorded in the progress log.
 *
 * Engine-text containment is `errorPaths.spec.ts`'s job; the two checks here
 * are the two failures scale specifically causes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PERF_CELL_FLAGS,
  PERF_ERRORS,
  PERF_COLS,
  PERF_ROWS,
  PERF_RULES_CSV,
  WIDE_COLS,
  WIDE_ROWS,
  writePerfParquet,
  writeWideParquet,
} from './support/perfDataset.mjs';

/** The gate. CI hardware, whole journey: upload → ingest → run → grid. */
const GATE_MS = 60_000;
/** Five times the gate, so a slow run reports rather than times out blind. */
test.describe.configure({ timeout: 300_000 });

const ANNOTATION_CAP = 20_000;

let workDir: string;

test.beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'quac-perf-'));
});

test.afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Chrome's non-standard heap counter. Absent elsewhere; recorded, not gated. */
async function heapMb(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const withMemory = performance as Performance & { memory?: { usedJSHeapSize: number } };
    const used = withMemory.memory?.usedJSHeapSize;
    return used === undefined ? null : Math.round(used / 2 ** 20);
  });
}

const statValue = async (page: Page, label: string): Promise<number> => {
  const text = await page
    .locator('.q-statcard', { hasText: label })
    .locator('.q-statcard-value')
    .textContent();
  return Number((text ?? '').replaceAll(',', ''));
};

test('100,000 × 20 runs end to end inside the 60 s gate', async ({ page }) => {
  const dataset = await writePerfParquet(workDir);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

  await page.goto('/quac/');

  const t0 = Date.now();
  await page.locator('[data-slot="data"] input[type="file"]').setInputFiles(dataset);
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toHaveText(
    `perf_100k_20.parquet · ${String(PERF_ROWS)} rows × ${String(PERF_COLS)} cols`,
    { timeout: 120_000 },
  );
  const tIngest = Date.now();

  await page
    .locator('[data-slot="rules"] input[type="file"]')
    .setInputFiles([
      { name: 'perf_rules.quac.csv', mimeType: 'text/csv', buffer: Buffer.from(PERF_RULES_CSV) },
    ]);
  // Settled, not merely valid — the dataset lint has to finish before Run, or
  // a rule could be excluded and the counts below would be quietly wrong.
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: 120_000 },
  );
  await expect(page.locator('[data-slot="rules"] .q-slotcard-summary')).toHaveText(
    '1 file · 5 rules',
    { timeout: 120_000 },
  );
  const tRules = Date.now();

  await expect(page.locator('.q-runbar-button')).toBeEnabled();
  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: 240_000 });
  const tRun = Date.now();

  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({ timeout: 120_000 });
  const tGrid = Date.now();
  const elapsed = tGrid - t0;

  const heap = await heapMb(page);
  console.log(
    `PERF 100k×20 — total ${String(elapsed)} ms (gate ${String(GATE_MS)}) · ` +
      `ingest ${String(tIngest - t0)} · lint ${String(tRules - tIngest)} · ` +
      `run ${String(tRun - tRules)} · grid ${String(tGrid - tRun)} · ` +
      `heap ${heap === null ? 'n/a' : `${String(heap)} MB`}`,
  );

  // ---- the gate ----------------------------------------------------------
  expect(elapsed, `100k×20 took ${String(elapsed)} ms`).toBeLessThan(GATE_MS);

  // ---- and the run has to have been a real one ---------------------------
  expect(await statValue(page, 'Errors')).toBe(PERF_ERRORS);
  // Five ran and none was skipped: proof that nothing lint-excluded silently,
  // which is the way a "fast" run can be fast for the wrong reason.
  expect(await statValue(page, 'Rules run')).toBe(5);
  expect(await statValue(page, 'Rules skipped')).toBe(0);

  // The cap engaged, and said exactly what it was doing.
  await expect(page.locator('.q-cap-banner')).toHaveText(
    `Painting ${ANNOTATION_CAP.toLocaleString('en-US')} of ` +
      `${PERF_CELL_FLAGS.toLocaleString('en-US')} cell flags — ` +
      'full detail in the panels and the Excel report.',
  );

  // The report is usable and exportable — not clicked (V21: exceljs has no
  // browser streaming writer, and the headless leg covers the export).
  await expect(page.locator('.q-btn--primary', { hasText: 'Download QC Report' })).toBeEnabled();

  // The two failures scale actually causes, neither of which may reach a user.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('Out of Memory');
  expect(body).not.toContain('Binder Error');
  expect(pageErrors).toEqual([]);
});

/**
 * HESP-width spot-check (phase task 2): 265 columns, a tenth of the rows.
 * Typechecked and linted always, run on demand — `QUAC_PERF_WIDE=1` — because
 * width costs schema-translation time the 60 s gate is not about, and the
 * phase asks for the number, not a second gate.
 */
test('265 columns × 10,000 rows — recorded, not gated', async ({ page }) => {
  test.skip(process.env.QUAC_PERF_WIDE === undefined, 'set QUAC_PERF_WIDE=1 to run');

  const dataset = await writeWideParquet(workDir);
  await page.goto('/quac/');

  const t0 = Date.now();
  await page.locator('[data-slot="data"] input[type="file"]').setInputFiles(dataset);
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toHaveText(
    `perf_wide_10k_265.parquet · ${String(WIDE_ROWS)} rows × ${String(WIDE_COLS)} cols`,
    { timeout: 120_000 },
  );
  const tIngest = Date.now();

  await page.locator('[data-slot="rules"] input[type="file"]').setInputFiles([
    {
      name: 'wide_rules.quac.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(
        [
          'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
          'WIDE001,validate,column,record_id,unique,,,error,Record identifiers must be unique.,true',
        ].join('\n'),
      ),
    },
  ]);
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: 120_000 },
  );

  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: 240_000,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: 240_000 });
  const tRun = Date.now();
  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({ timeout: 120_000 });

  console.log(
    `PERF 10k×265 — total ${String(Date.now() - t0)} ms · ingest ${String(tIngest - t0)} · ` +
      `run ${String(tRun - tIngest)} · heap ${String((await heapMb(page)) ?? 'n/a')} MB`,
  );
});
