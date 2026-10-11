/**
 * §C.3 row shaping (src/core/schema/row-shaping.ts): one dataset row → the
 * JSON record the validator judges, in each of the three modes — a text
 * cell read as the value it spells, a typed value as JSON writes it, a JSON
 * record exactly as written — plus the findings shaping itself makes (cast,
 * precision) and corrected cells.
 */
import { describe, expect, test } from 'vitest';
import { createRowShaper } from '../../../src/core/schema/row-shaping';
import type { NestedPlan } from '../../../src/core/schema/nested-values';
import type { JsonTypeName } from '../../../src/core/schema/value-spec';
import type { CellTransport, PresentedColumn } from '../../../src/core/schema/worker-protocol';

const column = (
  name: string,
  jsonTypes: JsonTypeName[],
  transport: CellTransport,
  over: Partial<PresentedColumn> = {},
): PresentedColumn => ({
  column: name,
  key: name,
  jsonTypes,
  nullAllowed: jsonTypes.includes('null'),
  transport,
  ...over,
});

const TEXT: CellTransport = { kind: 'text' };
const NATIVE: CellTransport = { kind: 'native' };
const json = (plan: NestedPlan, wideIntegers = false): CellTransport => ({ kind: 'json', plan, wideIntegers });

describe('text mode — a cell is the JSON value it spells, where the schema allows that type', () => {
  test('numbers in JSON grammar, true/false in any case, JSON text, strings kept as written', () => {
    const shaper = createRowShaper(
      [
        column('n', ['number'], TEXT),
        column('i', ['integer'], TEXT),
        column('b', ['boolean'], TEXT),
        column('s', ['string'], TEXT),
        column('a', ['array'], TEXT),
      ],
      'text',
    );
    const { obj, flags } = shaper.shapeRow({ values: [' -1.5e2 ', '7', 'TRUE', ' 42 ', '[1, "x"]'] }, 0);
    expect(obj).toEqual({ n: -150, i: 7, b: true, s: ' 42 ', a: [1, 'x'] });
    expect(flags).toEqual([]);
  });

  test('a multi-type column reads 42 as a number and 0042 as text', () => {
    const shaper = createRowShaper([column('code', ['integer', 'string'], TEXT)], 'text');
    expect(shaper.shapeRow({ values: ['42'] }, 0).obj).toEqual({ code: 42 });
    expect(shaper.shapeRow({ values: ['0042'] }, 1).obj).toEqual({ code: '0042' });
    expect(shaper.shapeRow({ values: ['4.5'] }, 2).obj).toEqual({ code: '4.5' });
  });

  test('the boolean-or-sentinel pattern: true/false as booleans, -99 as a number', () => {
    const shaper = createRowShaper([column('smoker', ['boolean', 'integer'], TEXT)], 'text');
    expect(shaper.shapeRow({ values: ['false'] }, 0).obj).toEqual({ smoker: false });
    expect(shaper.shapeRow({ values: ['-99'] }, 1).obj).toEqual({ smoker: -99 });
  });

  test('text no allowed type spells → a cast finding, the cell left out, Ajv covered', () => {
    const shaper = createRowShaper(
      [
        column('i', ['integer'], TEXT),
        column('n', ['number', 'null'], TEXT),
        column('b', ['boolean'], TEXT),
        column('o', ['object'], TEXT),
        column('w', ['integer'], TEXT),
      ],
      'text',
    );
    const { obj, flags, castKeys } = shaper.shapeRow({ values: ['1.5', '1_000', 'yes', '{bad', '   '] }, 4);
    expect(obj).toEqual({});
    expect(flags.map((f) => [f.ruleId, f.message, f.value])).toEqual([
      ['schema:prop:i:cast', '1.5 is not a whole number — this variable takes integer values.', '1.5'],
      ['schema:prop:n:cast', "'1_000' is not a valid number.", '1_000'],
      ['schema:prop:b:cast', "'yes' is not a valid true/false value.", 'yes'],
      ['schema:prop:o:cast', "'{bad' is not valid JSON — this variable takes an object, written as JSON text.", '{bad'],
      ['schema:prop:w:cast', "'   ' is not a valid integer.", '   '],
    ]);
    for (const f of flags) expect(f).toMatchObject({ severity: 'error', scope: 'cell', row: 4 });
    expect(castKeys).toEqual(['4 i', '4 n', '4 b', '4 o', '4 w']);
  });

  test('DuckDB-lenient spellings are text: +5, .5, 5., 007, NaN, Infinity', () => {
    const shaper = createRowShaper([column('x', ['number', 'string'], TEXT)], 'text');
    for (const raw of ['+5', '.5', '5.', '007', 'NaN', 'Infinity', '1,000']) {
      expect(shaper.shapeRow({ values: [raw] }, 0).obj).toEqual({ x: raw });
    }
  });

  test('an integer past 2^53 is read, rounded, with one precision warning per column', () => {
    const shaper = createRowShaper([column('id', ['integer'], TEXT)], 'text');
    const first = shaper.shapeRow({ values: ['9007199254740993'] }, 0);
    expect(first.obj).toEqual({ id: 9007199254740992 });
    expect(first.flags).toEqual([
      expect.objectContaining({
        ruleId: 'schema:prop:id:precision',
        severity: 'warning',
        value: '9007199254740993',
        message:
          'value exceeds the exactly-representable integer range (±(2^53−1)) — schema checks used the nearest representable number.',
      }),
    ]);
    expect(shaper.shapeRow({ values: ['18446744073709551616'] }, 1).flags).toEqual([]);
  });

  test('an empty cell is absent, or null where the schema allows null', () => {
    const shaper = createRowShaper([column('a', ['integer'], TEXT), column('b', ['integer', 'null'], TEXT)], 'text');
    const { obj } = shaper.shapeRow({ values: [null, null] }, 0);
    expect(obj).toEqual({ b: null });
  });
});

