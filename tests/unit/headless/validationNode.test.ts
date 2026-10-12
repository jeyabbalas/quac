/**
 * headless.md §3 — the in-process validation worker, driven at the protocol
 * level (json-schema-subsystem.md §F).
 *
 * No DuckDB here: the point is the message contract `runSchemaValidation`'s
 * channel depends on — reply order, abort at a batch boundary, the sticky flag
 * cap, and (new for the in-process variant) that two engines in ONE process do
 * not see each other's state. The engine's flag CONTENT is ground-truthed
 * elsewhere: `nodePipeline.test.ts` deep-equals the same mini fixture against
 * `mini_expected_flags.json`, the manifest the browser tier also pins.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { datasetShape, schemaRefUri } from '../../../src/core/schema/dataset-shape';
import { serializeColumnMeta } from '../../../src/core/schema/worker-protocol';
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import type { SchemaSet } from '../../../src/core/schema/types';
import type { MainToWorker, PresentedColumn, WorkerToMain } from '../../../src/core/schema/worker-protocol';

const MINI = resolve(__dirname, '..', '..', 'fixtures', 'synthetic', 'mini');
/** The mini dataset's schema-covered columns, in file order. */
const NAMES = ['id', 'age', 'score', 'consent'];

/**
 * `mini_invalid.csv` as the row loop fetches it — the raw TEXT of each cell
 * (§C.0): the worker reads each one as the value it spells, so row 3's `abc`
 * age is a cast finding made here, in the worker, and the follow-on
 * `required` error is suppressed in its favour.
 */
const ROWS: unknown[][] = [
  ['R101', '25', '0.5', '1'],
  ['X99', '30', '0.75', '1'], // bad id pattern
  ['R102', '150', '0.5', '1'], // age above the 100 branch maximum
  ['R103', 'abc', '0.25', '1'], // age: text no integer spells
  ['R104', '40', '1.5', '1'], // score above 1
  ['R105', '50', '0.5', '5'], // consent matches no oneOf branch
  ['R106', '60', '0.5', '0'], // conditional: consent 0 requires score -777
  ['R107', null, '0.75', '1'], // age empty → required
  ['R108', '70', '0.25', '1'],
  ['R108', '70', '0.25', '1'], // duplicate pair (a dataset-scope finding)
];

let set: SchemaSet;
let digest: ColumnDigest;

beforeAll(async () => {
  const raw = await readFile(resolve(MINI, 'mini.schema.json'), 'utf8');
  set = await buildSchemaSet([{ relativePath: 'mini.schema.json', raw }], { origin: 'upload' });
  const d = columnDigest(set);
  if (d === null) throw new Error('mini digest unavailable');
  digest = d;
});

function initMessage(flagCap: number): Extract<MainToWorker, { type: 'init' }> {
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  const shape = datasetShape(set);
  const record = shape?.record;
  if (root === undefined || record === undefined || record === null || record === false) {
    throw new Error('mini set has no record schema');
  }
  const columns: PresentedColumn[] = NAMES.map((name) => {
    const m = digest.meta.find((c) => c.name === name);
    const jsonTypes = m === undefined ? [] : [...m.jsonTypes].sort();
    return { column: name, key: name, jsonTypes, nullAllowed: jsonTypes.includes('null'), transport: { kind: 'text' } };
  });
  return {
    type: 'init',
    files: set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json })),
    draft: root.draft,
    columnMeta: serializeColumnMeta(digest.meta),
    conditionals: digest.conditionals,
    missingRequired: [],
    mode: 'text',
    columns,
    checks: { record: schemaRefUri(record), prefix: [], uniqueItems: shape.uniqueItems === true },
    config: { flagCap },
  };
}

