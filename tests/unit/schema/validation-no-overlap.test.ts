/**
 * §H edge 20 — the schema and the dataset share no column at all.
 *
 * `selected` (the columns fed to the QC worker) is empty exactly then, and the
 * row loop used to interpolate it into `SELECT ${selectList} FROM …`, which
 * DuckDB rejects with `Parser Error: SELECT clause without selection list` —
 * raw engine text on a toast, and no report. The guard must skip the row loop
 * (no worker at all) and say so as one dataset-scope flag, while the
 * dataset-level SQL checks — which read row counts and the dataset's OWN
 * columns — still run.
 *
 * SQL parity per testing-strategy §1: real DuckDB via @duckdb/node-api.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { runSchemaValidation } from '../../../src/core/schema/validation-run';
import { openMemoryDb, seedRawTable } from './duckdb';
import { entry } from './helpers';
import type { SqlRunner } from '../../../src/core/schema/casting';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import type { SchemaSet } from '../../../src/core/schema/types';
import type { MainToWorker, WorkerToMain } from '../../../src/core/schema/worker-protocol';

/**
 * Answers `init` with `ready` and nothing else — just enough for the row loop
 * to reach its first `fetchBatch`, which is where an empty select list dies.
 * With the guard in place it is never even constructed.
 */
interface FakeWorker {
  onmessage: ((event: { data: WorkerToMain }) => void) | null;
  postMessage: (msg: MainToWorker) => void;
  terminate: () => void;
}

function readyOnlyWorker(): Worker {
  const fake: FakeWorker = {
    onmessage: null,
    postMessage(msg) {
      if (msg.type !== 'init') return;
      queueMicrotask(() => fake.onmessage?.({ data: { type: 'ready', compileMs: 0 } }));
    },
    terminate() {
      /* nothing to tear down */
    },
  };
  return fake as unknown as Worker;
}

/** A people schema; the dataset below is a city table — nothing in common. */
const peopleSchema = (additionalProperties: unknown): unknown => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.test/people.schema.json',
  type: 'array',
  minItems: 5,
  items: {
    type: 'object',
    properties: {
      person_id: { type: 'string' },
      age: { type: 'integer' },
    },
    required: ['person_id', 'age'],
    additionalProperties,
  },
});

const DATASET_COLUMNS = ['city', 'population'];

let close: () => void;
let runner: SqlRunner;

beforeAll(async () => {
  const db = await openMemoryDb();
  runner = db.runner;
  close = db.close;
  await seedRawTable(
    runner,
    DATASET_COLUMNS.map((name) => ({ name, type: 'VARCHAR' })),
    [
      ['Springfield', '30720'],
      ['Shelbyville', '12000'],
    ],
  );
});

afterAll(() => {
  close();
});

async function loadSchema(additionalProperties: unknown): Promise<{
  set: SchemaSet;
  digest: ColumnDigest;
}> {
  const set = await buildSchemaSet([entry('people.schema.json', peopleSchema(additionalProperties))], {
    origin: 'upload',
  });
  const digest = columnDigest(set);
  if (digest === null) throw new Error('digest not derivable');
  return { set, digest };
}

describe('zero overlap between schema and dataset (§H edge 20)', () => {
  test('closed universe: no worker, no SQL, one dataset flag — and the run completes', async () => {
    const { set, digest } = await loadSchema(false);
    const flagStore = createFlagStore();
    let workersCreated = 0;

    const summary = await runSchemaValidation({
      runner,
      set,
      digest,
      datasetColumns: DATASET_COLUMNS,
      flagStore,
      createWorker: () => {
        workersCreated += 1;
        return readyOnlyWorker();
      },
    });

    // The whole point: it resolves. Before the guard this rejected with
    // DuckDB's `Parser Error: SELECT clause without selection list`.
    expect(summary.rowsTotal).toBe(2);
    expect(summary.aborted).toBe(false);
    expect(summary.rowsWithErrors).toBe(0);
    expect(workersCreated).toBe(0);

    const flags = flagStore.all().map((e) => e.flag);
    const noOverlap = flags.filter((f) => f.ruleId === 'schema:dataset:no-overlap');
    expect(noOverlap).toHaveLength(1);
    expect(noOverlap[0]?.scope).toBe('dataset');
    expect(noOverlap[0]?.severity).toBe('error');
    expect(noOverlap[0]?.message).toBe(
      "None of the schema's 2 variables are present among the dataset's 2 columns, " +
        'so no records could be validated — check that the schema and the dataset ' +
        'describe the same table.',
    );

    // Each absent variable is still named at column scope; the dataset-scope
    // sentence explains why no record was validated, it does not replace them.
    expect(
      flags
        .filter((f) => f.ruleId.endsWith(':missing'))
        .map((f) => f.column)
        .sort(),
    ).toEqual(['age', 'person_id']);

    // The aggregating stage is NOT skipped with the row loop: 2 rows < minItems 5.
    expect(flags.some((f) => f.ruleId === 'schema:dataset:min-items')).toBe(true);
  });

  test('an open property universe still validates every column through the worker', async () => {
    // `additionalProperties: {}` puts the dataset's own columns in scope, so
    // `selected` is non-empty and the guard must NOT fire — a guard that
    // over-triggered would silently report a clean dataset.
    const { set, digest } = await loadSchema({});
    await expect(
      runSchemaValidation({
        runner,
        set,
        digest,
        datasetColumns: DATASET_COLUMNS,
        flagStore: createFlagStore(),
        createWorker: () => {
          throw new Error('worker requested');
        },
      }),
    ).rejects.toThrow('worker requested');
  });
});
