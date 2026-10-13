/**
 * The companion channel end to end (companion.md): a page on this machine
 * opens QuaC, the person allows it, and every set of schemas the page sends
 * is checked against the dataset loaded here. The page hears statuses and
 * the findings without data — never a value from the dataset.
 *
 * The companion is a page this spec serves itself, through a route on a
 * loopback origin nothing listens on (`127.0.0.1:4198`): it opens QuaC,
 * records every message posted to it, and posts what the test tells it to.
 * The dataset is the synthetic mini fixture, whose failures are known
 * (`mini_expected_flags.json`) and whose values must never reach the page.
 *
 * The protocol's rules — which origins may be companions, what a request
 * must look like, the `containsData` refusal — are pinned by the unit test
 * (`tests/unit/core/share/companion.test.ts`); this pins the app's wiring:
 * consent, the opener and origin checks, the run on each request, and the
 * newest-request-wins handover between runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));
const MINI = join(FIXTURES, 'synthetic', 'mini');
const MINI_CSV = join(MINI, 'mini_invalid.csv');
const MINI_SCHEMA = readFileSync(join(MINI, 'mini.schema.json'), 'utf8');
const SCHEMA_PATH = 'mini/mini.schema.json';
/** The schema with age allowed up to 200: the age-range failure is gone. */
const WIDENED = MINI_SCHEMA.replace('"maximum": 100', '"maximum": 200');
/** A QC rules file of the person's own, for the mini dataset. */
const MINI_RULES = [
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled',
  'M001,validate,column,id,unique,,,error,Record identifiers must be unique.,true',
].join('\n');

const QUAC = 'http://localhost:4173';
const COMPANION = 'http://127.0.0.1:4198';
const ENVELOPE = { protocol: 'quac-companion', version: 1 };

const STEP_TIMEOUT = 30_000;
const RUN_TIMEOUT = 150_000;
test.describe.configure({ timeout: 300_000 });

/** Values in mini_invalid.csv that the findings must never carry. */
const SEEDED = ['X99', 'R101', 'R108', 'age-range', 'cond-break', 'dup-a', 'empty-age'];

interface Findings {
  containsData: boolean;
  dataset: { name: string; records: number };
  inputs: { schema: { root: string; files: string[]; setId: string } | null };
  schemaChecks: { ruleId: string; keyword: string | null; records: number | null }[];
}

interface Message {
  protocol: string;
  version: number;
  kind: 'hello' | 'status' | 'findings' | 'closed';
  id?: string | null;
  status?: string;
  detail?: string;
  quacVersion?: string;
  datasetLoaded?: boolean;
  findings?: Findings;
}

/** What the companion page exposes to the test. */
interface CompanionWindow {
  received: { origin: string; data: Message }[];
  openQuac: (link: string) => void;
  post: (message: unknown) => void;
}

const COMPANION_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Companion</title>
<script>
  window.received = [];
  window.addEventListener('message', (event) => {
    window.received.push({ origin: event.origin, data: event.data });
  });
  window.openQuac = (link) => { window.quac = window.open(link, 'quac'); };
  window.post = (message) => { window.quac.postMessage(message, '${QUAC}'); };
</script>`;

async function openCompanion(context: BrowserContext): Promise<Page> {
  await context.route(`${COMPANION}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: COMPANION_PAGE }),
  );
  const companion = await context.newPage();
  await companion.goto(`${COMPANION}/`);
  return companion;
}

/** Open QuaC from the companion, the way schemify's Connect QuaC does. */
async function openQuac(companion: Page, named = COMPANION): Promise<Page> {
  const popup = companion.waitForEvent('popup');
  await companion.evaluate((link) => {
    (window as unknown as CompanionWindow).openQuac(link);
  }, `${QUAC}/quac/#/load?companion=${named}`);
  return popup;
}

const send = (companion: Page, message: Record<string, unknown>): Promise<void> =>
  companion.evaluate(
    (m) => {
      (window as unknown as CompanionWindow).post(m);
    },
    { ...ENVELOPE, ...message },
  );

