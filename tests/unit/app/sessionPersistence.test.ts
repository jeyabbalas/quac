// P19b write-through disciplines against an in-memory SessionBackend with
// fake timers: rapid changes coalesce into one save, loading slots are never
// flushed, the all-empty state clears the backend (empty ≡ absent), meta is
// written by the same writer as the address bar, a boot restore never
// echo-saves what it just read, and purge/dispose stop the machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armSessionWriteThrough,
  initSessionPersistence,
  purgeSession,
} from '../../../src/app/sessionPersistence';
import { setPendingStudioRestore } from '../../../src/app/studioSession';
import { createAppStore } from '../../../src/app/store';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { resetSchemaSlot, schemaState } from '../../../src/core/schema/schema-store';
import { addRuleFiles, resetRulesSlot } from '../../../src/core/rules/rules-store';
import type { SessionBackend, SessionKey } from '../../../src/app/sessionBackend';
import type { DatasetRecord, MetaRecord } from '../../../src/app/sessionSnapshot';
import type { AppStore, DatasetSession } from '../../../src/app/store';
import type { SchemaSet } from '../../../src/core/schema/types';

interface MemoryBackend {
  backend: SessionBackend;
  map: Map<string, unknown>;
  writes: () => number;
}

function memoryBackend(): MemoryBackend {
  const map = new Map<string, unknown>();
  let writes = 0;
  return {
    map,
    writes: () => writes,
    backend: {
      readAll: () =>
        Promise.resolve(Object.fromEntries(map) as Partial<Record<SessionKey, unknown>>),
      write: (entries) => {
        writes += 1;
        for (const [key, value] of Object.entries(entries)) {
          if (value === null) map.delete(key);
          else map.set(key, value);
        }
        return Promise.resolve(true);
      },
      clear: () => {
        map.clear();
        return Promise.resolve();
      },
    },
  };
}

function fakeDataset(generation: number, sourceUrl?: string): DatasetSession {
  return {
    name: 'people.csv',
    format: 'csv',
    byteSize: 8,
    rowCount: 2,
    columnCount: 2,
    columns: ['a', 'b'],
    renames: [],
    parseWarnings: [],
    source: new Blob(['a,b\n1,2\n']),
    generation,
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
  };
}

const RULES_CSV =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n' +
  'R1,validate,row,a,a IS NULL,sql,,error,check,true\n';

/** A tiny but REAL set — buildSchemaRecord walks set.files and set.root. */
async function tinySchemaSet(): Promise<SchemaSet> {
  return buildSchemaSet(
    [
      {
        relativePath: 'people.schema.json',
        raw: '{"type":"array","items":{"type":"object","properties":{"a":{"type":"string"}}}}',
      },
    ],
    { origin: 'upload' },
  );
}

