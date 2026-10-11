/**
 * Nested data end to end on native DuckDB: LIST, STRUCT, MAP and JSON columns
 * through ingest → casting → schema validation → rules → the Excel report.
 *
 * The two `*_expected_flags.json` manifests are the cross-runtime contract —
 * `tests/browser/nested.browser.test.ts` asserts the same files on
 * duckdb-wasm, so the browser and the CLI cannot read a nested value
 * differently (they did, through their row reads: epoch milliseconds for a
 * date inside a list in one, a Date object in the other).
 *
 *   (a) the upstream stress fixture — valid, so no error at all
 *   (b) QuaC's own example, schema only — one finding per planted problem
 *   (c) the example with its QC rules — corrections fix what they should,
 *       rules read nested values, the workbook holds exact JSON text
 *   (d) JSON written into a CSV cell, under an array/object schema
 *   (e) a Parquet file's NaN, DECIMAL and DATE inside lists
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { ingestDataset } from '../../../src/core/ingest/ingest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { runSchemaValidation } from '../../../src/core/schema/validation-run';
import { createNodeBridge } from '../../../src/headless/nodeBridge';
import { runQuac } from '../../../src/headless/run';
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { IngestFormat } from '../../../src/core/ingest/sniff';

const ROOT = resolve(__dirname, '..', '..', '..');
const NESTED = join(ROOT, 'tests', 'fixtures', 'nested');
const EXAMPLE = join(ROOT, 'examples', 'nested');
const SLOW = 120_000;

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-nested-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

const SCOPE_RANK: Record<QCFlag['scope'], number> = { cell: 0, row: 1, column: 2, dataset: 3 };

/** Verbatim from nodePipeline.test.ts — every tier canonicalizes identically. */
function canonicalSort(flags: readonly QCFlag[], columns: readonly string[]): QCFlag[] {
  const ordinal = (c: string | undefined): number => {
    const i = c === undefined ? -1 : columns.indexOf(c);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...flags].sort(
    (a, b) =>
      SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
      (a.row ?? -1) - (b.row ?? -1) ||
      ordinal(a.column) - ordinal(b.column) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function normalize(flag: QCFlag): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flag)) {
    if (key === 'meta' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

const toArrayBuffer = (buf: Buffer): ArrayBuffer => {
  const bytes = new ArrayBuffer(buf.byteLength);
  new Uint8Array(bytes).set(buf);
  return bytes;
};

/** Ingest + schema validation only, as the browser tier runs it. */
async function schemaFlags(
  data: { name: string; bytes: ArrayBuffer; format: IngestFormat },
  schema: { name: string; raw: string },
): Promise<{ flags: QCFlag[]; columns: string[] }> {
  const { bridge, close } = await createNodeBridge();
  try {
    const ingest = await ingestDataset(bridge, data);
    const set = await buildSchemaSet([{ relativePath: schema.name, raw: schema.raw }], {
      origin: 'upload',
    });
    const digest = columnDigest(set);
    if (digest === null) throw new Error(`${schema.name}: no column digest`);
    const flagStore = createFlagStore();
    await runSchemaValidation({
      runner: bridge,
      set,
      digest,
      datasetColumns: ingest.columns,
      flagStore,
      createWorker: createInProcessValidationWorker,
    });
    return {
      flags: canonicalSort(
        flagStore.all().map((e) => e.flag),
        ingest.columns,
      ),
      columns: ingest.columns,
    };
  } finally {
    await close();
  }
}

async function manifest(name: string): Promise<QCFlag[]> {
  const parsed = JSON.parse(await readFile(join(NESTED, name), 'utf8')) as { flags: QCFlag[] };
  return parsed.flags;
}

describe('(a) the upstream nested stress fixture is valid against its schema', () => {
  test(
    'no error — one precision warning per column past 2^53, exact digits, located',
    async () => {
      const { flags, columns } = await schemaFlags(
        {
          name: 'nested-stress-tests.json',
          bytes: toArrayBuffer(await readFile(join(NESTED, 'nested-stress-tests.json'))),
          format: 'json',
        },
        {
          name: 'nested-stress-tests.schema.json',
          raw: await readFile(join(NESTED, 'nested-stress-tests.schema.json'), 'utf8'),
        },
      );
      const want = canonicalSort(await manifest('stress_expected_flags.json'), columns);
      expect(flags.map(normalize)).toEqual(want.map(normalize));
      expect(flags.filter((f) => f.severity === 'error')).toEqual([]);
    },
    SLOW,
  );
});

describe('(b) the nested example, schema only', () => {
  test(
    'one finding per planted problem, each naming where it is',
    async () => {
      const { flags, columns } = await schemaFlags(
        {
          name: 'participants.json',
          bytes: toArrayBuffer(await readFile(join(EXAMPLE, 'participants.json'))),
          format: 'json',
        },
        {
          name: 'participants.schema.json',
          raw: await readFile(join(EXAMPLE, 'participants.schema.json'), 'utf8'),
        },
      );
      const want = canonicalSort(await manifest('participants_expected_flags.json'), columns);
      expect(flags.map(normalize)).toEqual(want.map(normalize));
      // Nothing about the records that are clean — DuckDB's NULL-filled struct
      // fields (`unit`, `pulse`, the lab names) must not read as findings.
      expect(new Set(flags.map((f) => f.row))).toEqual(
        new Set([2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 32, 33]),
      );
    },
    SLOW,
  );
});

describe('(c) the nested example with its QC rules', () => {
  test(
    'rules read nested values, corrections fix what they should, the workbook holds JSON',
    async () => {
      const result = await runQuac({
        dataset: join(EXAMPLE, 'participants.json'),
        schema: [join(EXAMPLE, 'participants.schema.json')],
        rules: [join(EXAMPLE, 'participants.quac.csv')],
        out: outDir,
      });
      const flags = result.artifacts.flagStore.all().map((e) => e.flag);
      // The totals examples/nested/README.md promises.
      const summary = result.artifacts.flagStore.summary(result.artifacts.rowsTotal);
      expect(summary.severityTotals).toEqual({ error: 25, warning: 5, info: 5 });
      expect(summary.rowsAffected).toBe(31);
      const perRule = result.artifacts.rules?.perRule ?? [];
      expect(perRule.filter((r) => r.status !== 'ok')).toEqual([]);
      const violations = Object.fromEntries(perRule.map((r) => [r.ruleId, r.violationCount]));
      expect(violations).toEqual({
        R01: 2,
        R02: 1,
        R03: 1,
        R04: 2,
        R05: 1,
        R06: 1,
        R07: 1,
        R08: 1,
        R09: 1,
        R10: 1,
      });

      const corrections = flags
        .filter((f) => f.correction !== undefined)
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
      expect(
        corrections.map((f) => ({ ruleId: f.ruleId, row: f.row, ...f.correction })),
      ).toEqual([
        {
          ruleId: 'R08',
          row: 3,
          before: { street: '611 Pine Ct', city: 'Lakeside', postcode: '16664', country: 'us', unit: null },
          after: { street: '611 Pine Ct', city: 'Lakeside', postcode: '16664', country: 'US', unit: null },
        },
        { ruleId: 'R07', row: 8, before: ['+1 555-010-2030'], after: ['+15550102030'] },
        { ruleId: 'R06', row: 20, before: ['e11.9', 'I10'], after: ['E11.9', 'I10'] },
      ]);

      // Corrected before validation: the three corrected cells pass the schema.
      const schemaRows = new Set(
        flags.filter((f) => f.source === 'schema' && f.scope === 'cell').map((f) => `${String(f.row)} ${String(f.column)}`),
      );
      for (const fixed of ['3 address', '8 phones', '20 diagnoses']) {
        expect(schemaRows.has(fixed), fixed).toBe(false);
      }

      // A dataset rule's nested arithmetic arrives as plain values.
      const r09 = flags.find((f) => f.ruleId === 'R09');
      expect(r09?.message).toContain("participant_id='P0035'; weight_change_kg=18");

      // The Data sheet: nested cells are their exact JSON text — dates as
      // dates, the corrected values already in.
      const ExcelJS = (await import('exceljs')).default;
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.outPath);
      const sheet = workbook.getWorksheet('Data');
      if (sheet === undefined) throw new Error('no Data sheet');
      const header = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
      const cell = (row: number, column: string): unknown =>
        sheet.getRow(row + 2).getCell(header.indexOf(column) + 1).value;
      const source = JSON.parse(await readFile(join(EXAMPLE, 'participants.json'), 'utf8')) as {
        visits: Record<string, unknown>[];
        consent: Record<string, unknown>;
      }[];
      const first = source[0];
      if (first === undefined) throw new Error('empty example');
      // DuckDB's struct holds every key any record has: `pulse`, NULL here.
      expect(cell(0, 'visits')).toBe(JSON.stringify(first.visits.map((v) => ({ ...v, pulse: null }))));
      expect(cell(0, 'visits')).toMatch(/^\[\{"date":"\d{4}-\d{2}-\d{2}"/);
      expect(cell(0, 'consent')).toBe(JSON.stringify(first.consent));
      expect(cell(8, 'phones')).toBe('["+15550102030"]');
    },
    SLOW,
  );
});

describe('(d) JSON text in a CSV cell, under an array or object schema', () => {
  test(
    'parses into DuckDB JSON and validates; text that does not parse is a cast finding',
    async () => {
      const csv = [
        'id,tags,point',
        '1,"[""a"",""b""]","{""x"": 1, ""y"": 2}"',
        '2,"[""a"", 7]","{""x"": 1}"',
        '3,not json,"{""x"": ""far""}"',
        '4,,',
      ].join('\n');
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
            point: {
              type: 'object',
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y'],
            },
          },
        },
      };
      const { flags } = await schemaFlags(
        { name: 'cells.csv', bytes: toArrayBuffer(Buffer.from(csv)), format: 'csv' },
        { name: 'cells.schema.json', raw: JSON.stringify(schema) },
      );
      expect(flags.map((f) => ({ row: f.row, column: f.column, ruleId: f.ruleId, message: f.message }))).toEqual([
        {
          row: 1,
          column: 'tags',
          ruleId: 'schema:prop:tags:value',
          message: 'must be a string, got number (at tags[1]).',
        },
        {
          row: 1,
          column: 'point',
          ruleId: 'schema:prop:point:value',
          message: "required field 'y' is missing.",
        },
        {
          row: 2,
          column: 'tags',
          ruleId: 'schema:prop:tags:cast',
          message: "'not json' is not valid JSON — this variable takes an array, written as JSON text.",
        },
        {
          row: 2,
          column: 'point',
          ruleId: 'schema:prop:point:value',
          message: "must be a number, got string (at point.x).",
        },
        {
          row: 2,
          column: 'point',
          ruleId: 'schema:prop:point:value',
          message: "required field 'y' is missing.",
        },
      ]);
    },
    SLOW,
  );
});

