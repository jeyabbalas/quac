/**
 * P03 spike regressions for Verified fact V6 (architecture.md §10).
 *
 * The spike's verdict: SQL-level gates are unusable in duckdb-wasm
 * (enable_external_access is one-way AND disables the COPY/loadData file ops
 * the annotate stage needs; lock_configuration breaks data-table's per-load
 * SET TimeZone; disabled_filesystems does not govern its XHR path). Hardening
 * is therefore platform-level: the generated worker prelude removes
 * XMLHttpRequest/WebSocket/EventSource and allowlists fetch to the boot .wasm
 * (scripts/copy-duckdb-assets.mjs), while hardenBridge() pre-loads the
 * in-binary parquet/json extensions and disables extension autoloading.
 * These tests pin that the network is dead INSIDE the worker while every
 * pipeline path (loadData, COPY export) stays alive after hardenBridge().
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import { hardenBridge } from '../../src/core/bridge/harden';
import { QUAC_TYPED, copyToParquetBytes, ctas } from '../../src/core/bridge/tables';
import { PARQUET_MAGIC } from './support';

let bridge: WorkerBridge | undefined;

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

beforeAll(async () => {
  bridge = await createBridge();
  // Seed both ingest paths BEFORE hardening: a registered-buffer CSV load and a table.
  await bridge.loadData('a,b\n1,x\n2,y\n', { format: 'csv', tableName: 'pre_harden_csv' });
  await ctas(bridge, QUAC_TYPED, "SELECT * FROM (VALUES (0, 'keep')) AS t(__row__, val)");
  await hardenBridge(bridge);
});

afterAll(() => {
  bridge?.terminate();
});

test('V6: https reads die inside the worker without any network attempt', async () => {
  // With XMLHttpRequest alive this surfaces as a NetworkError from XHR send();
  // the prelude removes XHR entirely, so the failure must NOT be a network-layer
  // error — the request never leaves the worker.
  const failure = await b()
    .query("SELECT * FROM read_csv('https://example.invalid/leak.csv')")
    .then(() => 'unexpectedly resolved')
    .catch((error: unknown) => String(error instanceof Error ? error.message : error));
  expect(failure).not.toBe('unexpectedly resolved');
  expect(failure).not.toMatch(/XMLHttpRequest|NetworkError/);
});

test('V6: non-vendored extensions cannot be loaded', async () => {
  // INSTALL may resolve (duckdb-wasm defers the download), but the bytes can
  // only come from the same-origin vendored repository, so LOAD must fail.
  await b()
    .query('INSTALL spatial')
    .catch(() => undefined);
  await expect(b().query('LOAD spatial')).rejects.toThrow();
});

test('V6: plain SELECTs on pre-harden tables still work', async () => {
  expect(await b().query(`SELECT count(*)::INTEGER AS n FROM ${QUAC_TYPED}`)).toEqual([{ n: 1 }]);
  expect(await b().query('SELECT count(*)::INTEGER AS n FROM pre_harden_csv')).toEqual([{ n: 2 }]);
});

test('V6: loadData() of new bytes still works post-harden (no config lock)', async () => {
  const result = await b().loadData('c\n5\n7\n', { format: 'csv', tableName: 'post_harden_csv' });
  expect(result.rowCount).toBe(2);
  expect(await b().query('SELECT count(*)::INTEGER AS n FROM post_harden_csv')).toEqual([{ n: 2 }]);
});

test('V6: the annotate sequence works post-harden (COPY export → loadData bytes)', async () => {
  const bytes = await copyToParquetBytes(b(), `SELECT val FROM ${QUAC_TYPED}`);
  expect(Array.from(bytes.subarray(0, 4))).toEqual(PARQUET_MAGIC);

  const loaded = await b().loadData(bytes.slice().buffer, {
    format: 'parquet',
    tableName: 'post_harden_display',
  });
  expect(loaded.rowCount).toBe(1);
  expect(await b().query('SELECT val FROM post_harden_display')).toEqual([{ val: 'keep' }]);
});

test('V6: hardenBridge() is idempotent across runs', async () => {
  await expect(hardenBridge(b())).resolves.toBeUndefined();
});
