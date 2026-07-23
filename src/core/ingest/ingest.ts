/**
 * Dataset ingestion into the canonical engine tables (ingestion.md §2).
 *
 * Everything lands in quac_raw with __row__ = 0-based original file order.
 * The WorkerBridge's loaders inject a physical __rowid__ column in insertion
 * order (data-table-api.md §3), which becomes __row__ at CTAS time.
 *
 * Route per format (Verified facts V17/V18 — the spec's registerFileBuffer +
 * read_csv(all_varchar) path does not exist on the v0.5.1 bridge):
 *   csv/tsv  main-thread PapaParse → wrapped JSON (wrappedJson.ts — sidesteps
 *            read_json_auto's date detection AND MAP inference, V18) →
 *            loadData(format:'json') → json_extract_string CTAS; every
 *            column lands VARCHAR with exact text fidelity
 *   xlsx     SheetJS sheet_to_csv (sheet chosen upstream) → csv route
 *   json     prefix check → loadData(format:'json'); typed values kept
 *   parquet  loadData(format:'parquet'); native types kept
 *
 * The loaders' temp table is dropped and the SELECT cache cleared after
 * every step (Verified facts V2).
 */
import { quoteIdentifier } from '@jeyabbalas/data-table';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { QUAC_RAW, QUAC_TYPED, QUAC_WORK, ctas, refreshDataView } from '../bridge/tables';
import { parseDelimited } from './csv';
import { openWorkbook } from './excel';
import { sanitizeColumnNames } from './hygiene';
import { checkJsonArrayPrefix } from './json';
import { buildWrappedJsonBytes } from './wrappedJson';
import type { Rename } from './hygiene';
import type { IngestFormat } from './sniff';

/** Loader landing zone; transient within one ingest call (not in the §4 registry). */
const QUAC_INGEST_TMP = 'quac_ingest_tmp';

/** data-table's loader-injected physical row-order column. */
const ROWID = '__rowid__';

export interface IngestInput {
  name: string;
  bytes: ArrayBuffer;
  format: IngestFormat;
  /** Resolved upstream via SheetPickerModal; defaults to the first sheet. */
  sheetName?: string;
}

export type IngestStage = 'reading' | 'parsing' | 'loading' | 'preparing';
export type IngestStageFn = (stage: IngestStage, pct: number | null) => void;

export interface IngestResult {
  rowCount: number;
  columnCount: number;
  /** Final (sanitized) column names, __row__ excluded, in file order. */
  columns: string[];
  renames: Rename[];
  parseWarnings: string[];
  format: IngestFormat;
}

export interface RawTableResult {
  rowCount: number;
  columns: string[];
}

/**
 * Bytes → quac_raw → quac_typed (plain copy for now) → quac_work → `data`
 * view, so the Load-view preview and the display export work pre-run.
 */
export async function ingestDataset(
  bridge: WorkerBridge,
  input: IngestInput,
  onStage: IngestStageFn = () => undefined,
): Promise<IngestResult> {
  const raw = await buildRawTable(bridge, input, onStage);
  onStage('preparing', null);
  await buildTypedTable(bridge);
  await ctas(bridge, QUAC_WORK, `SELECT * FROM ${quoteIdentifier(QUAC_TYPED)}`);
  await refreshDataView(bridge);
  return raw;
}

async function buildRawTable(
  bridge: WorkerBridge,
  input: IngestInput,
  onStage: IngestStageFn,
): Promise<IngestResult> {
  const base = { format: input.format, parseWarnings: [] as string[], renames: [] as Rename[] };

  if (input.format === 'json' || input.format === 'parquet') {
    onStage('reading', null);
    if (input.format === 'json') checkJsonArrayPrefix(new Uint8Array(input.bytes));
    const { result, renames } = await loadTmpAndCtas(bridge, input.bytes, input.format, onStage);
    return { ...base, ...result, columnCount: result.columns.length, renames };
  }

  // Delimited routes (csv/tsv directly; xlsx via sheet_to_csv).
  onStage('reading', null);
  let text: string;
  if (input.format === 'xlsx') {
    const workbook = await openWorkbook(input.bytes);
    const sheet = input.sheetName ?? workbook.sheetNames[0];
    if (sheet === undefined) throw new Error('unreachable: openWorkbook guarantees a sheet');
    text = workbook.sheetToCsv(sheet);
  } else {
    text = new TextDecoder('utf-8', { fatal: false }).decode(input.bytes);
  }

  onStage('parsing', null);
  const parsed = await parseDelimited(text, input.format === 'tsv' ? '\t' : ',');
  const { names, renames } = sanitizeColumnNames(parsed.headers);
  const result =
    parsed.rows.length === 0
      ? await createEmptyRaw(bridge, names) // read_json_auto cannot infer from []
      : await loadWrappedJsonAsRaw(
          bridge,
          buildWrappedJsonBytes(names.length, parsed.rows),
          names,
          onStage,
        );
  return {
    ...base,
    ...result,
    columnCount: result.columns.length,
    renames,
    parseWarnings: parsed.parseWarnings,
  };
}

/**
 * quac_typed = plain copy of quac_raw. P09 replaces exactly this function
 * with the schema-driven TRY_CAST ladder (json-schema-subsystem.md §C).
 */