describe('typed mode — a value as JSON writes it', () => {
  test('native values pass through; NaN and ±Infinity are cast findings', () => {
    const shaper = createRowShaper([column('x', ['number'], NATIVE), column('y', ['number'], NATIVE)], 'typed');
    const { obj, flags, castKeys } = shaper.shapeRow({ values: [Number.NaN, Number.POSITIVE_INFINITY] }, 3);
    expect(obj).toEqual({});
    expect(flags.map((f) => [f.ruleId, f.message, f.value])).toEqual([
      ['schema:prop:x:cast', 'NaN is not a finite number.', 'NaN'],
      ['schema:prop:y:cast', 'Infinity is not a finite number.', 'Infinity'],
    ]);
    expect(castKeys).toEqual(['3 x', '3 y']);
  });

  test('a number type crosses as its digits: exact types earn the precision warning, FLOAT does not', () => {
    const shaper = createRowShaper(
      [column('big', ['integer'], { kind: 'number', exact: true }), column('f', ['number'], { kind: 'number', exact: false })],
      'typed',
    );
    const { obj, flags } = shaper.shapeRow({ values: ['9223372036854775807', '1e+20'] }, 0);
    expect(obj).toEqual({ big: 2 ** 63, f: 1e20 });
    expect(flags.map((f) => f.ruleId)).toEqual(['schema:prop:big:precision']);
    expect(shaper.shapeRow({ values: ['1', 'nan'] }, 1).flags.map((f) => f.message)).toEqual([
      'nan is not a finite number.',
    ]);
  });

  test('a JSON-transported value is decoded with its plan: standard text for timestamps', () => {
    const shaper = createRowShaper(
      [
        column('ts', ['string'], json({ kind: 'leaf', canonical: 'timestamp' })),
        column('tz', ['string'], json({ kind: 'leaf', canonical: 'timestamptz' })),
        column('days', ['array'], json({ kind: 'list', element: { kind: 'leaf' } })),
      ],
      'typed',
    );
    const { obj } = shaper.shapeRow(
      { values: ['"2024-01-15 08:30:00.5"', '"2024-01-15 03:00:00+00"', '["2024-01-15",null]'] },
      0,
    );
    expect(obj).toEqual({ ts: '2024-01-15T08:30:00.5', tz: '2024-01-15T03:00:00Z', days: ['2024-01-15', null] });
  });

  test("a JSON column's literal null is null only where the schema allows it", () => {
    const shaper = createRowShaper(
      [column('a', ['object'], json({ kind: 'json' })), column('b', ['object', 'null'], json({ kind: 'json' }))],
      'typed',
    );
    expect(shaper.shapeRow({ values: ['null', 'null'] }, 0).obj).toEqual({ b: null });
  });

  test('text a lenient cast accepted but JSON cannot read is a cast finding, not a crash', () => {
    const shaper = createRowShaper([column('a', ['array'], json({ kind: 'json' }))], 'typed');
    const { obj, flags } = shaper.shapeRow({ values: ['[1,'] }, 0);
    expect(obj).toEqual({});
    expect(flags[0]).toMatchObject({ ruleId: 'schema:prop:a:cast', message: "'[1,' could not be read as a JSON value." });
  });

  test('NaN inside a value: read as null, reported by path, its path suppressed', () => {
    const shaper = createRowShaper([column('r', ['array'], json({ kind: 'list', element: { kind: 'leaf' } }))], 'typed');
    const { obj, flags, suppressPaths } = shaper.shapeRow({ values: ['[1.5,NaN,inf]'] }, 0);
    expect(obj).toEqual({ r: [1.5, null, null] });
    expect(flags[0]?.message).toBe('NaN and inf are not finite numbers (at r[2], r[3]).');
    expect(suppressPaths).toEqual(['/r/1', '/r/2']);
  });

  test('a record is keyed by the source name; flags and cast keys say which', () => {
    const shaper = createRowShaper([column('padded', ['integer'], NATIVE, { key: ' padded ' })], 'typed');
    expect(shaper.shapeRow({ values: [5] }, 0).obj).toEqual({ ' padded ': 5 });
  });
});

