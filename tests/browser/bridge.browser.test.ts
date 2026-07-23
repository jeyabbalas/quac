/**
 * P03 spike regressions for Verified facts V1/V2 (architecture.md §10) plus
 * the tables.ts helper lifecycle. These tests ARE the spike: they pin the
 * bridge behaviors every later phase builds on.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { WorkerBridge } from '@jeyabbalas/data-table';
import { createBridge } from '../../src/core/bridge/bridge';
import {
  DATA_VIEW,
  QUAC_TYPED,
  QUAC_WORK,
  ctas,
  refreshDataView,
  swapWorkTable,
} from '../../src/core/bridge/tables';

let bridge: WorkerBridge | undefined;

function b(): WorkerBridge {
  if (!bridge) throw new Error('bridge not initialized');
  return bridge;
}

beforeAll(async () => {
  bridge = await createBridge();
});

afterAll(() => {
  bridge?.terminate();
});

test('V1: query() executes DDL/DML; DDL resolves [], DML resolves [{Count}]', async () => {
  await expect(b().query('CREATE TABLE v1_t (id INTEGER, name VARCHAR)')).resolves.toEqual([]);

  // DML is not resultless: DuckDB reports the affected-row count as one row.
  await expect(b().query("INSERT INTO v1_t VALUES (1, 'a'), (2, 'b')")).resolves.toEqual([
    { Count: 2 },
  ]);
  await expect(b().query("UPDATE v1_t SET name = 'z' WHERE id = 2")).resolves.toEqual([
    { Count: 1 },
  ]);
  await expect(b().query('DELETE FROM v1_t WHERE id > 99')).resolves.toEqual([{ Count: 0 }]);

  expect(await b().query('SELECT id, name FROM v1_t ORDER BY id')).toEqual([
    { id: 1, name: 'a' },
    { id: 2, name: 'z' },
  ]);

  await expect(b().query('DROP TABLE v1_t')).resolves.toEqual([]);
});

test('V2: SELECT cache serves stale rows after DML until clearQueryCache()', async () => {
  await b().query('CREATE TABLE v2_t (x INTEGER)');
  await b().query('INSERT INTO v2_t VALUES (1)');
  b().clearQueryCache();

  const sql = 'SELECT x FROM v2_t ORDER BY x';
  expect(await b().query(sql)).toEqual([{ x: 1 }]);

  await b().query('UPDATE v2_t SET x = 2');
  // The documented footgun: identical SELECT string still returns pre-mutation rows.
  expect(await b().query(sql)).toEqual([{ x: 1 }]);

  b().clearQueryCache();
  expect(await b().query(sql)).toEqual([{ x: 2 }]);
});

test('tables.ts: ctas → view → self-referential swap, caches cleared internally', async () => {
  await ctas(b(), QUAC_TYPED, "SELECT * FROM (VALUES (0, 'a'), (1, 'b')) AS t(__row__, val)");
  await ctas(b(), QUAC_WORK, `SELECT * FROM ${QUAC_TYPED}`);
  await refreshDataView(b());

  const sql = `SELECT val FROM ${DATA_VIEW} ORDER BY __row__`;
  expect(await b().query(sql)).toEqual([{ val: 'a' }, { val: 'b' }]);

  // The corrections pattern (architecture.md §6): quac_work rebuilt FROM itself.
  await swapWorkTable(b(), `SELECT __row__, upper(val) AS val FROM ${QUAC_WORK}`);

  // Identical SELECT string, no manual cache clear: helpers must have cleared it,
  // and the view must still resolve to the replaced table.
  expect(await b().query(sql)).toEqual([{ val: 'A' }, { val: 'B' }]);
});