describe('armSessionWriteThrough', () => {
  let mem: MemoryBackend;
  let store: AppStore;
  let dispose: (() => void) | null = null;

  beforeEach(() => {
    mem = memoryBackend();
    store = createAppStore();
  });

  afterEach(async () => {
    dispose?.();
    dispose = null;
    vi.useRealTimers();
    resetSchemaSlot();
    resetRulesSlot();
    setPendingStudioRestore(null);
    await purgeSession();
  });

  async function arm(): Promise<void> {
    await initSessionPersistence(() => Promise.resolve(mem.backend));
    dispose = armSessionWriteThrough(store);
  }

  it('a dataset generation change flushes immediately, cheap records riding along', async () => {
    await arm();
    vi.useFakeTimers();
    store.dataset.set(fakeDataset(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(mem.writes()).toBe(1);
    const dataset = mem.map.get('dataset') as DatasetRecord;
    expect(dataset.name).toBe('people.csv');
    expect(dataset.blob).toBeInstanceOf(Blob);
    expect(dataset.sourceUrl).toBeUndefined();
    expect(mem.map.get('prefs')).toEqual({ applyCorrections: true });
    expect((mem.map.get('meta') as MetaRecord).v).toBe(1);
  });

  it('N rapid slot changes coalesce into one save', async () => {
    const set = await tinySchemaSet();
    await arm();
    vi.useFakeTimers();
    for (let i = 0; i < 5; i += 1) {
      schemaState.set({ phase: 'ready', set, sourceUrls: [] });
    }
    await vi.advanceTimersByTimeAsync(499);
    expect(mem.writes()).toBe(0); // still inside the debounce window
    await vi.advanceTimersByTimeAsync(200);
    expect(mem.writes()).toBe(1);
    expect(mem.map.has('schema')).toBe(true);
  });

  it('never flushes a slot in the loading phase (hung fetch)', async () => {
    await arm();
    vi.useFakeTimers();
    schemaState.set({ phase: 'loading', set: null, sourceUrls: ['https://ex.test/s.json'] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mem.writes()).toBe(0); // the hang persists nothing
    const set = await tinySchemaSet();
    schemaState.set({ phase: 'ready', set, sourceUrls: ['https://ex.test/s.json'] });
    await vi.advanceTimersByTimeAsync(600);
    expect(mem.writes()).toBe(1); // the settle does
  });

  it('meta comes from the same writer as the address bar', async () => {
    const set = await tinySchemaSet();
    await arm();
    vi.useFakeTimers();
    schemaState.set({ phase: 'ready', set, sourceUrls: ['https://ex.test/s.json'] });
    store.dataset.set(fakeDataset(1, 'https://ex.test/people.csv'));
    await vi.advanceTimersByTimeAsync(600);
    const meta = mem.map.get('meta') as MetaRecord;
    expect(meta.syncedConfig.schema).toEqual(['https://ex.test/s.json']);
    expect(meta.syncedConfig.data).toBe('https://ex.test/people.csv');
    // The upload-only counterpart contributes nothing (live provenance rule).
    expect(meta.syncedConfig.rules).toEqual([]);
  });

  it('rules flush serializes files with sources and dirty marks', async () => {
    await addRuleFiles([{ name: 'r.quac.csv', text: RULES_CSV, sourceUrl: 'https://ex.test/r' }]);
    await arm();
    vi.useFakeTimers();
    // A restore-shaped no-op does not write; an actual change does.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mem.writes()).toBe(0);
    await addRuleFiles([{ name: 'u.quac.csv', text: RULES_CSV }]);
    await vi.advanceTimersByTimeAsync(600);
    expect(mem.writes()).toBe(1);
    const rules = mem.map.get('rules') as { files: { name: string; sourceUrl: string | null }[] };
    expect(rules.files.map((f) => f.sourceUrl)).toEqual(['https://ex.test/r', null]);
  });

  it('the all-empty state clears the backend instead of storing emptiness', async () => {
    await arm();
    vi.useFakeTimers();
    store.dataset.set(fakeDataset(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(mem.map.size).toBeGreaterThan(0);
    store.dataset.set(null); // the clear path
    await vi.advanceTimersByTimeAsync(1);
    expect(mem.map.size).toBe(0);
  });

  it('a boot restore never echo-saves what it just read (markers seed from live)', async () => {
    // State already present at arm time — exactly the post-restore picture.
    const set = await tinySchemaSet();
    schemaState.set({ phase: 'ready', set, sourceUrls: [] });
    store.dataset.set(fakeDataset(1));
    await arm();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mem.writes()).toBe(0);
  });

  it('purgeSession cancels pending flushes and empties the backend', async () => {
    await arm();
    vi.useFakeTimers();
    store.dataset.set(fakeDataset(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(mem.map.size).toBeGreaterThan(0);
    const set = await tinySchemaSet();
    schemaState.set({ phase: 'ready', set, sourceUrls: [] }); // pending 500 ms flush
    await purgeSession();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mem.map.size).toBe(0); // the pending flush died with the purge
  });

  it('dispose stops writes', async () => {
    await arm();
    vi.useFakeTimers();
    dispose?.();
    dispose = null;
    store.dataset.set(fakeDataset(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mem.writes()).toBe(0);
  });
});