export async function buildTypedTable(bridge: WorkerBridge): Promise<void> {
  await ctas(bridge, QUAC_TYPED, `SELECT * FROM ${quoteIdentifier(QUAC_RAW)}`);
}

/**
 * Load wrapped JSON bytes (buildWrappedJsonBytes output) as quac_raw.
 * The temp table holds one VARCHAR column `j` per row; the CTAS extracts
 * positional keys c0..cN and aliases them to the sanitized column names —
 * json_extract_string always returns VARCHAR, so raw fidelity is guaranteed
 * regardless of read_json_auto's inference heuristics (V18).
 */
export async function loadWrappedJsonAsRaw(
  bridge: WorkerBridge,
  ndjsonBytes: Uint8Array,
  columns: readonly string[],
  onStage?: IngestStageFn,
): Promise<RawTableResult> {
  const buffer = ndjsonBytes.buffer.slice(
    ndjsonBytes.byteOffset,
    ndjsonBytes.byteOffset + ndjsonBytes.byteLength,
  ) as ArrayBuffer;
  await loadTmp(bridge, buffer, 'json', onStage);
  try {
    const selectList = columns
      .map((name, i) => `json_extract_string(j, '$.c${String(i)}') AS ${quoteIdentifier(name)}`)
      .join(', ');
    await bridge.query(
      `CREATE OR REPLACE TABLE ${quoteIdentifier(QUAC_RAW)} AS ` +
        `SELECT ${quoteIdentifier(ROWID)} AS __row__, ${selectList} ` +
        `FROM ${quoteIdentifier(QUAC_INGEST_TMP)} ` +
        `ORDER BY ${quoteIdentifier(ROWID)}`,
    );
    bridge.clearQueryCache();
    return {
      rowCount: await countRawRows(bridge),
      columns: [...columns],
    };
  } finally {
    await dropTmp(bridge);
  }
}

/** loadData into the temp table + column discovery + rename-aware CTAS. */
async function loadTmpAndCtas(
  bridge: WorkerBridge,
  bytes: ArrayBuffer,
  format: 'json' | 'parquet',
  onStage: IngestStageFn,
): Promise<{ result: RawTableResult; renames: Rename[] }> {
  const loaded = await loadTmp(bridge, bytes, format, onStage);
  try {
    const originals = loaded.columns.filter((c) => c !== ROWID);
    const { names, renames } = sanitizeColumnNames(originals);
    const mapping = originals.map((from, i) => ({ from, to: names[i] ?? from }));
    const result = await ctasRawFromTmp(bridge, mapping);
    return { result, renames };
  } finally {
    await dropTmp(bridge);
  }
}

async function loadTmp(
  bridge: WorkerBridge,
  bytes: ArrayBuffer,
  format: 'json' | 'parquet',
  onStage?: IngestStageFn,
): Promise<{ columns: string[] }> {
  const loaded = await bridge.loadData(bytes, { format, tableName: QUAC_INGEST_TMP }, (info) => {
    onStage?.('loading', typeof info.percent === 'number' ? info.percent : null);
  });
  bridge.clearQueryCache();
  return { columns: loaded.columns };
}

async function dropTmp(bridge: WorkerBridge): Promise<void> {
  await bridge.dropTable(QUAC_INGEST_TMP);
  bridge.clearQueryCache();
}

/** Header-only delimited file: an all-VARCHAR quac_raw with zero rows. */
async function createEmptyRaw(
  bridge: WorkerBridge,
  columns: readonly string[],
): Promise<RawTableResult> {
  const selectList = columns
    .map((name) => `CAST(NULL AS VARCHAR) AS ${quoteIdentifier(name)}`)
    .join(', ');
  await bridge.query(
    `CREATE OR REPLACE TABLE ${quoteIdentifier(QUAC_RAW)} AS ` +
      `SELECT CAST(NULL AS BIGINT) AS __row__, ${selectList} WHERE false`,
  );
  bridge.clearQueryCache();
  return { rowCount: 0, columns: [...columns] };
}

/**
 * CREATE OR REPLACE quac_raw from the loader temp table: __rowid__ becomes
 * __row__ (original file order), columns are selected explicitly in order
 * (optionally renamed — json/parquet hygiene happens here).
 */
export async function ctasRawFromTmp(
  bridge: WorkerBridge,
  columns: readonly { from: string; to: string }[],
): Promise<RawTableResult> {
  const selectList = columns
    .map(({ from, to }) =>
      from === to ? quoteIdentifier(from) : `${quoteIdentifier(from)} AS ${quoteIdentifier(to)}`,
    )
    .join(', ');
  await bridge.query(
    `CREATE OR REPLACE TABLE ${quoteIdentifier(QUAC_RAW)} AS ` +
      `SELECT ${quoteIdentifier(ROWID)} AS __row__, ${selectList} ` +
      `FROM ${quoteIdentifier(QUAC_INGEST_TMP)} ` +
      `ORDER BY ${quoteIdentifier(ROWID)}`,
  );
  bridge.clearQueryCache();
  return {
    rowCount: await countRawRows(bridge),
    columns: columns.map((c) => c.to),
  };
}

async function countRawRows(bridge: WorkerBridge): Promise<number> {
  const [count] = await bridge.query<{ n: number | bigint }>(
    `SELECT count(*)::INT AS n FROM ${quoteIdentifier(QUAC_RAW)}`,
  );
  return Number(count?.n ?? 0);
}
