/**
 * DuckDB row → JSON object normalization for the Ajv row loop
 * (json-schema-subsystem.md §C.3). Pure — runs inside the validation worker.
 *
 * Spec-silent resolutions (phase-09 deferred notes): the NaN/±Infinity
 * interception and the BigInt precision warning reuse the cast flag family
 * (`schema:prop:<col>:cast` / `:precision`) — a non-finite cell also lands in
 * castFailures so the translator suppresses the follow-on `required` error
 * from the absent property.
 */
import { schemaPropRuleId } from './rule-ids';
import { createRefResolver, escapePointerSegment, getAtPointer } from './deref';
import { decodeNestedValue, renderNestedPath, toInstancePath } from './nested-values';
import type { QCFlag } from '../flags/flag';
import type { ColumnMeta } from './column-meta';
import type { NestedColumn, NestedPlan } from './nested-values';
import type { SchemaFile, SchemaSet } from './types';

/** Per-column facts the shaper needs (derived from ColumnMeta or absent for extras). */
export interface ShapingColumn {
  name: string;
  /** In the schema property universe (extras are excluded unless includeExtras). */
  inSchema: boolean;
  /** Column jsonTypes include 'null' → SQL NULL presents as JSON null, not absent. */
  nullAllowed: boolean;
  /** mixed:true VARCHAR → numeric-looking strings present as numbers (§C.3 heuristic). */
  mixed: boolean;
  /**
   * A nested or JSON column, whose cells arrive as `to_json` text
   * (nested-values.ts): the plan that reads them back, and whether to look
   * for integers past 2^53.
   */
  nested?: { plan: NestedPlan; wideIntegers: boolean };
}

export interface ShapedRow {
  obj: Record<string, unknown>;
  flags: QCFlag[];
  /** `${row} ${column}` keys discovered while shaping (NaN/Inf) — feed castFailures. */
  castKeys: string[];
  /**
   * Ajv `instancePath`s inside nested values that held a NaN or ±Infinity —
   * reported by a cast flag already, so any error AT or BELOW one is noise.
   */
  suppressPaths: string[];
}

export interface RowShaper {
  shapeRow(values: readonly unknown[], row: number): ShapedRow;
}

/** §C.3 mixed-column heuristic (documented regex). */
export const MIXED_NUMERIC_RE = /^-?(\d+)(\.\d+)?([eE][+-]?\d+)?$/;

const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

/** Derive ShapingColumns for a batch's column list from the ColumnMeta digest. */
export function shapingColumns(
  batchColumns: readonly string[],
  metaByName: ReadonlyMap<string, ColumnMeta>,
  nestedByName: ReadonlyMap<string, NestedColumn> = new Map(),
): ShapingColumn[] {
  return batchColumns.map((name) => {
    const m = metaByName.get(name);
    const nested = nestedByName.get(name);
    return {
      name,
      inSchema: m !== undefined,
      nullAllowed: m?.jsonTypes.has('null') ?? false,
      mixed: m?.mixed ?? false,
      ...(nested === undefined
        ? {}
        : { nested: { plan: nested.plan, wideIntegers: nested.wideIntegers } }),
    };
  });
}

/** Paths listed in one non-finite message before the rest are counted. */
const NON_FINITE_PATH_CAP = 5;

function nonFiniteMessage(tokens: readonly string[], paths: readonly string[]): string {
  const distinct = [...new Set(tokens)];
  const shown = paths.slice(0, NON_FINITE_PATH_CAP);
  const more = paths.length - shown.length;
  const where = more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ');
  const subject =
    distinct.length === 1
      ? `${distinct[0] ?? 'NaN'} is not a finite number`
      : `${distinct.slice(0, -1).join(', ')} and ${distinct.at(-1) ?? ''} are not finite numbers`;
  return `${subject} (at ${where}).`;
}

/** §C.3's precision warning; `at` names where inside a nested value. */
const precisionMessage = (at?: string): string =>
  `value${at === undefined ? '' : ` at ${at}`} exceeds the exactly-representable integer ` +
  'range (±(2^53−1)) — schema checks used the nearest representable number.';

