/**
 * Self-contained @duckdb/node-api adapter for the schema-engine node tests
 * (SQL parity per testing-strategy §1). Mirrors tests/unit/rules/support.ts
 * deliberately WITHOUT importing it — the rules dir belongs to the parallel
 * P11 phase. BIGINTs come back as JS bigint from node-api; the adapter
 * normalizes bigint → Number so assertions compare plain numbers (production
 * code does its own normalization at every SQL boundary and never relies on
 * this).
 */
import { createRequire } from 'node:module';
import type { SqlRunner } from '../../../src/core/schema/casting';

const require = createRequire(import.meta.url);

export interface SchemaTestDb {
  runner: SqlRunner;
  close: () => void;
}

export async function openMemoryDb(): Promise<SchemaTestDb> {
  const duckdb = require('@duckdb/node-api') as typeof import('@duckdb/node-api');
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  const runner: SqlRunner = {
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
    clearQueryCache(): void {
      /* node-api has no cross-statement SELECT cache */
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

const sqlLiteral = (v: string | number | boolean | null): string =>
  v === null
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : typeof v === 'boolean'
        ? (v ? 'TRUE' : 'FALSE')
        : `'${v.replace(/'/g, "''")}'`;

/**
 * Seed `quac_raw` with `__row__` BIGINT (0-based) plus the given columns.
 * String cells against non-VARCHAR column types rely on DuckDB's implicit
 * literal casts (e.g. '2020-01-02' into DATE).
 */
export async function seedRawTable(
  runner: SqlRunner,
  columns: readonly { name: string; type: string }[],
  rows: readonly (readonly (string | number | boolean | null)[])[],
): Promise<void> {
  const colDefs = columns.map((c) => `"${c.name}" ${c.type}`).join(', ');
  await runner.query(`CREATE OR REPLACE TABLE quac_raw (__row__ BIGINT, ${colDefs})`);
  if (rows.length === 0) return;
  const values = rows
    .map((row, i) => `(${[i, ...row.map((v) => sqlLiteral(v))].join(', ')})`)
    .join(',\n');
  await runner.query(`INSERT INTO quac_raw VALUES\n${values}`);
}
