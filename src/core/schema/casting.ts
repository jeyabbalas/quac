/**
 * Schema-driven casting into `quac_typed` (json-schema-subsystem.md §C.1) —
 * the typed columns the QC RULES see: `age > 18` works on a CSV column once
 * it is a BIGINT. Validation never reads these casts (§C.0): DuckDB's casts
 * are lenient (`yes` is true, `1_000` is 1000, ` 42 ` is 42), and the
 * validator judges the dataset's own values — a text cell's text, read by
 * text-cells.ts, which turns a cell that spells no value of the schema's type
 * into a cast finding.
 *
 * Integer ladder deviation from the §C.1 prose (Verified fact V19): DuckDB
 * 1.5.x TRY_CAST rounds decimal strings to integers ('42.5' → 43, '0.1' → 0),
 * so the spec's leading `TRY_CAST(raw AS BIGINT)` silently corrupts
 * non-integral values instead of leaving them NULL. The shipped ladder gates
 * on DOUBLE-integrality first and only then converts, keeping exact int64
 * precision via the BIGINT branch for values beyond 2^53.
 */
import { QUAC_RAW, QUAC_TYPED } from '../bridge/tables';
import { duckTypeBase, readsAsJson } from '../duckdb-type';
import { quoteIdentifier } from '../sql-identifier';
import type { ColumnMeta } from './column-meta';
import type { StorageType } from './value-spec';

/**
 * Minimal SQL surface the casting layer needs. Structurally satisfied by
 * both the WorkerBridge (browser) and the @duckdb/node-api test adapter —
 * deliberately NOT the rules engine's SQLRunner import (parallel-phase
 * decoupling; the shapes are compatible).
 */
export interface SqlRunner {
  query<T = Record<string, unknown>>(sql: string, signal?: AbortSignal): Promise<T[]>;
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
  /**
   * What a `JSON` target holds — `an array`, `an object` or `an array or an
   * object` — for the message when a text cell does not parse.
   */
  jsonShape?: string;
}

export interface CastPlan {
  columns: ColumnCast[];
  /** CREATE OR REPLACE TABLE quac_typed AS SELECT __row__, <casts> FROM quac_raw */
  sql: string;
}

/**
 * `DESCRIBE quac_raw` → column name → DuckDB type, `__row__` excluded. The
 * type is DuckDB's whole text (`DECIMAL(10,2)`, `STRUCT(x DOUBLE)[]`): read it
 * with `core/duckdb-type` — `duckTypeBase` for the scalar name the casting
 * ladder compares against. Stripping parameters off the text, as this once
 * did, read `DECIMAL(10,2)[]` as `DECIMAL` and a list of structs as `STRUCT`.
 */
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
    types.set(row.column_name, row.column_type);
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
  rawTypeText: string,
): { castExpr: string; passthrough: boolean } {
  // A nested or JSON column keeps the type the dataset gave it, whatever the
  // schema says: the validator reads it as JSON and judges its shape itself,
  // so a list where the schema wants a number is a type finding with the list
  // in it, not a cast failure on DuckDB's text for it — and the rules still
  // get a list to call list functions on. Casting one to VARCHAR (as a
  // mixed or string target once did) turned every nested cell into a string
  // the schema then rejected, and took nested rendering from the grids.
  if (readsAsJson(rawTypeText)) return { castExpr: quoted, passthrough: true };
  const rawType = duckTypeBase(rawTypeText);
  const asVarchar = rawType === 'VARCHAR' ? quoted : `CAST(${quoted} AS VARCHAR)`;
  if (target === 'JSON') {
    // Text holding JSON — a CSV, TSV or Excel cell with `[1, 2, 3]` in it —
    // becomes DuckDB's JSON type, and text that does not parse is a cast
    // finding. Any other scalar keeps its type: an array schema over a number
    // column is a type finding Ajv names.
    if (rawType === 'VARCHAR') return { castExpr: `TRY_CAST(${quoted} AS JSON)`, passthrough: false };
    return { castExpr: quoted, passthrough: true };
  }
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

function jsonShapeOf(meta: ColumnMeta): string {
  const array = meta.jsonTypes.has('array');
  const object = meta.jsonTypes.has('object');
  if (array && object) return 'an array or an object';
  return object ? 'an object' : 'an array';
}

/**
 * Derive the per-column cast plan (§C.1): dataset columns in file order;
 * schema columns get their ColumnMeta storage target — a column no property
 * declares, the target of the patternProperties / additionalProperties
 * schema that covers it (`undeclared`) — and the rest pass through with their
 * native type kept (the rules engine targets them via `data`).
 */
export function buildCastPlan(
  meta: readonly ColumnMeta[],
  datasetColumns: readonly string[],
  rawTypes: ReadonlyMap<string, string>,
  undeclared: (name: string) => ColumnMeta | null = () => null,
): CastPlan {
  const byName = new Map(meta.map((m) => [m.name, m]));
  const columns: ColumnCast[] = datasetColumns.map((name) => {
    const quoted = quoteIdentifier(name);
    const rawType = rawTypes.get(name) ?? 'VARCHAR';
    const m = byName.get(name) ?? undeclared(name) ?? undefined;
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
      ...(m.storageType === 'JSON' ? { jsonShape: jsonShapeOf(m) } : {}),
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