export function createRowShaper(
  columns: readonly ShapingColumn[],
  opts: { includeExtras: boolean },
): RowShaper {
  const precisionFlagged = new Set<string>();
  return {
    shapeRow(values, row) {
      const obj: Record<string, unknown> = {};
      const flags: QCFlag[] = [];
      const castKeys: string[] = [];
      const suppressPaths: string[] = [];
      columns.forEach((col, i) => {
        if (!col.inSchema && !opts.includeExtras) return;
        const v = values[i];
        if (v === null || v === undefined) {
          if (col.inSchema && col.nullAllowed) obj[col.name] = null;
          return;
        }
        if (col.nested !== undefined && typeof v === 'string') {
          const { plan, wideIntegers } = col.nested;
          const decoded = decodeNestedValue(v, plan, wideIntegers && !precisionFlagged.has(col.name));
          // A JSON column's literal `null` is a null like any other (§C.3).
          if (decoded.value === null) {
            if (col.inSchema && col.nullAllowed) obj[col.name] = null;
          } else {
            obj[col.name] = decoded.value;
          }
          if (decoded.nonFinite.length > 0) {
            const at = (path: readonly (string | number)[]): string =>
              renderNestedPath(col.name, path, decoded.value, plan);
            flags.push({
              source: 'schema',
              ruleId: schemaPropRuleId(col.name, 'cast'),
              scope: 'cell',
              row,
              column: col.name,
              severity: 'error',
              message: nonFiniteMessage(
                decoded.nonFinite.map((n) => n.token),
                decoded.nonFinite.map((n) => at(n.path)),
              ),
              value: v,
            });
            for (const { path } of decoded.nonFinite) {
              suppressPaths.push(toInstancePath(col.name, path));
            }
          }
          const unsafe = decoded.unsafeInteger;
          if (unsafe !== null && !precisionFlagged.has(col.name)) {
            precisionFlagged.add(col.name);
            flags.push({
              source: 'schema',
              ruleId: schemaPropRuleId(col.name, 'precision'),
              scope: 'cell',
              row,
              column: col.name,
              severity: 'warning',
              message: precisionMessage(renderNestedPath(col.name, unsafe.path, decoded.value, plan)),
              value: unsafe.text,
            });
          }
          return;
        }
        if (typeof v === 'bigint') {
          if ((v > MAX_SAFE || v < MIN_SAFE) && !precisionFlagged.has(col.name)) {
            precisionFlagged.add(col.name);
            flags.push({
              source: 'schema',
              ruleId: schemaPropRuleId(col.name, 'precision'),
              scope: 'cell',
              row,
              column: col.name,
              severity: 'warning',
              message: precisionMessage(),
              value: String(v),
            });
          }
          obj[col.name] = Number(v);
          return;
        }
        if (typeof v === 'number' && !Number.isFinite(v)) {
          flags.push({
            source: 'schema',
            ruleId: schemaPropRuleId(col.name, 'cast'),
            scope: 'cell',
            row,
            column: col.name,
            severity: 'error',
            message: `${String(v)} is not a finite number.`,
            value: String(v),
          });
          castKeys.push(`${String(row)} ${col.name}`);
          return;
        }
        if (col.mixed && typeof v === 'string' && MIXED_NUMERIC_RE.test(v)) {
          obj[col.name] = Number(v);
          return;
        }
        obj[col.name] = v;
      });
      return { obj, flags, castKeys, suppressPaths };
    },
  };
}

/** Row-level in-place applicator keys — these apply to the SAME object. */
const IN_PLACE_KEYS = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else'] as const;

/**
 * §C.3 fallback detection: the property universe is statically enumerable
 * unless a row-level applicator constrains unknown properties —
 * `patternProperties`, schema-valued `additionalProperties`, or
 * schema-valued `unevaluatedProperties` (boolean forms close or free the
 * universe; only object schemas make extras carry checkable constraints).
 * Walks in-place applicators + $refs only — the same keywords nested inside
 * a property's own subschema constrain that CELL's value, not the row.
 */
export function hasOpenPropertyUniverse(set: SchemaSet, rootFileId: string): boolean {
  const resolver = createRefResolver(set);
  const root = set.files.find((f) => f.fileId === rootFileId);
  if (!root) return false;
  const items = getAtPointer(root.json, '/items');
  if (!items.found) return false;

  const visited = new Set<string>();
  const opensUniverse = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    const rec = node as Record<string, unknown>;
    if ('patternProperties' in rec) return true;
    const addl = rec.additionalProperties;
    if (typeof addl === 'object' && addl !== null) return true;
    const uneval = rec.unevaluatedProperties;
    if (typeof uneval === 'object' && uneval !== null) return true;
    return false;
  };

  const walk = (file: SchemaFile, pointer: string, node: unknown, depth: number): boolean => {
    if (depth > 12) return false;
    const key = `${file.fileId}#${pointer}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (opensUniverse(node)) return true;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return false;
    const rec = node as Record<string, unknown>;
    if (typeof rec.$ref === 'string') {
      const site = resolver.resolve(file, pointer === '' ? '/$ref' : `${pointer}/$ref`);
      if (site) {
        if (walk(site.file, site.pointer, site.node, depth + 1)) return true;
      } else if (rec.$ref.startsWith('#/')) {
        // Fragment-only refs carry no graph edge (§A.2.6b) — deref in place.
        const fragment = rec.$ref.slice(1);
        const at = getAtPointer(file.json, fragment);
        if (at.found && walk(file, fragment, at.value, depth + 1)) return true;
      }
    }
    for (const k of IN_PLACE_KEYS) {
      const sub = rec[k];
      if (sub === undefined) continue;
      const subs = Array.isArray(sub) ? sub : [sub];
      for (const [i, s] of subs.entries()) {
        const childPointer = Array.isArray(sub)
          ? `${pointer}/${k}/${String(i)}`
          : `${pointer}/${k}`;
        if (walk(file, childPointer, s, depth + 1)) return true;
      }
    }
    const dependent = rec.dependentSchemas;
    if (typeof dependent === 'object' && dependent !== null && !Array.isArray(dependent)) {
      for (const [prop, s] of Object.entries(dependent)) {
        const seg = escapePointerSegment(prop);
        if (walk(file, `${pointer}/dependentSchemas/${seg}`, s, depth + 1)) return true;
      }
    }
    return false;
  };

  return walk(root, '/items', items.value, 0);
}
