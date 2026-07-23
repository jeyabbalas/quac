/**
 * Dataset ingestion into the canonical engine tables (ingestion.md §2).
 *
 * Everything lands in quac_raw with __row__ = 0-based original file order.
 * The WorkerBridge's loaders inject a physical __rowid__ column in insertion
 * order (data-table-api.md §3), which becomes __row__ at CTAS time. The
 * loaders' temp table is dropped and the SELECT cache cleared after every
 * step (Verified facts V2).
 */
import { quoteIdentifier } from '@jeyabbalas/data-table';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { QUAC_RAW } from '../bridge/tables';

/** Loader landing zone; transient within one ingest call (not in the §4 registry). */
const QUAC_INGEST_TMP = 'quac_ingest_tmp';

/** data-table's loader-injected physical row-order column. */
const ROWID = '__rowid__';

export interface RawTableResult {
  rowCount: number;
  /** Final (sanitized) column names, __row__ excluded. */
  columns: string[];
}

/**
 * Load all-string NDJSON bytes (buildNdjsonBytes output) as quac_raw.
 * `columns` is the sanitized header list — it must match the NDJSON keys.
 * `sentinelRow: true` mirrors the buildNdjsonBytes option: the first NDJSON
 * record is a type-defeating sentinel that is excluded here.
 */
export async function loadNdjsonAsRaw(
  bridge: WorkerBridge,
  ndjsonBytes: Uint8Array,
  columns: readonly string[],
  options: { sentinelRow?: boolean } = {},
): Promise<RawTableResult> {
  const buffer = ndjsonBytes.buffer.slice(
    ndjsonBytes.byteOffset,
    ndjsonBytes.byteOffset + ndjsonBytes.byteLength,
  ) as ArrayBuffer;
  await bridge.loadData(buffer, { format: 'json', tableName: QUAC_INGEST_TMP });
  bridge.clearQueryCache();
  try {
    return await ctasRawFromTmp(bridge, columns.map((name) => ({ from: name, to: name })), {
      skipSentinelRow: options.sentinelRow ?? false,
    });
  } finally {
    await bridge.dropTable(QUAC_INGEST_TMP);
    bridge.clearQueryCache();
  }
}

/**
 * CREATE OR REPLACE quac_raw from the loader temp table: __rowid__ becomes
 * __row__ (original file order), columns are selected explicitly in order
 * (optionally renamed — json/parquet hygiene happens here).
 */
export async function ctasRawFromTmp(
  bridge: WorkerBridge,
  columns: readonly { from: string; to: string }[],
  options: { skipSentinelRow?: boolean } = {},
): Promise<RawTableResult> {
  const skip = options.skipSentinelRow ?? false;
  const rowExpr = skip ? `${quoteIdentifier(ROWID)} - 1` : quoteIdentifier(ROWID);
  const selectList = columns
    .map(({ from, to }) =>
      from === to
        ? quoteIdentifier(from)
        : `${quoteIdentifier(from)} AS ${quoteIdentifier(to)}`,
    )
    .join(', ');
  const where = skip ? ` WHERE ${quoteIdentifier(ROWID)} > 0` : '';
  await bridge.query(
    `CREATE OR REPLACE TABLE ${quoteIdentifier(QUAC_RAW)} AS ` +
      `SELECT ${rowExpr} AS __row__, ${selectList} ` +
      `FROM ${quoteIdentifier(QUAC_INGEST_TMP)}${where} ` +
      `ORDER BY ${quoteIdentifier(ROWID)}`,
  );
  bridge.clearQueryCache();
  const [count] = await bridge.query<{ n: number | bigint }>(
    `SELECT count(*)::INT AS n FROM ${quoteIdentifier(QUAC_RAW)}`,
  );
  return {
    rowCount: Number(count?.n ?? 0),
    columns: columns.map((c) => c.to),
  };
}
