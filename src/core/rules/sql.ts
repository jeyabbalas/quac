// Pure SQL utilities for the rules engine (qc-rules-engine.md §3/§6): a
// string/comment-aware scanner, top-level-semicolon analysis, `__value__` token
// substitution, and the wrapper/builder strings the P11–P13 engine executes.
// Everything here is a pure function of its inputs — no bridge, no DOM.
import { quoteIdentifier } from '@jeyabbalas/data-table';
import type { QCRule } from './types';

// ---- scanner ----------------------------------------------------------------

interface Segment {
  code: boolean; // true = plain SQL text; false = string/identifier/comment body
  start: number;
  end: number; // exclusive
}

/** Consume a quoted region starting at `i` (opening char at sql[i]); '' / "" escape. */
function consumeQuoted(sql: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql.charAt(j) === quote) {
      if (sql.charAt(j + 1) === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  return sql.length; // unterminated: swallow to EOF
}

/**
 * Split SQL into code and non-code segments. Non-code: 'strings' ('' escape),
 * "quoted identifiers" ("" escape), -- line comments (terminating newline stays
 * code), /* block comments *\/ (nested, per DuckDB/Postgres), and $tag$ dollar
 * quotes. Unterminated regions swallow to EOF.
 */
function scanSegments(sql: string): Segment[] {
  const segs: Segment[] = [];
  const n = sql.length;
  let i = 0;
  let codeStart = 0;
  const closeCode = (end: number): void => {
    if (end > codeStart) segs.push({ code: true, start: codeStart, end });
  };
  const nonCode = (start: number, end: number): void => {
    closeCode(start);
    segs.push({ code: false, start, end });
    i = end;
    codeStart = end;
  };
  while (i < n) {
    const ch = sql.charAt(i);
    if (ch === "'" || ch === '"') {
      nonCode(i, consumeQuoted(sql, i, ch));
    } else if (ch === '-' && sql.charAt(i + 1) === '-') {
      const nl = sql.indexOf('\n', i + 2);
      nonCode(i, nl === -1 ? n : nl);
    } else if (ch === '/' && sql.charAt(i + 1) === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.charAt(j) === '/' && sql.charAt(j + 1) === '*') {
          depth += 1;
          j += 2;
        } else if (sql.charAt(j) === '*' && sql.charAt(j + 1) === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      nonCode(i, j);
    } else if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        nonCode(i, close === -1 ? n : close + tag.length);
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  closeCode(n);
  return segs;
}

// ---- top-level semicolons (lint + dataset trailing-`;` strip) ---------------

export interface SemicolonAnalysis {
  /** Indexes of every top-level (outside strings/identifiers/comments) `;`. */
  positions: number[];
  /** True iff the LAST top-level `;` is followed only by whitespace/comments. */
  trailing: boolean;
}

export function analyzeSemicolons(sql: string): SemicolonAnalysis {
  const segs = scanSegments(sql);
  const positions: number[] = [];
  for (const seg of segs) {
    if (!seg.code) continue;
    for (let i = seg.start; i < seg.end; i++) {
      if (sql.charAt(i) === ';') positions.push(i);
    }
  }
  const last = positions[positions.length - 1];
  let trailing = false;
  if (last !== undefined) {
    trailing = true;
    outer: for (const seg of segs) {
      if (!seg.code) continue;
      for (let i = Math.max(seg.start, last + 1); i < seg.end; i++) {
        if (!/\s/.test(sql.charAt(i))) {
          trailing = false;
          break outer;
        }
      }
    }
  }
  return { positions, trailing };
}

/**
 * Remove the final trailing top-level `;` together with everything after it
 * (which is only whitespace/comments — otherwise nothing is stripped).
 * Postcondition: the result is SAFELY APPENDABLE — the engine does
 * `stripTrailingSemicolon(sql) + ' LIMIT n'` (§3), so a line comment left
 * unterminated at EOF is closed with a newline. (An unterminated *block*
 * comment cannot be repaired here; that SQL is malformed and will surface as a
 * broken rule.)
 */
export function stripTrailingSemicolon(sql: string): string {
  const { positions, trailing } = analyzeSemicolons(sql);
  const last = positions[positions.length - 1];
  const out = last !== undefined && trailing ? sql.slice(0, last) : sql;
  const tail = scanSegments(out).at(-1);
  if (tail && !tail.code && tail.end === out.length && out.startsWith('--', tail.start)) {
    return `${out}\n`;
  }
  return out;
}

// ---- __value__ substitution (qc-rules-format.md §5, engine §6) --------------

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Ranges of the bare identifier `__value__` (case-insensitive) in code segments. */
function valueTokenRanges(sql: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const seg of scanSegments(sql)) {
    if (!seg.code) continue;
    const re = /__value__/gi;
    const slice = sql.slice(seg.start, seg.end);
    let m;
    while ((m = re.exec(slice)) !== null) {
      const start = seg.start + m.index;
      const end = start + m[0].length;
      const before = start > 0 ? sql.charAt(start - 1) : '';
      const after = end < sql.length ? sql.charAt(end) : '';
      if (!IDENT_CHAR.test(before) && !IDENT_CHAR.test(after)) ranges.push({ start, end });
    }
  }
  return ranges;
}

export function containsValueToken(sql: string): boolean {
  return valueTokenRanges(sql).length > 0;
}

export function substituteValueToken(sql: string, replacement: string): string {
  const ranges = valueTokenRanges(sql);
  if (ranges.length === 0) return sql;
  let out = '';
  let prev = 0;
  for (const r of ranges) {
    out += sql.slice(prev, r.start) + replacement;
    prev = r.end;
  }
  return out + sql.slice(prev);
}

export interface ValueExpansion {
  target: string;
  condition: string;
  expression: string;
}

/**
 * One (condition, expression) pair per target (§5): `__value__` becomes the
 * quoted target column; with no token present every target receives identical
 * text (the CTAS still needs one REPLACE branch each). For js rules only the
 * condition is SQL — the expression passes through as raw JS, never scanned.
 */
export function expandValueToken(rule: QCRule): ValueExpansion[] {
  return rule.targetVariables.map((target) => {
    const quoted = quoteIdentifier(target);
    return {
      target,
      condition: substituteValueToken(rule.condition, quoted),
      expression:
        rule.updateLanguage === 'js'
          ? rule.updateExpression
          : substituteValueToken(rule.updateExpression, quoted),
    };
  });
}

// ---- wrapper/builder strings (engine §3 pseudocode, byte-pinned in tests) ---
// Conditions are ALWAYS evaluated in a SELECT-list wrapper, never a bare WHERE —
// the one code path that makes window functions legal everywhere.

export function violCountSQL(condition: string): string {
  return `SELECT COUNT(*) FROM (SELECT (${condition}) AS viol FROM data) WHERE viol`;
}

export function violFetchSQL(condition: string, targets: string[], rowCap: number): string {
  const cols = ['__row__', ...targets.map((t) => quoteIdentifier(t))].join(', ');
  return (
    `SELECT ${cols} FROM (SELECT *, (${condition}) AS viol FROM data) ` +
    `WHERE viol ORDER BY __row__ LIMIT ${String(rowCap)}`
  );
}

/**
 * Dataset-scope fetch: the user's full SELECT with the engine cap appended
 * (engine §3 `stripTrailingSemicolon(rule.condition) + " LIMIT {cap+1}"`).
 * A rule carrying its own top-level LIMIT yields a parser error → broken rule.
 */
export function datasetFetchSQL(condition: string, rowCap: number): string {
  return `${stripTrailingSemicolon(condition)} LIMIT ${String(rowCap)}`;
}

/**
 * Exact result-row count for a dataset rule (needed for the "…and N more
 * result rows" truncation flag; engine §5). Newlines guard the closing paren
 * against a trailing line comment in the user's SELECT.
 */
export function datasetCountSQL(condition: string): string {
  return `SELECT COUNT(*) FROM (\n${stripTrailingSemicolon(condition)}\n)`;
}

export function correctionCountSQL(condition: string, expression: string, target: string): string {
  const t = quoteIdentifier(target);
  return (
    `SELECT COUNT(*) FROM (SELECT (${expression}) AS after, ${t} AS before, ` +
    `(${condition}) AS hit FROM data) WHERE hit AND after IS DISTINCT FROM before`
  );
}

export function correctionCaptureSQL(
  condition: string,
  expression: string,
  target: string,
  rowCap: number,
): string {
  const t = quoteIdentifier(target);
  return (
    `SELECT __row__, before, after FROM (SELECT __row__, ${t} AS before, ` +
    `(${expression}) AS after, (${condition}) AS hit FROM data) ` +
    `WHERE hit AND after IS DISTINCT FROM before ORDER BY __row__ LIMIT ${String(rowCap)}`
  );
}

/**
 * The rebuild SELECT covering all targets of a rule (engine §3/§4) — the exact
 * statement lint stage 4 EXPLAINs and the engine wraps in its atomic swap
 * (`CREATE OR REPLACE TABLE quac_work AS …` per Verified fact V14; the
 * quac_work_next dance in `ctasRebuildSQL` is not used by the engine).
 */
export function rebuildSelectSQL(pairs: ValueExpansion[]): string {
  const replaces = pairs
    .map((p) => {
      const t = quoteIdentifier(p.target);
      return `CASE WHEN (${p.condition}) THEN (${p.expression}) ELSE ${t} END AS ${t}`;
    })
    .join(', ');
  return `SELECT * REPLACE (${replaces}) FROM data`;
}

/** Atomic rebuild — ONE CTAS covering all targets of a rule (engine §3/§4). */
export function ctasRebuildSQL(pairs: ValueExpansion[]): string {
  return `CREATE TABLE quac_work_next AS ${rebuildSelectSQL(pairs)}`;
}

/**
 * Keyset-paginated match fetch for js corrections (engine §3, 5000-row
 * chunks). The single injected alias is `__qc_hit__` — `__`-prefixed dataset
 * columns are rejected at ingestion, so it can never shadow user data (the
 * engine reads the target's current value straight from the `*` projection).
 */
export function jsChunkFetchSQL(condition: string, lastRow: number | bigint, limit: number): string {
  return (
    `SELECT * FROM (SELECT *, (${condition}) AS __qc_hit__ FROM data) ` +
    `WHERE __qc_hit__ AND __row__ > ${String(lastRow)} ORDER BY __row__ LIMIT ${String(limit)}`
  );
}

/** SQL literal for a sandbox-returned value staged into an updates table. */
export function escapeSqlLiteral(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

/** One staged-updates table per (rule, pair index); engine-internal name. */
export function jsStageTableName(pairIndex: number): string {
  return `__qc_updates_${String(pairIndex)}`;
}

export function jsStageCreateSQL(table: string): string {
  return `CREATE OR REPLACE TABLE ${table} ("__row__" BIGINT, val VARCHAR)`;
}

/**
 * Batched INSERTs for the staged updates: ≤ 1000 tuples AND ≤ ~1 MB of literal
 * text per statement (long string cells must not balloon one parse).
 */
export function jsStageInsertSQL(
  table: string,
  updates: readonly { row: number; val: string | null }[],
): string[] {
  const statements: string[] = [];
  let tuples: string[] = [];
  let textLength = 0;
  const flush = (): void => {
    if (tuples.length === 0) return;
    statements.push(`INSERT INTO ${table} VALUES ${tuples.join(', ')}`);
    tuples = [];
    textLength = 0;
  };
  for (const u of updates) {
    const tuple = `(${String(u.row)}, ${escapeSqlLiteral(u.val)})`;
    tuples.push(tuple);
    textLength += tuple.length;
    if (tuples.length >= 1000 || textLength >= 1_000_000) flush();
  }
  flush();
  return statements;
}

export interface JsMergePart {
  target: string;
  /** Declared column type from DESCRIBE — engine-supplied, never user text. */
  castType: string;
  table: string;
}

/**
 * Exact changed-cell count for one staged pair: CAST back to the declared type
 * FIRST so cast-normalization no-ops (e.g. '042' → 42) are suppressed exactly
 * like SQL corrections' `after IS DISTINCT FROM before`. A non-castable staged
 * value throws HERE — before any merge ran — so a broken js rule leaves
 * quac_work untouched.
 */
export function jsCountSQL(part: JsMergePart): string {
  const t = quoteIdentifier(part.target);
  return (
    `SELECT COUNT(*) FROM data JOIN ${part.table} u ON data.__row__ = u.__row__ ` +
    `WHERE CAST(u.val AS ${part.castType}) IS DISTINCT FROM ${t}`
  );
}

/** Before/after capture rows for one staged pair (pre-merge `data` state). */
export function jsCaptureSQL(part: JsMergePart, rowCap: number): string {
  const t = quoteIdentifier(part.target);
  return (
    `SELECT data.__row__ AS __row__, ${t} AS before, CAST(u.val AS ${part.castType}) AS after ` +
    `FROM data JOIN ${part.table} u ON data.__row__ = u.__row__ ` +
    `WHERE CAST(u.val AS ${part.castType}) IS DISTINCT FROM ${t} ` +
    `ORDER BY data.__row__ LIMIT ${String(rowCap)}`
  );
}

/**
 * The staged-merge rebuild SELECT covering ALL targets of a js rule — ONE
 * atomic `CREATE OR REPLACE TABLE quac_work AS …` swap (V14; `rebuildSelectSQL`
 * symmetry), so a broken rule can never leave a partial multi-target merge.
 * Engine §3's per-pair merge sketch is superseded the same way `ctasRebuildSQL`
 * was (phase-12 Deferred notes) — see phase-13 notes.
 */
export function jsMergeSelectSQL(parts: readonly JsMergePart[]): string {
  const replaces = parts
    .map((p, i) => {
      const t = quoteIdentifier(p.target);
      return `CASE WHEN u${String(i)}.__row__ IS NOT NULL THEN CAST(u${String(i)}.val AS ${p.castType}) ELSE ${t} END AS ${t}`;
    })
    .join(', ');
  const joins = parts
    .map((p, i) => ` LEFT JOIN ${p.table} u${String(i)} ON data.__row__ = u${String(i)}.__row__`)
    .join('');
  return `SELECT data.* REPLACE (${replaces}) FROM data${joins}`;
}
