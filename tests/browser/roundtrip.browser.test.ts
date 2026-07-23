/**
 * P03 spike regressions for Verified facts V5/V7 (architecture.md §10): the
 * corrected-data display round trip of §9 — export display bytes from the
 * `data` view via the bridge, load them into a data-table grid, and prove
 * the grid's __rowid__ equals QuaC's __row__ so annotations land by flag.row.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ROWID_COLUMN, createDataTable } from '@jeyabbalas/data-table';
import type { DataTable, WorkerBridge } from '@jeyabbalas/data-table';
import '@jeyabbalas/data-table/styles';
import { createBridge } from '../../src/core/bridge/bridge';
import {
  DISPLAY_EXPORT_SQL,
  QUAC_DISPLAY,
  QUAC_TYPED,
  QUAC_WORK,
  copyToParquetBytes,
  ctas,
  refreshDataView,
} from '../../src/core/bridge/tables';
import { PARQUET_MAGIC, toArrayBuffer, waitFor } from './support';

const ROWS = 5;

let bridge: WorkerBridge;
let container: HTMLElement;
let table: DataTable | undefined;
let bytes: Uint8Array;

beforeAll(async () => {
  bridge = await createBridge();
  // Canonical chain: quac_typed → quac_work → view `data` (architecture.md §4),
  // with BIGINT __row__ = original order and a value column derived from it.
  await ctas(
    bridge,
    QUAC_TYPED,
    `SELECT r::BIGINT AS __row__, 'r' || r AS val, (r * 10)::INTEGER AS num FROM range(${String(ROWS)}) AS t(r)`,
  );
  await ctas(bridge, QUAC_WORK, `SELECT * FROM ${QUAC_TYPED}`);
  await refreshDataView(bridge);

  container = document.createElement('div');
  container.style.width = '900px';
  container.style.height = '500px';
  document.body.appendChild(container);
});

afterAll(async () => {
  await table?.destroy();
  bridge.terminate();
  container.remove();
});

test('V5: copyToParquetBytes(display SQL) returns real Parquet bytes', async () => {
  bytes = await copyToParquetBytes(bridge, DISPLAY_EXPORT_SQL);
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(bytes.byteLength).toBeGreaterThan(PARQUET_MAGIC.length);
  expect(Array.from(bytes.subarray(0, 4))).toEqual(PARQUET_MAGIC);
});

test('V7: loadData(display bytes) yields __rowid__ === __row__, __row__ excluded', async () => {
  const t = await createDataTable({
    container,
    source: toArrayBuffer(bytes),
    sourceFormat: 'parquet',
    tableName: QUAC_DISPLAY,
    bridge,
    persistence: false,
  });
  table = t;
  await waitFor(() => t.state.totalRows.get() === ROWS, `totalRows to reach ${String(ROWS)}`);

  // The display table was exported ORDER BY __row__ with __row__ excluded, so the
  // library's insertion-order __rowid__ must reproduce __row__ (val = 'r' || __row__).
  const rows = await bridge.query<{ __rowid__: number | bigint; val: string }>(
    `SELECT ${ROWID_COLUMN}, val FROM ${QUAC_DISPLAY} ORDER BY ${ROWID_COLUMN}`,
  );
  expect(rows).toHaveLength(ROWS);
  for (const row of rows) {
    expect(row.val).toBe(`r${String(Number(row.__rowid__))}`);
  }

  const columns = t.state.schema.get().map((c) => c.name);
  expect(columns).not.toContain('__row__');
  expect(columns).toEqual(expect.arrayContaining(['val', 'num']));
});

test('V7: a cell annotation at rowId k lands on the row whose __row__ === k', async () => {
  const t = table;
  if (!t) throw new Error('previous test did not initialize the table');

  const added = t.annotations.add({
    scope: 'cell',
    rowId: 3,
    column: 'val',
    severity: 'error',
    message: 'spike: annotation landing check',
  });
  expect(t.annotations.getByCell(3, 'val').map((a) => a.id)).toContain(added.id);

  // Painted cell carries the annotation class and must show row 3's value.
  await waitFor(
    () => container.querySelector('.dt-cell--annotated') !== null,
    'the annotated cell to paint',
  );
  const cell = container.querySelector('.dt-cell--annotated');
  expect(cell?.textContent).toContain('r3');
});