/** A worker plus a recorder of everything it posts back, in arrival order. */
function openWorker(): { post: (msg: MainToWorker) => void; received: WorkerToMain[]; end: () => void } {
  const worker = createInProcessValidationWorker();
  const received: WorkerToMain[] = [];
  worker.onmessage = (event: { data: WorkerToMain }): void => {
    received.push(event.data);
  };
  return {
    post: (msg) => {
      worker.postMessage(msg);
    },
    received,
    end: () => {
      worker.terminate();
    },
  };
}

/** Let every queued microtask hop settle (both directions are deferred). */
const settle = async (): Promise<void> => {
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
};

const doneOf = (received: readonly WorkerToMain[]): Extract<WorkerToMain, { type: 'done' }> => {
  const msg = received.find((m) => m.type === 'done');
  if (msg?.type !== 'done') throw new Error('no done message');
  return msg;
};

describe('protocol order', () => {
  test('init → ready, each batch → one batchDone, flush → done', async () => {
    const w = openWorker();
    w.post(initMessage(1000));
    await settle();
    expect(w.received.map((m) => m.type)).toEqual(['ready']);

    w.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS.slice(0, 5) });
    await settle();
    w.post({ type: 'batch', seq: 1, rowStart: 5, rows: ROWS.slice(5) });
    await settle();
    w.post({ type: 'flush' });
    await settle();

    expect(w.received.map((m) => m.type)).toEqual(['ready', 'batchDone', 'batchDone', 'done']);
    const [first, second] = w.received.filter((m) => m.type === 'batchDone');
    expect(first?.type === 'batchDone' && first.seq).toBe(0);
    expect(second?.type === 'batchDone' && second.seq).toBe(1);

    const summary = doneOf(w.received).summary;
    expect(summary.rowsTotal).toBe(10);
    expect(summary.aborted).toBe(false);
    // 7 worker-side flags on this fixture: six translator findings and the
    // `abc` cast finding (made here, reading the cell's text) — the rest of
    // the manifest are main-thread findings (column and dataset scope).
    expect(summary.flagsEmitted).toBe(7);
    expect(summary.rowsWithErrors).toBe(7);
    expect(summary.flagsTruncated).toBe(false);
    w.end();
  });

  test('replies are asynchronous — nothing arrives before the caller can listen', () => {
    const w = openWorker();
    w.post(initMessage(1000));
    // The orchestrator's `expect()` parks on a promise between messages; a
    // synchronous reply would be delivered before it started listening.
    expect(w.received).toEqual([]);
    w.end();
  });

  test('a terminated worker stops delivering', async () => {
    const w = openWorker();
    w.post(initMessage(1000));
    await settle();
    w.end();
    w.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    expect(w.received.map((m) => m.type)).toEqual(['ready']);
  });
});

describe('abort at a batch boundary', () => {
  test('done{aborted:true} carries the partial summary', async () => {
    const w = openWorker();
    w.post(initMessage(1000));
    await settle();
    w.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS.slice(0, 5) });
    await settle();
    w.post({ type: 'abort' });
    await settle();

    const summary = doneOf(w.received).summary;
    expect(summary.aborted).toBe(true);
    expect(summary.rowsTotal).toBe(5); // partial, and kept
    w.end();
  });

  test('a batch posted after the abort is ignored', async () => {
    const w = openWorker();
    w.post(initMessage(1000));
    await settle();
    w.post({ type: 'abort' });
    await settle();
    w.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    expect(w.received.map((m) => m.type)).toEqual(['ready', 'done']);
    w.end();
  });
});

