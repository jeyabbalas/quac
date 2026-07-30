/**
 * P22 task 3 — the privacy claim, as a test.
 *
 * The README tells a data steward that after the page loads, QuaC makes no
 * third-party request at all. This is what backs that sentence, and the
 * README may not make it without this spec passing.
 *
 * **Why it is meaningful.** The one thing in QuaC that could plausibly reach
 * the internet is the DuckDB worker: duckdb-wasm 1.33.1-dev57 does not link
 * parquet/icu/json statically and autoloads them from `extensions.duckdb.org`
 * at first use. Those extensions are vendored into `public/duckdb/` at build
 * time and served same-origin, and the worker prelude removes the network at
 * the platform level — but "we removed it" is a claim, and this is the check.
 * Playwright's interception does cover dedicated workers (`NetworkManager`
 * attaches a session for every `targetInfo.type === 'worker'`), so the
 * worker's own fetches and its synchronous XHR extension installs land in the
 * recorder below alongside the page's.
 *
 * **The journey is chosen to touch every lazy chunk**, because a chunk that
 * never loads cannot be caught phoning home: xlsx (SheetJS) → csv (worker
 * boot + the json and icu extensions) → JSON Schema (Ajv) → a rules file with
 * a `js` correction (QuickJS) → Run (the parquet extension) → Download
 * (exceljs) → `#/studio` (CodeMirror).
 *
 * **Both halves are asserted.** The negative half — no off-origin URL was
 * requested, and the belt-and-braces abort never fired — is worthless without
 * the positive half: the recorder must actually have SEEN the wasm binary,
 * the worker script and at least one extension. A test that records nothing
 * passes the negative half trivially.
 *
 * The `:4199` CORS fixture server is deliberately absent. Every byte here is
 * a local file or an origin-local asset.
 *
 * **Scope, honestly.** This proves the ARTIFACT: `vite preview` serves the
 * same `dist/` bytes CI uploads to Pages. Proving the DEPLOYMENT is a
 * different check — the deployment-SHA comparison and `curl` in the release
 * step.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const PUBLIC_DUCKDB = fileURLToPath(new URL('../../public/duckdb', import.meta.url));
const TINY = join(FIXTURES, 'tiny');

const ORIGIN = 'http://localhost:4173';
const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

/** Anything NOT on the preview origin. A RegExp route matches the full URL. */
const OFF_ORIGIN = /^(?!http:\/\/localhost:4173\/)/;

/**
 * A correction written in JS, so the QuickJS chunk is genuinely loaded and
 * its wasm genuinely instantiated. Synthesized rather than committed: the
 * fixture corpus has no js rule for `tiny/people.csv`, and this spec is not a
 * reason to add bytes to `tests/fixtures/` and its byte gate.
 */
const JS_RULES = [
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
  'N001,correct,row,city,city IS NOT NULL,js,"(row) => String(row.city).toUpperCase()",info,City normalized to uppercase.,true',
  'N002,validate,column,person_id,unique,,,error,Identifiers must be unique.,true',
].join('\n');

/** Every file under public/duckdb/, as origin-absolute URLs under /quac/. */
function vendoredDuckdbUrls(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  return walk(PUBLIC_DUCKDB).map(
    (file) => `${ORIGIN}/quac/duckdb/${relative(PUBLIC_DUCKDB, file).split(sep).join(posix.sep)}`,
  );
}

