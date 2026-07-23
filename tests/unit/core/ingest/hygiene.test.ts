import { expect, test } from 'vitest';
import { sanitizeColumnNames } from '../../../../src/core/ingest/hygiene';

test('clean input passes through with zero renames', () => {
  const { names, renames } = sanitizeColumnNames(['id', 'name', 'age']);
  expect(names).toEqual(['id', 'name', 'age']);
  expect(renames).toEqual([]);
});

test('reserved __-prefixed names are stripped and reported', () => {
  const { names, renames } = sanitizeColumnNames(['__row__', 'a']);
  expect(names).toEqual(['row__', 'a']);
  expect(renames).toEqual([{ from: '__row__', to: 'row__', reason: 'reserved' }]);
});

test('all-underscore reserved name falls back to positional', () => {
  const { names, renames } = sanitizeColumnNames(['____', 'a']);
  expect(names).toEqual(['column_1', 'a']);
  expect(renames[0]?.reason).toBe('reserved');
});

test('case-insensitive duplicates get numeric suffixes', () => {
  const { names, renames } = sanitizeColumnNames(['ID', 'id', 'Id']);
  expect(names).toEqual(['ID', 'id_2', 'Id_3']);
  expect(renames).toEqual([
    { from: 'id', to: 'id_2', reason: 'duplicate' },
    { from: 'Id', to: 'Id_3', reason: 'duplicate' },
  ]);
});

test('suffix collisions keep counting up', () => {
  const { names } = sanitizeColumnNames(['a', 'a_2', 'a', 'a']);
  expect(names).toEqual(['a', 'a_2', 'a_3', 'a_4']);
});

test('empty and whitespace-only headers get positional names', () => {
  const { names, renames } = sanitizeColumnNames(['', '  ', 'x']);
  expect(names).toEqual(['column_1', 'column_2', 'x']);
  expect(renames.map((r) => r.reason)).toEqual(['empty', 'empty']);
});

test('output names are always unique', () => {
  const { names } = sanitizeColumnNames(['__a', '_a'.replace('_', '__'), 'a', 'A', '', 'column_5']);
  expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
});
