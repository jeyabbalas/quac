/**
 * Validation worker end-to-end (phase-09 verification): the synthetic/mini
 * fixture through the real pipeline — ingest → casting → QC worker → dataset
 * checks — must reproduce tests/fixtures/synthetic/mini/mini_expected_flags.json
 * EXACTLY (the fixture is immutable; P08 unit tests pin it verbatim). Plus:
 * progress monotonicity, mid-run abort, cap truncation with exact counts, a
 * 100k-row generated smoke (elapsed ms recorded for the progress log), and
 * the V19 TRY_CAST-rounding pin on duckdb-wasm.
 *
 * Comparison normalization: the fixture carries no `meta` and omits absent
 * optional fields, so both sides are compared as {source, ruleId, scope,
 * row?, column?, severity, message, value?} projections in canonical order
 * (cell by row→column-ordinal→ruleId, then column scope, then dataset).
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { createFlagStore } from '../../src/core/flags/flagStore';
import { ingestDataset } from '../../src/core/ingest/ingest';
import { columnDigest } from '../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../src/core/schema/schema-set';
import { runSchemaValidation } from '../../src/core/schema/validation-run';
import miniSchemaUrl from '../fixtures/synthetic/mini/mini.schema.json?url';
import miniInvalidUrl from '../fixtures/synthetic/mini/mini_invalid.csv?url';
import miniExpectedUrl from '../fixtures/synthetic/mini/mini_expected_flags.json?url';
import hespDirtyCsvUrl from '../fixtures/hesp/data/hesp_dirty_100.csv?url';
import seededViolationsUrl from '../fixtures/hesp/data/seeded-violations.json?url';
import type { QCFlag } from '../../src/core/flags/flag';
import type { FlagStore } from '../../src/core/flags/flagStore';
import type { ColumnDigest } from '../../src/core/schema/column-meta';
import type { SchemaSet } from '../../src/core/schema/types';
import type {
  ValidationProgress,
  ValidationSummary,
} from '../../src/core/schema/worker-protocol';

/** The 14 HESP schema files, served by Vite (manifest.json included — intake ignores it). */
const hespSchemaUrls = import.meta.glob<string>('../fixtures/hesp/json_schema/**/*.json', {
  query: '?url',
  import: 'default',
  eager: true,
});

