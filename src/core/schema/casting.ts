/**
 * Schema-driven casting into `quac_typed` (json-schema-subsystem.md §C.1/§C.2).
 *
 * A failed cast is itself a QC finding: TRY_CAST leaves NULL where the raw
 * text is not representable, and the cast-failure scan turns exactly those
 * cells into `schema:prop:<col>:cast` flags + the `castFailures` set the
 * translator consults (one flag per bad cell, Ajv errors suppressed).
 *
 * Integer ladder deviation from the §C.1 prose (Verified fact V19): DuckDB
 * 1.5.x TRY_CAST rounds decimal strings to integers ('42.5' → 43, '0.1' → 0),
 * so the spec's leading `TRY_CAST(raw AS BIGINT)` silently corrupts
 * non-integral values instead of flagging them. The shipped ladder gates on
 * DOUBLE-integrality first and only then converts, keeping exact int64
 * precision via the BIGINT branch for values beyond 2^53.
 */
import { quoteIdentifier } from '@jeyabbalas/data-table';
import { QUAC_RAW, QUAC_TYPED } from '../bridge/tables';
import { schemaPropRuleId } from './rule-ids';
import { castNonIntegralMessage, castNonNumericMessage } from './translator';
import type { QCFlag } from '../flags/flag';
import type { ColumnMeta } from './column-meta';
import type { StorageType } from './value-spec';

/**
 * Minimal SQL surface the casting layer needs. Structurally satisfied by
 * both the WorkerBridge (browser) and the @duckdb/node-api test adapter —
 * deliberately NOT the rules engine's SQLRunner import (parallel-phase
 * decoupling; the shapes are compatible).
 */
export interface SqlRunner {
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Present on the bridge (V2: SELECT cache survives DDL/DML); optional for node. */
  clearQueryCache?: () => void;
}

export interface ColumnCast {
  column: string;
  /** Target storage for schema columns; nominal VARCHAR for extras. */
  storageType: StorageType;
  mixed: boolean;
  castExpr: string;
  /** True when the expression can never turn non-empty text into NULL (scan-exempt). */
  passthrough: boolean;
  inSchema: boolean;
}

export interface CastPlan {
  columns: ColumnCast[];
  /** CREATE OR REPLACE TABLE quac_typed AS SELECT __row__, <casts> FROM quac_raw */
  sql: string;
}

export interface CastScanResult {
  flags: QCFlag[];
  /** Keys `${row} ${column}` — consulted by the translator (§C.2). */
  castFailures: Set<string>;
}