const schemas = (id: string, text = MINI_SCHEMA): Record<string, unknown> => ({
  kind: 'schemas',
  id,
  files: [{ path: SCHEMA_PATH, text }],
  index: SCHEMA_PATH,
});

/** A request whose one file is not JSON. */
const broken = (id: string): Record<string, unknown> => ({
  kind: 'schemas',
  id,
  files: [{ path: 'broken.json', text: '{ "type": "array", ' }],
});

const received = (companion: Page): Promise<{ origin: string; data: Message }[]> =>
  companion.evaluate(() => (window as unknown as CompanionWindow).received);

const messages = async (companion: Page): Promise<Message[]> =>
  (await received(companion)).map((m) => m.data);

/** The first message matching, once it has arrived. */
async function arrival(
  companion: Page,
  match: (m: Message) => boolean,
  timeout = STEP_TIMEOUT,
): Promise<Message> {
  let found: Message | undefined;
  await expect
    .poll(
      async () => {
        found = (await messages(companion)).find(match);
        return found !== undefined;
      },
      { timeout },
    )
    .toBe(true);
  if (found === undefined) throw new Error('unreachable: the poll passed');
  return found;
}

const statusOf = (id: string, status: string) => (m: Message) =>
  m.kind === 'status' && m.id === id && m.status === status;
const findingsFor = (id: string) => (m: Message) => m.kind === 'findings' && m.id === id;

function findingsOf(message: Message): Findings {
  if (message.findings === undefined) throw new Error(`no findings in ${message.kind}`);
  return message.findings;
}

const bar = (quac: Page): Locator => quac.getByRole('region', { name: 'Companion connection' });
const datasetInput = (quac: Page): Locator => quac.locator('[data-slot="data"] input[type="file"]');
const datasetBadge = (quac: Page): Locator => quac.locator('[data-slot="data"] .q-badge');
const schemaBadge = (quac: Page): Locator =>
  quac.locator('[data-slot="schema"] .q-slotcard-header .q-badge').first();
const rulesInput = (quac: Page): Locator => quac.locator('[data-slot="rules"] input[type="file"]');
const rulesSummary = (quac: Page): Locator =>
  quac.locator('[data-slot="rules"] .q-slotcard-summary');

/** Open QuaC from a fresh companion and press Allow; returns both pages. */
async function connected(context: BrowserContext): Promise<{ companion: Page; quac: Page }> {
  const companion = await openCompanion(context);
  const quac = await openQuac(companion);
  await bar(quac).getByRole('button', { name: 'Allow' }).click();
  await arrival(companion, (m) => m.kind === 'hello');
  return { companion, quac };
}

