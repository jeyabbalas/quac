/**
 * Nested and JSON values out of DuckDB, as JSON text.
 *
 * A LIST, STRUCT, MAP or JSON value does not survive the trip out of DuckDB
 * intact by the ordinary row read. data-table's `bridge.query` documents what
 * Arrow loses inside one — a DATE arrives as epoch milliseconds, a HUGEINT or
 * DECIMAL as a meaningless number, a MAP's DECIMAL keys as their digits — and
 * @duckdb/node-api returns value classes of its own, so the browser and the
 * CLI would each show a different value. `CAST(to_json(c) AS VARCHAR)` is
 * exact on both: dates and UUIDs as their text, every digit of a 128-bit
 * integer, a JSON value as itself. Every read of row values that leaves DuckDB
 * for people to look at — the Excel report, the Load preview, a rule's
 * finding, a JavaScript correction's input — goes through it.
 *
 * Pure and dependency-light: no bridge import, so the rules engine, the
 * report writer and the headless runner can all share it.
 */
import { readsAsJson } from './duckdb-type';
import { quoteIdentifier } from './sql-identifier';

/** `CAST(to_json(expr) AS VARCHAR)` — the exact JSON text of a nested or JSON value. */
export const toJsonText = (expr: string): string => `CAST(to_json(${expr}) AS VARCHAR)`;

/** The nested and JSON columns among a `DESCRIBE`'s name → type map. */
export function nestedColumnsOf(types: ReadonlyMap<string, string>): Set<string> {
  const nested = new Set<string>();
  for (const [name, type] of types) if (readsAsJson(type)) nested.add(name);
  return nested;
}

/** `"c"`, or `CAST(to_json("c") AS VARCHAR) AS "c"` for a nested column. */
export function selectColumn(name: string, nested: ReadonlySet<string>, qualifier?: string): string {
  const quoted = quoteIdentifier(name);
  const ref = qualifier === undefined ? quoted : `${qualifier}.${quoted}`;
  return nested.has(name) ? `${toJsonText(ref)} AS ${quoted}` : ref;
}

/**
 * The `REPLACE (…)` clause that reads every listed nested column of a `*` as
 * JSON text — `''` when there are none, so a flat dataset's SQL is unchanged
 * byte for byte.
 */
export function nestedReplaceClause(nested: Iterable<string>): string {
  const parts = [...nested].map((name) => {
    const quoted = quoteIdentifier(name);
    return `${toJsonText(quoted)} AS ${quoted}`;
  });
  return parts.length === 0 ? '' : ` REPLACE (${parts.join(', ')})`;
}

/** A private-use marker no `to_json` output contains, standing in for a non-finite token. */
export const NON_FINITE_MARK = 'quac-non-finite:';

/**
 * `to_json` text with each bare `NaN` / `Infinity` / `-Infinity` (outside
 * strings, in any letter case, `inf` too) — what DuckDB writes for a
 * non-finite DOUBLE, and what `JSON.parse` rejects — turned into a marker
 * string `JSON.parse` accepts.
 */
export function markNonFinite(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    // DuckDB's to_json writes `NaN` / `Infinity`; its JSON cast keeps the
    // text a CSV cell gave it, so `nan`, `inf` and `-INF` arrive here too.
    const token = /^(-?(?:infinity|inf|nan))/i.exec(text.slice(i, i + 9))?.[1];
    if (token !== undefined) {
      out += JSON.stringify(NON_FINITE_MARK + token);
      i += token.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Marker strings back to null, in place. */
function clearMarks(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith(NON_FINITE_MARK) ? null : value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = clearMarks(value[i]);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const next = clearMarks(record[key]);
      if (next !== record[key]) {
        Object.defineProperty(record, key, { value: next, writable: true, enumerable: true, configurable: true });
      }
    }
  }
  return value;
}

/**
 * Parse `to_json` text back into a value — the value as the source JSON held
 * it. A NaN or ±Infinity reads as null (JSON has no word for one); an integer
 * past 2^53 as the nearest number, as a BIGINT does at every other boundary.
 */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return clearMarks(JSON.parse(markNonFinite(text)) as unknown);
  }
}

/** In place: every listed column of every row, parsed from its JSON text. */
export function parseNestedColumns(
  rows: readonly Record<string, unknown>[],
  columns: ReadonlySet<string>,
): void {
  if (columns.size === 0) return;
  for (const row of rows) {
    for (const column of columns) {
      const text = row[column];
      if (typeof text === 'string') row[column] = parseJsonText(text);
    }
  }
}
