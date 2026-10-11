/**
 * Nested data end to end on native DuckDB: LIST, STRUCT, MAP and JSON columns
 * through ingest → casting → schema validation → rules → the Excel report.
 *
 * The `*_expected_flags.json` manifests are the cross-runtime contract —
 * `tests/browser/nested.browser.test.ts` asserts the same files on
 * duckdb-wasm, so the browser and the CLI cannot read a nested value
 * differently (they did, through their row reads: epoch milliseconds for a
 * date inside a list in one, a Date object in the other).
 *
 *   (a) the upstream stress fixture — valid, so no error at all
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
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { IngestFormat } from '../../../src/core/ingest/sniff';

const ROOT = resolve(__dirname, '..', '..', '..');
const NESTED = join(ROOT, 'tests', 'fixtures', 'nested');
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
