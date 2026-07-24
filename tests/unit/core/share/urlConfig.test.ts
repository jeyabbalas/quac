import { expect, test } from 'vitest';
import {
  MAX_URL_CHARS,
  assembleFragment,
  decodeConfig,
  encodeConfig,
  isEmptyConfig,
} from '../../../../src/core/share/urlConfig';

test('decodes known keys, preserving repeated schema/rules order', () => {
  const config = decodeConfig(
    'schema=https%3A%2F%2Fh%2Fa.json&schema=https%3A%2F%2Fh%2Fb.json' +
      '&rules=https%3A%2F%2Fh%2Fr1.csv&rules=https%3A%2F%2Fh%2Fr2.csv' +
      '&index=https%3A%2F%2Fh%2Fa.json&data=https%3A%2F%2Fh%2Fd.csv',
  );
  expect(config.schema).toEqual(['https://h/a.json', 'https://h/b.json']);
  expect(config.rules).toEqual(['https://h/r1.csv', 'https://h/r2.csv']);
  expect(config.index).toBe('https://h/a.json');
  expect(config.data).toBe('https://h/d.csv');
  expect(config.config).toBeUndefined();
});

test('encode → decode is a fixpoint incl. order and every field', () => {
  const config = {
    schema: ['https://h/a.json', 'https://h/b.json'],
    rules: ['https://h/r1.csv'],
    index: 'https://schemas.example.org/x#frag',
    data: 'https://h/d.csv',
    config: undefined,
    passthrough: [] as [string, string][],
  };
  expect(decodeConfig(encodeConfig(config))).toEqual(config);
});

test('unknown params are preserved verbatim on re-encode', () => {
  const config = decodeConfig('schema=https%3A%2F%2Fh%2Fa.json&theme=dark&v=2');
  expect(config.passthrough).toEqual([
    ['theme', 'dark'],
    ['v', '2'],
  ]);
  // Round-trips: unknown params survive an encode pass.
  expect(decodeConfig(encodeConfig(config)).passthrough).toEqual(config.passthrough);
  expect(encodeConfig(config)).toContain('theme=dark');
});

test('values needing escaping round-trip (encodeURIComponent contract)', () => {
  const url = 'https://h/path with space/a.json?x=1&y=2';
  const config = { schema: [url], rules: [], passthrough: [] as [string, string][] };
  const query = encodeConfig(config);
  expect(query).toContain(encodeURIComponent(url));
  expect(decodeConfig(query).schema).toEqual([url]);
});

test('assembleFragment preserves the route and omits an empty query', () => {
  const empty = { schema: [], rules: [], passthrough: [] as [string, string][] };
  expect(assembleFragment(empty)).toBe('#/load');
  expect(assembleFragment(empty, 'report')).toBe('#/report');
  const one = { schema: ['https://h/a.json'], rules: [], passthrough: [] as [string, string][] };
  expect(assembleFragment(one)).toBe('#/load?schema=https%3A%2F%2Fh%2Fa.json');
});

test('empty (schema=) params are dropped, not decoded as empty strings', () => {
  const config = decodeConfig('schema=&rules=https%3A%2F%2Fh%2Fr.csv&index=');
  expect(config.schema).toEqual([]);
  expect(config.rules).toEqual(['https://h/r.csv']);
  expect(config.index).toBeUndefined();
});

test('length detection: assembled URL beyond MAX_URL_CHARS is flagged', () => {
  const many = Array.from({ length: 40 }, (_, i) => `https://host.example.org/schemas/file-${String(i)}.json`);
  const config = { schema: many, rules: [], passthrough: [] as [string, string][] };
  const url = `https://jeyabbalas.github.io/quac/${assembleFragment(config)}`;
  expect(url.length).toBeGreaterThan(MAX_URL_CHARS);

  const small = { schema: [many[0] ?? ''], rules: [], passthrough: [] as [string, string][] };
  const smallUrl = `https://jeyabbalas.github.io/quac/${assembleFragment(small)}`;
  expect(smallUrl.length).toBeLessThan(MAX_URL_CHARS);
});

test('isEmptyConfig ignores passthrough-only configs', () => {
  expect(isEmptyConfig({ schema: [], rules: [], passthrough: [] })).toBe(true);
  expect(isEmptyConfig({ schema: [], rules: [], passthrough: [['theme', 'dark']] })).toBe(true);
  expect(isEmptyConfig({ schema: ['https://h/a.json'], rules: [], passthrough: [] })).toBe(false);
});
