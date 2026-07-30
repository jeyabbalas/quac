/**
 * P19b: restore→store convergence and the write-through against REAL
 * IndexedDB. The unit tier already pins the debounce/diff logic with fake
 * timers; this tier proves the same machine drives an actual browser DB —
 * injected ~short debounces keep it fast. The dataset leg is deliberately
 * left to e2e: it replays through the ingest controller and needs DuckDB.
 *
 * The module stores (schemaState/rulesState) and the browser origin (one
 * `quac-session` DB, plus the localStorage presence hint) are SHARED across
 * tests, so every test starts from an explicit purge/reset rather than
 * assuming a clean slate, and every armed effect is disposed in afterEach.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openSessionBackend } from '../../src/app/sessionBackend';
import {
  armSessionWriteThrough,
  initSessionPersistence,
  purgeSession,
  restoreStoredSession,
} from '../../src/app/sessionPersistence';
import { readStoredSession } from '../../src/app/sessionSnapshot';
import { setPendingStudioRestore } from '../../src/app/studioSession';
import { createAppStore } from '../../src/app/store';
import {
  addRuleFiles,
  resetRulesSlot,
  restoreRuleFiles,
  rulesState,
  summarizeSlot as summarizeRulesSlot,
} from '../../src/core/rules/rules-store';
import {
  chooseRoot,
  loadSchemaEntries,
  needsRootChoice,
  resetSchemaSlot,
  restoreSchemaEntries,
  schemaState,
} from '../../src/core/schema/schema-store';
import type { SessionBackend } from '../../src/app/sessionBackend';
import type { StoredSession } from '../../src/app/sessionSnapshot';
import type { IntakeEntry } from '../../src/core/schema/types';

const HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n';
const ruleFile = (id: string): string =>
  `${HEADER}${id},validate,row,name,name IS NULL,sql,,error,inline check,true\n`;

const FIRST = 'first.quac.csv';
const SECOND = 'second.quac.csv';
const FIRST_URL = 'https://ex.test/first.quac.csv';

/** Single-root array-of-objects schema (no IndexPicker involved). */
const SINGLE_ROOT: IntakeEntry = {
  relativePath: 'people.schema.json',
  raw: JSON.stringify({
    type: 'array',
    items: { type: 'object', properties: { name: { type: 'string' } } },
  }),
};

/** TWO independent array-of-objects schemas: both in-degree 0, both
 *  array-shaped ⇒ root status 'ambiguous' — the IndexPicker case. */
const TWO_ROOTS: IntakeEntry[] = [
  {
    relativePath: 'a.schema.json',
    raw: JSON.stringify({
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'string' } } },
    }),
  },
  {
    relativePath: 'b.schema.json',
    raw: JSON.stringify({
      type: 'array',
      items: { type: 'object', properties: { b: { type: 'string' } } },
    }),
  },
];

async function open(): Promise<SessionBackend> {
  const backend = await openSessionBackend();
  if (backend === null) throw new Error('IndexedDB unavailable in the test browser');
  return backend;
}

async function readSession(): Promise<StoredSession | null> {
  return readStoredSession(await (await open()).readAll());
}

let dispose: (() => void) | null = null;

beforeEach(async () => {
  resetSchemaSlot();
  resetRulesSlot();
  setPendingStudioRestore(null);
  await purgeSession();
  await (await open()).clear();
});

afterEach(async () => {
  dispose?.();
  dispose = null;
  await purgeSession();
});

