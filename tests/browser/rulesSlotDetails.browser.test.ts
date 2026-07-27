/**
 * UX-05 regression: an emptied QC Rules card must leave no `Details` behind.
 *
 * `createSlotCard`'s `update()` derives the disclosure's visibility from live
 * DOM — `details.hidden = detailHost.childElementCount === 0` — so a card has
 * to settle its detail host BEFORE calling it. The rules effect called
 * `update()` first and `renderDetails()` second, so `update` counted the
 * PREVIOUS load's file blocks and left a visible `▶ Details` over an `Empty`
 * card, opening onto nothing. The other two slots already render details
 * first (`schemaSlotCard.ts`, and `datasetCard.ts` via `clearLocalUi`).
 *
 * Driven through the production module against the production store, because
 * the card "renders exclusively from the store snapshot" — every one of the
 * three user paths into an empty slot (whole-slot Clear, Clear all inputs,
 * ✕ on the last file) lands on the same `rulesState.set(emptyState())`, so
 * the store is where they converge. No DuckDB: with no dataset in the store
 * the card's lint effect never boots the bridge, which is what keeps this
 * test in milliseconds. The user path through the real buttons is covered by
 * `clearInputs.spec.ts`.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createAppStore } from '../../src/app/store';
import {
  addRuleFiles,
  clearRuleFiles,
  removeRuleFile,
  resetRulesSlot,
} from '../../src/core/rules/rules-store';
import { mountRulesSlotCard } from '../../src/ui/views/load/rulesSlotCard';
import type { Router } from '../../src/app/router';

const HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n';
const ruleFile = (id: string): string => `${HEADER}${id},validate,row,name,name IS NULL,sql,,error,inline check,true\n`;

const FIRST = 'first.quac.csv';
const SECOND = 'second.quac.csv';

/** The card never reads the router; a stub keeps the address bar out of it. */
const router: Router = {
  route: { get: () => 'load', subscribe: () => () => undefined },
  navigate: () => undefined,
  dispose: () => undefined,
};

let host: HTMLElement;

/** The disclosure and its content host, as `slotCard` builds them. */
function disclosure(): { details: HTMLDetailsElement; children: number } {
  const details = host.querySelector<HTMLDetailsElement>('.q-slotcard-details');
  if (details === null) throw new Error('the card has no details disclosure');
  const detailHost = details.querySelector<HTMLElement>(':scope > div');
  return { details, children: detailHost?.childElementCount ?? 0 };
}

const badge = (): string => host.querySelector('.q-slotcard-header .q-badge')?.textContent ?? '';

/** What a cold-loaded card looks like — the state every clear must return to. */
function expectNoDetail(): void {
  const { details, children } = disclosure();
  expect(badge()).toBe('Empty');
  expect(children).toBe(0);
  expect(details.hidden).toBe(true);
  // A re-load must not come back pre-expanded either.
  expect(details.open).toBe(false);
}

beforeAll(() => {
  host = document.createElement('div');
  document.body.append(host);
  mountRulesSlotCard(host, { store: createAppStore(), router });
});

afterAll(() => {
  host.remove();
});

beforeEach(() => {
  resetRulesSlot();
});

test('a cold card carries no details, and loading files reveals one per file', async () => {
  expectNoDetail();

  await addRuleFiles([
    { name: FIRST, text: ruleFile('S001') },
    { name: SECOND, text: ruleFile('S002') },
  ]);

  const { details, children } = disclosure();
  expect(badge()).not.toBe('Empty');
  expect(children).toBe(2);
  expect(details.hidden).toBe(false);
  expect(host.querySelectorAll('.q-rulesfile')).toHaveLength(2);
});

test('clearing the whole slot leaves no details behind', async () => {
  await addRuleFiles([{ name: FIRST, text: ruleFile('S001') }]);
  expect(disclosure().details.hidden).toBe(false);
  // The user had it expanded — the state the report photographed.
  disclosure().details.open = true;

  clearRuleFiles(); // the per-slot Clear and Clear all inputs both land here

  expectNoDetail();
});

test('removing the LAST file leaves no details behind', async () => {
  await addRuleFiles([
    { name: FIRST, text: ruleFile('S001') },
    { name: SECOND, text: ruleFile('S002') },
  ]);
  disclosure().details.open = true;

  // One survivor: the disclosure stays, and stays open.
  expect(await removeRuleFile(FIRST)).toBe(true);
  expect(disclosure().children).toBe(1);
  expect(disclosure().details.hidden).toBe(false);
  expect(disclosure().details.open).toBe(true);

  expect(await removeRuleFile(SECOND)).toBe(true);

  expectNoDetail();
});
