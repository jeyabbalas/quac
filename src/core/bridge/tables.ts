/**
 * Canonical DuckDB table registry + lifecycle helpers (architecture.md §4).
 * Every mutating helper ends with bridge.clearQueryCache(): the bridge's
 * SELECT cache is NOT invalidated by DDL/DML (Verified facts V2).
 */
import { quoteIdentifier } from '@jeyabbalas/data-table';
import type { WorkerBridge } from '@jeyabbalas/data-table';

export const QUAC_RAW = 'quac_raw';
export const QUAC_TYPED = 'quac_typed';
export const QUAC_WORK = 'quac_work';
export const DATA_VIEW = 'data';
export const QUAC_DISPLAY = 'quac_display';
export const QUAC_STUDIO_DISPLAY = 'quac_studio_display';

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
 */
export const reportRowsSQL = (offset: number, limit: number): string =>
  `SELECT * FROM ${DATA_VIEW} ORDER BY __row__ LIMIT ${String(limit)} OFFSET ${String(offset)}`;

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
