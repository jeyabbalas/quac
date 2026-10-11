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
  JSON: 'array',
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

  test('delimited (all-VARCHAR) goldens: the typed values the rules see', async () => {
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

    // The cast is for the rules; validation reads the raw text itself
    // (text-cells.ts, row-shaping.test.ts), so a lenient cast never decides
    // what a cell holds: 'yes', '1' and ' 42 ' above are typed for the rules
    // only.
  });

  test("empty and blank strings cast to NULL for the rules", async () => {
    const meta = [metaStub('n', 'BIGINT')];
    await seedRawTable(runner(), [{ name: 'n', type: 'VARCHAR' }], [[''], ['  '], ['7']]);
    const plan = buildCastPlan(meta, ['n'], allVarchar(['n']));
    await applyCastPlan(runner(), plan);
    const typed = await runner().query<{ n: number | null }>(
      'SELECT n FROM quac_typed ORDER BY __row__',
    );
    expect(typed.map((r) => r.n)).toEqual([null, null, 7]);
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

  });
});

describe('nested and JSON columns (§C.1, nested data)', () => {
  test('a nested or JSON raw column keeps its type whatever the schema says', () => {
    const meta = [
      metaStub('list_as_int', 'BIGINT'),
      metaStub('struct_as_text', 'VARCHAR'),
      metaStub('list_mixed', 'VARCHAR', true),
      metaStub('struct_as_json', 'JSON'),
      metaStub('doc', 'DOUBLE'),
    ];
    const rawTypes = new Map([
      ['list_as_int', 'BIGINT[]'],
      ['struct_as_text', 'STRUCT(x DOUBLE, tier VARCHAR)'],
      ['list_mixed', 'STRUCT("name" VARCHAR, age BIGINT)[]'],
      ['struct_as_json', 'MAP(VARCHAR, BIGINT)'],
      ['doc', 'JSON'],
    ]);
    const plan = buildCastPlan(meta, [...rawTypes.keys()], rawTypes);
    for (const c of plan.columns) {
      expect(c, c.column).toMatchObject({ castExpr: `"${c.column}"`, passthrough: true });
    }
  });

  test('a list OF decimals is a list, not a DECIMAL to widen', () => {
    const plan = buildCastPlan([metaStub('prices', 'DOUBLE')], ['prices'], new Map([['prices', 'DECIMAL(10,2)[]']]));
    expect(plan.columns[0]).toMatchObject({ castExpr: '"prices"', passthrough: true });
  });

  test('text under an array/object schema parses into JSON; other scalars keep their type', () => {
    const meta = [metaStub('tags', 'JSON'), metaStub('n', 'JSON')];
    const plan = buildCastPlan(meta, ['tags', 'n'], new Map([['tags', 'VARCHAR'], ['n', 'BIGINT']]));
    const byName = new Map(plan.columns.map((c) => [c.column, c]));
    expect(byName.get('tags')).toMatchObject({
      castExpr: 'TRY_CAST("tags" AS JSON)',
      passthrough: false,
      jsonShape: 'an array',
    });
    expect(byName.get('n')).toMatchObject({ castExpr: '"n"', passthrough: true });
  });

  describe('on DuckDB', () => {
    let db: Awaited<ReturnType<typeof openMemoryDb>>;
    beforeAll(async () => {
      db = await openMemoryDb();
    });
    afterAll(() => {
      db.close();
    });

    test('JSON text parses into DuckDB JSON for the rules; text that does not is NULL there', async () => {
      await seedRawTable(db.runner, [{ name: 'tags', type: 'VARCHAR' }], [['["a", "b"]'], ['[1, 2'], ['42'], [null]]);
      const meta: ColumnMeta = {
        ...metaStub('tags', 'JSON'),
        jsonTypes: new Set<JsonTypeName>(['array', 'object']),
      };
      const plan = buildCastPlan([meta], ['tags'], allVarchar(['tags']));
      await applyCastPlan(db.runner, plan);
      const typed = await db.runner.query<{ t: string; v: string | null }>(
        'SELECT typeof(tags) AS t, CAST(tags AS VARCHAR) AS v FROM quac_typed ORDER BY __row__',
      );
      expect(typed.map((r) => r.v)).toEqual(['["a", "b"]', null, '42', null]);
      expect(typed[0]?.t).toBe('JSON');
    });
  });
});

describe('columns no property declares (patternProperties / additionalProperties)', () => {
  test('take the target of the schema that covers them; the rest pass through', () => {
    const plan = buildCastPlan([metaStub('id', 'BIGINT')], ['id', 'x_score', 'notes'], allVarchar(['id', 'x_score', 'notes']), (name) =>
      name.startsWith('x_') ? metaStub(name, 'DOUBLE') : null,
    );
    const byName = new Map(plan.columns.map((c) => [c.column, c]));
    expect(byName.get('x_score')).toMatchObject({ storageType: 'DOUBLE', inSchema: true, passthrough: false });
    expect(byName.get('notes')).toMatchObject({ storageType: 'VARCHAR', inSchema: false, passthrough: true });
  });
});