test('keeps a dataset checked: Allow, schemas, a dataset, the findings without data, a re-check', async ({
  context,
}) => {
  const companion = await openCompanion(context);
  const quac = await openQuac(companion);

  // Consent first: the bar names the page and the promise, and nothing is heard yet.
  await expect(bar(quac)).toContainText(`${COMPANION} asks QuaC to keep checking a dataset`);
  await expect(bar(quac)).toContainText('never your data');
  await send(companion, schemas('before-allow'));

  await bar(quac).getByRole('button', { name: 'Allow' }).click();
  const hello = await arrival(companion, (m) => m.kind === 'hello');
  expect(hello).toMatchObject({ ...ENVELOPE, datasetLoaded: false });
  expect(hello.quacVersion).toMatch(/^\d+\.\d+\.\d+/);
  await expect(bar(quac)).toContainText(`Connected to ${COMPANION}`);

  // Schemas before any dataset: loaded, and waiting for one.
  await send(companion, schemas('r1'));
  await arrival(companion, statusOf('r1', 'needs-dataset'));
  await expect(schemaBadge(quac)).toHaveText('Valid');
  await expect(bar(quac)).toContainText('Load your dataset on the Load tab');

  // The dataset arrives: the check runs on its own, and the findings come back.
  await datasetInput(quac).setInputFiles(MINI_CSV);
  await arrival(companion, statusOf('r1', 'running'), RUN_TIMEOUT);
  const first = findingsOf(await arrival(companion, findingsFor('r1'), RUN_TIMEOUT));
  expect(first.containsData).toBe(false);
  expect(first.dataset).toMatchObject({ name: 'mini_invalid.csv', records: 10 });
  expect(first.inputs.schema).toMatchObject({ root: SCHEMA_PATH, files: [SCHEMA_PATH] });
  const failed = first.schemaChecks.map((c) => c.ruleId);
  for (const ruleId of [
    'schema:prop:id:value',
    'schema:prop:age:value',
    'schema:prop:age:cast',
    'schema:prop:consent:value',
    'schema:cond:0:score',
    'schema:column:notes:unexpected',
  ]) {
    expect(failed).toContain(ruleId);
  }
  await expect(bar(quac)).toContainText('Sent the findings without data');

  // New schemas — age may now reach 200 — are checked again, unasked.
  expect(WIDENED).not.toBe(MINI_SCHEMA);
  await send(companion, schemas('r2', WIDENED));
  const second = findingsOf(await arrival(companion, findingsFor('r2'), RUN_TIMEOUT));
  expect(second.inputs.schema?.setId).not.toBe(first.inputs.schema?.setId);
  expect(second.schemaChecks).not.toContainEqual(
    expect.objectContaining({ ruleId: 'schema:prop:age:value', keyword: 'maximum' }),
  );
  expect(second.schemaChecks.map((c) => c.ruleId)).toContain('schema:prop:id:value');

  // A ping is answered, now with the dataset in.
  await send(companion, { kind: 'ping' });
  await expect
    .poll(async () => (await messages(companion)).filter((m) => m.kind === 'hello').length)
    .toBe(2);
  expect((await messages(companion)).filter((m) => m.kind === 'hello')[1]).toMatchObject({
    datasetLoaded: true,
  });

  // Disconnect: the page is told, and nothing more is heard or sent.
  await bar(quac).getByRole('button', { name: 'Disconnect' }).click();
  await arrival(companion, (m) => m.kind === 'closed');
  await expect(bar(quac)).toContainText('Disconnected: nothing more is sent.');
  await expect(bar(quac).getByRole('button')).toHaveCount(0);
  await send(companion, schemas('r3'));
  await send(companion, { kind: 'ping' });
  await quac.waitForTimeout(1000); // nothing to wait FOR: the assertion is that nothing comes

  const all = await received(companion);
  expect(all.every((m) => m.origin === QUAC)).toBe(true);
  expect(all.every((m) => m.data.protocol === ENVELOPE.protocol && m.data.version === 1)).toBe(
    true,
  );
  // Neither the request sent before Allow nor the ones after Disconnect were heard.
  expect(all.some((m) => m.data.id === 'before-allow' || m.data.id === 'r3')).toBe(false);
  expect(all.filter((m) => m.data.kind === 'hello')).toHaveLength(2);
  const everything = JSON.stringify(all);
  for (const value of SEEDED) expect(everything).not.toContain(value);
});

test('the newest schemas win: a request sent during a check waits for it, then is checked', async ({
  context,
}) => {
  const { companion, quac } = await connected(context);
  await datasetInput(quac).setInputFiles(MINI_CSV);
  await expect(datasetBadge(quac)).toHaveText('Valid', { timeout: RUN_TIMEOUT });

  // Hold r1's check in flight: the first chunk its run loads is answered only
  // once r2 has arrived and been told to wait.
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  await quac.route('**/assets/findingsExport-*.js', async (route) => {
    await released;
    await route.continue();
  });

  await send(companion, schemas('r1'));
  await arrival(companion, statusOf('r1', 'running'), RUN_TIMEOUT);
  await send(companion, schemas('r2', WIDENED));
  await arrival(companion, statusOf('r2', 'busy'));
  await expect(bar(quac)).toContainText('the newest schemas are checked when it ends');
  release();

  const r2 = findingsOf(await arrival(companion, findingsFor('r2'), RUN_TIMEOUT));
  expect(r2.schemaChecks).not.toContainEqual(
    expect.objectContaining({ ruleId: 'schema:prop:age:value', keyword: 'maximum' }),
  );
  await expect(bar(quac)).toContainText('Sent the findings without data');
  // r1's check ended after r2 arrived: its findings would answer an old question.
  expect((await messages(companion)).some(findingsFor('r1'))).toBe(false);
});

