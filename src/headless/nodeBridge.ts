/**
 * `WorkerBridge`-shaped facade over `@duckdb/node-api` (headless.md §2).
 *
 * The whole QC engine takes a `WorkerBridge`; under Node there is no `Worker`
 * global and no duckdb-wasm, so this module supplies the same surface over
 * native DuckDB. The pipeline path touches exactly five members — `query`,
 * `loadData`, `exportToBuffer`, `clearQueryCache`, `dropTable` — and nothing
 * else needs implementing. `WorkerBridge` is a nominal class with private
 * fields, so the facade is force-cast (the house cast: see
 * `tests/unit/pipeline/pipeline.test.ts`).
 *
 * Import rule (architecture.md §2): this module may import `src/core/**` and
 * npm packages only, and nothing under `src/app/` or `src/ui/` may import it.
 * `HEADLESS_MARKER` below is what the bundle gate greps for to prove that.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ProgressCallback, WorkerBridge } from '@jeyabbalas/data-table';
import { quoteIdentifier } from '../core/sql-identifier';

/**
 * Leak sentinel for `scripts/check-bundle-size.mjs`: a string that exists in
 * the headless graph and nowhere in app code, so a stray static import from
 * `src/app/` or `src/ui/` fails the bundle gate loudly instead of quietly
 * growing the entry chunk. Do not reword it without updating the script.
 */
export const HEADLESS_MARKER = 'quac-headless-runtime';

export interface NodeBridgeHandle {
  bridge: WorkerBridge;
  close: () => Promise<void>;
}

/**
 * Browser-parity value normalization (data-table's worker does the same with
 * `convertBigInts`): `getRowObjectsJS()` still hands back JS `bigint` for
 * BIGINT columns, and the engine's SQL boundaries expect plain numbers.
 * Recursive so LIST/STRUCT payloads are covered too; `Date` and `Uint8Array`
 * are values, not containers, and pass through untouched.
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (
    value !== null &&
    typeof value === 'object' &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  ) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) out[key] = normalizeValue(inner);
    return out;
  }
  return value;
}

const sqlLiteral = (path: string): string => `'${path.replaceAll("'", "''")}'`;

/**
 * One in-memory DuckDB instance + one connection, plus a private temp dir for
 * the `loadData` route. `close()` releases all three; callers own it (the
 * headless runner closes in a `finally`).
 */
export async function createNodeBridge(): Promise<NodeBridgeHandle> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection: DuckDBConnection = await instance.connect();
  const tempDir = await mkdtemp(join(tmpdir(), 'quac-headless-'));
  let loadSeq = 0;

  async function query<T = Record<string, unknown>>(
    sql: string,
    signal?: AbortSignal,
  ): Promise<T[]> {
    // V12: cancellation is a per-call AbortSignal, not a bridge-level cancel.
    // The pre-check is the reliable half; `interrupt()` is best effort, and the
    // rules engine deliberately passes no signal so its cleanup always runs.
    if (signal?.aborted === true) throw new Error('The operation was aborted');
    const onAbort = (): void => {
      try {
        connection.interrupt();
      } catch {
        /* the connection may already be closed */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRowObjectsJS().map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = normalizeValue(value);
        return out as T;
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function dropTable(tableName: string): Promise<void> {
    await query(`DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`);
  }

  /**
   * node-api has no buffer registration, so the bytes go to a temp file that a
   * single-file scan reads back. `__rowid__` must be physical file order (the
   * `data-table-api.md` §3 contract ingest depends on): `preserve_insertion_order`
   * defaults true, so `row_number()` over a single-file `read_json` IS file
   * order, and parquet gets it exactly from `file_row_number`.
   */
  async function loadData(
    source: ArrayBuffer | string,
    options: { format: string; tableName?: string },
    onProgress?: ProgressCallback,
  ): Promise<{ tableName: string; rowCount: number; columns: string[]; schema: never[] }> {
    const table = options.tableName ?? 'data_table';
    const bytes =
      typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(new Uint8Array(source));
    const isParquet = options.format === 'parquet';
    if (!isParquet && options.format !== 'json') {
      throw new Error(`nodeBridge.loadData: unsupported format '${options.format}'`);
    }
    const path = join(tempDir, `load-${String(loadSeq++)}.${isParquet ? 'parquet' : 'json'}`);
    await writeFile(path, bytes);
    try {
      const file = sqlLiteral(path);
      const target = quoteIdentifier(table);
      await query(
        isParquet
          ? `CREATE OR REPLACE TABLE ${target} AS ` +
              `SELECT CAST(file_row_number AS BIGINT) AS "__rowid__", * EXCLUDE (file_row_number) ` +
              `FROM read_parquet(${file}, file_row_number=true)`
          : `CREATE OR REPLACE TABLE ${target} AS ` +
              `SELECT CAST(row_number() OVER () - 1 AS BIGINT) AS "__rowid__", * ` +
              `FROM read_json(${file})`,
      );
      const described = await query<{ column_name: string }>(`DESCRIBE ${target}`);
      const [counted] = await query<{ n: number }>(`SELECT count(*) AS n FROM ${target}`);
      onProgress?.({ stage: 'reading', percent: 100, cancelable: false });
      return {
        tableName: table,
        rowCount: counted?.n ?? 0,
        // `__rowid__` included, exactly as the wasm loaders report it; ingest
        // filters it out itself.
        columns: described.map((c) => c.column_name),
        schema: [],
      };
    } finally {
      await rm(path, { force: true });
    }
  }

  const facade = {
    query,
    loadData,
    dropTable,
    clearQueryCache(): void {
      // node-api has no cross-statement SELECT cache, so V2's post-DML
      // invalidation has nothing to invalidate (house precedent:
      // tests/unit/schema/duckdb.ts).
    },
    exportToBuffer(): Promise<Uint8Array> {
      // Unreachable: the headless pipeline stubs the `exportDisplay` executor,
      // which is the only caller (there is no grid to feed).
      return Promise.reject(
        new Error(`exportToBuffer is not available in the ${HEADLESS_MARKER}`),
      );
    },
  };

  return {
    bridge: facade as unknown as WorkerBridge,
    close: async (): Promise<void> => {
      try {
        connection.closeSync();
      } catch {
        /* already closed */
      }
      try {
        instance.closeSync();
      } catch {
        /* already closed */
      }
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
