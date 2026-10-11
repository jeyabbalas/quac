/**
 * Nested data on duckdb-wasm, through data-table's bridge and the real
 * validation Web Worker — the browser half of the cross-runtime contract
 * `tests/unit/headless/nestedParity.test.ts` asserts on native DuckDB: both
 * deep-equal the same `tests/fixtures/nested/*_expected_flags.json`.
 *
 * This is the tier where Arrow's row read would have lied: data-table's
 * `bridge.query` hands a DATE inside a list over as epoch milliseconds and a
 * HUGEINT inside one as a meaningless number. The validator reads nested
 * columns as `to_json` text instead, so both runtimes see what the file held.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { hardenBridge } from '../../src/core/bridge/harden';
import { DATA_VIEW, previewSQL } from '../../src/core/bridge/tables';
import { createFlagStore } from '../../src/core/flags/flagStore';
import { ingestDataset } from '../../src/core/ingest/ingest';
import { nestedColumnsOf } from '../../src/core/nested-json';
import { describeColumns } from '../../src/core/schema/casting';
import { columnDigest } from '../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../src/core/schema/schema-set';
import { rowSourceFor } from '../../src/core/schema/row-source';
import { runSchemaValidation } from '../../src/core/schema/validation-run';
import stressDataUrl from '../fixtures/nested/nested-stress-tests.json?url';
import stressSchemaUrl from '../fixtures/nested/nested-stress-tests.schema.json?url';
import stressExpectedUrl from '../fixtures/nested/stress_expected_flags.json?url';
import participantsExpectedUrl from '../fixtures/nested/participants_expected_flags.json?url';
import participantsUrl from '../../examples/nested/participants.json?url';
import participantsSchemaUrl from '../../examples/nested/participants.schema.json?url';
import { fetchFixtureBytes } from './fixtures';
import type { QCFlag } from '../../src/core/flags/flag';

let bridge: WorkerBridge | undefined;

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

beforeAll(async () => {
  bridge = await createBridge();
  // As every run does: loads the vendored json extension, which `to_json` needs.
  await hardenBridge(bridge);
}, 120_000);

afterAll(() => {
  bridge?.terminate();
});

const SCOPE_RANK: Record<QCFlag['scope'], number> = { cell: 0, row: 1, column: 2, dataset: 3 };

/** Verbatim from validation-worker.browser.test.ts — the tiers canonicalize identically. */
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

async function text(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${String(res.status)} ${url}`);
  return res.text();
}

/** Ingest + schema validation in the real worker; flags canonically sorted. */
async function validate(
  data: { name: string; url: string },
  schema: { name: string; url: string },
): Promise<{ flags: QCFlag[]; columns: string[] }> {
  const bytes = await fetchFixtureBytes(data.url);
  const ingest = await ingestDataset(b(), { name: data.name, bytes, format: 'json' });
  const set = await buildSchemaSet([{ relativePath: schema.name, raw: await text(schema.url) }], {
    origin: 'upload',
  });
  const digest = columnDigest(set);
  if (digest === null) throw new Error(`${schema.name}: no column digest`);
  const flagStore = createFlagStore();
  await runSchemaValidation({
    runner: b(),
    set,
    digest,
    datasetColumns: ingest.columns,
    flagStore,
    // As the pipeline runs it: a JSON file's own records.
    source: rowSourceFor('json', ingest.renames, () => Promise.resolve(bytes)),
  });
  return {
    flags: canonicalSort(
      flagStore.all().map((e) => e.flag),
      ingest.columns,
    ),
    columns: ingest.columns,
  };
}

async function expected(url: string, columns: readonly string[]): Promise<Record<string, unknown>[]> {
  const parsed = JSON.parse(await text(url)) as { flags: QCFlag[] };
  return canonicalSort(parsed.flags, columns).map(normalize);
}

test('the upstream nested stress fixture: the browser reports exactly what Node does', async () => {
  const { flags, columns } = await validate(
    { name: 'nested-stress-tests.json', url: stressDataUrl },
    { name: 'nested-stress-tests.schema.json', url: stressSchemaUrl },
  );
  expect(flags.map(normalize)).toEqual(await expected(stressExpectedUrl, columns));
  expect(flags.filter((f) => f.severity === 'error')).toEqual([]);

  // Nested columns kept their DuckDB types through the schema's cast plan —
  // the grids and the rules see lists and structs, not their text.
  const types = await describeColumns(b(), DATA_VIEW);
  expect(types.get('people')).toBe('STRUCT("name" VARCHAR, age BIGINT, langs VARCHAR[])[]');
  expect(types.get('days')).toBe('DATE[]');
  expect(types.get('shifty')).toBe('JSON');
}, 120_000);

test('the preview reads a nested value as its exact JSON text — dates and 64-bit integers intact', async () => {
  const types = await describeColumns(b(), DATA_VIEW);
  const rows = await b().query(previewSQL(nestedColumnsOf(types)));
  expect(rows[3]?.signed).toBe('[-9223372036854775808,-1,0,9223372036854775807]');
  expect(rows[2]?.days).toBe('["2020-01-01",null]');
  expect(rows[2]?.people).toBe(
    '[null,{"name":null,"age":null,"langs":null},{"name":"Ada","age":36,"langs":["en",null]}]',
  );
}, 60_000);

test('the nested example: one finding per planted problem, as on Node', async () => {
  const { flags, columns } = await validate(
    { name: 'participants.json', url: participantsUrl },
    { name: 'participants.schema.json', url: participantsSchemaUrl },
  );
  expect(flags.map(normalize)).toEqual(await expected(participantsExpectedUrl, columns));
}, 120_000);
