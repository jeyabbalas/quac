/**
 * One dataset row → the JSON record the Ajv row loop validates
 * (json-schema-subsystem.md §C.3). Pure — runs inside the validation worker.
 *
 * The record holds EVERY dataset column, under the source's own name for it
 * (`key`), so the schema — not QuaC — decides what an extra column means:
 * `additionalProperties: false` rejects it, an open object accepts it, and
 * `maxProperties`, `propertyNames` or `dependentRequired` see the whole row.
 *
 * Each mode reads values its own way (worker-protocol.ts `RowSourceKind`):
 * - `records` — the JSON file's record, exactly: a missing key is missing and
 *   an explicit `null` is null, as JSON Schema tells them apart;
 * - `typed`   — each value as JSON writes it (canonical.ts), via its transport;
 * - `text`    — each cell's text read as the JSON value it spells (text-cells.ts).
 * In `typed` and `text`, a SQL NULL is absent from the record unless the
 * schema allows null there, where it is null (the text and Parquet
 * convention: an empty cell is a missing value).
 *
 * Findings the shaping itself makes:
 * - **cast** (`schema:prop:<col>:cast`, error) — a text cell that spells no
 *   value of any type the schema allows; a NaN or ±Infinity, which no JSON
 *   value can be. The cell is left out of the record and Ajv's errors at it
 *   are dropped (`castKeys`, `suppressPaths`): the cast finding says it.
 * - **precision** (`schema:prop:<col>:precision`, warning) — once per column:
 *   an integer past ±(2^53 − 1), which the validator compares rounded.
 */
import { decodeNestedValue, decodeRecord, renderNestedPath, toInstancePath } from './nested-values';
import { schemaPropRuleId } from './rule-ids';
import { readTextCell } from './text-cells';
import { castNonIntegralMessage, castNonNumericMessage, castNotJsonMessage } from './translator';
import type { QCFlag } from '../flags/flag';
import type { NestedPlan, PathSegment } from './nested-values';
import type { PresentedColumn, RowSourceKind } from './worker-protocol';
import type { JsonTypeName } from './value-spec';

export interface ShapedRow {
  /** The record — an object, except for a JSON dataset's non-object element. */
  obj: unknown;
  flags: QCFlag[];
  /** `${row} ${column}` keys of cells with a cast finding — Ajv's errors there are covered. */
  castKeys: string[];
  /** Ajv `instancePath`s holding a NaN or ±Infinity (read as null, already reported). */
  suppressPaths: string[];
}

export interface RowInput {
  values?: readonly unknown[];
  record?: string;
  fixes?: readonly (string | null)[];
}

export interface RowShaper {
  shapeRow(input: RowInput, row: number): ShapedRow;
}

const MAX_SAFE = 9007199254740991n;
const MIN_SAFE = -9007199254740991n;

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

const NON_FINITE_TEXT = /^-?(?:nan|inf|infinity)$/i;

/** A key that stays a key — `__proto__` included. */
function setKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

const isRecordObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The message for a text cell that spells no value the schema allows. */
function castMessage(
  raw: string,
  reason: 'type' | 'non-integral' | 'out-of-range',
  expected: string,
  types: ReadonlySet<JsonTypeName>,
): string {
  if (reason === 'non-integral') return castNonIntegralMessage(raw);
  if (reason === 'out-of-range') return `'${raw}' is beyond the range of numbers QuaC can check (about ±1.8e308).`;
  const structural = [...types].every((t) => t === 'array' || t === 'object' || t === 'null');
  if (structural) {
    const shape =
      types.has('array') && types.has('object') ? 'an array or an object' : types.has('object') ? 'an object' : 'an array';
    return castNotJsonMessage(raw, shape);
  }
  return castNonNumericMessage(raw, expected);
}

