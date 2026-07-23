// qc_fixture — the shared @duckdb/node-api seed helpers for rules-engine node
// tests (qc-rules-engine.md §9, testing-strategy.md §3.1). Created here in P10
// for T-ASSERT-EXPANSION; P11's engine tests and P12's corrections tests import
// the same helpers. The seed data + SQL builders were extracted to
// tests/shared/qcFixtureSql.ts in P12 (pure extraction — statements unchanged)
// so the browser tier can seed the identical table through the WorkerBridge.
import { createRequire } from 'node:module';
import type { SQLRunner } from '../../../src/core/rules/types';
import { qcFixtureSetupSql } from '../../shared/qcFixtureSql';

const require = createRequire(import.meta.url);

export interface QcFixtureDb {
  runner: SQLRunner;
  close: () => void;
}

/**
 * Bare in-memory DuckDB behind the bigint→Number SQLRunner adapter, seeded by
 * running `setupSql` statements in order. `openQcFixture` delegates here;
 * engine tests also call it directly for purpose-built scratch tables
 * (tolerance/caps/wave-gap cases) that expose their own `data` view.
 */
export async function openDuckDb(setupSql: readonly string[]): Promise<QcFixtureDb> {
  const duckdb = require('@duckdb/node-api') as typeof import('@duckdb/node-api');
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  for (const sql of setupSql) {
    await conn.run(sql);
  }

  const runner: SQLRunner = {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      const reader = await conn.runAndReadAll(sql);
      const rows = reader.getRowObjects().map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] = typeof value === 'bigint' ? Number(value) : value;
        }
        return out;
      });
      return rows as T[];
    },
  };

  return {
    runner,
    close: (): void => {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

/**
 * In-memory DuckDB with the seeded `qc_fixture` table (+ injected `__row__`
 * BIGINT, 0-based file order) and the canonical view `data` over it — all rule
 * SQL targets `data` (architecture.md §4). BIGINTs come back as JS bigint from
 * @duckdb/node-api; the SQLRunner adapter normalizes bigint → Number at the
 * boundary so tests compare plain numbers.
 */
export async function openQcFixture(): Promise<QcFixtureDb> {
  return openDuckDb(qcFixtureSetupSql('qc_fixture', { dataView: true }));
}

/**
 * In-memory DuckDB with the same 16 rows seeded as `quac_typed` and NO `data`
 * view — the shape `runQC` expects: its prepare stage rebuilds `quac_work`
 * from `quac_typed` and creates the view itself (engine spec §3).
 */
export async function openQcTyped(): Promise<QcFixtureDb> {
  return openDuckDb(qcFixtureSetupSql('quac_typed'));
}
