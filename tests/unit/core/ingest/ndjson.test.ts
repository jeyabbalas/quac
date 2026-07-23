import { expect, test } from 'vitest';
import { buildNdjsonBytes } from '../../../../src/core/ingest/ndjson';

function lines(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).trimEnd().split('\n');
}

test('values stay strings and preserve leading zeros / big ids', () => {
  const out = lines(buildNdjsonBytes(['id', 'big'], [['007', '0012345678901234567']]));
  expect(out).toHaveLength(1);
  expect(JSON.parse(out[0] ?? '')).toEqual({ id: '007', big: '0012345678901234567' });
});

test('empty string and null both serialize to JSON null', () => {
  const out = lines(buildNdjsonBytes(['a', 'b', 'c'], [['', null, 'x']]));
  expect(JSON.parse(out[0] ?? '')).toEqual({ a: null, b: null, c: 'x' });
});

test('short rows are padded with null', () => {
  const out = lines(buildNdjsonBytes(['a', 'b'], [['only']]));
  expect(JSON.parse(out[0] ?? '')).toEqual({ a: 'only', b: null });
});

test('quotes, newlines, tabs and unicode survive the round trip', () => {
  const tricky = 'say "hi",\nnew\tline — ünïcødé 🦆';
  const out = lines(buildNdjsonBytes(['t'], [[tricky]]));
  expect(out).toHaveLength(1); // embedded \n must be escaped, not literal
  expect(JSON.parse(out[0] ?? '')).toEqual({ t: tricky });
});

test('key order follows the header order', () => {
  const out = lines(buildNdjsonBytes(['z', 'a', 'm'], [['1', '2', '3']]));
  expect(Object.keys(JSON.parse(out[0] ?? '') as object)).toEqual(['z', 'a', 'm']);
});

test('sentinelRow prepends one all-"z" record', () => {
  const out = lines(buildNdjsonBytes(['a', 'b'], [['1', '2']], { sentinelRow: true }));
  expect(out).toHaveLength(2);
  expect(JSON.parse(out[0] ?? '')).toEqual({ a: 'z', b: 'z' });
  expect(JSON.parse(out[1] ?? '')).toEqual({ a: '1', b: '2' });
});

test('every line is independently parseable NDJSON', () => {
  const out = lines(
    buildNdjsonBytes(['a'], [['x'], [null], ['y']], { sentinelRow: true }),
  );
  expect(out).toHaveLength(4);
  for (const line of out) {
    expect(() => {
      JSON.parse(line);
    }).not.toThrow();
  }
});
