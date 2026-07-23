import { expect, test } from 'vitest';
import { buildWrappedJsonBytes } from '../../../../src/core/ingest/wrappedJson';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function unwrap(bytes: Uint8Array): Record<string, string | null>[] {
  const outer = JSON.parse(decode(bytes)) as { j: string }[];
  return outer.map((entry) => {
    expect(Object.keys(entry)).toEqual(['j']);
    expect(typeof entry.j).toBe('string');
    return JSON.parse(entry.j) as Record<string, string | null>;
  });
}

test('output is a top-level JSON array (deterministic loader routing)', () => {
  for (const rows of [[], [['x']], [['x'], ['y']]] as (string | null)[][][]) {
    const text = decode(buildWrappedJsonBytes(1, rows)).trim();
    expect(text.startsWith('[')).toBe(true);
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
  }
});

test('values stay strings and preserve leading zeros / big ids', () => {
  const rows = unwrap(buildWrappedJsonBytes(2, [['007', '0012345678901234567']]));
  expect(rows).toEqual([{ c0: '007', c1: '0012345678901234567' }]);
});

test('empty string and null both serialize to JSON null', () => {
  const rows = unwrap(buildWrappedJsonBytes(3, [['', null, 'x']]));
  expect(rows).toEqual([{ c0: null, c1: null, c2: 'x' }]);
});

test('short rows are padded with null to the declared width', () => {
  const rows = unwrap(buildWrappedJsonBytes(2, [['only']]));
  expect(rows).toEqual([{ c0: 'only', c1: null }]);
});

test('quotes, newlines, tabs and unicode survive the double-encoding round trip', () => {
  const tricky = 'say "hi",\nnew\tline — ünïcødé 🦆 \\backslash\\ {"fake":"json"}';
  const bytes = buildWrappedJsonBytes(1, [[tricky]]);
  expect(unwrap(bytes)).toEqual([{ c0: tricky }]);
});

test('keys are positional c0..cN in column order', () => {
  const rows = unwrap(buildWrappedJsonBytes(3, [['1', '2', '3']]));
  expect(Object.keys(rows[0] ?? {})).toEqual(['c0', 'c1', 'c2']);
});

test('row order is preserved', () => {
  const rows = unwrap(buildWrappedJsonBytes(1, [['a'], [null], ['b']]));
  expect(rows.map((r) => r.c0)).toEqual(['a', null, 'b']);
});

test('zero rows produce a valid empty array', () => {
  expect(JSON.parse(decode(buildWrappedJsonBytes(5, [])))).toEqual([]);
});
