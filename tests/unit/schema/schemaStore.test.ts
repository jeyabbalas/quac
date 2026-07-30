// UIX-7: the schema slot's loadToken — a reset (Clear) or a newer load landing
// while loadSchemaEntries/loadSchemaUrls is parked on an await must win; the
// stale completion is discarded silently (no publish, no throw).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chooseRoot,
  loadSchemaEntries,
  loadSchemaUrls,
  needsRootChoice,
  resetSchemaSlot,
  restoreSchemaEntries,
  schemaState,
  summarizeSlot,
} from '../../../src/core/schema/schema-store';
import type { FetchJson, SchemaSet } from '../../../src/core/schema/types';
import { entry } from './helpers';

const ARRAY_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { a: { type: 'string' } } },
};

beforeEach(() => {
  resetSchemaSlot();
});

describe('resetSchemaSlot vs in-flight loads', () => {
  it('a reset landing mid-loadSchemaEntries leaves the slot empty after it settles', async () => {
    const pending = loadSchemaEntries([entry('schema.json', ARRAY_SCHEMA)]);
    expect(schemaState.get().phase).toBe('loading');
    resetSchemaSlot();
    await pending;
    expect(schemaState.get()).toMatchObject({ phase: 'empty', set: null, sourceUrls: [] });
  });

  it('a reset then a fresh load publishes the fresh load normally', async () => {
    const stale = loadSchemaEntries([entry('old.json', ARRAY_SCHEMA)]);
    resetSchemaSlot();
    await stale;
    await loadSchemaEntries([entry('new.json', ARRAY_SCHEMA)]);
    const state = schemaState.get();
    expect(state.phase).toBe('ready');
    expect(state.set?.files.map((f) => f.relativePath)).toEqual(['new.json']);
  });

  it('a newer URL load supersedes an older one still parked on its fetch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch: FetchJson = async (url) => {
      await gate;
      return { finalUrl: url, text: JSON.stringify(ARRAY_SCHEMA) };
    };
    const fastFetch: FetchJson = (url) =>
      Promise.resolve({ finalUrl: url, text: JSON.stringify(ARRAY_SCHEMA) });
    const first = loadSchemaUrls(['https://slow.test/a.json'], slowFetch);
    const second = loadSchemaUrls(['https://fast.test/b.json'], fastFetch);
    release?.();
    await Promise.all([first, second]);
    const state = schemaState.get();
    expect(state.phase).toBe('ready');
    expect(state.sourceUrls).toEqual(['https://fast.test/b.json']);
  });
});

// UX-04: the slot card reads `summarizeSlot(...).status` for BOTH the badge and
// whether Clear is on screen, so a loading window that projects as 'empty' hides
// the one control that can abandon a hung no-timeout fetch. Every loader
// publishes `set: null` while loading, which is exactly what the emptiness guard
// used to match first.
describe('summarizeSlot during the load window (UX-04)', () => {
  it('a URL crawl in flight projects as loading, not empty', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch: FetchJson = async (url) => {
      await gate;
      return { finalUrl: url, text: JSON.stringify(ARRAY_SCHEMA) };
    };
    const pending = loadSchemaUrls(['https://slow.test/a.json'], slowFetch);
    // Mid-fetch: the host has not answered and may never.
    expect(summarizeSlot(schemaState.get())).toEqual({
      status: 'loading',
      detail: 'Loading schema files…',
    });
    release?.();
    await pending;
    expect(summarizeSlot(schemaState.get()).status).toBe('valid');
  });

  it('an upload being compiled projects as loading too', async () => {
    const pending = loadSchemaEntries([entry('schema.json', ARRAY_SCHEMA)]);
    expect(summarizeSlot(schemaState.get()).status).toBe('loading');
    await pending;
    expect(summarizeSlot(schemaState.get()).status).toBe('valid');
  });

  it('an untouched slot is still empty', () => {
    expect(summarizeSlot(schemaState.get())).toEqual({ status: 'empty', detail: '' });
  });
});

