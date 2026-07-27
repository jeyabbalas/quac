/**
 * UX-06 regression: a cleared slot must forget the URL it was fetched from.
 *
 * `ui-design.md` §5 pins `createUrlField`'s `clear()` as "empties the typed URL
 * on slot clear", but it had ONE call site in all of `src/` — the Dataset card,
 * the only one holding a hook `clearInputs.ts` could reach. The schema and
 * rules clears are store-only, so both cards kept naming the file they had just
 * dropped, under an `Empty` badge.
 *
 * The fix registers a card hook per check-source slot, so this test drives the
 * production ENTRY POINTS (`clearRules`, `clearSchema`, `removeRulesFile`)
 * rather than the stores — that is where every explicit clear converges, and
 * where the sibling `rulesSlotDetails.browser.test.ts` would not reach. The
 * last case is the inverse pin: a store reset called directly must NOT touch
 * the field, which forbids re-doing this inside the cards' render effects (the
 * schema store lands on `phase: 'empty'` when a load THROWS, and a failed load
 * has to keep what was typed).
 *
 * No DuckDB: with no dataset in the store the rules card's lint effect never
 * boots the bridge, which is what keeps this in milliseconds. The user path
 * through the real buttons is covered by `clearInputs.spec.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { clearRules, clearSchema, removeRulesFile } from '../../src/app/clearInputs';
import { createAppStore } from '../../src/app/store';
import { addRuleFiles, clearRuleFiles, resetRulesSlot } from '../../src/core/rules/rules-store';
import { loadSchemaEntries, resetSchemaSlot } from '../../src/core/schema/schema-store';
import { mountRulesSlotCard } from '../../src/ui/views/load/rulesSlotCard';
import { mountSchemaSlotCard } from '../../src/ui/views/load/schema/schemaSlotCard';
import type { Router } from '../../src/app/router';
import type { ShellContext } from '../../src/app/shell';
import type { IntakeEntry } from '../../src/core/schema/types';

const HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n';
const ruleFile = (id: string): string =>
  `${HEADER}${id},validate,row,name,name IS NULL,sql,,error,inline check,true\n`;

const FIRST = 'first.quac.csv';
const SECOND = 'second.quac.csv';

/** A single-root array-of-objects schema — the shape `tiny/people.schema.json`
 *  has, trimmed to what root detection needs (no IndexPicker to dismiss). */
const SCHEMA_ENTRY: IntakeEntry = {
  relativePath: 'people.schema.json',
  raw: JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.org/quac/tiny/people.schema.json',
    title: 'Tiny people table',
    type: 'array',
    items: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  }),
};

/** Neither card reads the router; a stub keeps the address bar out of it. */
const router: Router = {
  route: { get: () => 'load', subscribe: () => () => undefined },
  navigate: () => undefined,
  dispose: () => undefined,
};

let host: HTMLElement;
let ctx: ShellContext;

const slotRoot = (slot: 'schema' | 'rules'): HTMLElement => {
  const root = host.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (root === null) throw new Error(`no ${slot} card mounted`);
  return root;
};
const urlInput = (slot: 'schema' | 'rules'): HTMLInputElement => {
  const input = slotRoot(slot).querySelector<HTMLInputElement>('.q-urlfield-input');
  if (input === null) throw new Error(`the ${slot} card has no URL field`);
  return input;
};
const badge = (slot: 'schema' | 'rules'): string =>
  slotRoot(slot).querySelector('.q-slotcard-header .q-badge')?.textContent ?? '';

/** What a URL fetch leaves behind: the field keeps what was typed. */
const seed = (slot: 'schema' | 'rules'): string => {
  const url = `http://localhost:4199/${slot}-source`;
  urlInput(slot).value = url;
  return url;
};

beforeAll(() => {
  host = document.createElement('div');
  document.body.append(host);
  ctx = { store: createAppStore(), router };
  // Each card owns its own `[data-slot]` wrapper here; `loadView.ts` does the
  // same in production, and the selectors above are the e2e specs' own.
  for (const slot of ['schema', 'rules'] as const) {
    const wrapper = document.createElement('div');
    wrapper.dataset.slot = slot;
    host.append(wrapper);
    if (slot === 'schema') mountSchemaSlotCard(wrapper, ctx);
    else mountRulesSlotCard(wrapper, ctx);
  }
});

afterAll(() => {
  host.remove();
});

beforeEach(() => {
  resetRulesSlot();
  resetSchemaSlot();
  urlInput('schema').value = '';
  urlInput('rules').value = '';
});

test('clearing the QC rules empties the Rules URL field', async () => {
  await addRuleFiles([{ name: FIRST, text: ruleFile('S001') }]);
  const url = seed('rules');
  expect(urlInput('rules').value).toBe(url);

  await clearRules(ctx); // no unsaved Studio work ⇒ no confirm

  expect(badge('rules')).toBe('Empty');
  expect(urlInput('rules').value).toBe('');
});

test('clearing the JSON Schema empties the Schema URL field', async () => {
  await loadSchemaEntries([SCHEMA_ENTRY]);
  seed('schema');
  expect(badge('schema')).not.toBe('Empty');

  clearSchema(ctx);

  expect(badge('schema')).toBe('Empty');
  expect(urlInput('schema').value).toBe('');
  expect(urlInput('rules').value).toBe(''); // per-slot, not a broadcast
});

test('the ✕ empties the field only once it empties the slot', async () => {
  await addRuleFiles([
    { name: FIRST, text: ruleFile('S001') },
    { name: SECOND, text: ruleFile('S002') },
  ]);
  const url = seed('rules');

  // One survivor: the slot still holds a file the URL could have named.
  await removeRulesFile(ctx, FIRST);
  expect(badge('rules')).not.toBe('Empty');
  expect(urlInput('rules').value).toBe(url);

  await removeRulesFile(ctx, SECOND);
  expect(badge('rules')).toBe('Empty');
  expect(urlInput('rules').value).toBe('');
});

test('a bare store reset leaves the fields alone (the fix stays out of the effects)', async () => {
  await addRuleFiles([{ name: FIRST, text: ruleFile('S001') }]);
  await loadSchemaEntries([SCHEMA_ENTRY]);
  const rulesUrl = seed('rules');
  const schemaUrl = seed('schema');

  // Not user clears — the raw store writes an effect-based fix would react to.
  // The schema store makes exactly these writes when a load THROWS, and that
  // text is what the user fixes their typo in.
  clearRuleFiles();
  resetSchemaSlot();

  expect(badge('rules')).toBe('Empty');
  expect(badge('schema')).toBe('Empty');
  expect(urlInput('rules').value).toBe(rulesUrl);
  expect(urlInput('schema').value).toBe(schemaUrl);
});
