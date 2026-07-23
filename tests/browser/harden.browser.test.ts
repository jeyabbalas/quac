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

// ---- P12 extension: rules execute AGAINST the hardened bridge -------------
// (Appended after the V6 pins — they share this bridge and its seeded tables;
// runQC only creates quac_work + the data view, never touching quac_typed or
// the pre/post_harden tables. The full corrections-parity manifest lives in
// rulesExec.browser.test.ts on its own bridge.)

test('P12: a rule reaching for https breaks locally; corrections still mutate hardened', async () => {
  const { createBridgeRunner, runQC } = await import('../../src/core/rules/engine');
  const base = {
    ruleScope: 'row' as const,
    targetVariables: ['val'],
    updateLanguage: 'sql' as const,
    severity: 'info' as const,
    comment: 'Hardened-run probe.',
    enabled: true,
    sourceFile: 'inline.quac.csv',
    extras: {},
  };
  const files = [
    {
      name: 'inline.quac.csv',
      group: 'inline',
      extraColumns: [],
      rules: [
        {
          ...base,
          ruleId: 'X_LEAK',
          ruleType: 'validate' as const,
          ruleScope: 'dataset' as const,
          targetVariables: [],
          condition: "SELECT * FROM read_csv('https://example.invalid/leak.csv')",
          updateExpression: '',
          severity: 'error' as const,
          rowNumber: 1,
        },
        {
          ...base,
          ruleId: 'X_FIX',
          ruleType: 'correct' as const,
          condition: "val = 'keep'",
          updateExpression: "'kept'",
          rowNumber: 2,
        },
      ],
    },
  ];

  const { flags, perRule, correctedCells } = await runQC(createBridgeRunner(b()), files);

  // The https read died INSIDE the worker (no network-layer error), the rule
  // is broken, and the run continued.
  const leak = perRule.find((s) => s.ruleId === 'X_LEAK');
  expect(leak?.status).toBe('broken');
  expect(leak?.error).not.toMatch(/XMLHttpRequest|NetworkError/);
  const leakFlag = flags.find((f) => f.ruleId === 'X_LEAK');
  expect(leakFlag?.message).toMatch(/^Rule failed to execute: /);

  // The correction path works fully hardened: capture + CTAS swap + flags.
  expect(perRule.find((s) => s.ruleId === 'X_FIX')).toMatchObject({
    status: 'ok',
    changedCells: 1,
  });
  expect(correctedCells).toBe(1);
  expect(flags.find((f) => f.ruleId === 'X_FIX')?.correction).toEqual({
    before: 'keep',
    after: 'kept',
  });
  expect(await b().query('SELECT val FROM quac_work')).toEqual([{ val: 'kept' }]);
});