test('a full local run makes zero off-origin requests', async ({ page }) => {
  const requested: string[] = [];
  const blocked: string[] = [];

  page.on('request', (request) => requested.push(request.url()));
  // Belt and braces. If anything off-origin is attempted the recorder above
  // already catches it; this makes sure it cannot also SUCCEED, so a failure
  // here is never a test that quietly let data out while reporting on it.
  await page.route(OFF_ORIGIN, (route) => {
    blocked.push(route.request().url());
    void route.abort('blockedbyclient');
  });

  await page.goto('/quac/');

  // 1 — xlsx: SheetJS lazy chunk, the sheet picker, and the first worker boot.
  const datasetInput = page.locator('[data-slot="data"] input[type="file"]');
  await datasetInput.setInputFiles(join(TINY, 'two_sheets.xlsx'));
  const picker = page.getByRole('dialog', { name: 'Choose a sheet' });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.getByRole('radio', { name: 'people' }).check();
  await picker.getByRole('button', { name: 'Use this sheet' }).click();
  await expect(page.locator('[data-slot="data"] .q-badge')).toHaveText('Valid', {
    timeout: INGEST_TIMEOUT,
  });

  // 2 — csv: the delimited route, which is also what pulls json + icu.
  await datasetInput.setInputFiles(join(TINY, 'people.csv'));
  await expect(page.locator('[data-slot="data"] .q-slotcard-summary')).toHaveText(
    'people.csv · 12 rows × 5 cols',
    { timeout: INGEST_TIMEOUT },
  );

  // 3 — JSON Schema: Ajv, plus the meta-validation dynamic import.
  await page.getByLabel('Browse schema files').setInputFiles(join(TINY, 'people.schema.json'));
  await expect(page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first()).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  // 4 — rules with a js correction: the QuickJS chunk and its wasm.
  await page.locator('[data-slot="rules"] input[type="file"]').setInputFiles([
    {
      name: 'network_isolation.quac.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(JS_RULES),
    },
  ]);
  await expect(page.locator('[data-slot="rules"] .q-slotcard-header .q-badge')).toHaveText(
    'Valid',
    { timeout: INGEST_TIMEOUT },
  );

  // 5 — Run: the parquet extension, through the display-grid COPY.
  await page.locator('.q-runbar-button').click();
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
  await expect(page.locator('.q-report-grid .dt-cell').first()).toBeVisible({ timeout: 60_000 });

  // 6 — Download: exceljs, the largest lazy chunk in the app.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.q-btn--primary', { hasText: 'Download QC Report' }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/\.xlsx$/);

  // 7 — Rule Studio: CodeMirror and the SQL/JS language modes.
  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await expect(page.locator('.q-filebtn')).toHaveCount(1, { timeout: 60_000 });
  await page.locator('.q-filebtn').first().click();
  // Attached, not visible: opening a rule mounts one editor per expression
  // field and which of them is on screen depends on the rule's shape. What
  // this step is here to prove is that the CodeMirror chunk was fetched and
  // ran — a mounted `.cm-editor` is exactly that.
  await page.locator('.cm-editor').first().waitFor({ state: 'attached', timeout: 60_000 });
  expect(await page.locator('.cm-editor').count()).toBeGreaterThan(0);

  // ---- the negative half -------------------------------------------------
  const offOrigin = [...new Set(requested.filter((url) => !url.startsWith(`${ORIGIN}/`)))];
  expect(offOrigin, 'QuaC requested something off-origin').toEqual([]);
  expect(blocked, 'an off-origin request was attempted and aborted').toEqual([]);

  // ---- the positive half: the recorder was not asleep --------------------
  const sawExtension = requested.some((url) => /\/duckdb\/extensions\/.+\.wasm$/.test(url));
  expect(
    requested.some((url) => /\/duckdb\/duckdb-(?:mvp|eh)\.wasm$/.test(url)),
    'no DuckDB wasm binary was recorded — is interception even attached?',
  ).toBe(true);
  expect(
    requested.some((url) => /\/duckdb\/quac-duckdb-browser-.+\.worker\.js$/.test(url)),
    'no hardened worker script was recorded',
  ).toBe(true);
  expect(sawExtension, 'no vendored extension was recorded').toBe(true);
  // …and the run really did produce a report, so none of the above is the
  // trivially-clean network of an app that did nothing.
  expect(await page.locator('.q-report-grid').count()).toBeGreaterThan(0);
});

/**
 * Phase-03 debt: every vendored DuckDB asset must be reachable under
 * `/quac/duckdb/`. Enumerated from disk rather than hardcoded, so a
 * `DUCKDB_CORE_VERSION` bump that moves the extension directory fails this
 * test instead of silently narrowing it — a hardcoded list would keep passing
 * while checking a path nothing loads any more.
 *
 * The floor is what stops an empty (or half-copied) `public/duckdb/` from
 * passing an all-200 assertion over zero files.
 */
test('every vendored DuckDB asset is served under /quac/duckdb/', async ({ page }) => {
  const urls = vendoredDuckdbUrls();
  expect(urls.length, 'public/duckdb/ looks empty — did prebuild run?').toBeGreaterThanOrEqual(10);

  const failures: string[] = [];
  for (const url of urls) {
    // HEAD would be cheaper, but a 96 MB GET is what the app actually does and
    // vite preview answers HEAD differently for some asset types.
    const response = await page.request.get(url, { maxRedirects: 0 });
    if (response.status() !== 200) failures.push(`${String(response.status())} ${url}`);
  }
  expect(failures).toEqual([]);
});
