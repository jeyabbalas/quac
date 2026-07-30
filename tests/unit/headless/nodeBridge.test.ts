/**
 * headless.md §2 — the node-api facade's conformance to the WorkerBridge
 * contract the QC engine relies on, plus §2's harden parity.
 *
 * These are the Node-side twins of the P03 browser spike assertions that live
 * on in `tests/browser/bridge.browser.test.ts`: result shapes (V13), the
 * `__rowid__`-is-file-order guarantee ingest depends on, and the cache/abort
 * semantics. What the browser proved on duckdb-wasm, this proves on native
 * DuckDB — the two engines must agree or the parity manifests diverge.
 */
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createNodeBridge, HEADLESS_MARKER } from '../../../src/headless/nodeBridge';
import { nodeHarden } from '../../../src/headless/harden';
import type { NodeBridgeHandle } from '../../../src/headless/nodeBridge';

let handle: NodeBridgeHandle;
const b = (): NodeBridgeHandle['bridge'] => handle.bridge;

const utf8 = (text: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

beforeEach(async () => {
  handle = await createNodeBridge();
});

afterEach(async () => {
  await handle.close();
});

describe('query: result shapes (V13 parity on node-api)', () => {
  test('DDL returns an empty array; DML returns a count row', async () => {
    expect(await b().query('CREATE TABLE t (a INTEGER)')).toEqual([]);

    const inserted = await b().query<{ Count: number }>('INSERT INTO t VALUES (1), (2), (3)');
    expect(inserted).toHaveLength(1);
    expect(Number(inserted[0]?.Count)).toBe(3);

    const deleted = await b().query<{ Count: number }>('DELETE FROM t WHERE a > 1');
    expect(Number(deleted[0]?.Count)).toBe(2);

    expect(await b().query('DROP TABLE t')).toEqual([]);
  });

  test('SELECT returns plain row objects keyed by column name', async () => {
    const rows = await b().query("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2, 'y' ORDER BY a");
    expect(rows).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ]);
  });
});

describe('query: bigint normalization (data-table convertBigInts parity)', () => {
  test('a top-level BIGINT comes back as a JS number', async () => {
    const [row] = await b().query<{ n: unknown }>('SELECT 42::BIGINT AS n');
    expect(typeof row?.n).toBe('number');
    expect(row?.n).toBe(42);
  });

  test('BIGINTs nested in LIST and STRUCT are normalized too', async () => {
    const [row] = await b().query<{ l: unknown; s: unknown; deep: unknown }>(
      "SELECT [1::BIGINT, 2::BIGINT] AS l, {'a': 3::BIGINT} AS s, " +
        "{'inner': [{'v': 4::BIGINT}]} AS deep",
    );
    expect(row?.l).toEqual([1, 2]);
    expect(row?.s).toEqual({ a: 3 });
    expect(row?.deep).toEqual({ inner: [{ v: 4 }] });
  });

  test('NULL, DATE and BLOB values survive normalization unchanged', async () => {
    const [row] = await b().query<{ nothing: unknown; d: unknown; blob: unknown }>(
      "SELECT NULL AS nothing, DATE '2020-01-02' AS d, 'ab'::BLOB AS blob",
    );
    expect(row?.nothing).toBeNull();
    expect(row?.d).toBeInstanceOf(Date);
    expect(row?.blob).toBeInstanceOf(Uint8Array);
  });
});