// Session restore (P19b): replay persisted entries offline; provenance and the
// stored root choice must come back exactly — restore is indistinguishable from
// the original load.
describe('restoreSchemaEntries', () => {
  const loadedSet = (): SchemaSet => {
    const set = schemaState.get().set;
    if (set === null) throw new Error('expected a loaded schema set');
    return set;
  };

  it('upload round-trip: same setId/fileIds, root back, no prompt', async () => {
    await loadSchemaEntries([
      entry('pkg/core/index.schema.json', {
        type: 'array',
        items: { $ref: './person.schema.json' },
      }),
      entry('pkg/core/person.schema.json', {
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
    ]);
    const original = loadedSet();
    // The original intake stripped `pkg/`, leaving a nested-only set — the
    // exact shape a second strip would rename.
    expect(original.files.map((f) => f.relativePath)).toEqual([
      'core/index.schema.json',
      'core/person.schema.json',
    ]);

    await restoreSchemaEntries({
      entries: original.files.map((f) => ({ relativePath: f.relativePath, raw: f.raw })),
      origin: 'upload',
      sourceUrls: [],
      ...(original.root.indexFileId !== undefined
        ? { chosenIndexFileId: original.root.indexFileId }
        : {}),
    });
    const state = schemaState.get();
    expect(state.phase).toBe('ready');
    expect(state.sourceUrls).toEqual([]);
    const restored = loadedSet();
    expect(restored.setId).toBe(original.setId);
    expect(restored.files.map((f) => f.fileId)).toEqual(original.files.map((f) => f.fileId));
    expect(restored.root.rootFileId).toBe(original.root.rootFileId);
    expect(needsRootChoice(restored)).toBe(false);
  });

  it('URL round-trip: entries replay by fileId offline, provenance republished', async () => {
    const remote: Record<string, unknown> = {
      'https://host.test/schemas/index.json': {
        type: 'array',
        items: { $ref: './person.json' },
      },
      'https://host.test/schemas/person.json': {
        type: 'object',
        properties: { a: { type: 'string' } },
      },
    };
    const fetchJson: FetchJson = (url) => {
      const json = remote[url];
      if (json === undefined) return Promise.reject(new Error(`unexpected fetch ${url}`));
      return Promise.resolve({ finalUrl: url, text: JSON.stringify(json) });
    };
    await loadSchemaUrls(['https://host.test/schemas/index.json'], fetchJson);
    const original = loadedSet();
    expect(original.files).toHaveLength(2); // the crawl pulled person.json

    // Persist shape for URL sets: replay by fileId (the retrieval URL), which
    // relativizeUrlPaths then re-renders into the same display paths.
    await restoreSchemaEntries({
      entries: original.files.map((f) => ({
        relativePath: f.fileId,
        raw: f.raw,
        retrievalUri: f.retrievalUri,
      })),
      origin: 'url',
      sourceUrls: ['https://host.test/schemas/index.json'],
      ...(original.root.indexFileId !== undefined
        ? { chosenIndexFileId: original.root.indexFileId }
        : {}),
    });
    const state = schemaState.get();
    expect(state.phase).toBe('ready');
    expect(state.sourceUrls).toEqual(['https://host.test/schemas/index.json']);
    const restored = loadedSet();
    expect(restored.setId).toBe(original.setId);
    expect(restored.files.map((f) => f.fileId)).toEqual(original.files.map((f) => f.fileId));
    expect(restored.files.map((f) => f.relativePath)).toEqual(
      original.files.map((f) => f.relativePath),
    );
    expect(restored.root.rootFileId).toBe(original.root.rootFileId);
  });

  it('an ambiguous set restores pinned through chosenIndexFileId', async () => {
    const twoRoots = [
      entry('a.schema.json', { type: 'array', items: { type: 'object' } }),
      entry('b.schema.json', { type: 'array', items: { type: 'object' } }),
    ];
    await loadSchemaEntries(twoRoots);
    expect(needsRootChoice(loadedSet())).toBe(true);
    chooseRoot('b.schema.json');
    const original = loadedSet();
    expect(original.root.indexFileId).toBe('b.schema.json');

    await restoreSchemaEntries({
      entries: twoRoots,
      origin: 'upload',
      sourceUrls: [],
      chosenIndexFileId: 'b.schema.json',
    });
    const restored = loadedSet();
    expect(restored.root.rootFileId).toBe('b.schema.json');
    expect(needsRootChoice(restored)).toBe(false);
  });

  it('a pending root choice restores pending and re-prompts', async () => {
    // Persisted before any choice: chosenIndexFileId is simply absent.
    await restoreSchemaEntries({
      entries: [
        entry('a.schema.json', { type: 'array', items: { type: 'object' } }),
        entry('b.schema.json', { type: 'array', items: { type: 'object' } }),
      ],
      origin: 'upload',
      sourceUrls: [],
    });
    const restored = loadedSet();
    expect(schemaState.get().phase).toBe('ready');
    expect(needsRootChoice(restored)).toBe(true);
  });

  it('a reset landing mid-restore discards the stale completion', async () => {
    const pending = restoreSchemaEntries({
      entries: [entry('schema.json', ARRAY_SCHEMA)],
      origin: 'upload',
      sourceUrls: [],
    });
    expect(schemaState.get().phase).toBe('loading');
    resetSchemaSlot();
    await pending;
    expect(schemaState.get()).toMatchObject({ phase: 'empty', set: null, sourceUrls: [] });
  });
});

describe('chooseRoot after a reset', () => {
  it('is a no-op on an empty slot', async () => {
    await loadSchemaEntries([entry('schema.json', ARRAY_SCHEMA)]);
    const fileId = schemaState.get().set?.files[0]?.fileId;
    expect(fileId).toBeDefined();
    resetSchemaSlot();
    const before = schemaState.get();
    chooseRoot(fileId ?? '');
    expect(schemaState.get()).toBe(before);
  });
});
