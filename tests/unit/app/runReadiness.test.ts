// UIX-6: the ONE run-readiness predicate. Button and startRun both consume
// this, so the cases below are the behavioral contract for both surfaces:
// either check source alone suffices, a Warning dataset runs, a failed
// re-ingest (slot error + stale store.dataset) refuses, and an index-pending
// schema blocks only when no rules can carry the run. Module-singleton stores
// (schemaState / rulesState) reset in afterEach so cases stay independent.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { effect } from '../../../src/app/signals';
import { assessRunReadiness } from '../../../src/app/runReadiness';
import { createAppStore } from '../../../src/app/store';
import { addRuleFiles, resetRulesSlot } from '../../../src/core/rules/rules-store';
import {
  chooseRoot,
  loadSchemaEntries,
  resetSchemaSlot,
  schemaState,
} from '../../../src/core/schema/schema-store';
import { entriesFromDir, entry, fixtureDir } from '../schema/helpers';
import type { RunReadiness } from '../../../src/app/runReadiness';
import type { AppStore, DatasetSession } from '../../../src/app/store';

const tinyFixture = (name: string): string =>
  readFileSync(join(fixtureDir('tiny'), name), 'utf8');

const TINY_SCHEMA = tinyFixture('people.schema.json');
const TINY_RULES = tinyFixture('people_rules.quac.csv');
/** Every required header absent → file-level structural error, nothing runs. */
const BROKEN_RULES = 'foo,bar\nx,y\n';

const session = (): DatasetSession => ({
  name: 'people.csv',
  format: 'csv',
  byteSize: 120,
  rowCount: 12,
  columnCount: 5,
  columns: ['person_id', 'name', 'age', 'city', 'score'],
  renames: [],
  parseWarnings: [],
  source: new Blob(['stub']),
  generation: 1,
});

const withDataset = (store: AppStore, status: 'valid' | 'warning' = 'valid'): void => {
  store.dataset.set(session());
  store.slots.data.set({ status, detail: 'people.csv · 12 rows × 5 cols' });
};

const loadTinySchema = (): Promise<void> =>
  loadSchemaEntries([entry('people.schema.json', TINY_SCHEMA)]);

const loadTinyRules = (): Promise<void> =>
  addRuleFiles([{ name: 'people_rules.quac.csv', text: TINY_RULES }]);

afterEach(() => {
  resetSchemaSlot();
  resetRulesSlot();
});

describe('assessRunReadiness — blocked states', () => {
  it('a run in progress blocks silently-codeable as running', () => {
    const store = createAppStore();
    withDataset(store);
    store.pipeline.set({
      stage: 'prepare',
      progress: { done: 0, total: 0 },
      cancel: { cancelled: false, cancel: () => undefined },
    });
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('running');
  });

  it('a loading dataset blocks ahead of everything else', async () => {
    const store = createAppStore();
    await loadTinySchema();
    store.slots.data.set({ status: 'loading', detail: '' });
    expect(assessRunReadiness(store).code).toBe('data-loading');
  });

  it('no dataset blocks even with both check sources loaded', async () => {
    const store = createAppStore();
    await loadTinySchema();
    await loadTinyRules();
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('no-dataset');
    expect(r.reason).toBe('Load a dataset to run QC.');
  });

  it('a failed re-ingest (slot error, stale store.dataset) refuses to run old data', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadTinySchema();
    store.slots.data.set({ status: 'error', detail: 'parse failed' });
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('dataset-error');
    expect(r.reason).toBe('The dataset failed to load — fix it or load another to run QC.');
  });

  it('an index-pending schema with no rules blocks with the choose-index reason and hint', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadSchemaEntries(entriesFromDir(fixtureDir('synthetic', 'two-roots')));
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('schema-index-pending');
    expect(r.reason).toBe('Choose the index schema on the JSON Schema card to run QC.');
    expect(r.hint).toBe('Or load a QC rules file — either input is enough to run.');
  });

  it('a fatally-broken schema with no rules blocks as schema-unusable, not index-pending', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadSchemaEntries([entry('bad.json', '{ this is not json')]);
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('schema-unusable');
    expect(r.reason).toBe(
      'The JSON Schema has errors that block validation — fix it or load a QC rules file to run QC.',
    );
  });

  it('rules whose every file is structurally broken block as rules-blocked', async () => {
    const store = createAppStore();
    withDataset(store);
    await addRuleFiles([{ name: 'broken.quac.csv', text: BROKEN_RULES }]);
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('rules-blocked');
    expect(r.reason).toBe(
      'Every QC rules file has blocking lint errors — fix them or load a JSON Schema to run QC.',
    );
  });

  it('a dataset alone blocks as no-checks', () => {
    const store = createAppStore();
    withDataset(store);
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(false);
    expect(r.code).toBe('no-checks');
    expect(r.reason).toBe('Load a JSON Schema or a QC rules file to run QC.');
  });
});

