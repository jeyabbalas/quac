/**
 * UX-01 regression: rebuilding the display grid after the dataset's SHAPE
 * changed.
 *
 * data-table's parquet loader derives its duckdb-wasm virtual file from the
 * table name — `registerFileBuffer('<tableName>.parquet', bytes)` … `finally
 * { dropFile(...) }`. Reusing ONE name across builds therefore reuses one
 * path, and DuckDB carries per-path state across the drop: the second build
 * of a differently sized export reads the new bytes against the old file's
 * extent and dies ("No magic bytes found at end of file"), unrecoverably
 * until the page reloads.
 *
 * `nextDisplayTableName` (core/bridge/tables.ts) is what stops that, so this
 * proves the whole loop the report grid runs on a dataset replacement:
 * export wide → build → destroy → export NARROW → build again. Pin the name
 * back to the bare `QUAC_DISPLAY` constant and the second build fails — that
 * is the regression guarded here.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDataTable } from '@jeyabbalas/data-table';
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
  nextDisplayTableName,
  refreshDataView,
} from '../../src/core/bridge/tables';
import { PARQUET_MAGIC, toArrayBuffer, waitFor } from './support';

/** Wide enough that the two exports differ substantially in size. */
const WIDE_COLUMNS = 60;
const WIDE_ROWS = 40;
const NARROW_ROWS = 3;

let bridge: WorkerBridge;
let container: HTMLElement;
let table: DataTable | undefined;

/** Repoint the canonical chain at a fresh shape, as a re-ingest would. */
async function installShape(selectSql: string): Promise<void> {
  await ctas(bridge, QUAC_TYPED, selectSql);
  await ctas(bridge, QUAC_WORK, `SELECT * FROM ${QUAC_TYPED}`);
  await refreshDataView(bridge);
}

/** The report grid's build, verbatim: export the display view, mount it. */
async function buildGrid(): Promise<DataTable> {
  const bytes = await copyToParquetBytes(bridge, DISPLAY_EXPORT_SQL);
  expect(Array.from(bytes.subarray(0, 4))).toEqual(PARQUET_MAGIC);
  return createDataTable({
    container,
    source: toArrayBuffer(bytes),
    sourceFormat: 'parquet',
    tableName: nextDisplayTableName(QUAC_DISPLAY),
    bridge,
    persistence: false,
  });
}

const wideSql =
  `SELECT r::BIGINT AS __row__, ` +
  Array.from({ length: WIDE_COLUMNS }, (_, i) => `('c${String(i)}_' || r) AS "c${String(i)}"`).join(
    ', ',
  ) +
  ` FROM range(${String(WIDE_ROWS)}) AS t(r)`;

const narrowSql =
  `SELECT r::BIGINT AS __row__, ('only_' || r) AS "solo" ` +
  `FROM range(${String(NARROW_ROWS)}) AS t(r)`;

beforeAll(async () => {
  bridge = await createBridge();
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

test('UX-01: a grid rebuilt after a reshape reads the NEW dataset', async () => {
  await installShape(wideSql);
  const wide = await buildGrid();
  table = wide;
  await waitFor(
    () => wide.state.totalRows.get() === WIDE_ROWS,
    `the wide grid to reach ${String(WIDE_ROWS)} rows`,
  );
  expect(wide.state.schema.get().map((c) => c.name)).toContain('c0');

  // Replacement: destroy the mounted instance, then rebuild on a dataset with
  // a different column set and a much smaller export.
  await wide.destroy();
  table = undefined;
  await installShape(narrowSql);

  const narrow = await buildGrid();
  table = narrow;
  await waitFor(
    () => narrow.state.totalRows.get() === NARROW_ROWS,
    `the narrow grid to reach ${String(NARROW_ROWS)} rows`,
  );
  const columns = narrow.state.schema.get().map((c) => c.name);
  expect(columns).toContain('solo');
  expect(columns).not.toContain('c0');
  expect(columns).not.toContain('__row__');
});
