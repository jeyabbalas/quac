/**
 * DuckDB type text → tree (src/core/duckdb-type.ts). The inputs are what
 * `DESCRIBE` prints for data-table's nested stress fixtures — the JSON file's
 * 21 columns and the Parquet file's 36 — so every shape QuaC can meet in a
 * dataset is here, written exactly as DuckDB writes it.
 */
import { describe, expect, it } from 'vitest';
import {
  duckTypeBase,
  isNestedDuckType,
  mayHoldWideIntegers,
  parseDuckType,
  readsAsJson,
} from '../../../src/core/duckdb-type';

describe('parseDuckType', () => {
  it('reads scalars by base name, parameters stripped, words kept', () => {
    expect(parseDuckType('BIGINT')).toEqual({ kind: 'scalar', name: 'BIGINT' });
    expect(parseDuckType('DECIMAL(10,2)')).toEqual({ kind: 'scalar', name: 'DECIMAL' });
    expect(parseDuckType('TIMESTAMP WITH TIME ZONE')).toEqual({
      kind: 'scalar',
      name: 'TIMESTAMP WITH TIME ZONE',
    });
    expect(parseDuckType("ENUM('a)', 'b,c')")).toEqual({ kind: 'scalar', name: 'ENUM' });
    expect(parseDuckType('JSON')).toEqual({ kind: 'json' });
    expect(parseDuckType('VARIANT')).toEqual({ kind: 'variant' });
  });

  it('reads lists and fixed-size arrays, nested any depth', () => {
    expect(parseDuckType('BIGINT[]')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', name: 'BIGINT' },
    });
    expect(parseDuckType('TINYINT[][][]')).toEqual({
      kind: 'list',
      element: { kind: 'list', element: { kind: 'list', element: { kind: 'scalar', name: 'TINYINT' } } },
    });
    expect(parseDuckType('FLOAT[768]')).toEqual({
      kind: 'array',
      size: 768,
      element: { kind: 'scalar', name: 'FLOAT' },
    });
    // The case the old parameter-stripping got wrong: a list OF decimals.
    expect(parseDuckType('DECIMAL(10,2)[]')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', name: 'DECIMAL' },
    });
    expect(parseDuckType('TIMESTAMP WITH TIME ZONE[]')).toEqual({
      kind: 'list',
      element: { kind: 'scalar', name: 'TIMESTAMP WITH TIME ZONE' },
    });
  });

  it('reads struct fields by name, quoted names unquoted, keyword quoting dropped', () => {
    expect(
      parseDuckType(
        'STRUCT(k VARCHAR, score DOUBLE, kind VARCHAR, "my field" JSON, "a.b" BIGINT, "q""k" BOOLEAN, "ünï" VARCHAR)',
      ),
    ).toEqual({
      kind: 'struct',
      fields: [
        ['k', { kind: 'scalar', name: 'VARCHAR' }],
        ['score', { kind: 'scalar', name: 'DOUBLE' }],
        ['kind', { kind: 'scalar', name: 'VARCHAR' }],
        ['my field', { kind: 'json' }],
        ['a.b', { kind: 'scalar', name: 'BIGINT' }],
        ['q"k', { kind: 'scalar', name: 'BOOLEAN' }],
        ['ünï', { kind: 'scalar', name: 'VARCHAR' }],
      ],
    });
    // DESCRIBE quotes keywords that need no quoting; the name is still the name.
    expect(parseDuckType('STRUCT("name" VARCHAR, age BIGINT, langs VARCHAR[])[]')).toEqual({
      kind: 'list',
      element: {
        kind: 'struct',
        fields: [
          ['name', { kind: 'scalar', name: 'VARCHAR' }],
          ['age', { kind: 'scalar', name: 'BIGINT' }],
          ['langs', { kind: 'list', element: { kind: 'scalar', name: 'VARCHAR' } }],
        ],
      },
    });
  });

  it('keeps field names a JavaScript object would mangle', () => {
    const type = parseDuckType('STRUCT(size INTEGER, toJSON VARCHAR, __proto__ VARCHAR, "2" INTEGER, "1" INTEGER)');
    expect(type.kind === 'struct' ? type.fields.map(([name]) => name) : []).toEqual([
      'size',
      'toJSON',
      '__proto__',
      '2',
      '1',
    ]);
  });

  it('reads maps and unions, and structs with a parameterised or spaced field type', () => {
    expect(parseDuckType('MAP(DATE, INTEGER[])')).toEqual({
      kind: 'map',
      key: { kind: 'scalar', name: 'DATE' },
      value: { kind: 'list', element: { kind: 'scalar', name: 'INTEGER' } },
    });
    expect(
      parseDuckType('MAP(VARCHAR, STRUCT(qty INTEGER, price DECIMAL(10,2), note VARCHAR))'),
    ).toEqual({
      kind: 'map',
      key: { kind: 'scalar', name: 'VARCHAR' },
      value: {
        kind: 'struct',
        fields: [
          ['qty', { kind: 'scalar', name: 'INTEGER' }],
          ['price', { kind: 'scalar', name: 'DECIMAL' }],
          ['note', { kind: 'scalar', name: 'VARCHAR' }],
        ],
      },
    });
    expect(parseDuckType('UNION(num INTEGER, str VARCHAR)')).toEqual({
      kind: 'union',
      members: [
        ['num', { kind: 'scalar', name: 'INTEGER' }],
        ['str', { kind: 'scalar', name: 'VARCHAR' }],
      ],
    });
    expect(parseDuckType('STRUCT(ts TIMESTAMP WITH TIME ZONE, d DECIMAL(38,0))')).toEqual({
      kind: 'struct',
      fields: [
        ['ts', { kind: 'scalar', name: 'TIMESTAMP WITH TIME ZONE' }],
        ['d', { kind: 'scalar', name: 'DECIMAL' }],
      ],
    });
  });

  it('reads five levels of structs', () => {
    let type = parseDuckType('STRUCT(l2 STRUCT(l3 STRUCT(l4 STRUCT(l5 STRUCT(leaf BIGINT)))))');
    const names: string[] = [];
    while (type.kind === 'struct') {
      const [field] = type.fields;
      if (field === undefined) break;
      names.push(field[0]);
      type = field[1];
    }
    expect(names).toEqual(['l2', 'l3', 'l4', 'l5', 'leaf']);
    expect(type).toEqual({ kind: 'scalar', name: 'BIGINT' });
  });
});