/** `DESCRIBE quac_raw` → column name → DuckDB type (parameters stripped), `__row__` excluded. */
export async function describeColumns(
  runner: SqlRunner,
  table: string = QUAC_RAW,
): Promise<Map<string, string>> {
  const rows = await runner.query<{ column_name: string; column_type: string }>(
    `DESCRIBE ${quoteIdentifier(table)}`,
  );
  const types = new Map<string, string>();
  for (const row of rows) {
    if (row.column_name === '__row__') continue;
    types.set(row.column_name, row.column_type.replace(/\(.*$/, '').toUpperCase());
  }
  return types;
}

/** Integer types that widen into BIGINT without any possibility of failure. */
const BIGINT_SAFE = new Set(['TINYINT', 'SMALLINT', 'INTEGER', 'UTINYINT', 'USMALLINT', 'UINTEGER']);
/** Numeric types that convert into DOUBLE without any possibility of failure. */
const DOUBLE_SAFE = new Set([
  'FLOAT',
  'REAL',
  'DOUBLE',
  'DECIMAL',
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'HUGEINT',
]);

/** §C.1 integer ladder over a VARCHAR expression (see module note / V19). */
function integerLadder(src: string): string {
  const dbl = `TRY_CAST(${src} AS DOUBLE)`;
  return (
    `CASE WHEN ${dbl} IS NULL THEN NULL ` +
    `WHEN NOT isfinite(${dbl}) THEN NULL ` +
    `WHEN ${dbl} != trunc(${dbl}) THEN NULL ` +
    `ELSE COALESCE(TRY_CAST(${src} AS BIGINT), TRY_CAST(${dbl} AS BIGINT)) END`
  );
}

function castExprFor(
  quoted: string,
  target: StorageType,
  mixed: boolean,
  rawType: string,
): { castExpr: string; passthrough: boolean } {
  const asVarchar = rawType === 'VARCHAR' ? quoted : `CAST(${quoted} AS VARCHAR)`;
  if (mixed || target === 'VARCHAR') {
    // String targets never fail; CAST-to-VARCHAR exists for every DuckDB type.
    return { castExpr: asVarchar, passthrough: true };
  }
  if (target === 'BIGINT') {
    if (rawType === 'BIGINT') return { castExpr: quoted, passthrough: true };
    if (BIGINT_SAFE.has(rawType)) {
      return { castExpr: `CAST(${quoted} AS BIGINT)`, passthrough: true };
    }
    return { castExpr: integerLadder(asVarchar), passthrough: false };
  }
  if (target === 'DOUBLE') {
    if (rawType === 'DOUBLE') return { castExpr: quoted, passthrough: true };
    if (DOUBLE_SAFE.has(rawType)) {
      return { castExpr: `CAST(${quoted} AS DOUBLE)`, passthrough: true };
    }
    return { castExpr: `TRY_CAST(${asVarchar} AS DOUBLE)`, passthrough: false };
  }
  // BOOLEAN
  if (rawType === 'BOOLEAN') return { castExpr: quoted, passthrough: true };
  return { castExpr: `TRY_CAST(${asVarchar} AS BOOLEAN)`, passthrough: false };
}

/**
 * Derive the per-column cast plan (§C.1): dataset columns in file order;
 * schema columns get their ColumnMeta storage target, extras pass through
 * with their native type kept (the rules engine targets them via `data`;
 * the spec's "VARCHAR passthrough" row described all-VARCHAR delimited raw,
 * where passthrough and VARCHAR coincide).
 */
export function buildCastPlan(
  meta: readonly ColumnMeta[],
  datasetColumns: readonly string[],
  rawTypes: ReadonlyMap<string, string>,
): CastPlan {
  const byName = new Map(meta.map((m) => [m.name, m]));
  const columns: ColumnCast[] = datasetColumns.map((name) => {
    const quoted = quoteIdentifier(name);
    const rawType = rawTypes.get(name) ?? 'VARCHAR';
    const m = byName.get(name);
    if (m === undefined) {
      return {
        column: name,
        storageType: 'VARCHAR',
        mixed: false,
        castExpr: quoted,
        passthrough: true,
        inSchema: false,
      };
    }
    const { castExpr, passthrough } = castExprFor(quoted, m.storageType, m.mixed, rawType);
    return {
      column: name,
      storageType: m.storageType,
      mixed: m.mixed,
      castExpr,
      passthrough,
      inSchema: true,
    };
  });
  const selectList = columns
    .map((c) =>
      c.castExpr === quoteIdentifier(c.column)
        ? c.castExpr
        : `${c.castExpr} AS ${quoteIdentifier(c.column)}`,
    )
    .join(', ');
  const sql =
    `CREATE OR REPLACE TABLE ${quoteIdentifier(QUAC_TYPED)} AS ` +
    `SELECT __row__, ${selectList} FROM ${quoteIdentifier(QUAC_RAW)} ORDER BY __row__`;
  return { columns, sql };
}

/** Execute the CTAS; the SELECT cache must be cleared afterwards (V2). */
export async function applyCastPlan(runner: SqlRunner, plan: CastPlan): Promise<void> {
  await runner.query(plan.sql);
  runner.clearQueryCache?.();
}

/** How many columns to scan per UNION ALL statement (keeps statements bounded). */
const SCAN_CHUNK = 40;

const CAST_NOUN: Record<StorageType, string> = {
  BIGINT: 'integer',
  DOUBLE: 'number',
  BOOLEAN: 'true/false value',
  VARCHAR: 'value', // unreachable: VARCHAR targets are passthrough
};

interface ScanHit {
  row: number | bigint;
  col: string;
  raw: string;
  numeric_like: boolean;
}

/**
 * §C.2 cast-failure scan: one pass over the non-passthrough columns
 * returning `(row, rawValue)` where the raw text is non-empty but the typed
 * cell is NULL. Raw values are read through CAST(… AS VARCHAR) when the raw
 * column is not VARCHAR — trim() on DOUBLE/DATE is a binder error.
 */
export async function scanCastFailures(
  runner: SqlRunner,
  plan: CastPlan,
  ordinalByName: ReadonlyMap<string, number>,
): Promise<CastScanResult> {
  const scanned = plan.columns.filter((c) => !c.passthrough);
  const hits: ScanHit[] = [];
  for (let i = 0; i < scanned.length; i += SCAN_CHUNK) {
    const chunk = scanned.slice(i, i + SCAN_CHUNK);
    const parts = chunk.map((c) => {
      const quoted = quoteIdentifier(c.column);
      const rawv = `CAST(r.${quoted} AS VARCHAR)`;
      const dbl = `TRY_CAST(${rawv} AS DOUBLE)`;
      const literal = c.column.replace(/'/g, "''");
      return (
        `SELECT r.__row__ AS row, '${literal}' AS col, ${rawv} AS raw, ` +
        `(${dbl} IS NOT NULL AND isfinite(${dbl})) AS numeric_like ` +
        `FROM ${quoteIdentifier(QUAC_RAW)} r JOIN ${quoteIdentifier(QUAC_TYPED)} t USING (__row__) ` +
        `WHERE r.${quoted} IS NOT NULL AND trim(${rawv}) <> '' AND t.${quoted} IS NULL`
      );
    });
    hits.push(...(await runner.query<ScanHit>(parts.join(' UNION ALL '))));
  }

  const storageByName = new Map(plan.columns.map((c) => [c.column, c.storageType]));
  const ordinal = (col: string): number => ordinalByName.get(col) ?? Number.MAX_SAFE_INTEGER;
  hits.sort((a, b) => Number(a.row) - Number(b.row) || ordinal(a.col) - ordinal(b.col));

  const flags: QCFlag[] = [];
  const castFailures = new Set<string>();
  for (const hit of hits) {
    const row = Number(hit.row);
    const storage = storageByName.get(hit.col) ?? 'VARCHAR';
    const message =
      storage === 'BIGINT' && hit.numeric_like
        ? castNonIntegralMessage(hit.raw)
        : castNonNumericMessage(hit.raw, CAST_NOUN[storage]);
    flags.push({
      source: 'schema',
      ruleId: schemaPropRuleId(hit.col, 'cast'),
      scope: 'cell',
      row,
      column: hit.col,
      severity: 'error',
      message,
      value: hit.raw,
    });
    castFailures.add(`${String(row)} ${hit.col}`);
  }
  return { flags, castFailures };
}
