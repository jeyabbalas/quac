/**
 * Canonical DuckDB table registry + lifecycle helpers (architecture.md §4).
 * Every mutating helper ends with bridge.clearQueryCache(): the bridge's
 * SELECT cache is NOT invalidated by DDL/DML (Verified facts V2).
 */
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { nestedReplaceClause } from '../nested-json';
import { quoteIdentifier } from '../sql-identifier';

export const QUAC_RAW = 'quac_raw';
export const QUAC_TYPED = 'quac_typed';
export const QUAC_WORK = 'quac_work';
export const DATA_VIEW = 'data';
export const QUAC_DISPLAY = 'quac_display';
export const QUAC_STUDIO_DISPLAY = 'quac_studio_display';

/**
 * Base names for the two data-table grids, suffixed per instance (UX-01).
 *
 * Through data-table 0.8 the parquet loader derived its duckdb-wasm virtual
 * file from the table name — `registerFileBuffer('<tableName>.parquet', …)` …
 * `finally { dropFile(...) }` — so a FIXED name made every grid build register
 * and drop the same path with different-sized content. DuckDB kept per-path
 * state across that cycle: the second build of a differently shaped dataset
 * read the new bytes against the old file's extent and failed with "No magic
 * bytes found at end of file", unrecoverably. A fresh name per build was the
 * fix.
 *
 * Since 0.9 the loader names its file itself (`__dt_source_<n>`, upstream
 * 9d2827c2), so that collision cannot recur: displayGridReshape's rebuild
 * passes with the bare constant too (checked on 0.10.0). The suffix stays —
 * it costs nothing and keeps every build's table distinct in DuckDB — but it
 * is no longer load-bearing. Monotonic like ingestController's generation
 * counter: never reused within a session, even after a table is dropped.
 */
let displayTableSeq = 0;
export function nextDisplayTableName(base: string): string {
  displayTableSeq += 1;
  return `${base}_${String(displayTableSeq)}`;
}

/**
 * Display-bytes export SQL (architecture.md §9): data-table assigns __rowid__
 * in insertion order, so exporting ORDER BY __row__ with __row__ excluded
 * makes __rowid__ === __row__ after loadData (Verified facts V7).
 */
export const DISPLAY_EXPORT_SQL = `SELECT * EXCLUDE (__row__) FROM ${DATA_VIEW} ORDER BY __row__`;

/**
 * Excel-export row page (qc-report-spec.md §5): post-correction values ordered
 * by __row__, `__row__` INCLUDED — it keys the report model's per-row
 * decoration lookup and is dropped when the workbook cell array is built.
 * `nested` names the LIST/STRUCT/MAP/JSON columns, read as their exact JSON
 * text (core/nested-json.ts) — what a cell of the Data sheet shows.
 */
export const reportRowsSQL = (offset: number, limit: number, nested: Iterable<string> = []): string =>
  `SELECT *${nestedReplaceClause(nested)} FROM ${DATA_VIEW} ORDER BY __row__ ` +
  `LIMIT ${String(limit)} OFFSET ${String(offset)}`;

/** Load-view Preview sample size (ingestion.md §2). */
export const PREVIEW_ROW_CAP = 50;

/**
 * Load-view Preview rows: the first 50 in canonical order with `__row__`
 * excluded, nested columns as their JSON text. One builder, so the cap cannot
 * drift between the SQL, the "first 50 of 101 rows" meta line, and the table's
 * accessible name — it used to be a literal in all three.
 */
export const previewSQL = (nested: Iterable<string> = []): string =>
  `SELECT * EXCLUDE (__row__)${nestedReplaceClause(nested)} FROM ${DATA_VIEW} ORDER BY __row__ ` +
  `LIMIT ${String(PREVIEW_ROW_CAP)}`;

/** The preview over a flat dataset. */
export const PREVIEW_SQL = previewSQL();

/** Studio live-preview sample size (P18): the browsing grid caps at 10k rows;
 *  rule-test counts always run against the FULL `data` view. */