describe('records mode — a JSON record exactly as written', () => {
  const cols = [
    column('id', ['integer'], NATIVE),
    column('note', ['string'], NATIVE),
    column('ids', ['array'], NATIVE, { numbering: { kind: 'list', element: { kind: 'leaf' } } }),
  ];

  test('explicit null stays null and a missing key stays missing', () => {
    const shaper = createRowShaper(cols, 'records');
    expect(shaper.shapeRow({ record: '{"id":1,"note":null}' }, 0).obj).toEqual({ id: 1, note: null });
    expect(shaper.shapeRow({ record: '{"id":2}' }, 1).obj).toEqual({ id: 2 });
  });

  test('ISO text and keys DuckDB would rename reach the validator untouched', () => {
    const shaper = createRowShaper(cols, 'records');
    const record = '{"id":1,"ts":"2024-01-15T08:30:00+05:30","__proto__":"x"," padded ":1}';
    const { obj } = shaper.shapeRow({ record }, 0);
    expect((obj as Record<string, unknown>).ts).toBe('2024-01-15T08:30:00+05:30');
    expect(Object.keys(obj as object)).toEqual(['id', 'ts', '__proto__', ' padded ']);
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  test('integers past 2^53: one warning per column, located with the grid numbering', () => {
    const shaper = createRowShaper(cols, 'records');
    const { flags } = shaper.shapeRow({ record: '{"id":9007199254740993,"ids":[1,9007199254740995]}' }, 0);
    expect(flags.map((f) => [f.column, f.message.slice(0, 22), f.value])).toEqual([
      ['id', 'value exceeds the exac', '9007199254740993'],
      ['ids', 'value at ids[2] exceed', '9007199254740995'],
    ]);
  });

  test('a record that is not an object is handed over as it is', () => {
    const shaper = createRowShaper(cols, 'records');
    expect(shaper.shapeRow({ record: '5' }, 0).obj).toBe(5);
  });
});

describe('corrected cells — read from the corrected data', () => {
  test("'' is a NULL; JSON text is the corrected value, decoded with the corrected column's plan", () => {
    const fix = { plan: { kind: 'leaf' } as NestedPlan, wideIntegers: false };
    const shaper = createRowShaper(
      [
        column('a', ['integer'], TEXT, { fix }),
        column('b', ['integer', 'null'], TEXT, { fix }),
        column('c', ['string'], TEXT, { fix }),
      ],
      'text',
    );
    const { obj, flags } = shaper.shapeRow({ values: ['x', 'y', 'kept'], fixes: ['5', '', null] }, 0);
    expect(obj).toEqual({ a: 5, b: null, c: 'kept' });
    expect(flags).toEqual([]);
  });

  test('a correction overrides a JSON record’s value', () => {
    const fix = { plan: { kind: 'leaf' } as NestedPlan, wideIntegers: false };
    const shaper = createRowShaper([column('id', ['integer'], NATIVE, { fix }), column('n', ['string'], NATIVE, { fix })], 'records');
    const { obj } = shaper.shapeRow({ record: '{"id":"7","n":"x"}', fixes: ['7', ''] }, 0);
    expect(obj).toEqual({ id: 7 });
  });
});