describe('the sticky flag cap', () => {
  test('materialized flags stop at the cap but countsByRuleId stays exact', async () => {
    const capped = openWorker();
    capped.post(initMessage(2));
    await settle();
    capped.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    capped.post({ type: 'flush' });
    await settle();

    const uncapped = openWorker();
    uncapped.post(initMessage(1000));
    await settle();
    uncapped.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    uncapped.post({ type: 'flush' });
    await settle();

    const cappedSummary = doneOf(capped.received).summary;
    const fullSummary = doneOf(uncapped.received).summary;
    expect(cappedSummary.flagsEmitted).toBe(2);
    expect(cappedSummary.flagsTruncated).toBe(true);
    expect(fullSummary.flagsTruncated).toBe(false);
    // The cap governs materialization only — Sheet 4's tallies must stay whole.
    expect(cappedSummary.countsByRuleId).toEqual(fullSummary.countsByRuleId);
    expect(cappedSummary.rowsWithErrors).toBe(fullSummary.rowsWithErrors);
    // …and so must the per-check tallies the findings without data are built from.
    expect(cappedSummary.checks).toEqual(fullSummary.checks);
    capped.end();
    uncapped.end();
  });

  test('per-check tallies split a ruleId by keyword and place, and sum to its count', async () => {
    const w = openWorker();
    w.post(initMessage(2));
    await settle();
    w.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    w.post({ type: 'flush' });
    await settle();
    const summary = doneOf(w.received).summary;
    expect(summary.checks.length).toBeGreaterThan(0);
    const summed = new Map<string, number>();
    for (const check of summary.checks) {
      summed.set(check.ruleId, (summed.get(check.ruleId) ?? 0) + check.count);
      // A per-record check counts each record once, however often it failed there.
      if (check.scope === 'cell' || check.scope === 'row') {
        expect(check.records).toBeGreaterThan(0);
        expect(check.records).toBeLessThanOrEqual(check.count);
      }
      // The translator located every keyword it reported in its file.
      if (check.keyword !== undefined && check.scope !== 'dataset') {
        expect(check.location).toMatch(/^quac-set:\/mini\.schema\.json#\//);
        expect(check.location?.endsWith(`/${check.keyword}`)).toBe(true);
      }
    }
    expect(Object.fromEntries(summed)).toEqual(summary.countsByRuleId);
    // Identifying fields only — a tally carries no message and no value.
    for (const check of summary.checks) {
      expect(Object.keys(check).sort()).toEqual(
        expect.arrayContaining(['count', 'records', 'ruleId', 'scope', 'severity']),
      );
      expect(check).not.toHaveProperty('message');
      expect(check).not.toHaveProperty('value');
    }
    w.end();
  });
});

describe('engine isolation', () => {
  test('two interleaved workers keep separate state', async () => {
    // The planning spike drove ONE module-singleton engine through a fake
    // `self`; this is the behavior that made it not graduate.
    const a = openWorker();
    const b = openWorker();
    a.post(initMessage(1000));
    b.post(initMessage(2));
    await settle();

    // Interleave: different row sets, different caps, overlapping in time.
    a.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS.slice(0, 5) });
    b.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    a.post({ type: 'batch', seq: 1, rowStart: 5, rows: ROWS.slice(5) });
    await settle();
    a.post({ type: 'flush' });
    b.post({ type: 'flush' });
    await settle();

    const sa = doneOf(a.received).summary;
    const sb = doneOf(b.received).summary;
    expect(sa.rowsTotal).toBe(10);
    expect(sb.rowsTotal).toBe(10);
    expect(sa.flagsTruncated).toBe(false);
    expect(sb.flagsTruncated).toBe(true);
    expect(sa.flagsEmitted).toBe(7);
    expect(sb.flagsEmitted).toBe(2);
    expect(sa.countsByRuleId).toEqual(sb.countsByRuleId);
    a.end();
    b.end();
  });

  test('an engine reports its own fatal without poisoning a sibling', async () => {
    const good = openWorker();
    const bad = openWorker();
    good.post(initMessage(1000));
    // A batch before init: the engine catches and posts `fatal`.
    bad.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    good.post({ type: 'batch', seq: 0, rowStart: 0, rows: ROWS });
    await settle();
    good.post({ type: 'flush' });
    await settle();

    expect(bad.received.map((m) => m.type)).toEqual(['fatal']);
    expect(good.received.map((m) => m.type)).toEqual(['ready', 'batchDone', 'done']);
    expect(doneOf(good.received).summary.rowsTotal).toBe(10);
    good.end();
    bad.end();
  });
});