test("says when the schemas cannot be used: at once, and when the person's own rules could run", async ({
  context,
}) => {
  const { companion, quac } = await connected(context);

  // Not JSON: refused with the reason before any dataset is in — no run needed to know.
  await send(companion, broken('b1'));
  const unusable = await arrival(companion, statusOf('b1', 'schemas-unusable'));
  expect(unusable.detail).toBeTruthy();
  await expect(bar(quac)).toContainText('The schemas it sent cannot be used');

  // A dataset and a QC rules file of the person's own make a run possible
  // with no schema at all. The page asked about its schemas, so it is told
  // they cannot be used — never sent the findings of a rules-only run.
  await datasetInput(quac).setInputFiles(MINI_CSV);
  await expect(datasetBadge(quac)).toHaveText('Valid', { timeout: RUN_TIMEOUT });
  await rulesInput(quac).setInputFiles({
    name: 'mini_rules.quac.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(MINI_RULES),
  });
  await expect(rulesSummary(quac)).toHaveText('1 file · 1 rule', { timeout: RUN_TIMEOUT });
  await expect(quac.locator('.q-runbar-button')).toBeEnabled();
  await send(companion, broken('b2'));
  await arrival(companion, statusOf('b2', 'schemas-unusable'));
  await send(companion, { kind: 'ping' });
  await expect
    .poll(async () => (await messages(companion)).filter((m) => m.kind === 'hello').length)
    .toBe(2);
  const replies = (await messages(companion)).filter((m) => m.id === 'b1' || m.id === 'b2');
  expect(replies.map((m) => `${m.id ?? ''}:${m.status ?? m.kind}`)).toEqual([
    'b1:schemas-unusable',
    'b2:schemas-unusable',
  ]);
});

test('listens only to the page that opened it, and says goodbye when the tab closes', async ({
  context,
}) => {
  const { companion, quac } = await connected(context);

  // A request posted by anything but the opener — here QuaC's own window — is
  // ignored. The companion's ping, queued after it, is the marker: by its
  // answer, the impostor's has had its turn.
  await quac.evaluate(
    (m) => {
      window.postMessage(m, '*');
    },
    { ...ENVELOPE, kind: 'ping' },
  );
  await send(companion, { kind: 'ping' });
  await expect
    .poll(async () => (await messages(companion)).filter((m) => m.kind === 'hello').length)
    .toBe(2);
  await quac.waitForTimeout(500); // an answer to the impostor would already be here
  expect((await messages(companion)).filter((m) => m.kind === 'hello')).toHaveLength(2);

  await quac.close({ runBeforeUnload: true });
  await arrival(companion, (m) => m.kind === 'closed');
});

test('connects nothing without its opener, a loopback origin, or Allow', async ({
  context,
  page,
}) => {
  // Opened directly, not by the page it names: the bar says so, with nothing to press.
  await page.goto(`/quac/#/load?companion=${COMPANION}`);
  await expect(bar(page)).toContainText('that page did not open it');
  await expect(bar(page).getByRole('button')).toHaveCount(0);

  // A companion on another machine is not one: no bar at all.
  const companion = await openCompanion(context);
  const remote = await openQuac(companion, 'https://example.org');
  await remote.waitForLoadState('networkidle');
  await expect(remote.locator('[data-slot="data"] .q-dropzone')).toBeVisible();
  await expect(bar(remote)).toHaveCount(0);
  await remote.close();

  // Not now: QuaC as it was, and the page's requests go unheard.
  const quac = await openQuac(companion);
  await bar(quac).getByRole('button', { name: 'Not now' }).click();
  await expect(bar(quac)).toContainText('Not connected: nothing is sent anywhere.');
  await expect(bar(quac).getByRole('button')).toHaveCount(0);
  await send(companion, schemas('r1'));
  await send(companion, { kind: 'ping' });
  await quac.waitForTimeout(1000); // nothing to wait FOR: the assertion is that nothing comes
  expect(await received(companion)).toEqual([]);
  await expect(schemaBadge(quac)).not.toHaveText('Valid');
});
