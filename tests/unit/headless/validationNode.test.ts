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
import { serializeColumnMeta } from '../../../src/core/schema/worker-protocol';
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import type { SchemaSet } from '../../../src/core/schema/types';
import type { MainToWorker, WorkerToMain } from '../../../src/core/schema/worker-protocol';

const MINI = resolve(__dirname, '..', '..', 'fixtures', 'synthetic', 'mini');
/** The mini dataset's schema-covered columns, in file order (`notes` is extra). */
const COLUMNS = ['id', 'age', 'score', 'consent'];

/**
 * `mini_invalid.csv` as the row loop fetches it — TYPED, because the batch is
 * read from `quac_typed` after the cast plan has run (§C). Row 3's `age` is
 * NULL for the same reason the real scan reports it: `'abc'` did not cast, and
 * that cell is named in `CAST_FAILURES` so the translator suppresses the
 * follow-on `required` error in favour of the main thread's cast flag.
 */
const ROWS: unknown[][] = [
  ['R101', 25, 0.5, 1],
  ['X99', 30, 0.75, 1], // bad id pattern
  ['R102', 150, 0.5, 1], // age above the 100 branch maximum
  ['R103', null, 0.25, 1], // age cast failure ('abc')
  ['R104', 40, 1.5, 1], // score above 1
  ['R105', 50, 0.5, 5], // consent matches no oneOf branch
  ['R106', 60, 0.5, 0], // conditional: consent 0 requires score -777
  ['R107', null, 0.75, 1], // age empty → required
  ['R108', 70, 0.25, 1],
  ['R108', 70, 0.25, 1], // duplicate pair (a dataset-scope SQL finding)
];
/** `${row} ${column}` — the key format `scanCastFailures` produces. */
const CAST_FAILURES = ['3 age'];

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
  if (root === undefined) throw new Error('mini set has no root');
  return {
    type: 'init',
    files: set.schemas.map((f) => ({ uri: f.retrievalUri, json: f.json })),
    rootBase: root.declaredId ?? root.retrievalUri,
    draft: root.draft,
    columnMeta: serializeColumnMeta(digest.meta),
    conditionals: digest.conditionals,
    missingColumns: [],
    castFailures: CAST_FAILURES,
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

    w.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS.slice(0, 5) });
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
    // 6 worker-side translator flags on this fixture — the other 3 of the
    // manifest's 9 are main-thread SQL findings (cast/column/dataset scope).
    expect(summary.flagsEmitted).toBe(6);
    expect(summary.rowsWithErrors).toBe(6);
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
    w.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
    await settle();
    expect(w.received.map((m) => m.type)).toEqual(['ready']);
  });
});

describe('abort at a batch boundary', () => {
  test('done{aborted:true} carries the partial summary', async () => {
    const w = openWorker();
    w.post(initMessage(1000));
    await settle();
    w.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS.slice(0, 5) });
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
    w.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
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
    capped.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
    await settle();
    capped.post({ type: 'flush' });
    await settle();

    const uncapped = openWorker();
    uncapped.post(initMessage(1000));
    await settle();
    uncapped.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
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
    capped.end();
    uncapped.end();
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
    a.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS.slice(0, 5) });
    b.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
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
    expect(sa.flagsEmitted).toBe(6);
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
    bad.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
    await settle();
    good.post({ type: 'batch', seq: 0, rowStart: 0, columns: COLUMNS, rows: ROWS });
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
