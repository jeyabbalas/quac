import { expect, test } from 'vitest';
import {
  applyPrecedence,
  configToManifest,
  fetchConfigManifest,
  manifestToConfig,
  parseManifest,
} from '../../../../src/core/share/configManifest';
import type { UrlConfig } from '../../../../src/core/share/urlConfig';

const cfg = (over: Partial<UrlConfig> = {}): UrlConfig => ({
  schema: [],
  rules: [],
  passthrough: [],
  ...over,
});

test('parseManifest accepts a well-formed manifest', () => {
  const manifest = parseManifest({
    schema: ['https://h/a.json'],
    rules: ['https://h/r.csv'],
    index: 'https://h/a.json',
    data: 'https://h/d.csv',
  });
  expect(manifest).toEqual({
    schema: ['https://h/a.json'],
    rules: ['https://h/r.csv'],
    index: 'https://h/a.json',
    data: 'https://h/d.csv',
  });
});

test('parseManifest tolerates missing arrays and empty strings', () => {
  expect(parseManifest({})).toEqual({ schema: [], rules: [] });
  expect(parseManifest({ schema: ['https://h/a.json', ''], index: '' })).toEqual({
    schema: ['https://h/a.json'],
    rules: [],
  });
});

test('parseManifest rejects bad shapes with friendly messages', () => {
  expect(() => parseManifest(42)).toThrow(/JSON object/);
  expect(() => parseManifest([])).toThrow(/JSON object/);
  expect(() => parseManifest({ schema: 'https://h/a.json' })).toThrow(/"schema" must be an array/);
  expect(() => parseManifest({ schema: [1, 2] })).toThrow(/"schema" must be an array/);
  expect(() => parseManifest({ index: 5 })).toThrow(/"index" must be a string/);
});

test('manifest ⇄ config round-trip', () => {
  const manifest = { schema: ['https://h/a.json'], rules: ['https://h/r.csv'], index: 'https://h/a.json' };
  const config = manifestToConfig(manifest);
  expect(config).toEqual(cfg({ schema: manifest.schema, rules: manifest.rules, index: manifest.index }));
  expect(configToManifest(config)).toEqual(manifest);
});

test('applyPrecedence: inline overrides each manifest key wholesale', () => {
  const fromManifest = cfg({
    schema: ['https://h/m1.json', 'https://h/m2.json'],
    rules: ['https://h/mr.csv'],
    index: 'https://h/m1.json',
    data: 'https://h/md.csv',
  });
  const inline = cfg({ schema: ['https://h/inline.json'], data: 'https://h/inline.csv' });

  const { merged, overridden } = applyPrecedence(fromManifest, inline);
  expect(merged.schema).toEqual(['https://h/inline.json']); // replaced, not appended
  expect(merged.data).toBe('https://h/inline.csv');
  expect(merged.rules).toEqual(['https://h/mr.csv']); // untouched → from manifest
  expect(merged.index).toBe('https://h/m1.json');
  expect(overridden.sort()).toEqual(['data', 'schema']);
});

test('applyPrecedence: no inline keys keeps the manifest and reports no overrides', () => {
  const fromManifest = cfg({ schema: ['https://h/m.json'], rules: ['https://h/r.csv'] });
  const { merged, overridden } = applyPrecedence(fromManifest, cfg());
  expect(merged.schema).toEqual(['https://h/m.json']);
  expect(merged.rules).toEqual(['https://h/r.csv']);
  expect(overridden).toEqual([]);
});

test('applyPrecedence carries inline passthrough and drops config=', () => {
  const fromManifest = cfg({ schema: ['https://h/m.json'] });
  const inline = cfg({ config: 'https://h/manifest.json', passthrough: [['theme', 'dark']] });
  const { merged } = applyPrecedence(fromManifest, inline);
  expect(merged.config).toBeUndefined();
  expect(merged.passthrough).toEqual([['theme', 'dark']]);
});

test('fetchConfigManifest decodes bytes and validates', async () => {
  const body = JSON.stringify({ schema: ['https://h/a.json'], rules: [] });
  const bytes = new TextEncoder().encode(body).buffer;
  const manifest = await fetchConfigManifest('https://h/config.json', () =>
    Promise.resolve({ bytes }),
  );
  expect(manifest.schema).toEqual(['https://h/a.json']);
});

test('fetchConfigManifest rejects non-JSON with a friendly error', async () => {
  const bytes = new TextEncoder().encode('not json').buffer;
  await expect(
    fetchConfigManifest('https://h/config.json', () => Promise.resolve({ bytes })),
  ).rejects.toThrow(/not valid JSON/);
});