describe('assessRunReadiness — ready states', () => {
  it('schema alone is enough; the exact run inputs come back', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadTinySchema();
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(true);
    expect(r.code).toBeNull();
    expect(r.reason).toBe('');
    expect(r.note).toBeUndefined();
    expect(r.schema).not.toBeNull();
    expect(r.schema?.digest.meta.length).toBeGreaterThan(0);
    expect(r.ruleFiles).toEqual([]);
  });

  it('rules alone are enough, lint-filtered exactly as the run sees them', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadTinyRules();
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(true);
    expect(r.schema).toBeNull();
    expect(r.ruleFiles).toHaveLength(1);
    expect(r.ruleFiles[0]?.rules.length).toBe(6);
  });

  it('a Warning dataset is runnable', async () => {
    const store = createAppStore();
    withDataset(store, 'warning');
    await loadTinyRules();
    expect(assessRunReadiness(store).ready).toBe(true);
  });

  it('an index-pending schema rides along as a note once rules can carry the run', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadSchemaEntries(entriesFromDir(fixtureDir('synthetic', 'two-roots')));
    await loadTinyRules();
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(true);
    expect(r.schema).toBeNull();
    expect(r.note).toBe(
      "The JSON Schema is waiting on an index choice and won't be checked this run.",
    );
  });

  it('choosing the index clears the note and the schema joins the run', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadSchemaEntries(entriesFromDir(fixtureDir('synthetic', 'two-roots')));
    await loadTinyRules();
    const fileId = schemaState.get().set?.root.candidates[0]?.fileId;
    expect(fileId).toBeDefined();
    chooseRoot(fileId ?? '');
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(true);
    expect(r.note).toBeUndefined();
    expect(r.schema).not.toBeNull();
  });

  it('structurally-broken rules ride along as a note once the schema carries the run', async () => {
    const store = createAppStore();
    withDataset(store);
    await loadTinySchema();
    await addRuleFiles([{ name: 'broken.quac.csv', text: BROKEN_RULES }]);
    const r = assessRunReadiness(store);
    expect(r.ready).toBe(true);
    expect(r.ruleFiles).toEqual([]);
    expect(r.note).toBe("The QC rules all have blocking lint errors and won't run this time.");
  });
});

describe('assessRunReadiness — signals reactivity', () => {
  it('re-fires an effect when a later-leg signal flips while an earlier blocker is active', async () => {
    const store = createAppStore(); // no dataset → blocked before the schema leg matters
    const seen: (string | null)[] = [];
    // Object property on purpose: TS pins closure-assigned `let`s to their
    // initializer type (the pipeline.ts gotcha).
    const last: { r: RunReadiness | null } = { r: null };
    const dispose = effect(() => {
      last.r = assessRunReadiness(store);
      seen.push(last.r.code);
    });
    expect(seen).toEqual(['no-dataset']);
    // The early no-dataset return must NOT have unsubscribed the schema leg.
    await loadTinySchema();
    expect(seen.length).toBeGreaterThan(1);
    expect(last.r?.code).toBe('no-dataset');
    // …and once the earlier blocker clears, the already-tracked leg is live.
    withDataset(store);
    expect(last.r?.ready).toBe(true);
    dispose();
  });
});
