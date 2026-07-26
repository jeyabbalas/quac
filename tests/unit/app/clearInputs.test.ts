// UIX-7: buildClearedConfig — the pure core of the post-clear hash rewrite.
// A clear rebuilds the #/load fragment from the LIVE stores: cleared inputs
// vanish, config= always drops (the manifest still names the cleared
// artifact) with the remainder materialized inline, passthrough params
// survive verbatim, and index= dies with the last schema= param.
import { describe, expect, it } from 'vitest';
import { buildClearedConfig } from '../../../src/app/clearInputs';
import { decodeConfig, encodeConfig } from '../../../src/core/share/urlConfig';

describe('buildClearedConfig', () => {
  it('drops config= and materializes the remaining slots inline', () => {
    const current = decodeConfig(
      'config=https%3A%2F%2Fex.test%2Fmanifest.json&schema=https%3A%2F%2Fex.test%2Fschema.json',
    );
    const next = buildClearedConfig(current, {
      schemaUrls: [],
      rulesUrls: ['https://ex.test/rules.quac.csv'],
      dataUrl: 'https://ex.test/people.csv',
    });
    expect(next.config).toBeUndefined();
    expect(encodeConfig(next)).toBe(
      'rules=https%3A%2F%2Fex.test%2Frules.quac.csv&data=https%3A%2F%2Fex.test%2Fpeople.csv',
    );
  });

  it('rebuilds each key from the live stores, order preserved', () => {
    const current = decodeConfig('rules=https%3A%2F%2Fex.test%2Fold.csv');
    const next = buildClearedConfig(current, {
      schemaUrls: ['https://ex.test/a.json', 'https://ex.test/b.json'],
      rulesUrls: [],
      dataUrl: null,
    });
    expect(next.schema).toEqual(['https://ex.test/a.json', 'https://ex.test/b.json']);
    expect(next.rules).toEqual([]);
    expect(next.data).toBeUndefined();
  });

  it('preserves passthrough params verbatim', () => {
    const current = decodeConfig('schema=https%3A%2F%2Fex.test%2Fs.json&theme=dark&z=1');
    const next = buildClearedConfig(current, {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: null,
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
    const kept = buildClearedConfig(current, {
      schemaUrls: ['https://ex.test/a.json'],
      rulesUrls: [],
      dataUrl: null,
    });
    expect(kept.index).toBe('b.json');
    const dropped = buildClearedConfig(current, {
      schemaUrls: [],
      rulesUrls: ['https://ex.test/r.csv'],
      dataUrl: null,
    });
    expect(dropped.index).toBeUndefined();
  });

  it('upload-origin inputs contribute nothing — the fragment can empty out', () => {
    const current = decodeConfig('schema=https%3A%2F%2Fex.test%2Fs.json&data=https%3A%2F%2Fex.test%2Fd.csv');
    const next = buildClearedConfig(current, {
      schemaUrls: [],
      rulesUrls: [],
      dataUrl: null,
    });
    expect(encodeConfig(next)).toBe('');
  });
});