test('a burst of rules changes coalesces into ONE backend write with the final state', async () => {
  // Warm the lazy codec + lint chunks first, so the burst below measures the
  // debounce and not a first-import stall.
  await addRuleFiles([{ name: 'warm.quac.csv', text: ruleFile('W1') }]);
  resetRulesSlot();

  const real = await open();
  let writes = 0;
  const counting: SessionBackend = {
    readAll: () => real.readAll(),
    write: (entries) => {
      writes += 1;
      return real.write(entries);
    },
    clear: () => real.clear(),
  };
  await initSessionPersistence(() => Promise.resolve(counting));
  dispose = armSessionWriteThrough(createAppStore(), { dataset: 0, slots: 300, studio: 300 });

  // Two rapid loads → many publishes (loading + relint each) → one flush.
  await addRuleFiles([{ name: FIRST, text: ruleFile('R1'), sourceUrl: FIRST_URL }]);
  await addRuleFiles([{ name: SECOND, text: ruleFile('R2') }]);
  await expect.poll(() => writes, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  await new Promise((resolve) => setTimeout(resolve, 450)); // catch any straggler flush
  expect(writes).toBe(1);

  const session = await readSession();
  expect(session?.rules?.files.map((f) => f.name)).toEqual([FIRST, SECOND]);
  expect(session?.rules?.files.map((f) => f.sourceUrl)).toEqual([FIRST_URL, null]);
  expect(session?.rules?.dirty).toEqual([]);
  expect(session?.meta.syncedConfig.rules).toEqual([FIRST_URL]); // live provenance
  expect(localStorage.getItem('quac.session.hint')).toBe('1');
});

test('restoreRuleFiles converges the real rules store: order, sources, dirty, summary', async () => {
  await restoreRuleFiles(
    [
      { name: FIRST, text: ruleFile('R1'), sourceUrl: FIRST_URL },
      { name: SECOND, text: ruleFile('R2'), sourceUrl: null },
    ],
    [SECOND],
  );
  const state = rulesState.get();
  expect(state.phase).toBe('ready');
  expect(state.files.map((f) => f.file.name)).toEqual([FIRST, SECOND]);
  expect(state.sources).toEqual([FIRST_URL, null]);
  expect(state.dirtyFiles.has(SECOND)).toBe(true);
  // The slot card's own projection reads the restored slot exactly like a
  // fresh load — SQL checks pending because no dataset context is installed.
  expect(summarizeRulesSlot(state)).toEqual({
    status: 'valid',
    detail: '2 files · 2 rules · data checks pending',
  });
});

test('a two-roots set restores with its pinned root — no IndexPicker re-prompt', async () => {
  await loadSchemaEntries(TWO_ROOTS);
  const loaded = schemaState.get().set;
  if (loaded === null) throw new Error('two-roots set missing after load');
  expect(needsRootChoice(loaded)).toBe(true); // ambiguous on first load
  chooseRoot('b.schema.json');
  const chosen = schemaState.get().set;
  if (chosen === null) throw new Error('set missing after chooseRoot');
  expect(chosen.root.rootFileId).toBe('b.schema.json');
  expect(chosen.root.indexFileId).toBe('b.schema.json');

  // Persist-shape (upload): once-stripped paths + raw, plus the pinned root.
  const entries = chosen.files.map((f) => ({ relativePath: f.relativePath, raw: f.raw }));
  resetSchemaSlot();
  await restoreSchemaEntries({
    entries,
    origin: 'upload',
    sourceUrls: [],
    chosenIndexFileId: chosen.root.indexFileId,
  });

  const restored = schemaState.get();
  expect(restored.phase).toBe('ready');
  const restoredSet = restored.set;
  if (restoredSet === null) throw new Error('set missing after restore');
  expect(restoredSet.setId).toBe(chosen.setId);
  expect(restoredSet.root.rootFileId).toBe('b.schema.json');
  expect(needsRootChoice(restoredSet)).toBe(false); // restore never re-prompts
});

test('full loop: write-through persists, restoreStoredSession converges a fresh session', async () => {
  const store = createAppStore();
  await initSessionPersistence();
  const stop = armSessionWriteThrough(store, { dataset: 0, slots: 25, studio: 25 });
  dispose = stop;

  await loadSchemaEntries([SINGLE_ROOT]);
  await addRuleFiles([{ name: FIRST, text: ruleFile('R1') }]);
  store.applyCorrections.set(false);
  const liveSetId = schemaState.get().set?.setId;
  expect(liveSetId).toBeDefined();

  await expect
    .poll(
      async () => {
        const flushed = await readSession();
        if (flushed === null) return false;
        return (
          flushed.schema !== null &&
          flushed.rules !== null &&
          flushed.prefs?.applyCorrections === false
        );
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  const session = await readSession();
  if (session === null) throw new Error('nothing persisted after the flush');

  // The reload picture: effect gone, module stores empty, fresh AppStore.
  stop();
  dispose = null;
  resetSchemaSlot();
  resetRulesSlot();
  const fresh = createAppStore();
  const restored = await restoreStoredSession(fresh, session, 'all');
  expect(restored).toBe(true);

  expect(schemaState.get().phase).toBe('ready');
  expect(schemaState.get().set?.setId).toBe(liveSetId);
  expect(rulesState.get().files.map((f) => f.file.name)).toEqual([FIRST]);
  expect(fresh.applyCorrections.get()).toBe(false);
  // No restore leg failed: nothing reported an error into the slots.
  expect(fresh.slots.schema.get().status).not.toBe('error');
  expect(fresh.slots.rules.get().status).not.toBe('error');
});

test('the all-empty transition clears the DB and the presence hint', async () => {
  const store = createAppStore();
  await initSessionPersistence();
  dispose = armSessionWriteThrough(store, { dataset: 0, slots: 25, studio: 25 });

  await addRuleFiles([{ name: FIRST, text: ruleFile('R1') }]);
  await expect
    .poll(
      async () => {
        const flushed = await readSession();
        return flushed !== null && flushed.rules !== null;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  expect(localStorage.getItem('quac.session.hint')).toBe('1');

  resetRulesSlot(); // the last loaded slot empties — the session is over
  await expect
    .poll(async () => Object.keys(await (await open()).readAll()).length, { timeout: 5_000 })
    .toBe(0);
  expect(localStorage.getItem('quac.session.hint')).toBeNull();
});