export const STUDIO_SAMPLE_ROW_CAP = 10_000;

/**
 * Studio preview sample export (P18): first 10k rows in canonical order with
 * __row__ excluded — the DISPLAY_EXPORT_SQL trick (V7), so the sample grid's
 * __rowid__ equals QuaC's __row__ for every sampled row.
 */
export const STUDIO_SAMPLE_SQL =
  `SELECT * EXCLUDE (__row__) FROM ${DATA_VIEW} ORDER BY __row__ ` +
  `LIMIT ${String(STUDIO_SAMPLE_ROW_CAP)}`;

/** CREATE OR REPLACE TABLE <table> AS <selectSql>. */
export async function ctas(bridge: WorkerBridge, table: string, selectSql: string): Promise<void> {
  await bridge.query(`CREATE OR REPLACE TABLE ${quoteIdentifier(table)} AS ${selectSql}`);
  bridge.clearQueryCache();
}

/**
 * Atomically replace quac_work with the result of selectSql, which may read
 * from quac_work itself (the corrections CTAS-swap, architecture.md §6).
 * DuckDB evaluates the SELECT against the old table before the single-
 * statement replace commits (verified in bridge.browser.test.ts).
 */
export async function swapWorkTable(bridge: WorkerBridge, selectSql: string): Promise<void> {
  await ctas(bridge, QUAC_WORK, selectSql);
}

/** Point the canonical `data` view (all rule SQL targets it) at quac_work. */
export async function refreshDataView(bridge: WorkerBridge): Promise<void> {
  await bridge.query(
    `CREATE OR REPLACE VIEW ${quoteIdentifier(DATA_VIEW)} AS SELECT * FROM ${quoteIdentifier(QUAC_WORK)}`,
  );
  bridge.clearQueryCache();
}

/**
 * Read-only Parquet export of selectSql via the worker-side COPY wrapper
 * (Verified facts V5: bridge.exportToBuffer).
 */
export async function copyToParquetBytes(
  bridge: WorkerBridge,
  selectSql: string,
): Promise<Uint8Array> {
  return bridge.exportToBuffer(selectSql, 'parquet');
}

/**
 * Display bytes as the grids hand them to data-table: a Blob, not an
 * ArrayBuffer. Since 0.9 data-table registers a Blob as a file handle and
 * DuckDB reads it from disk as it decodes; an ArrayBuffer is copied into
 * DuckDB's wasm memory first — the whole file, in a heap that grows to its
 * high-water mark and never shrinks — and its loader's memory check counts the
 * file against the load. Unnamed binary data is taken to be Parquet.
 *
 * The Blob constructor refuses a view over a SharedArrayBuffer, so such a view
 * is copied out first. None arrives in practice: the worker's export transfers
 * a plain ArrayBuffer, and the page is not cross-origin isolated.
 */
export function parquetSource(bytes: Uint8Array): Blob {
  return new Blob([onArrayBuffer(bytes) ? bytes : bytes.slice()]);
}

function onArrayBuffer(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

/**
 * Dataset clear (UIX-7): actually free the memory — drop the `data` view
 * first (it reads quac_work), then the three canonical tables. IF EXISTS
 * throughout makes it idempotent. quac_display/quac_studio_display are NOT
 * ours to drop — they belong to the data-table instances and die with
 * `table.destroy()`.
 */
export async function dropDatasetTables(bridge: WorkerBridge): Promise<void> {
  await bridge.query(`DROP VIEW IF EXISTS ${quoteIdentifier(DATA_VIEW)}`);
  await bridge.query(`DROP TABLE IF EXISTS ${quoteIdentifier(QUAC_WORK)}`);
  await bridge.query(`DROP TABLE IF EXISTS ${quoteIdentifier(QUAC_TYPED)}`);
  await bridge.query(`DROP TABLE IF EXISTS ${quoteIdentifier(QUAC_RAW)}`);
  bridge.clearQueryCache();
}
