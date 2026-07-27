// UIX-7: the schema slot's loadToken — a reset (Clear) or a newer load landing
// while loadSchemaEntries/loadSchemaUrls is parked on an await must win; the
// stale completion is discarded silently (no publish, no throw).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chooseRoot,
  loadSchemaEntries,
  loadSchemaUrls,
  resetSchemaSlot,
  schemaState,
  summarizeSlot,
} from '../../../src/core/schema/schema-store';
import type { FetchJson } from '../../../src/core/schema/types';
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
