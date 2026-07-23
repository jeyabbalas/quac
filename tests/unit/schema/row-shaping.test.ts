/**
 * §C.3 row shaping: every table row (NULL→absent, null-typed columns, BigInt
 * precision, NaN/Inf interception, mixed heuristic, extra-column exclusion)
 * plus the open-property-universe fallback detection.
 */
import { describe, expect, test } from 'vitest';
import {
  MIXED_NUMERIC_RE,
  createRowShaper,
  hasOpenPropertyUniverse,
  shapingColumns,
} from '../../../src/core/schema/row-shaping';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { entriesFromDir, entry, fixtureDir } from './helpers';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import type { ShapingColumn } from '../../../src/core/schema/row-shaping';

const col = (name: string, over: Partial<ShapingColumn> = {}): ShapingColumn => ({
  name,
  inSchema: true,
  nullAllowed: false,
  mixed: false,
  ...over,
});

describe('createRowShaper (§C.3 table)', () => {
  test('SQL NULL → property absent; null-typed column → JSON null kept', () => {
    const shaper = createRowShaper([col('a'), col('b', { nullAllowed: true })], {
      includeExtras: false,
    });
    const { obj, flags, castKeys } = shaper.shapeRow([null, null], 0);
    expect(obj).toEqual({ b: null });
    expect('a' in obj).toBe(false);
    expect(flags).toEqual([]);
    expect(castKeys).toEqual([]);
  });

  test('BigInt → Number; beyond ±(2^53−1) → precision warning once per column', () => {
    const shaper = createRowShaper([col('n')], { includeExtras: false });
    const small = shaper.shapeRow([42n], 0);
    expect(small.obj).toEqual({ n: 42 });
    expect(small.flags).toEqual([]);

    const big = shaper.shapeRow([9007199254740993n], 1);
    expect(big.obj.n).toBe(9007199254740992);
    expect(big.flags).toHaveLength(1);
    expect(big.flags[0]).toMatchObject({
      ruleId: 'schema:prop:n:precision',
      scope: 'cell',
      row: 1,
      column: 'n',
      severity: 'warning',
      value: '9007199254740993',
    });
    expect(big.castKeys).toEqual([]);

    // once per column: a second oversized value in the same run adds no flag
    const again = shaper.shapeRow([-9007199254741000n], 2);
    expect(again.obj.n).toBe(-9007199254741000);
    expect(again.flags).toEqual([]);
  });

  test('NaN/±Infinity → absent + cast-family flag + castKey', () => {
    const shaper = createRowShaper([col('x'), col('y')], { includeExtras: false });
    const { obj, flags, castKeys } = shaper.shapeRow([Number.NaN, Number.POSITIVE_INFINITY], 3);
    expect(obj).toEqual({});
    expect(flags.map((f) => [f.ruleId, f.message, f.value])).toEqual([
      ['schema:prop:x:cast', 'NaN is not a finite number.', 'NaN'],
      ['schema:prop:y:cast', 'Infinity is not a finite number.', 'Infinity'],
    ]);
    for (const f of flags) expect(f).toMatchObject({ severity: 'error', scope: 'cell', row: 3 });
    expect(castKeys).toEqual(['3 x', '3 y']);
  });

  test('mixed heuristic: numeric-looking strings become numbers', () => {
    const shaper = createRowShaper([col('m', { mixed: true })], { includeExtras: false });
    const cases: [string, unknown][] = [
      ['42', 42],
      ['-4.2e1', -42],
      ['3.14', 3.14],
      ['abc', 'abc'],
      ['1,5', '1,5'],
      ['', ''],
      [' 42', ' 42'],
    ];
    for (const [input, expected] of cases) {
      expect(shaper.shapeRow([input], 0).obj.m).toBe(expected);
    }
    expect(MIXED_NUMERIC_RE.test('1e5')).toBe(true);
  });

  test('extras excluded by default, included in fallback mode', () => {
    const cols = [col('a'), col('notes', { inSchema: false })];
    const closed = createRowShaper(cols, { includeExtras: false }).shapeRow(['v', 'x'], 0);
    expect(closed.obj).toEqual({ a: 'v' });
    const open = createRowShaper(cols, { includeExtras: true }).shapeRow(['v', 'x'], 0);
    expect(open.obj).toEqual({ a: 'v', notes: 'x' });
  });

  test('shapingColumns derives facts from ColumnMeta presence', () => {
    const a: ColumnMeta = {
      name: 'a',
      required: true,
      jsonTypes: new Set(['integer', 'null']),
      storageType: 'BIGINT',
      mixed: false,
      valueSpec: { kind: 'opaque' },
      conditionals: { asTarget: [], asCondition: [] },
      source: { fileId: 'f', pointer: '/p' },
    };
    const meta = new Map([['a', a]]);
    expect(shapingColumns(['a', 'zz'], meta)).toEqual([
      { name: 'a', inSchema: true, nullAllowed: true, mixed: false },
      { name: 'zz', inSchema: false, nullAllowed: false, mixed: false },
    ]);
  });
});

describe('hasOpenPropertyUniverse (§C.3 fallback detection)', () => {
  const buildSingle = async (items: Record<string, unknown>) => {
    const set = await buildSchemaSet(
      [entry('root.schema.json', { $id: 'https://example.org/t', type: 'array', items })],
      { origin: 'upload' },
    );
    const rootFileId = set.root.rootFileId;
    if (rootFileId === undefined) throw new Error('no root resolved');
    return { set, rootFileId };
  };

  test('mini fixture: closed universe', async () => {
    const entries = entriesFromDir(fixtureDir('synthetic', 'mini'));
    const set = await buildSchemaSet(entries, { origin: 'upload' });
    expect(set.root.rootFileId).toBeDefined();
    expect(hasOpenPropertyUniverse(set, String(set.root.rootFileId))).toBe(false);
  });

  test('patternProperties at row level opens the universe', async () => {
    const { set, rootFileId } = await buildSingle({
      type: 'object',
      properties: { a: { type: 'string' } },
      patternProperties: { '^x_': { type: 'number' } },
    });
    expect(hasOpenPropertyUniverse(set, rootFileId)).toBe(true);
  });

  test('boolean additionalProperties/unevaluatedProperties stay closed', async () => {
    const { set, rootFileId } = await buildSingle({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
      unevaluatedProperties: false,
    });
    expect(hasOpenPropertyUniverse(set, rootFileId)).toBe(false);
  });

  test('schema-valued additionalProperties opens (incl. inside allOf)', async () => {
    const { set, rootFileId } = await buildSingle({
      type: 'object',
      allOf: [{ additionalProperties: { type: 'string' } }],
    });
    expect(hasOpenPropertyUniverse(set, rootFileId)).toBe(true);
  });

  test('cell-level patternProperties (inside a property) does NOT open the row universe', async () => {
    const { set, rootFileId } = await buildSingle({
      type: 'object',
      properties: {
        nested: { type: 'object', patternProperties: { x: { type: 'string' } } },
      },
    });
    expect(hasOpenPropertyUniverse(set, rootFileId)).toBe(false);
  });

  test('reached through a fragment-only $ref', async () => {
    const { set, rootFileId } = await buildSingle({
      type: 'object',
      allOf: [{ $ref: '#/items/$defs/open' }],
      $defs: { open: { patternProperties: { y: { type: 'number' } } } },
    });
    expect(hasOpenPropertyUniverse(set, rootFileId)).toBe(true);
  });
});