describe('(e) Parquet: NaN, DECIMAL and DATE inside lists, a MAP', () => {
  test(
    'non-finite numbers are cast findings at their path; decimals and dates arrive intact',
    async () => {
      const path = join(outDir, 'nested.parquet');
      const { bridge, close } = await createNodeBridge();
      try {
        await bridge.query(
          `COPY (SELECT * FROM (VALUES
             (0, [1.5, 'nan'::DOUBLE, 'inf'::DOUBLE], [1.25, 2.50]::DECIMAL(10,2)[], ['2020-01-31'::DATE], MAP {'a': 1, 'b': -2}),
             (1, [0.5], [3.75]::DECIMAL(10,2)[], ['1969-07-20'::DATE], MAP {'a': 3})
           ) t(id, readings, prices, days, counts)) TO '${path}' (FORMAT parquet)`,
        );
      } finally {
        await close();
      }
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            readings: { type: 'array', items: { type: 'number', maximum: 1 } },
            prices: { type: 'array', items: { type: 'number', multipleOf: 0.25, maximum: 3 } },
            days: { type: 'array', items: { type: 'string', format: 'date' } },
            counts: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
          },
        },
      };
      const { flags } = await schemaFlags(
        { name: 'nested.parquet', bytes: toArrayBuffer(await readFile(path)), format: 'parquet' },
        { name: 'nested.schema.json', raw: JSON.stringify(schema) },
      );
      expect(flags.map((f) => ({ row: f.row, column: f.column, ruleId: f.ruleId, message: f.message }))).toEqual([
        {
          row: 0,
          column: 'readings',
          ruleId: 'schema:prop:readings:cast',
          message: 'NaN and Infinity are not finite numbers (at readings[2], readings[3]).',
        },
        {
          row: 0,
          column: 'readings',
          ruleId: 'schema:prop:readings:value',
          message: '1.5 exceeds the maximum 1 (at readings[1]).',
        },
        {
          row: 0,
          column: 'counts',
          ruleId: 'schema:prop:counts:value',
          message: '-2 is below the minimum 0 (at counts["b"]).',
        },
        {
          row: 1,
          column: 'prices',
          ruleId: 'schema:prop:prices:value',
          message: '3.75 exceeds the maximum 3 (at prices[1]).',
        },
      ]);
    },
    SLOW,
  );
});
