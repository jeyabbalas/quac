/**
 * §C.1/§C.2 casting: storage-target derivation, CastPlan SQL snapshot, and
 * execution goldens on @duckdb/node-api (SQL parity, testing-strategy §1).
 * Pins the V19 ladder deviation: DuckDB TRY_CAST rounds decimal strings to
 * integers, so the spec's leading TRY_CAST(raw AS BIGINT) would corrupt
 * '42.5'/'0.1' silently instead of flagging them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  applyCastPlan,
  buildCastPlan,
  describeColumns,
  scanCastFailures,
} from '../../../src/core/schema/casting';
import { openMemoryDb, seedRawTable } from './duckdb';
import type { SqlRunner } from '../../../src/core/schema/casting';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import type { JsonTypeName, StorageType } from '../../../src/core/schema/value-spec';

const JSON_TYPES: Record<StorageType, JsonTypeName> = {
  BIGINT: 'integer',
  DOUBLE: 'number',
  VARCHAR: 'string',
  BOOLEAN: 'boolean',
};

function metaStub(name: string, storageType: StorageType, mixed = false): ColumnMeta {
  return {
    name,
    required: true,
    jsonTypes: new Set<JsonTypeName>([JSON_TYPES[storageType]]),
    storageType,
    mixed,
    valueSpec: { kind: 'opaque' },
    conditionals: { asTarget: [], asCondition: [] },
    source: { fileId: 'stub.json', pointer: `/items/properties/${name}` },
  };
}

const allVarchar = (names: readonly string[]): Map<string, string> =>
  new Map(names.map((n) => [n, 'VARCHAR']));

const ordinals = (names: readonly string[]): Map<string, number> =>
  new Map(names.map((n, i) => [n, i]));

describe('buildCastPlan derivation (§C.1)', () => {
  test('VARCHAR raw: targets map to ladder / TRY_CAST / passthrough', () => {
    const meta = [
      metaStub('n', 'BIGINT'),
      metaStub('d', 'DOUBLE'),
      metaStub('b', 'BOOLEAN'),
      metaStub('p', 'VARCHAR'),
      metaStub('m', 'VARCHAR', true),
    ];
    const cols = ['n', 'd', 'b', 'p', 'm', 'extra'];
    const plan = buildCastPlan(meta, cols, allVarchar(cols));
    const byName = new Map(plan.columns.map((c) => [c.column, c]));
    expect(byName.get('n')).toMatchObject({ passthrough: false, inSchema: true });
    expect(byName.get('n')?.castExpr).toContain('CASE WHEN TRY_CAST("n" AS DOUBLE) IS NULL');
    expect(byName.get('n')?.castExpr).toContain('trunc');
    expect(byName.get('d')).toMatchObject({ castExpr: 'TRY_CAST("d" AS DOUBLE)', passthrough: false });
    expect(byName.get('b')).toMatchObject({ castExpr: 'TRY_CAST("b" AS BOOLEAN)', passthrough: false });
    expect(byName.get('p')).toMatchObject({ castExpr: '"p"', passthrough: true });
    expect(byName.get('m')).toMatchObject({ castExpr: '"m"', passthrough: true, mixed: true });
    expect(byName.get('extra')).toMatchObject({
      castExpr: '"extra"',
      passthrough: true,
      inSchema: false,
      storageType: 'VARCHAR',
    });
  });

  test('typed raw: passthrough on exact match, safe widening, ladder otherwise', () => {
    const meta = [
      metaStub('a', 'BIGINT'),
      metaStub('w', 'BIGINT'),
      metaStub('f', 'BIGINT'),
      metaStub('s', 'VARCHAR'),
      metaStub('x', 'DOUBLE'),
    ];
    const rawTypes = new Map([
      ['a', 'BIGINT'],
      ['w', 'INTEGER'],
      ['f', 'DOUBLE'],
      ['s', 'DATE'],
      ['x', 'DECIMAL'],
      ['e', 'INTEGER'],
    ]);
    const plan = buildCastPlan(meta, ['a', 'w', 'f', 's', 'x', 'e'], rawTypes);
    const byName = new Map(plan.columns.map((c) => [c.column, c]));
    expect(byName.get('a')).toMatchObject({ castExpr: '"a"', passthrough: true });
    expect(byName.get('w')).toMatchObject({ castExpr: 'CAST("w" AS BIGINT)', passthrough: true });
    expect(byName.get('f')?.castExpr).toContain('CAST("f" AS VARCHAR)');
    expect(byName.get('f')?.passthrough).toBe(false);
    expect(byName.get('s')).toMatchObject({ castExpr: 'CAST("s" AS VARCHAR)', passthrough: true });
    expect(byName.get('x')).toMatchObject({ castExpr: 'CAST("x" AS DOUBLE)', passthrough: true });
    expect(byName.get('e')).toMatchObject({ castExpr: '"e"', passthrough: true, inSchema: false });
  });

  test('CastPlan SQL snapshot', () => {
    const plan = buildCastPlan(
      [metaStub('a', 'BIGINT'), metaStub('b', 'VARCHAR')],
      ['a', 'b', 'c'],
      allVarchar(['a', 'b', 'c']),
    );
    expect(plan.sql).toBe(
      'CREATE OR REPLACE TABLE "quac_typed" AS SELECT __row__, ' +
        'CASE WHEN TRY_CAST("a" AS DOUBLE) IS NULL THEN NULL ' +
        'WHEN NOT isfinite(TRY_CAST("a" AS DOUBLE)) THEN NULL ' +
        'WHEN TRY_CAST("a" AS DOUBLE) != trunc(TRY_CAST("a" AS DOUBLE)) THEN NULL ' +
        'ELSE COALESCE(TRY_CAST("a" AS BIGINT), TRY_CAST(TRY_CAST("a" AS DOUBLE) AS BIGINT)) END AS "a", ' +
        '"b", "c" FROM "quac_raw" ORDER BY __row__',
    );
  });
});

describe('execution on DuckDB (§C.2 goldens + edge ledger 14)', () => {
  let db: Awaited<ReturnType<typeof openMemoryDb>>;
  const runner = (): SqlRunner => db.runner;

  beforeAll(async () => {
    db = await openMemoryDb();
  });
  afterAll(() => {
    db.close();
  });

  test('V19 pin: DuckDB TRY_CAST rounds decimal strings to integers', async () => {
    const [row] = await runner().query<{ a: number | null; b: number | null }>(
      "SELECT TRY_CAST('42.5' AS BIGINT) AS a, TRY_CAST('0.1' AS BIGINT) AS b",
    );
    expect(row).toEqual({ a: 43, b: 0 });
  });

  test('delimited (all-VARCHAR) goldens: values, flags, castFailures', async () => {
    const names = ['n', 'd', 'b', 'p'];
    const meta = [
      metaStub('n', 'BIGINT'),
      metaStub('d', 'DOUBLE'),
      metaStub('b', 'BOOLEAN'),
      metaStub('p', 'VARCHAR'),
    ];
    await seedRawTable(
      runner(),
      names.map((name) => ({ name, type: 'VARCHAR' })),
      [
        /* 0 */ ['42.0', '0.5', 'yes', '007'],
        /* 1 */ ['42.5', 'abc', 'maybe', null],
        /* 2 */ ['abc', '1e3', '1', 'x'],
        /* 3 */ [null, null, 'TRUE', null],
        /* 4 */ [' 42 ', '-2.5', 'false', 'y'],
        /* 5 */ ['4.2e1', '2', '0', 'z'],
        /* 6 */ ['1e5', '3.5', 'no', 'w'],
        /* 7 */ ['0.1', '4', 'true', 'v'],
        /* 8 */ ['9007199254740993', '5', 'false', 'u'],
      ],
    );
    const plan = buildCastPlan(meta, names, allVarchar(names));
    await applyCastPlan(runner(), plan);

    const typed = await runner().query<{ n: number | null; d: number | null; b: boolean | null; p: string | null }>(
      'SELECT n, d, b, p FROM quac_typed ORDER BY __row__',
    );
    expect(typed.map((r) => r.n)).toEqual([42, null, null, null, 42, 42, 100000, null, 9007199254740992]);
    expect(typed.map((r) => r.d)).toEqual([0.5, null, 1000, null, -2.5, 2, 3.5, 4, 5]);
    expect(typed.map((r) => r.b)).toEqual([true, null, true, true, false, false, false, true, false]);
    expect(typed.map((r) => r.p)).toEqual(['007', null, 'x', null, 'y', 'z', 'w', 'v', 'u']);

    // 2^53+1 survives exactly in SQL (BIGINT branch); the JS 9007199254740992
    // above is only the node adapter's bigint→Number readback rounding.
    const [exact] = await runner().query<{ ok: boolean }>(
      'SELECT (n = 9007199254740993) AS ok FROM quac_typed WHERE __row__ = 8',
    );
    expect(exact?.ok).toBe(true);

    const { flags, castFailures } = await scanCastFailures(runner(), plan, ordinals(names));
    expect(
      flags.map((f) => ({ row: f.row, column: f.column, message: f.message, value: f.value })),
    ).toEqual([
      { row: 1, column: 'n', message: '42.5 is not a whole number — this variable takes integer values.', value: '42.5' },
      { row: 1, column: 'd', message: "'abc' is not a valid number.", value: 'abc' },
      { row: 1, column: 'b', message: "'maybe' is not a valid true/false value.", value: 'maybe' },
      { row: 2, column: 'n', message: "'abc' is not a valid integer.", value: 'abc' },
      { row: 7, column: 'n', message: '0.1 is not a whole number — this variable takes integer values.', value: '0.1' },
    ]);
    for (const f of flags) {
      expect(f).toMatchObject({ source: 'schema', scope: 'cell', severity: 'error' });
      expect(f.ruleId).toBe(`schema:prop:${String(f.column)}:cast`);
      expect(f.meta).toBeUndefined();
    }
    expect([...castFailures].sort()).toEqual(['1 b', '1 d', '1 n', '2 n', '7 n']);
  });

  test("empty string casts to NULL without a flag ('' is missing, not bad)", async () => {
    const meta = [metaStub('n', 'BIGINT')];
    await seedRawTable(runner(), [{ name: 'n', type: 'VARCHAR' }], [[''], ['  '], ['7']]);
    const plan = buildCastPlan(meta, ['n'], allVarchar(['n']));
    await applyCastPlan(runner(), plan);
    const typed = await runner().query<{ n: number | null }>(
      'SELECT n FROM quac_typed ORDER BY __row__',
    );
    expect(typed.map((r) => r.n)).toEqual([null, null, 7]);
    const { flags } = await scanCastFailures(runner(), plan, ordinals(['n']));
    expect(flags).toEqual([]);
  });

  test('typed input: passthrough keeps types, DATE→VARCHAR, DOUBLE→BIGINT ladder', async () => {
    await seedRawTable(
      runner(),
      [
        { name: 'a', type: 'BIGINT' },
        { name: 'f', type: 'DOUBLE' },
        { name: 's', type: 'DATE' },
        { name: 'e', type: 'INTEGER' },
      ],
      [
        [42, 42.0, '2020-01-02', 1],
        [7, 42.5, '2021-12-31', 2],
      ],
    );
    const meta = [metaStub('a', 'BIGINT'), metaStub('f', 'BIGINT'), metaStub('s', 'VARCHAR')];
    const rawTypes = await describeColumns(runner());
    expect(rawTypes.get('s')).toBe('DATE');
    const plan = buildCastPlan(meta, ['a', 'f', 's', 'e'], rawTypes);
    await applyCastPlan(runner(), plan);

    const described = await runner().query<{ column_name: string; column_type: string }>(
      'DESCRIBE quac_typed',
    );
    const types = Object.fromEntries(described.map((r) => [r.column_name, r.column_type]));
    expect(types).toMatchObject({ a: 'BIGINT', f: 'BIGINT', s: 'VARCHAR', e: 'INTEGER' });

    const typed = await runner().query<{ a: number; f: number | null; s: string }>(
      'SELECT a, f, s FROM quac_typed ORDER BY __row__',
    );
    expect(typed).toEqual([
      { a: 42, f: 42, s: '2020-01-02' },
      { a: 7, f: null, s: '2021-12-31' },
    ]);

    // No binder error on non-VARCHAR raw (trim over CAST AS VARCHAR), and the
    // 42.5 DOUBLE cell is flagged as non-integral with its text rendering.
    const { flags } = await scanCastFailures(runner(), plan, ordinals(['a', 'f', 's', 'e']));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      row: 1,
      column: 'f',
      message: '42.5 is not a whole number — this variable takes integer values.',
    });
  });
});