export function createRowShaper(columns: readonly PresentedColumn[], mode: RowSourceKind): RowShaper {
  const precisionFlagged = new Set<string>();
  const typesOf = columns.map((c) => new Set(c.jsonTypes));
  const byKey = new Map(columns.map((c, i) => [c.key, i]));

  return {
    shapeRow(input, row) {
      const flags: QCFlag[] = [];
      const castKeys: string[] = [];
      const suppressPaths: string[] = [];

      const castFlag = (col: PresentedColumn, message: string, value: string): void => {
        flags.push({
          source: 'schema',
          ruleId: schemaPropRuleId(col.column, 'cast'),
          scope: 'cell',
          row,
          column: col.column,
          severity: 'error',
          message,
          value,
        });
        castKeys.push(`${String(row)} ${col.key}`);
      };
      const precisionFlag = (col: PresentedColumn, text: string, at?: string): void => {
        if (precisionFlagged.has(col.column)) return;
        precisionFlagged.add(col.column);
        flags.push({
          source: 'schema',
          ruleId: schemaPropRuleId(col.column, 'precision'),
          scope: 'cell',
          row,
          column: col.column,
          severity: 'warning',
          message: precisionMessage(at),
          value: text,
        });
      };
      const nonFiniteFlag = (
        col: PresentedColumn,
        found: readonly { path: PathSegment[]; token: string }[],
        value: unknown,
        plan: NestedPlan | undefined,
        raw: string,
      ): void => {
        const at = (path: readonly PathSegment[]): string => renderNestedPath(col.key, path, value, plan);
        flags.push({
          source: 'schema',
          ruleId: schemaPropRuleId(col.column, 'cast'),
          scope: 'cell',
          row,
          column: col.column,
          severity: 'error',
          message: nonFiniteMessage(
            found.map((n) => n.token),
            found.map((n) => at(n.path)),
          ),
          value: raw,
        });
        for (const { path } of found) suppressPaths.push(toInstancePath(col.key, path));
      };

      /** A JSON-text value (a transport cell or a corrected one) read into the record. */
      const putJson = (
        obj: Record<string, unknown>,
        col: PresentedColumn,
        text: string,
        plan: NestedPlan,
        wideIntegers: boolean,
      ): void => {
        const decoded = decodeNestedValue(text, plan, wideIntegers && !precisionFlagged.has(col.column));
        if (decoded.unreadable === true) {
          castFlag(col, `'${text}' could not be read as a JSON value.`, text);
          return;
        }
        if (decoded.value === null) {
          // A JSON column's literal `null` is a null like any other.
          if (col.nullAllowed) setKey(obj, col.key, null);
        } else {
          setKey(obj, col.key, decoded.value);
        }
        if (decoded.nonFinite.length > 0) nonFiniteFlag(col, decoded.nonFinite, decoded.value, plan, text);
        const unsafe = decoded.unsafeInteger;
        if (unsafe !== null) {
          precisionFlag(col, unsafe.text, unsafe.path.length === 0 ? undefined : renderNestedPath(col.key, unsafe.path, decoded.value, plan));
        }
      };

      /** A corrected cell: `''` is NULL; anything else is `to_json` text. */
      const putFix = (obj: Record<string, unknown>, col: PresentedColumn, fix: string): void => {
        Reflect.deleteProperty(obj, col.key);
        if (fix === '') {
          if (col.nullAllowed) setKey(obj, col.key, null);
          return;
        }
        putJson(obj, col, fix, col.fix?.plan ?? { kind: 'json' }, col.fix?.wideIntegers ?? true);
      };

      if (mode === 'records') {
        const text = input.record ?? 'null';
        const decoded = decodeRecord(text, true);
        if (decoded.unreadable || !isRecordObject(decoded.value)) {
          // Not a record (or unreadable): the validator says what it is.
          return { obj: decoded.unreadable ? text : decoded.value, flags, castKeys, suppressPaths };
        }
        const obj = decoded.value;
        if (decoded.nonFinite.length > 0) {
          const byColumn = new Map<number, { path: PathSegment[]; token: string }[]>();
          for (const found of decoded.nonFinite) {
            const index = byKey.get(String(found.path[0]));
            if (index === undefined) continue;
            const list = byColumn.get(index) ?? [];
            list.push({ path: found.path.slice(1), token: found.token });
            byColumn.set(index, list);
          }
          for (const [index, found] of byColumn) {
            const col = columns[index];
            if (col !== undefined) nonFiniteFlag(col, found, obj[col.key], col.numbering, JSON.stringify(obj[col.key]));
          }
        }
        for (const [key, unsafe] of decoded.unsafeIntegers) {
          const index = byKey.get(key);
          const col = index === undefined ? undefined : columns[index];
          if (col === undefined) continue;
          const inner = unsafe.path.slice(1);
          precisionFlag(col, unsafe.text, inner.length === 0 ? undefined : renderNestedPath(col.key, inner, obj[col.key], col.numbering));
        }
        input.fixes?.forEach((fix, i) => {
          const col = columns[i];
          if (fix !== null && col !== undefined) putFix(obj, col, fix);
        });
        return { obj, flags, castKeys, suppressPaths };
      }

      const obj: Record<string, unknown> = {};
      const values = input.values ?? [];
      columns.forEach((col, i) => {
        const fix = input.fixes?.[i];
        if (fix !== null && fix !== undefined) {
          putFix(obj, col, fix);
          return;
        }
        const v = values[i];
        if (v === null || v === undefined) {
          if (col.nullAllowed) setKey(obj, col.key, null);
          return;
        }
        const t = col.transport;
        if (t.kind === 'json') {
          if (typeof v === 'string') putJson(obj, col, v, t.plan, t.wideIntegers);
          else setKey(obj, col.key, v);
          return;
        }
        if (t.kind === 'text') {
          const raw = typeof v === 'string' ? v : String(v);
          const types = typesOf[i] ?? new Set<JsonTypeName>();
          const reading = readTextCell(raw, types);
          if (reading.kind === 'cast') {
            castFlag(col, castMessage(raw, reading.reason, reading.expected, types), raw);
            return;
          }
          setKey(obj, col.key, reading.value);
          if (reading.precision !== undefined) precisionFlag(col, reading.precision);
          return;
        }
        if (t.kind === 'number' && typeof v === 'string') {
          if (NON_FINITE_TEXT.test(v)) {
            castFlag(col, `${v} is not a finite number.`, v);
            return;
          }
          const n = Number(v);
          setKey(obj, col.key, n);
          if (t.exact && Number.isInteger(n) && !Number.isSafeInteger(n)) precisionFlag(col, v);
          return;
        }
        // Native: the engine's own value.
        if (typeof v === 'bigint') {
          if (v > MAX_SAFE || v < MIN_SAFE) precisionFlag(col, String(v));
          setKey(obj, col.key, Number(v));
          return;
        }
        if (typeof v === 'number' && !Number.isFinite(v)) {
          castFlag(col, `${String(v)} is not a finite number.`, String(v));
          return;
        }
        setKey(obj, col.key, v);
      });
      return { obj, flags, castKeys, suppressPaths };
    },
  };
}
