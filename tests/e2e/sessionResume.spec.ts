/**
 * P19b golden journey 17: the session survives reload. Uploaded inputs,
 * Rule Studio work and the Apply-corrections toggle come back from IndexedDB;
 * URL-provenance slots keep re-fetching themselves; the QC report is NEVER
 * restored (consent to compute — the user clicks Run QC again); a different
 * share link wins over the stored session; header Reset returns the app to
 * first-run and a reload STAYS first-run. Restore is route-independent
 * (UIX-19): a reload parked on #/report or #/studio resumes in place — the
 * dataset leg runs through the eagerly-mounted (hidden) Load view.
 *
 * Persistence is debounced (dataset immediate, slots 500 ms, studio 1 s), so
 * every reload is anchored on `readPersisted` polling the real IndexedDB via
 * page.evaluate — reloading on a timer would race the flush.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const HESP_CSV = join(FIXTURES, 'hesp', 'data', 'hesp_dirty_100.csv');
const TINY_CSV = join(FIXTURES, 'tiny', 'people.csv');
const TINY_RULES = join(FIXTURES, 'tiny', 'people_rules.quac.csv');
const TWO_SHEETS = join(FIXTURES, 'tiny', 'two_sheets.xlsx');
const CORS = 'http://localhost:4199';
const HESP_SCHEMA_URL = `${CORS}/hesp/json_schema/core/core.schema.json`;
const HESP_RULES_URLS = [
  `${CORS}/hesp/rules/hesp_keys_and_structure.quac.csv`,
  `${CORS}/hesp/rules/hesp_consistency.quac.csv`,
  `${CORS}/hesp/rules/hesp_corrections.quac.csv`,
];

const INGEST_TIMEOUT = 90_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

const datasetInput = (page: Page): Locator =>
  page.locator('[data-slot="data"] input[type="file"]');
const rulesInput = (page: Page): Locator => page.locator('[data-slot="rules"] input[type="file"]');
const datasetBadge = (page: Page): Locator => page.locator('[data-slot="data"] .q-badge');
const datasetSummary = (page: Page): Locator =>
  page.locator('[data-slot="data"] .q-slotcard-summary');
const schemaBadge = (page: Page): Locator =>
  page.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first();
const rulesBadge = (page: Page): Locator =>
  page.locator('[data-slot="rules"] .q-slotcard-header .q-badge');
const rulesSummary = (page: Page): Locator =>
  page.locator('[data-slot="rules"] .q-slotcard-summary');
const runButton = (page: Page): Locator => page.locator('.q-runbar-button');
const reportPill = (page: Page): Locator =>
  page.locator('.q-tab', { hasText: 'QC Report' }).locator('.q-pill');
const restoreToast = (page: Page): Locator =>
  page.getByText('Restored your previous session.');
const hero = (page: Page): Locator => page.locator('.q-example');

interface PersistedProbe {
  keys: string[];
  studioComment: string | null;
  rulesDirty: string[];
}

/** Read the real IndexedDB from the page. Never CREATES the database — an
 *  accidental versionless create would leave a store-less DB that breaks the
 *  app's own open. Blobs never cross the evaluate boundary (not serializable);
 *  only derived strings come back. */
const readPersisted = (page: Page): Promise<PersistedProbe> =>
  page.evaluate(async () => {
    const empty = {
      keys: [] as string[],
      studioComment: null as string | null,
      rulesDirty: [] as string[],
    };
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === 'quac-session')) return empty;
    return new Promise<typeof empty>((resolve) => {
      const req = indexedDB.open('quac-session');
      req.onerror = () => {
        resolve(empty);
      };
      req.onsuccess = () => {
        const db = req.result;
        let tx: IDBTransaction;
        try {
          tx = db.transaction('session', 'readonly');
        } catch {
          db.close();
          resolve(empty);
          return;
        }
        const store = tx.objectStore('session');
        const keysReq = store.getAllKeys();
        const studioReq = store.get('studio');
        const rulesReq = store.get('rules');
        tx.oncomplete = () => {
          const studio = studioReq.result as
            | { drawer?: { draft?: { comment?: string } } | null }
            | null
            | undefined;
          const rules = rulesReq.result as { dirty?: string[] } | undefined;
          db.close();
          resolve({
            keys: keysReq.result.map(String),
            studioComment: studio?.drawer?.draft?.comment ?? null,
            rulesDirty: rules?.dirty ?? [],
          });
        };
        tx.onerror = () => {
          db.close();
          resolve(empty);
        };
      };
    });
  });