describe('loadData: __rowid__ is physical file order', () => {
  test('a JSON array lands in file order with __rowid__ 0..n-1', async () => {
    // Deliberately NOT sorted by any column: the only thing that can produce
    // this order is the file itself.
    const payload = JSON.stringify([{ v: 'c' }, { v: 'a' }, { v: 'b' }]);
    const result = await b().loadData(utf8(payload), { format: 'json', tableName: 'j' });

    expect(result.tableName).toBe('j');
    expect(result.rowCount).toBe(3);
    // `__rowid__` is REPORTED (ingest filters it out itself) — the wasm loaders
    // do the same, and ctasRawFromTmp relies on it being in the list.
    expect(result.columns).toEqual(['__rowid__', 'v']);

    const rows = await b().query<{ __rowid__: number; v: string }>(
      'SELECT __rowid__, v FROM j ORDER BY __rowid__',
    );
    expect(rows).toEqual([
      { __rowid__: 0, v: 'c' },
      { __rowid__: 1, v: 'a' },
      { __rowid__: 2, v: 'b' },
    ]);
  });

  test('a parquet file lands in file order via file_row_number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quac-bridge-test-'));
    const path = join(dir, 'ordered.parquet');
    try {
      await b().query(
        `COPY (SELECT * FROM (VALUES ('c'), ('a'), ('b')) AS t(v)) ` +
          `TO '${path}' (FORMAT PARQUET)`,
      );
      const bytes = await readFile(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

      const result = await b().loadData(buffer, { format: 'parquet', tableName: 'p' });
      expect(result.rowCount).toBe(3);
      expect(result.columns).toEqual(['__rowid__', 'v']);

      const rows = await b().query<{ __rowid__: number; v: string }>(
        'SELECT __rowid__, v FROM p ORDER BY __rowid__',
      );
      expect(rows).toEqual([
        { __rowid__: 0, v: 'c' },
        { __rowid__: 1, v: 'a' },
        { __rowid__: 2, v: 'b' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a string source is accepted (the ingest wrapped-JSON route)', async () => {
    const result = await b().loadData('[{"j":"{\\"c0\\":\\"7\\"}"}]', {
      format: 'json',
      tableName: 'w',
    });
    expect(result.rowCount).toBe(1);
    const [row] = await b().query<{ c0: string }>("SELECT json_extract_string(j, '$.c0') AS c0 FROM w");
    expect(row?.c0).toBe('7');
  });

  test('an unsupported format is refused', async () => {
    await expect(b().loadData(utf8('a,b\n1,2'), { format: 'csv', tableName: 'x' })).rejects.toThrow(
      /unsupported format 'csv'/,
    );
  });
});

describe('the remaining three members', () => {
  test('clearQueryCache is a no-op (node-api has no SELECT cache)', async () => {
    await b().query('CREATE TABLE cached AS SELECT 1 AS a');
    expect(await b().query<{ a: number }>('SELECT a FROM cached')).toEqual([{ a: 1 }]);
    b().clearQueryCache();
    await b().query('UPDATE cached SET a = 9');
    // Nothing to invalidate: node-api reads through to the table every time,
    // so V2's post-DML clear is vacuous here rather than load-bearing.
    expect(await b().query<{ a: number }>('SELECT a FROM cached')).toEqual([{ a: 9 }]);
  });

  test('dropTable removes the table and is idempotent', async () => {
    await b().query('CREATE TABLE gone (a INTEGER)');
    await b().dropTable('gone');
    await b().dropTable('gone');
    const [row] = await b().query<{ n: number }>(
      "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'gone'",
    );
    expect(Number(row?.n)).toBe(0);
  });

  test('dropTable quotes the identifier', async () => {
    await b().query('CREATE TABLE "odd name" (a INTEGER)');
    await b().dropTable('odd name');
    const [row] = await b().query<{ n: number }>(
      "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'odd name'",
    );
    expect(Number(row?.n)).toBe(0);
  });

  test('exportToBuffer rejects — the headless pipeline stubs exportDisplay', async () => {
    await expect(b().exportToBuffer('SELECT 1', 'parquet')).rejects.toThrow(HEADLESS_MARKER);
  });
});

describe('abort (V12: per-call AbortSignal, no bridge.cancel)', () => {
  test('a pre-aborted signal rejects before the statement runs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(b().query('CREATE TABLE never_made (a INTEGER)', controller.signal)).rejects.toThrow(
      /aborted/i,
    );
    const [row] = await b().query<{ n: number }>(
      "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'never_made'",
    );
    expect(Number(row?.n)).toBe(0);
  });

  test('a live signal that never fires leaves the query untouched', async () => {
    const controller = new AbortController();
    const rows = await b().query<{ a: number }>('SELECT 1 AS a', controller.signal);
    expect(rows).toEqual([{ a: 1 }]);
    // The listener must be removed in `finally`, or every query would leak one
    // and a later abort would interrupt an unrelated statement.
    controller.abort();
    expect(await b().query<{ a: number }>('SELECT 2 AS a')).toEqual([{ a: 2 }]);
  });
});

describe('nodeHarden (headless.md §2 harden parity)', () => {
  test('external access is off afterwards and table-only SQL still works', async () => {
    await b().query('CREATE TABLE kept AS SELECT 1 AS a');
    await nodeHarden(b());

    const [setting] = await b().query<{ value: string }>(
      "SELECT current_setting('enable_external_access') AS value",
    );
    expect(String(setting?.value)).toBe('false');

    const [autoload] = await b().query<{ value: string }>(
      "SELECT current_setting('autoload_known_extensions') AS value",
    );
    expect(String(autoload?.value)).toBe('false');

    // Everything the pipeline does after prepare is table-only, and must survive.
    expect(await b().query<{ a: number }>('SELECT a FROM kept')).toEqual([{ a: 1 }]);
    await b().query('CREATE OR REPLACE TABLE kept AS SELECT a + 1 AS a FROM kept');
    expect(await b().query<{ a: number }>('SELECT a FROM kept')).toEqual([{ a: 2 }]);
  });

  test('a hardened connection refuses to read the filesystem', async () => {
    await nodeHarden(b());
    await expect(b().query("SELECT * FROM read_json('/etc/hosts')")).rejects.toThrow();
  });

  test('hardening twice is safe (the setting is one-way per instance)', async () => {
    await nodeHarden(b());
    await expect(nodeHarden(b())).resolves.toBeUndefined();
  });
});
