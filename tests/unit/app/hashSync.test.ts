// UIX-10: buildSyncedConfig — the pure core of the address-bar sync, in BOTH
// directions. The fragment is rebuilt wholly from the LIVE stores on every
// load, replace and clear: cleared inputs vanish, replaced ones take over,
// config= always drops (the manifest still names the artifact that changed)
// with the remainder materialized inline, passthrough params survive verbatim,
// and index= is DERIVED from the live root rather than copied — so a schema
// swap can never leave the previous set's index behind.
import { describe, expect, it } from 'vitest';
import { buildSyncedConfig } from '../../../src/app/hashSync';
import { decodeConfig, encodeConfig } from '../../../src/core/share/urlConfig';

describe('buildSyncedConfig — the clear direction', () => {
  it('drops config= and materializes the remaining slots inline', () => {
    const current = decodeConfig(
      'config=https%3A%2F%2Fex.test%2Fmanifest.json&schema=https%3A%2F%2Fex.test%2Fschema.json',
    );
    const next = buildSyncedConfig(current, {
      schemaUrls: [],
      rulesUrls: ['https://ex.test/rules.quac.csv'],
      dataUrl: 'https://ex.test/people.csv',
      schemaIndexId: undefined,
    });
    expect(next.config).toBeUndefined();
    expect(encodeConfig(next)).toBe(
      'rules=https%3A%2F%2Fex.test%2Frules.quac.csv&data=https%3A%2F%2Fex.test%2Fpeople.csv',
    );
  });

  it('rebuilds each key from the live stores, order preserved', () => {
    const current = decodeConfig('rules=https%3A%2F%2Fex.test%2Fold.csv');
    const next = buildSyncedConfig(current, {
      schemaUrls: ['https://ex.test/a.json', 'https://ex.test/b.json'],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: undefined,
    });
    expect(next.schema).toEqual(['https://ex.test/a.json', 'https://ex.test/b.json']);
    expect(next.rules).toEqual([]);
    expect(next.data).toBeUndefined();
  });

  it('preserves passthrough params verbatim', () => {
    const current = decodeConfig('schema=https%3A%2F%2Fex.test%2Fs.json&theme=dark&z=1');
    const next = buildSyncedConfig(current, {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: undefined,
    });
    expect(next.passthrough).toEqual([
      ['theme', 'dark'],
      ['z', '1'],
    ]);
    expect(encodeConfig(next)).toBe('theme=dark&z=1');
  });

  it('keeps index= while schema params remain, drops it with the last one', () => {
    const current = decodeConfig(
      'schema=https%3A%2F%2Fex.test%2Fa.json&rules=https%3A%2F%2Fex.test%2Fr.csv&index=b.json',
    );
    const kept = buildSyncedConfig(current, {
      schemaUrls: ['https://ex.test/a.json'],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: 'b.json',
    });
    expect(kept.index).toBe('b.json');
    const dropped = buildSyncedConfig(current, {
      schemaUrls: [],
      rulesUrls: ['https://ex.test/r.csv'],
      dataUrl: null,
      schemaIndexId: 'b.json',
    });
    expect(dropped.index).toBeUndefined();
  });

  it('upload-origin inputs contribute nothing — the fragment can empty out', () => {
    const current = decodeConfig(
      'schema=https%3A%2F%2Fex.test%2Fs.json&data=https%3A%2F%2Fex.test%2Fd.csv',
    );
    const next = buildSyncedConfig(current, {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: undefined,
    });
    expect(encodeConfig(next)).toBe('');
  });
});

describe('buildSyncedConfig — the load direction (UX-02)', () => {
  it('a replaced dataset takes over data= — the old URL does not survive', () => {
    const current = decodeConfig('data=https%3A%2F%2Fex.test%2Fpeople.csv');
    const next = buildSyncedConfig(current, {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: 'https://ex.test/people.parquet',
      schemaIndexId: undefined,
    });
    expect(next.data).toBe('https://ex.test/people.parquet');
    expect(encodeConfig(next)).toBe('data=https%3A%2F%2Fex.test%2Fpeople.parquet');
  });

  it('a bare fragment GAINS data= when a dataset is loaded by URL', () => {
    const next = buildSyncedConfig(decodeConfig(''), {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: 'https://ex.test/people.csv',
      schemaIndexId: undefined,
    });
    expect(encodeConfig(next)).toBe('data=https%3A%2F%2Fex.test%2Fpeople.csv');
  });

  it('index= is derived from the live root, not copied from the fragment', () => {
    const next = buildSyncedConfig(decodeConfig('schema=https%3A%2F%2Fex.test%2Fa.json'), {
      schemaUrls: ['https://ex.test/a.json'],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: 'person.schema.json',
    });
    expect(next.index).toBe('person.schema.json');
  });

  it('a STALE index= dies with the schema it belonged to', () => {
    // The bar still carries the old set's index; the live root is a different
    // file (or none resolved at all). Copying `current.index` forward would
    // hand the reload an index that names nothing in the new set.
    const current = decodeConfig('schema=https%3A%2F%2Fex.test%2Fold.json&index=old.json');
    const swapped = buildSyncedConfig(current, {
      schemaUrls: ['https://ex.test/new.json'],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: 'new.json',
    });
    expect(swapped.index).toBe('new.json');
    const unresolved = buildSyncedConfig(current, {
      schemaUrls: ['https://ex.test/new.json'],
      rulesUrls: [],
      dataUrl: null,
      schemaIndexId: undefined,
    });
    expect(unresolved.index).toBeUndefined();
  });
});
