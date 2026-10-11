/**
 * §H edge 20 — the schema and the dataset share no column at all.
 *
 * The row loop once fed the worker only the schema's columns, so here it had
 * none and died on DuckDB's `SELECT clause without selection list`. Records
 * now carry every dataset column (§C.3), so the run always has something to
 * read; what remains to pin is the outcome: each absent variable named once,
 * one dataset-scope sentence, and the schema's own verdict on the columns it
 * does not know.
 *
 * SQL parity per testing-strategy §1: real DuckDB via @duckdb/node-api.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { runSchemaValidation } from '../../../src/core/schema/validation-run';
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import { openMemoryDb, seedRawTable } from './duckdb';
import { entry } from './helpers';
import type { SqlRunner } from '../../../src/core/schema/casting';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import type { SchemaSet } from '../../../src/core/schema/types';

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
  test('the run completes: each record is still validated, and one dataset flag says why little matched', async () => {
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
        return createInProcessValidationWorker();
      },
    });

    // Every record holds every dataset column, so there is always something
    // to select — the old `SELECT FROM …` crash cannot recur — and the schema
    // judges the columns it does not know (here: additionalProperties false).
    expect(summary.rowsTotal).toBe(2);
    expect(summary.aborted).toBe(false);
    expect(workersCreated).toBe(1);

    const flags = flagStore.all().map((e) => e.flag);
    const noOverlap = flags.filter((f) => f.ruleId === 'schema:dataset:no-overlap');
    expect(noOverlap).toHaveLength(1);
    expect(noOverlap[0]?.scope).toBe('dataset');
    expect(noOverlap[0]?.severity).toBe('error');

    // Each absent variable is named once, at column scope — its per-record
    // `required` errors are folded into that flag.
    expect(
      flags
        .filter((f) => f.ruleId.endsWith(':missing'))
        .map((f) => f.column)
        .sort(),
    ).toEqual(['age', 'person_id']);
    expect(flags.filter((f) => f.ruleId.endsWith(':required'))).toEqual([]);

    // The aggregating stage still runs: 2 rows < minItems 5.
    expect(flags.some((f) => f.ruleId === 'schema:dataset:min-items')).toBe(true);
  });

  test('an open schema: the unknown columns are allowed — information, not errors', async () => {
    const { set, digest } = await loadSchema({});
    const flagStore = createFlagStore();
    await runSchemaValidation({
      runner,
      set,
      digest,
      datasetColumns: DATASET_COLUMNS,
      flagStore,
      createWorker: createInProcessValidationWorker,
    });
    const flags = flagStore.all().map((e) => e.flag);
    // `additionalProperties: {}` covers them with a schema: described, checked, fine.
    expect(flags.filter((f) => f.column === 'city' || f.column === 'population')).toEqual([]);
  });
});
