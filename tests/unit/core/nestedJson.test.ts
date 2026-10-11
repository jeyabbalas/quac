/**
 * Reading nested values as JSON text (src/core/nested-json.ts): the SQL that
 * does it, and the parse back — non-finite numbers included, which DuckDB's
 * `to_json` writes bare and `JSON.parse` rejects.
 */
import { describe, expect, it } from 'vitest';
import {
  NON_FINITE_MARK,
  markNonFinite,
  nestedColumnsOf,
  nestedReplaceClause,
  parseJsonText,
  parseNestedColumns,
  selectColumn,
  toJsonText,
} from '../../../src/core/nested-json';

describe('SQL', () => {
  it('reads a nested column as its JSON text, a flat one as itself', () => {
    const nested = new Set(['people']);
    expect(selectColumn('people', nested)).toBe('CAST(to_json("people") AS VARCHAR) AS "people"');
    expect(selectColumn('id', nested)).toBe('"id"');
    expect(selectColumn('people', nested, 'data')).toBe(
      'CAST(to_json(data."people") AS VARCHAR) AS "people"',
    );
    expect(toJsonText('"a""b"')).toBe('CAST(to_json("a""b") AS VARCHAR)');
  });

  it('builds a REPLACE clause only when there is something to replace', () => {
    expect(nestedReplaceClause([])).toBe('');
    expect(nestedReplaceClause(['point', 'my field'])).toBe(
      ' REPLACE (CAST(to_json("point") AS VARCHAR) AS "point", CAST(to_json("my field") AS VARCHAR) AS "my field")',
    );
  });

  it('picks the nested and JSON columns out of a DESCRIBE', () => {
    const types = new Map([
      ['id', 'BIGINT'],
      ['point', 'STRUCT(x DOUBLE)'],
      ['tags', 'VARCHAR[]'],
      ['doc', 'JSON'],
      ['price', 'DECIMAL(10,2)'],
    ]);
    expect([...nestedColumnsOf(types)]).toEqual(['point', 'tags', 'doc']);
  });
});

describe('parseJsonText', () => {
  it('parses ordinary JSON as JSON.parse does', () => {
    expect(parseJsonText('[1,null,"x"]')).toEqual([1, null, 'x']);
    expect(parseJsonText('{"x":-0.0,"y":5e-324}')).toEqual({ x: -0, y: 5e-324 });
  });

  it('reads bare NaN and ±Infinity as null, and leaves the words alone inside strings', () => {
    expect(parseJsonText('[1.5,NaN,Infinity,-Infinity]')).toEqual([1.5, null, null, null]);
    expect(parseJsonText('{"a":NaN,"b":"NaN and Infinity","c":[-Infinity]}')).toEqual({
      a: null,
      b: 'NaN and Infinity',
      c: [null],
    });
  });

  it('keeps a __proto__ field a field', () => {
    const value = parseJsonText('{"__proto__":NaN,"x":1}') as Record<string, unknown>;
    expect(Object.hasOwn(value, '__proto__')).toBe(true);
    expect(value.__proto__).toBeNull();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe('markNonFinite', () => {
  it('replaces only bare tokens, minding escapes inside strings', () => {
    const marked = markNonFinite('["a\\"NaN",NaN]');
    expect(JSON.parse(marked)).toEqual(['a"NaN', `${NON_FINITE_MARK}NaN`]);
  });
});

describe('parseNestedColumns', () => {
  it('parses the listed columns of every row in place and leaves the rest', () => {
    const rows: Record<string, unknown>[] = [
      { __row__: 0, days: '["2020-01-01",null]', label: '["not parsed"]' },
      { __row__: 1, days: null, label: 'x' },
    ];
    parseNestedColumns(rows, new Set(['days']));
    expect(rows).toEqual([
      { __row__: 0, days: ['2020-01-01', null], label: '["not parsed"]' },
      { __row__: 1, days: null, label: 'x' },
    ]);
  });
});