let bridge: WorkerBridge | undefined;
let set: SchemaSet | undefined;
let digest: ColumnDigest | undefined;
let datasetColumns: string[] = [];

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture fetch failed: ${String(res.status)} ${url}`);
  return res.text();
}

async function ingestMiniInvalid(): Promise<void> {
  const res = await fetch(miniInvalidUrl);
  const bytes = await res.arrayBuffer();
  const result = await ingestDataset(b(), { name: 'mini_invalid.csv', bytes, format: 'csv' });
  datasetColumns = result.columns;
}

interface RunOptions {
  batchRows?: number;
  flagCap?: number;
  onProgress?: (p: ValidationProgress) => void;
  signal?: AbortSignal;
  flagStore?: FlagStore;
  datasetColumns?: string[];
}

async function run(opts: RunOptions = {}): Promise<{
  summary: ValidationSummary;
  flags: QCFlag[];
}> {
  if (!set || !digest) throw new Error('schema not loaded');
  const flagStore = opts.flagStore ?? createFlagStore();
  const summary = await runSchemaValidation({
    runner: b(),
    set,
    digest,
    datasetColumns: opts.datasetColumns ?? datasetColumns,
    flagStore,
    onProgress: opts.onProgress,
    signal: opts.signal,
    config: { batchRows: opts.batchRows, flagCap: opts.flagCap },
  });
  return { summary, flags: flagStore.all().map((e) => e.flag) };
}

const SCOPE_RANK: Record<QCFlag['scope'], number> = { cell: 0, row: 1, column: 2, dataset: 3 };

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

beforeAll(async () => {
  bridge = await createBridge();
  const schemaRaw = await fetchText(miniSchemaUrl);
  set = await buildSchemaSet([{ relativePath: 'mini.schema.json', raw: schemaRaw }], {
    origin: 'upload',
  });
  const d = columnDigest(set);
  if (!d) throw new Error('mini digest unavailable');
  digest = d;
  await ingestMiniInvalid();
}, 120_000);

afterAll(() => {
  bridge?.terminate();
});

test('V19 pin (wasm): DuckDB TRY_CAST rounds decimal strings to integers', async () => {
  const [row] = await b().query<{ a: number | bigint | null; b: number | bigint | null }>(
    "SELECT TRY_CAST('42.5' AS BIGINT) AS a, TRY_CAST('0.1' AS BIGINT) AS b",
  );
  expect(Number(row?.a)).toBe(43);
  expect(Number(row?.b)).toBe(0);
});

test('mini end-to-end: flags deep-equal mini_expected_flags.json', async () => {
  const expected = JSON.parse(await fetchText(miniExpectedUrl)) as { flags: QCFlag[] };
  const { summary, flags } = await run();

  const got = canonicalSort(flags, datasetColumns).map(normalize);
  const want = canonicalSort(expected.flags, datasetColumns).map(normalize);
  expect(got).toEqual(want);
  expect(got).toHaveLength(9);

  expect(summary.rowsTotal).toBe(10);
  expect(summary.aborted).toBe(false);
  expect(summary.flagsTruncated).toBe(false);
  // Worker-side share of the 9: 6 translator flags (the cast, column, and
  // dataset flags are main-thread SQL findings).
  expect(summary.flagsEmitted).toBe(6);
  expect(summary.rowsWithErrors).toBe(6);
});

test('progress events: phase order and monotone rowsDone', async () => {
  const events: ValidationProgress[] = [];
  await run({ batchRows: 3, onProgress: (p) => events.push(p) });

  const phases = events.map((e) => e.phase);
  for (const phase of ['casting', 'compiling', 'validating', 'aggregating'] as const) {
    expect(phases).toContain(phase);
  }
  const order = { casting: 0, compiling: 1, validating: 2, aggregating: 3 };
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1];
    const cur = events[i];
    if (!prev || !cur) continue;
    expect(order[cur.phase]).toBeGreaterThanOrEqual(order[prev.phase]);
    expect(cur.rowsDone).toBeGreaterThanOrEqual(prev.rowsDone);
  }
  const last = events.at(-1);
  expect(last?.phase).toBe('aggregating');
  expect(last?.rowsTotal).toBe(10);
});

test('abort mid-run returns a partial summary and keeps partial flags', async () => {
  const controller = new AbortController();
  const store = createFlagStore();
  // Deterministic trigger: the first worker batch (rows 0–1) lands the row-1
  // id flag; FlagStore notifies synchronously inside flagStore.add, before
  // the run loop's between-batch signal check.
  const unsubscribe = store.subscribe(() => {
    if (store.byRule('schema:prop:id:value').length > 0 && !controller.signal.aborted) {
      controller.abort();
    }
  });
  const { summary, flags } = await run({
    batchRows: 2,
    signal: controller.signal,
    flagStore: store,
  });
  unsubscribe();
  expect(summary.aborted).toBe(true);
  expect(summary.rowsTotal).toBe(10);
  expect(summary.flagsEmitted).toBeLessThan(6);
  // Dataset checks are skipped on abort — the duplicate pair is absent, but
  // main-thread casting/column flags landed before the row loop.
  expect(flags.some((f) => f.ruleId === 'schema:dataset:duplicate-records')).toBe(false);
  expect(flags.some((f) => f.ruleId === 'schema:prop:age:cast')).toBe(true);
  expect(flags.some((f) => f.ruleId === 'schema:column:notes:unexpected')).toBe(true);
});

test('cap truncation: materialized ≤ cap, countsByRuleId stays exact', async () => {
  const uncapped = await run();
  const capped = await run({ flagCap: 3 });
  expect(capped.summary.flagsTruncated).toBe(true);
  expect(capped.summary.flagsEmitted).toBe(3);
  expect(capped.summary.countsByRuleId).toEqual(uncapped.summary.countsByRuleId);
  const workerFlagCount = Object.values(capped.summary.countsByRuleId).reduce((a, n) => a + n, 0);
  expect(workerFlagCount).toBe(6);
});

test('HESP dirty end-to-end: every seeded schema:* expectation surfaces', async () => {
  const entries = await Promise.all(
    Object.entries(hespSchemaUrls).map(async ([path, url]) => ({
      relativePath: path.replace('../fixtures/hesp/json_schema/', ''),
      raw: await fetchText(url),
    })),
  );
  const hespSet = await buildSchemaSet(entries, { origin: 'upload' });
  const hespDigest = columnDigest(hespSet);
  if (!hespDigest) throw new Error('HESP digest unavailable');
  expect(hespDigest.meta).toHaveLength(265);
  expect(hespDigest.conditionals).toHaveLength(171);

  const bytes = await (await fetch(hespDirtyCsvUrl)).arrayBuffer();
  const ingest = await ingestDataset(b(), { name: 'hesp_dirty_100.csv', bytes, format: 'csv' });

  const flagStore = createFlagStore();
  const summary = await runSchemaValidation({
    runner: b(),
    set: hespSet,
    digest: hespDigest,
    datasetColumns: ingest.columns,
    flagStore,
  });
  expect(summary.rowsTotal).toBe(101);
  expect(summary.aborted).toBe(false);

  interface Injection {
    kind: string;
    rows: number[];
    column: string | null;
    expectedRuleIds: string[];
  }
  const manifest = JSON.parse(await fetchText(seededViolationsUrl)) as {
    injections: Injection[];
  };
  for (const injection of manifest.injections) {
    for (const ruleId of injection.expectedRuleIds.filter((r) => r.startsWith('schema:'))) {
      const hits = flagStore.byRule(ruleId);
      expect(hits.length, `${injection.kind} → ${ruleId}`).toBeGreaterThan(0);
      const cellHits = hits.filter((h) => h.flag.scope === 'cell');
      if (cellHits.length > 0 && injection.rows.length > 0) {
        for (const row of injection.rows) {
          expect(
            cellHits.some((h) => h.flag.row === row),
            `${injection.kind} → ${ruleId} at __row__ ${String(row)}`,
          ).toBe(true);
        }
      }
    }
  }

  // Restore the mini ingest for any later test.
  await ingestMiniInvalid();
}, 120_000);

test('100k-row generated smoke: full run completes, zero findings', async () => {
  await b().query(
    'CREATE OR REPLACE TABLE quac_raw AS ' +
      'SELECT CAST(i AS BIGINT) AS __row__, ' +
      "'R' || lpad(CAST(i % 1000 AS VARCHAR), 3, '0') AS id, " +
      'CAST(18 + (i % 83) AS VARCHAR) AS age, ' +
      'CAST((i % 97) / 100.0 AS VARCHAR) AS score, ' +
      "'1' AS consent " +
      'FROM range(100000) t(i)',
  );
  b().clearQueryCache();
  try {
    const t0 = performance.now();
    const { summary, flags } = await run({
      datasetColumns: ['id', 'age', 'score', 'consent'],
    });
    const wallMs = Math.round(performance.now() - t0);
    console.log(
      `[perf] 100k×4 mini-schema run: total ${String(wallMs)} ms ` +
        `(worker validate ${String(summary.elapsedMs)} ms, ` +
        `${String(Math.round(100000 / (summary.elapsedMs / 1000)))} rows/s)`,
    );
    expect(summary.rowsTotal).toBe(100_000);
    expect(summary.aborted).toBe(false);
    expect(summary.rowsWithErrors).toBe(0);
    expect(flags).toHaveLength(0);
  } finally {
    // Restore the mini_invalid ingest for any later test.
    await ingestMiniInvalid();
  }
}, 120_000);