describe('classification', () => {
  it('nested = LIST, ARRAY, STRUCT, MAP, UNION or VARIANT; JSON reads as JSON but is not nested', () => {
    for (const t of ['BIGINT[]', 'FLOAT[32]', 'STRUCT(x DOUBLE)', 'MAP(VARCHAR, BIGINT)', 'UNION(a INTEGER)', 'VARIANT']) {
      expect(isNestedDuckType(t), t).toBe(true);
      expect(readsAsJson(t), t).toBe(true);
    }
    expect(isNestedDuckType('JSON')).toBe(false);
    expect(readsAsJson('JSON')).toBe(true);
    for (const t of ['VARCHAR', 'BIGINT', 'DECIMAL(18,3)', 'DATE', 'UUID', 'BLOB', 'TIMESTAMP WITH TIME ZONE']) {
      expect(readsAsJson(t), t).toBe(false);
    }
  });

  it('duckTypeBase names the outer type', () => {
    expect(duckTypeBase('DECIMAL(10,2)')).toBe('DECIMAL');
    expect(duckTypeBase('DECIMAL(10,2)[]')).toBe('LIST');
    expect(duckTypeBase('STRUCT("name" VARCHAR)[]')).toBe('LIST');
    expect(duckTypeBase('DOUBLE[3]')).toBe('ARRAY');
    expect(duckTypeBase('MAP(VARCHAR, BIGINT)')).toBe('MAP');
    expect(duckTypeBase('JSON')).toBe('JSON');
    expect(duckTypeBase('varchar')).toBe('VARCHAR');
  });

  it('mayHoldWideIntegers looks inside: 64/128-bit integers, DECIMAL, JSON', () => {
    const wide = (t: string): boolean => mayHoldWideIntegers(parseDuckType(t));
    expect(wide('HUGEINT[]')).toBe(true);
    expect(wide('STRUCT("name" VARCHAR, age BIGINT)[]')).toBe(true);
    expect(wide('MAP(VARCHAR, UBIGINT)')).toBe(true);
    expect(wide('JSON[]')).toBe(true);
    expect(wide('DOUBLE[]')).toBe(false);
    expect(wide('STRUCT(x DOUBLE, y DOUBLE, tier VARCHAR)')).toBe(false);
    expect(wide('INTEGER[]')).toBe(false);
  });
});