/** The write is debounced — anchor every reload on the record actually landing. */
async function awaitPersisted(page: Page, keys: string[]): Promise<void> {
  await expect
    .poll(async () => (await readPersisted(page)).keys, { timeout: 15_000 })
    .toEqual(expect.arrayContaining(keys));
}

const statValue = async (page: Page, label: string): Promise<number> =>
  Number(
    await page
      .locator('.q-statcard', { hasText: label })
      .locator('.q-statcard-value')
      .innerText(),
  );

async function runToCompletion(page: Page): Promise<void> {
  await runButton(page).click();
  await expect(page).toHaveURL(/#\/report/);
  await expect(page.locator('.q-statcard', { hasText: 'Errors' })).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await expect(page.locator('.q-run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });
}

test('mixed provenance crown: upload + URLs → run → reload → restore, never auto-run, same counts', async ({
  page,
}) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(HESP_CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Schema URL').fill(HESP_SCHEMA_URL);
  await page.locator('[data-slot="schema"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(page.locator('[data-slot="schema"] .q-slotcard-summary')).toContainText(
    '14 files · root: core/core.schema.json',
  );
  await page.getByLabel('Rules URL').fill(HESP_RULES_URLS.join(' '));
  await page.locator('[data-slot="rules"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(rulesSummary(page)).toContainText('3 files · 22 rules', {
    timeout: INGEST_TIMEOUT,
  });

  await runToCompletion(page);
  const errors = await statValue(page, 'Errors');
  const pill = await reportPill(page).innerText();
  expect(errors).toBeGreaterThan(0);

  await awaitPersisted(page, ['meta', 'dataset', 'schema', 'rules']);
  // The run parked the app on #/report — reload lands there, which is the
  // interesting case: the whole restore is route-independent (UIX-19). The
  // dataset leg runs through the eagerly-mounted (hidden) Load view, so the
  // session is back BEFORE the Load tab is ever visited.
  await page.reload();

  // The bar held only what URLs can reload; the upload came back from IDB.
  await expect(restoreToast(page)).toBeVisible({ timeout: INGEST_TIMEOUT });
  expect(page.url()).toContain('schema=');
  expect(page.url()).toContain('rules=');
  expect(page.url()).not.toContain('data=');
  // Hidden-element assertions on purpose — text and enabled-state read fine
  // through `hidden`, and clicking Load first would mask the old parking bug
  // (the dataset used to wait for the Load view to mount).
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(runButton(page)).toBeEnabled({ timeout: INGEST_TIMEOUT });
  expect(page.url()).toContain('#/report');
  await page.getByRole('link', { name: 'Load', exact: true }).click();
  await expect(datasetSummary(page)).toContainText('101 rows × 266 cols');
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(rulesSummary(page)).toContainText('3 files · 22 rules', {
    timeout: INGEST_TIMEOUT,
  });

  // Consent to compute: the report did NOT come back with the inputs.
  await expect(reportPill(page)).toBeHidden();
  await expect(page.locator('.q-statcard')).toHaveCount(0);
  await expect(runButton(page)).toBeEnabled({ timeout: INGEST_TIMEOUT });

  await runToCompletion(page);
  expect(await statValue(page, 'Errors')).toBe(errors);
  await expect(reportPill(page)).toHaveText(pill);
});

test('a pure-URL session reloads through refetch with no restore toast', async ({ page }) => {
  // Typed-in URLs, not a link boot: user actions after the write-through is
  // armed, so the session IS stored — which is what makes the reload take the
  // equal-config row rather than trivially finding nothing.
  await page.goto('/quac/');
  await page.getByLabel('Schema URL').fill(`${CORS}/tiny/people.schema.json`);
  await page.locator('[data-slot="schema"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await page.getByLabel('Rules URL').fill(`${CORS}/tiny/people_rules.quac.csv`);
  await page.locator('[data-slot="rules"]').getByRole('button', { name: 'Fetch' }).click();
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await awaitPersisted(page, ['meta', 'schema', 'rules']);
  await page.reload();
  await expect(schemaBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  // Every slot re-fetched itself from its URL — nothing needed IDB, so
  // nothing claims to have been "restored".
  await expect(restoreToast(page)).toHaveCount(0);
});

test('pure-IDB restore: uploads and the corrections toggle come back, bar stays bare', async ({
  page,
}) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(TINY_CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(TINY_RULES);
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  const toggle = page.locator('.q-runbar-toggle input');
  await toggle.uncheck();

  await awaitPersisted(page, ['meta', 'dataset', 'rules', 'prefs']);
  await page.reload();

  await expect(restoreToast(page)).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toContainText('people.csv');
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await expect(toggle).not.toBeChecked();
  // Uploads contribute nothing shareable — the bar holds no params at all.
  expect(page.url()).toMatch(/#\/load$/);
});

test('an unsaved Studio drawer draft survives a reload on #/studio', async ({ page }) => {
  await page.goto('/quac/');
  await rulesInput(page).setInputFiles(TINY_RULES);
  // No dataset in this journey: SQL checks are pending-data, so Valid.
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await page.locator('.q-rulegrid tbody tr', { hasText: 'R001' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
  await page.locator('#q-rf-comment').fill('Draft typed before the reload.');

  await expect
    .poll(async () => (await readPersisted(page)).studioComment, { timeout: 15_000 })
    .toBe('Draft typed before the reload.');
  await page.reload();

  // The workspace remounts from the restored rules and reopens the drawer
  // with the draft — dirty, so the discard guard is live.
  await expect(page.locator('.q-studio-drawer')).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(page.locator('#q-rf-comment')).toHaveValue('Draft typed before the reload.');
  await page.locator('.q-studio-back').click();
  const guard = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
});

test('a #/studio reload restores the dataset too — no Load visit required', async ({ page }) => {
  // The user's filed repro (UIX-19): work on Rule Studio, refresh, and the
  // session must come back RIGHT THERE — the dataset leg runs through the
  // eagerly-mounted (hidden) Load view, nobody clicks the Load tab.
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(TINY_CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(TINY_RULES);
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await page.locator('.q-rulegrid tbody tr', { hasText: 'R001' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
  await page.locator('#q-rf-comment').fill('Typed on studio, reloaded on studio.');

  await awaitPersisted(page, ['meta', 'dataset', 'rules']);
  await expect
    .poll(async () => (await readPersisted(page)).studioComment, { timeout: 15_000 })
    .toBe('Typed on studio, reloaded on studio.');
  await page.reload();

  await expect(page.locator('.q-studio-drawer')).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(page.locator('#q-rf-comment')).toHaveValue('Typed on studio, reloaded on studio.');
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  // 'Warning', not the pending-data 'Valid': the restored dataset's lint
  // context reached the restored rules — the whole chain ran on #/studio.
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  // The DRAFT re-lints too once the context lands: the restored drawer must
  // not keep a stale "SQL checks are pending" hint beside live data.
  await expect(page.locator('.q-studio-drawer')).not.toContainText(
    'SQL checks are pending until a dataset is loaded.',
    { timeout: INGEST_TIMEOUT },
  );
  expect(page.url()).toContain('#/studio');
});

test('a saved dirty marker survives the reload', async ({ page }) => {
  await page.goto('/quac/');
  await rulesInput(page).setInputFiles(TINY_RULES);
  // No dataset in this journey: SQL checks are pending-data, so Valid.
  await expect(rulesBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });

  await page.getByRole('link', { name: 'Rule Studio' }).click();
  await page.locator('.q-rulegrid tbody tr', { hasText: 'R001' }).click();
  await expect(page.locator('.q-studio-drawer')).toBeVisible();
  await page.locator('#q-rf-comment').fill('Edited and saved for the resume journey.');
  // No dataset loaded → the gate is lint-only and the submit reads accordingly.
  const save = page.getByRole('button', { name: 'Save untested' });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect(page.locator('.q-studio-drawer')).toBeHidden();
  await expect(page.locator('.q-filebtn-dirty')).toBeVisible();

  await expect
    .poll(async () => (await readPersisted(page)).rulesDirty, { timeout: 15_000 })
    .toEqual(['people_rules.quac.csv']);
  await page.reload();

  await expect(page.locator('.q-filebtn')).toHaveCount(1, { timeout: INGEST_TIMEOUT });
  await expect(page.locator('.q-filebtn-dirty')).toBeVisible();
  // The edit itself came back too, not just the marker.
  await page.locator('.q-rulegrid tbody tr', { hasText: 'R001' }).click();
  await expect(page.locator('#q-rf-comment')).toHaveValue(
    'Edited and saved for the resume journey.',
  );
});

test('a different share link wins over the stored session, and stays won across reload', async ({
  page,
}) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(TINY_CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(TINY_RULES);
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await awaitPersisted(page, ['meta', 'dataset', 'rules']);

  // Same browser storage, someone else's link: the link's shape only.
  const pageB = await page.context().newPage();
  await pageB.goto(
    `/quac/#/load?schema=${encodeURIComponent(`${CORS}/tiny/people.schema.json`)}`,
  );
  await expect(schemaBadge(pageB)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetBadge(pageB)).toHaveText('Empty');
  await expect(rulesBadge(pageB)).toHaveText('Empty');
  await expect(restoreToast(pageB)).toHaveCount(0);

  await pageB.reload();
  await expect(schemaBadge(pageB)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetBadge(pageB)).toHaveText('Empty');
  await expect(rulesBadge(pageB)).toHaveText('Empty');
  await expect(restoreToast(pageB)).toHaveCount(0);
  await pageB.close();
});

test('cold boot is unaffected: hero, zero toasts', async ({ page }) => {
  await page.goto('/quac/');
  await expect(hero(page)).toBeVisible();
  await expect(
    page.getByText(
      'Your data never leaves this browser. No uploads, no servers — your session is saved only on this device.',
    ),
  ).toBeVisible();
  await expect(page.locator('.q-toast')).toHaveCount(0);
});

test('header Reset from the Report route returns to first-run, and reload STAYS first-run', async ({
  page,
}) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(TINY_CSV);
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await rulesInput(page).setInputFiles(TINY_RULES);
  await expect(rulesBadge(page)).toHaveText('Warning', { timeout: INGEST_TIMEOUT });
  await awaitPersisted(page, ['meta', 'dataset', 'rules']);

  await page.getByRole('link', { name: 'QC Report' }).click();
  const reset = page.getByRole('button', { name: 'Reset', exact: true });
  await expect(reset).toBeEnabled();
  await reset.click();
  // The same always-confirming flow as the run-bar Clear all inputs.
  const dialog = page.getByRole('dialog', { name: 'Clear all inputs?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.q-panel-note')).toContainText(
    'The session saved in this browser is removed.',
  );
  await dialog.getByRole('button', { name: 'Clear all inputs' }).click();
  await expect(page.getByText('All inputs cleared.')).toBeVisible();
  await expect(reset).toBeDisabled();

  await page.getByRole('link', { name: 'Load', exact: true }).click();
  await expect(hero(page)).toBeVisible();
  await expect
    .poll(async () => (await readPersisted(page)).keys, { timeout: 15_000 })
    .toEqual([]);

  await page.reload();
  await expect(hero(page)).toBeVisible();
  await expect(restoreToast(page)).toHaveCount(0);
});

test('a pinned sheet restores without the SheetPicker', async ({ page }) => {
  await page.goto('/quac/');
  await datasetInput(page).setInputFiles(TWO_SHEETS);
  const picker = page.getByRole('dialog', { name: 'Choose a sheet' });
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.getByRole('radio', { name: 'people' }).check();
  await picker.getByRole('button', { name: 'Use this sheet' }).click();
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toHaveText('two_sheets.xlsx · 4 rows × 3 cols');

  await awaitPersisted(page, ['meta', 'dataset']);
  await page.reload();

  // Restore must never re-prompt for a decision the session already made.
  await expect(restoreToast(page)).toBeVisible({ timeout: INGEST_TIMEOUT });
  await expect(datasetBadge(page)).toHaveText('Valid', { timeout: INGEST_TIMEOUT });
  await expect(datasetSummary(page)).toHaveText('two_sheets.xlsx · 4 rows × 3 cols');
  await expect(picker).toHaveCount(0);
});
