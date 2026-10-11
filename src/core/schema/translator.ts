/**
 * Ajv error → QCFlag translator (json-schema-subsystem.md §D). Pure and
 * deterministic: string templating over the digests (ColumnMeta / ValueSpec
 * / ConditionalRule), no Ajv imports, `Intl.NumberFormat('en-US')` via
 * value-spec's formatBound. Golden messages (§D.7) are pinned
 * character-exact in tests/unit/schema/translator.test.ts.
 *
 * A row's errors are first read into a tree (error-tree.ts): which errors a
 * failed `anyOf`/`oneOf`, `if`, `contains` or `propertyNames` owns. Then:
 *
 * - a failed union whose value only one branch could have meant reports that
 *   branch's own errors; any other becomes ONE flag, and only its own
 *   branch errors go quiet — an unrelated error on the same value stays;
 * - the errors of a failed `then` / `else` carry their condition ("when
 *   status = 'closed', …", "unless …"), wherever the `if` sits — the row,
 *   a property, a `$ref`'d category file, a nested value; an error under
 *   `dependentSchemas` / draft-07 `dependencies` carries "when 'a' is present";
 * - a root `required` means "the cell is missing — required for every
 *   record" only when it is unconditional; inside a condition it says when;
 * - `contains` is one flag (its item errors are not findings), and a bad
 *   property name is one flag that says what names must be.
 *
 * A flag's `column` is the record key the error is under (the engine maps
 * keys to dataset columns); a key the digest does not know gets no ValueSpec
 * and no trailers, nothing else changes. The empty key is a column like any
 * other: `/` is the column named '', `''` is the record itself.
 *
 * Spec deviations (goldens + P02 fixture manifests win over §D prose; see
 * phase-08 Deferred notes): trailers attach only to `schema:prop:<col>:value`
 * messages; conditional messages include the target column name; the
 * anyOf/oneOf collapse for string-pattern specs renders
 * "a {patternTitle} ({humanized regex})" instead of §D.4's "text matching …".
 */
import { describeCondition, vacuousProperties } from './conditionals';
import { buildErrorTree } from './error-tree';
import { formatBound, labelledValuesOf, renderExpectation, renderValue } from './value-spec';
import type { ConditionalRule, ConditionalTarget } from './conditionals';
import type { ContainsNode, ErrorNode, IfNode, NamesNode, UnionNode } from './error-tree';
import type { SchemaProbe } from './schema-probe';
import type { ValueSpec } from './value-spec';
import type { ColumnMeta } from './column-meta';
import { schemaColumnRuleId, schemaCondRuleId, schemaPropRuleId } from './rule-ids';
import type { QCFlag } from '../flags/flag';

/** Structural subset of Ajv's ErrorObject — no runtime Ajv dependency. */
export interface AjvErrorLike {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
  message?: string;
  data?: unknown;
  /** The keyword's own value (Ajv `verbose`): a union's branch schemas. */
  schema?: unknown;
  /** The schema object holding the keyword (Ajv `verbose`). */
  parentSchema?: unknown;
  /** Set by Ajv on an error about a property NAME (`propertyNames`). */
  propertyName?: string;
}

/**
 * Renders where below its column an error sits — `people[2].age` — from an
 * Ajv `instancePath` (nested-values.ts `renderNestedPath`). The worker builds
 * one per row, over the row's decoded values; without one a path reads as its
 * JSON Pointer.
 */
export type Locate = (instancePath: string) => string;

export interface TranslateCtx {
  readonly metaByName: ReadonlyMap<string, ColumnMeta>;
  readonly ordinalByName: ReadonlyMap<string, number>;
  readonly conditionalByIndex: ReadonlyMap<number, ConditionalRule>;
  /**
   * Columns that got an error-level missing-column flag: a row's
   * UNCONDITIONAL `required` error for one is that flag's, not a new finding.
   * A conditional one ("required when …") is still reported.
   */
  readonly missingRequired: ReadonlySet<string>;
  /** @deprecated The pre-tree name of `missingRequired` — the same set. */
  readonly missingColumns: ReadonlySet<string>;
  /** Keys `` `${row} ${column}` `` (§C.2). */
  readonly castFailures: ReadonlySet<string>;
}

export interface TranslateOptions {
  locate?: Locate;
  /**
   * Re-validation for exact applicator blocks (schema-probe.ts — the worker
   * builds one). Without it the tree is read from schemaPaths.
   */
  probe?: SchemaProbe;
}

/** Precompute the per-run lookups; the worker builds one per validation run. */
export function createTranslateCtx(
  meta: readonly ColumnMeta[],
  conditionals: readonly ConditionalRule[],
  opts: {
    missingRequired?: Iterable<string>;
    /** Read as `missingRequired` (the name before the tree translator). */
    missingColumns?: Iterable<string>;
    castFailures?: Iterable<string>;
  } = {},
): TranslateCtx {
  const metaByName = new Map<string, ColumnMeta>();
  const ordinalByName = new Map<string, number>();
  meta.forEach((m, i) => {
    metaByName.set(m.name, m);
    ordinalByName.set(m.name, i);
  });
  const conditionalByIndex = new Map<number, ConditionalRule>();
  for (const rule of conditionals) conditionalByIndex.set(rule.index, rule);
  const missingRequired = new Set([...(opts.missingRequired ?? []), ...(opts.missingColumns ?? [])]);
  return {
    metaByName,
    ordinalByName,
    conditionalByIndex,
    missingRequired,
    missingColumns: missingRequired,
    castFailures: new Set(opts.castFailures ?? []),
  };
}

// ---------------------------------------------------------------------------
// Shared message pieces
// ---------------------------------------------------------------------------

const REQUIRED_CELL_MESSAGE = 'value is missing — this variable is required for every record.';

/** Trailer enrichment — `schema:prop:<col>:value` messages only (§D.4 scoped by the §D.7 goldens). */
function trailers(meta: ColumnMeta | undefined): string {
  if (meta === undefined) return '';
  let text = '';
  if (meta.unit !== undefined) text += ` [Unit: ${meta.unit}]`;
  if (meta.universe !== undefined) text += ` [Universe: ${meta.universe}]`;
  if (meta.comment !== undefined) text += ` [Note: ${meta.comment}]`;
  return text;
}

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];

/**
 * Humanize the narrow literal-plus-digit-class regex shape used by identifier
 * defs: `^HH[0-9]{8}$` → `'HH' followed by eight digits`. Anything the tiny
 * grammar can't parse → null (caller falls back to §D.4's "text matching …").
 */
function humanizePattern(pattern: string): string | null {
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
  const token = /([A-Za-z_][A-Za-z_]*)|(?:\[0-9\]|\\d)\{(\d+)\}/gy;
  const parts: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    token.lastIndex = pos;
    const match = token.exec(body);
    if (match === null) return null;
    const [, literal, digits] = match;
    if (literal !== undefined) parts.push(`'${literal}'`);
    else {
      const n = Number(digits);
      const word = NUMBER_WORDS[n];
      if (word === undefined) return null;
      parts.push(`${word} ${n === 1 ? 'digit' : 'digits'}`);
    }
    pos = token.lastIndex;
  }
  return parts.length === 0 ? null : parts.join(' followed by ');
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

/** Collapse expectation — §D.4 except the string-pattern golden-#6 override. */
function collapseExpectation(spec: ValueSpec): string {
  if (spec.kind === 'string-pattern' && spec.patternTitle !== undefined) {
    const humanized = humanizePattern(spec.pattern);
    if (humanized !== null) {
      let text = `${article(spec.patternTitle)} ${spec.patternTitle} (${humanized})`;
      if (spec.sentinels.length > 0) {
        const codes = spec.sentinels
          .map((s) => (s.label === undefined ? renderValue(s.value) : `${renderValue(s.value)} ${s.label}`))
          .join('; ');
        text += `, or one of: ${codes}`;
      }
      return text;
    }
  }
  return renderExpectation(spec);
}

/** A value quoted in a message is cut past this many code points (a list can hold 10,000 items). */
const MESSAGE_VALUE_CAP = 80;

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const points = Array.from(text);
  return points.length <= cap ? text : `${points.slice(0, cap - 1).join('')}…`;
}

function renderData(value: unknown): string {
  if (typeof value === 'string') {
    const clipped = clip(value, MESSAGE_VALUE_CAP - 2);
    return clipped === value ? renderValue(value) : `'${clipped}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return renderValue(value);
  }
  return value === undefined ? 'value' : clip(JSON.stringify(value), MESSAGE_VALUE_CAP);
}

/** JSON Schema's name for what a value is — `array`, not `typeof`'s `object`. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const TYPE_NOUNS: Readonly<Record<string, string>> = {
  integer: 'an integer',
  number: 'a number',
  string: 'a string',
  boolean: 'a boolean',
  null: 'null',
  array: 'an array',
  object: 'an object',
};

const typeNoun = (type: string): string => TYPE_NOUNS[type] ?? `${article(type)} ${type}`;

/** `an integer`, `an integer or null` — what a `type` keyword asks for. */
function typeList(type: unknown): string {
  const list = Array.isArray(type) ? type.map(String) : [String(type)];
  return list.map(typeNoun).join(' or ');
}

const quoteName = (name: unknown): string => `'${String(name)}'`;

const plural = (n: number, noun: string): string =>
  `${formatBound(n)} ${noun}${n === 1 ? '' : 's'}`;

/** `1, 2 and 3` — option numbers, items. */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Values past this many in a standalone `enum` list are counted, not printed (as §D.4 codes). */
const ENUM_LIST_CAP = 8;

function cappedValues(values: readonly unknown[]): string {
  const shown = values.slice(0, ENUM_LIST_CAP).map(renderData).join(', ');
  const more = values.length - ENUM_LIST_CAP;
  return more > 0 ? `${shown}, … (${String(more)} more)` : shown;
}

/** Ajv's `format` names, as a reader would say them — the standard formats (2020-12 §7.3) and ajv-formats' own. */
const FORMAT_NOUNS: Readonly<Record<string, string>> = {
  date: 'date (YYYY-MM-DD)',
  'date-time': 'RFC 3339 date-time (YYYY-MM-DDThh:mm:ssZ)',
  time: 'RFC 3339 time (hh:mm:ssZ)',
  duration: 'RFC 3339 duration (P1Y2M3DT4H5M6S — whole numbers only)',
  email: 'email address',
  'idn-email': 'internationalized email address',
  hostname: 'host name',
  'idn-hostname': 'internationalized host name',
  ipv4: 'IPv4 address',
  ipv6: 'IPv6 address',
  uri: 'absolute URI (with a scheme, such as https:)',
  'uri-reference': 'URI reference',
  iri: 'absolute IRI (with a scheme, such as https:)',
  'iri-reference': 'IRI reference',
  uuid: 'UUID',
  'uri-template': 'URI template (RFC 6570)',
  'json-pointer': 'JSON Pointer',
  'relative-json-pointer': 'relative JSON Pointer',
  regex: 'regular expression',
  'iso-time': 'ISO 8601 time (hh:mm:ss, offset optional)',
  'iso-date-time': 'ISO 8601 date-time (offset optional)',
  url: 'URL',
  'json-pointer-uri-fragment': 'JSON Pointer URI fragment',
  int32: '32-bit integer',
  int64: '64-bit integer',
  float: '32-bit floating-point number',
  double: '64-bit floating-point number',
  byte: 'base64-encoded value',
};

const formatNoun = (format: string): string => FORMAT_NOUNS[format] ?? `'${format}' value`;

/** An ISO 8601 local date-time — valid in itself, but with no offset RFC 3339 requires. */
const OFFSETLESS_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
const OFFSETLESS_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
/** A duration ISO 8601 allows and RFC 3339's grammar does not: a decimal fraction. */
const FRACTIONAL_DURATION = /^P(?=.)(?:\d+(?:[.,]\d+)?[YMWD])*(?:T(?:\d+(?:[.,]\d+)?[HMS])+)?$/;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validClock(h: number, m: number, s: number): boolean {
  return h <= 23 && m <= 59 && s <= 59;
}

function validDate(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const max = mo === 2 && !leap ? 28 : (DAYS_IN_MONTH[mo - 1] ?? 31);
  return d <= max;
}

function formatBody(error: AjvErrorLike): string {
  const format = String(error.params.format);
  const data = error.data;
  if (typeof data === 'string') {
    const needsOffset = ' — it needs a time-zone offset such as Z or +05:30';
    if (format === 'date-time') {
      const m = OFFSETLESS_DATE_TIME.exec(data);
      if (m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3])) && validClock(Number(m[4]), Number(m[5]), Number(m[6]))) {
        return `${renderData(data)} is not a valid RFC 3339 date-time${needsOffset}`;
      }
    }
    if (format === 'time') {
      const m = OFFSETLESS_TIME.exec(data);
      if (m !== null && validClock(Number(m[1]), Number(m[2]), Number(m[3]))) {
        return `${renderData(data)} is not a valid RFC 3339 time${needsOffset}`;
      }
    }
    if (format === 'duration' && FRACTIONAL_DURATION.test(data) && /[.,]\d/.test(data)) {
      return `${renderData(data)} is not a valid RFC 3339 duration — it takes whole numbers only, no fractions`;
    }
  }
  return `${renderData(data)} is not a valid ${formatNoun(format)}`;
}

/** What one union branch accepts, in a word or two — from the branch alone, no `$ref` followed. */
function branchNoun(branch: unknown): string | null {
  if (branch === true) return 'any value';
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return null;
  const node = branch as Record<string, unknown>;
  if (Object.hasOwn(node, 'const')) return renderData(node.const);
  if (Array.isArray(node.enum)) return `one of ${cappedValues(node.enum)}`;
  const types = typeof node.type === 'string' ? [node.type] : Array.isArray(node.type) ? node.type : [];
  const nouns = types.map((t) => {
    switch (t) {
      case 'integer':
        return 'an integer';
      case 'number':
        return 'a number';
      case 'string':
        return 'text';
      case 'boolean':
        return 'a boolean';
      case 'null':
        return 'null';
      case 'array':
        return 'an array';
      case 'object':
        return 'an object';
      default:
        return String(t);
    }
  });
  if (nouns.length > 0) return nouns.join(' or ');
  if (typeof node.title === 'string') return node.title;
  return null;
}

function describeBranches(schema: unknown): string {
  const branches = Array.isArray(schema) ? schema : [];
  const nouns = [...new Set(branches.map(branchNoun).filter((n): n is string => n !== null))];
  if (nouns.length === 0 || nouns.length < branches.length) {
    return nouns.length === 0
      ? 'a value matching one of the schema\'s alternatives'
      : `${nouns.join(', ')} or another of the schema's alternatives`;
  }
  return nouns.length === 1 ? (nouns[0] ?? '') : `${nouns.slice(0, -1).join(', ')} or ${nouns.at(-1) ?? ''}`;
}

/** The JSON types a branch says outright with `type`; null when it does not (enum/const-only, `$ref`, …). */
function branchTypes(branch: unknown): ReadonlySet<string> | null {
  if (branch === false) return new Set();
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return null;
  const node = branch as Record<string, unknown>;
  if (typeof node.$ref === 'string') return null;
  if (typeof node.type === 'string') return new Set([node.type]);
  if (Array.isArray(node.type)) return new Set(node.type.map(String));
  return null;
}

/**
 * The one branch of a failed union whose `type` admits the value, when
 * exactly one does and EVERY branch states its type: `{"k": 12}` against
 * text, a number or a `{k: 0–9}` object can only have meant the object, and
 * the useful finding is that branch's own — `12 exceeds the maximum 9` — not
 * "is not valid". A branch that says no type (enum/const-only, a `$ref`)
 * could have meant anything, so such a union never narrows.
 */
function discriminatedBranch(union: AjvErrorLike): number | null {
  const passing = union.params.passingSchemas;
  if (Array.isArray(passing) && passing.length > 1) return null;
  if (!Array.isArray(union.schema)) return null;
  const actual = jsonTypeOf(union.data);
  const integral = typeof union.data === 'number' && Number.isInteger(union.data);
  let match: number | null = null;
  for (const [i, branch] of union.schema.entries()) {
    const types = branchTypes(branch);
    if (types === null) return null;
    const admits = types.has(actual) || (integral && types.has('integer'));
    if (!admits) continue;
    if (match !== null) return null;
    match = i;
  }
  return match;
}

/** Lead sentence for the collapse template (decision from goldens #1/#2/#6 + mini). */
function collapseLead(spec: ValueSpec | undefined, value: unknown): string {
  const rendered = renderData(value);
  if (spec?.kind === 'numeric' && typeof value === 'number') {
    if (spec.min !== undefined && value < spec.min) {
      return `${rendered} is below the minimum ${formatBound(spec.min)}`;
    }
    if (spec.max !== undefined && value > spec.max) {
      return `${rendered} exceeds the maximum ${formatBound(spec.max)}`;
    }
    if (spec.numType === 'integer' && !Number.isInteger(value)) {
      return `${rendered} is not an integer`;
    }
  }
  if (spec?.kind === 'codes') return `${rendered} is not an allowed value`;
  return `${rendered} is not valid`;
}

/** Generic fallback (§D.6 last row) — no error is ever dropped silently. */
function genericMessage(error: AjvErrorLike): string {
  const params = JSON.stringify(error.params);
  const summary = params === '{}' ? '' : `${params} `;
  return `value fails the '${error.keyword}' constraint ${summary}(schema: ${error.schemaPath})`;
}

// ---------------------------------------------------------------------------
// Exported message builders (goldens #8–#10; consumed by P09's SQL checks)
// ---------------------------------------------------------------------------

/** §C.2 non-numeric cast failure: `'twelve hundred' is not a valid integer.` */
export function castNonNumericMessage(rawValue: string, typeNoun = 'integer'): string {
  return `'${rawValue}' is not a valid ${typeNoun}.`;
}

/**
 * §C.2 for an array or object variable read from text (CSV, TSV, Excel): the
 * cell must hold JSON, and this one does not parse.
 */
export function castNotJsonMessage(rawValue: string, shape: string): string {
  return `'${rawValue}' is not valid JSON — this variable takes ${shape}, written as JSON text.`;
}

/** §C.2 non-integral cast failure in an integer column. */
export function castNonIntegralMessage(rawValue: string): string {
  return `${rawValue} is not a whole number — this variable takes integer values.`;
}

/** Golden #8 — required variable absent from the dataset (column scope). */
export function missingColumnMessage(name: string, title?: string): string {
  const titled = title === undefined ? '' : ` (${title})`;
  return `Variable '${name}'${titled} is required by the schema but not present in the dataset.`;
}

/** §D.6 unevaluatedProperties — dataset column not in the schema (column scope). */
export function unexpectedColumnMessage(column: string): string {
  return `Column '${column}' is not defined in the schema, which does not allow unexpected variables.`;
}

/**
 * A record key the schema rejects (column scope) — said by the keyword that
 * rejects it: `additionalProperties` / `unevaluatedProperties` false, or the
 * reason a `propertyNames` schema gives.
 */
export function notAllowedColumnMessage(column: string, reason: string): string {
  const why =
    reason === 'additionalProperties' || reason === 'unevaluatedProperties' ? `${reason} is false` : reason;
  return `Column '${column}' is not allowed by the schema (${why}).`;
}

/** Golden #10 — dataset duplicate pair (SQL GROUP BY ALL, P09). */
export function duplicateRecordsMessage(rowA: number, rowB: number): string {
  return `Rows ${String(rowA)} and ${String(rowB)} are identical records — the schema requires all records to be unique.`;
}

/**
 * §H edge 20 — the schema and the dataset share no column at all (P09). Every
 * variable is separately reported missing at column scope; this is the one
 * dataset-scope sentence saying why no record was validated.
 */
export function noOverlapMessage(schemaVariables: number, datasetColumns: number): string {
  return (
    `None of the schema's ${formatBound(schemaVariables)} variables are present among the ` +
    `dataset's ${formatBound(datasetColumns)} columns, so no records could be validated — ` +
    `check that the schema and the dataset describe the same table.`
  );
}

/** §D.6 minItems (SQL count, P09). */
export function minItemsMessage(rows: number, minimum: number): string {
  return `The dataset has ${formatBound(rows)} records; the schema requires at least ${formatBound(minimum)}.`;
}

/** The dataset-level `maxItems`. */
export function maxItemsMessage(rows: number, maximum: number): string {
  return `The dataset has ${formatBound(rows)} records; the schema allows at most ${formatBound(maximum)}.`;
}

// ---------------------------------------------------------------------------
// Keyword sentences
// ---------------------------------------------------------------------------

/** A finite number from Ajv's params, or NaN. */
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/** An items limit from Ajv's params: `limit` (Ajv), `len` (older recordings). */
const itemLimit = (params: Record<string, unknown>): number =>
  typeof params.limit === 'number' ? params.limit : num(params.len);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The label a column's ValueSpec gives a code, if any. */
function labelOf(spec: ValueSpec | undefined, value: unknown): string | undefined {
  if (spec === undefined || (typeof value !== 'string' && typeof value !== 'number')) return undefined;
  return labelledValuesOf(spec).find((s) => s.value === value && s.label !== undefined)?.label;
}

/** `contains` in words, from its params and (when the probe counted them) the matches. */
function containsBody(error: AjvErrorLike, matches: number | null): string {
  const min = typeof error.params.minContains === 'number' ? error.params.minContains : 1;
  const max = typeof error.params.maxContains === 'number' ? error.params.maxContains : undefined;
  const noun = branchNoun(error.schema);
  const wanted = noun === null ? '' : ` — expected an item that is ${noun}`;
  if (max !== undefined) {
    if (matches !== null && matches > max) {
      return `has ${plural(matches, 'matching item')}; at most ${formatBound(max)} allowed${wanted}`;
    }
    if (matches !== null) {
      return `has ${plural(matches, 'matching item')}; at least ${formatBound(min)} required${wanted}`;
    }
    return min === max
      ? `must contain exactly ${plural(min, 'matching item')}${wanted}`
      : `must contain between ${formatBound(min)} and ${plural(max, 'matching item')}${wanted}`;
  }
  if (min > 1) {
    return matches === null
      ? `has fewer than ${plural(min, 'item')} matching the schema${wanted}`
      : `has ${plural(matches, 'matching item')}; at least ${formatBound(min)} required${wanted}`;
  }
  return `has no item matching the schema${wanted}`;
}

/**
 * §D.6 keyword table — one sentence per single-keyword error, without its
 * final period (the caller adds the location first).
 */
function keywordBody(error: AjvErrorLike, spec: ValueSpec | undefined, locate?: Locate): string {
  const data = error.data;
  switch (error.keyword) {
    case 'pattern': {
      const pattern = typeof error.params.pattern === 'string' ? error.params.pattern : '';
      const description = spec?.kind === 'string-pattern' ? spec.patternDescription : undefined;
      const gloss = description === undefined ? '' : ` — ${description.replace(/\.$/, '')}`;
      return `${renderData(data)} does not match the expected format (pattern ${pattern}${gloss})`;
    }
    case 'enum': {
      const allowed = Array.isArray(error.params.allowedValues) ? error.params.allowedValues : [];
      return `${renderData(data)} is not an allowed value — expected one of ${cappedValues(allowed)}`;
    }
    case 'type': {
      const expected = typeList(error.params.type);
      if (data === null) return `null is not allowed here — expected ${expected}`;
      if (data === undefined) return `must be ${expected}`;
      return `${renderData(data)} is ${typeNoun(jsonTypeOf(data))}, not ${expected}`;
    }
    case 'minimum':
      return `${renderData(data)} is below the minimum ${formatBound(num(error.params.limit))}`;
    case 'maximum':
      return `${renderData(data)} exceeds the maximum ${formatBound(num(error.params.limit))}`;
    case 'exclusiveMinimum':
      return `${renderData(data)} must be greater than ${formatBound(num(error.params.limit))}`;
    case 'exclusiveMaximum':
      return `${renderData(data)} must be less than ${formatBound(num(error.params.limit))}`;
    case 'multipleOf':
      return `${renderData(data)} is not a multiple of ${renderData(error.params.multipleOf)}`;
    case 'const': {
      const allowed = error.params.allowedValue;
      const label = labelOf(spec, allowed);
      const found = data === undefined ? '' : ` — found ${renderData(data)}`;
      return `must be ${renderData(allowed)}${label === undefined ? '' : ` (${label})`}${found}`;
    }
    case 'required':
      return `required field ${quoteName(error.params.missingProperty)} is missing`;
    case 'dependentRequired':
    case 'dependencies':
      return (
        `field ${quoteName(error.params.missingProperty)} is required when ` +
        `${quoteName(error.params.property)} is present`
      );
    case 'additionalProperties':
      return `field ${quoteName(error.params.additionalProperty)} is not allowed here`;
    case 'unevaluatedProperties':
      return `field ${quoteName(error.params.unevaluatedProperty)} is not allowed here`;
    case 'propertyNames': {
      const rule = typeof error.params.namePattern === 'string' ? ` (names must match ${error.params.namePattern})` : '';
      return `field name ${quoteName(error.params.propertyName)} is not allowed${rule}`;
    }
    case 'maxProperties':
    case 'minProperties': {
      const has = isRecord(data) ? Object.keys(data).length : NaN;
      const limit = num(error.params.limit);
      return error.keyword === 'maxProperties'
        ? `has ${plural(has, 'field')}; at most ${formatBound(limit)} allowed`
        : `has ${plural(has, 'field')}; at least ${formatBound(limit)} required`;
    }
    case 'maxItems':
    case 'minItems': {
      const has = Array.isArray(data) ? data.length : NaN;
      const limit = num(error.params.limit);
      return error.keyword === 'maxItems'
        ? `has ${plural(has, 'item')}; at most ${formatBound(limit)} allowed`
        : `has ${plural(has, 'item')}; at least ${formatBound(limit)} required`;
    }
    // `items: false` after `prefixItems`, draft-07 `additionalItems`, and
    // `unevaluatedItems`: items past the ones the schema accounts for.
    case 'items':
    case 'additionalItems':
    case 'unevaluatedItems': {
      const limit = itemLimit(error.params);
      if (!Number.isFinite(limit)) return genericMessage(error);
      return Array.isArray(data)
        ? `has ${plural(data.length, 'item')}; at most ${formatBound(limit)} allowed`
        : `must have at most ${plural(limit, 'item')}`;
    }
    case 'uniqueItems': {
      // Ajv's two code paths name the pair in opposite orders (a typed item
      // schema takes a hash-map walk, any other a pairwise one), so order them
      // here: the later item repeats the earlier. Both 0-based.
      const a = num(error.params.i);
      const b = num(error.params.j);
      const at = (index: number): string =>
        locate === undefined
          ? `item ${String(index + 1)}`
          : locate(`${error.instancePath}/${String(index)}`);
      return `${at(Math.max(a, b))} repeats ${at(Math.min(a, b))} — items must be unique`;
    }
    case 'contains':
      return containsBody(error, null);
    case 'maxLength':
    case 'minLength': {
      const length = typeof data === 'string' ? Array.from(data).length : NaN;
      const limit = num(error.params.limit);
      return error.keyword === 'maxLength'
        ? `${renderData(data)} has ${plural(length, 'character')}; at most ${formatBound(limit)} allowed`
        : `${renderData(data)} has ${plural(length, 'character')}; at least ${formatBound(limit)} required`;
    }
    case 'format':
      return formatBody(error);
    case 'false schema':
      return 'no value is allowed here';
    case 'not': {
      const ruled = error.schema;
      if (isRecord(ruled) && Object.hasOwn(ruled, 'const') && Object.keys(ruled).length === 1) {
        const label = labelOf(spec, ruled.const);
        return `must not be ${renderData(ruled.const)}${label === undefined ? '' : ` (${label})`}`;
      }
      if (isRecord(ruled) && Array.isArray(ruled.enum) && Object.keys(ruled).length === 1) {
        return `${renderData(data)} is a value the schema rules out (not one of ${cappedValues(ruled.enum)})`;
      }
      return `${renderData(data)} is a value the schema rules out`;
    }
    default:
      return genericMessage(error);
  }
}

/**
 * The same finding as a predicate on a named subject — "must be at most 17" —
 * for conditional messages ("when …, people[2].age must be at most 17").
 * Null for a keyword with no such phrasing (the caller uses the sentence).
 */
function predicate(error: AjvErrorLike, spec: ValueSpec | undefined): string | null {
  const p = error.params;
  switch (error.keyword) {
    case 'const': {
      const label = labelOf(spec, p.allowedValue);
      return `must be ${renderData(p.allowedValue)}${label === undefined ? '' : ` (${label})`}`;
    }
    case 'enum':
      return `must be one of ${cappedValues(Array.isArray(p.allowedValues) ? p.allowedValues : [])}`;
    case 'type':
      return `must be ${typeList(p.type)}`;
    case 'minimum':
      return `must be at least ${formatBound(num(p.limit))}`;
    case 'maximum':
      return `must be at most ${formatBound(num(p.limit))}`;
    case 'exclusiveMinimum':
      return `must be greater than ${formatBound(num(p.limit))}`;
    case 'exclusiveMaximum':
      return `must be less than ${formatBound(num(p.limit))}`;
    case 'multipleOf':
      return `must be a multiple of ${renderData(p.multipleOf)}`;
    case 'minLength':
      return `must have at least ${plural(num(p.limit), 'character')}`;
    case 'maxLength':
      return `must have at most ${plural(num(p.limit), 'character')}`;
    case 'pattern':
      return typeof p.pattern === 'string' ? `must match ${p.pattern}` : null;
    case 'format':
      return `must be a valid ${formatNoun(String(p.format))}`;
    case 'not': {
      const ruled = error.schema;
      if (isRecord(ruled) && Object.hasOwn(ruled, 'const') && Object.keys(ruled).length === 1) {
        const label = labelOf(spec, ruled.const);
        return `must not be ${renderData(ruled.const)}${label === undefined ? '' : ` (${label})`}`;
      }
      if (isRecord(ruled) && Array.isArray(ruled.enum) && Object.keys(ruled).length === 1) {
        return `must not be one of ${cappedValues(ruled.enum)}`;
      }
      return 'must not match the value the schema rules out';
    }
    case 'false schema':
      return 'must be absent';
    case 'minItems':
      return `must have at least ${plural(num(p.limit), 'item')}`;
    case 'maxItems':
      return `must have at most ${plural(num(p.limit), 'item')}`;
    case 'items':
    case 'additionalItems':
    case 'unevaluatedItems': {
      const limit = itemLimit(p);
      return Number.isFinite(limit) ? `must have at most ${plural(limit, 'item')}` : null;
    }
    case 'uniqueItems':
      return 'must not repeat items';
    case 'minProperties':
      return `must have at least ${plural(num(p.limit), 'field')}`;
    case 'maxProperties':
      return `must have at most ${plural(num(p.limit), 'field')}`;
    case 'required':
      return `must have the field ${quoteName(p.missingProperty)}`;
    case 'additionalProperties':
      return `must not have the field ${quoteName(p.additionalProperty)}`;
    case 'unevaluatedProperties':
      return `must not have the field ${quoteName(p.unevaluatedProperty)}`;
    case 'dependentRequired':
    case 'dependencies':
      return `must have the field ${quoteName(p.missingProperty)} when ${quoteName(p.property)} is present`;
    default:
      return null;
  }
}

/** Predicates whose subject's value adds nothing ("Found …" is omitted). */
const NO_FOUND = new Set([
  'required',
  'additionalProperties',
  'unevaluatedProperties',
  'dependentRequired',
  'dependencies',
  'not',
]);

// ---------------------------------------------------------------------------
// Columns, paths, conditions
// ---------------------------------------------------------------------------

const escapeSegment = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');
const unescapeSegment = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~');

/**
 * The record key an `instancePath` is under, unescaped (`/bp (mm~1Hg)/2` →
 * `bp (mm/Hg)`). `/` is the key '' — a column like any other; `''` (the
 * record itself) is no column.
 */
function columnOf(instancePath: string): string | null {
  if (instancePath === '') return null;
  const end = instancePath.indexOf('/', 1);
  return unescapeSegment(end === -1 ? instancePath.slice(1) : instancePath.slice(1, end));
}

const columnPath = (column: string): string => `/${escapeSegment(column)}`;

/**
 * ` (at people[2].age)` for an error below the column's own value, '' for
 * one at it. Without a `locate`, the path is the JSON Pointer below the
 * column: `` (at `/2/street`) ``.
 */
function locationSuffix(error: AjvErrorLike, column: string, locate?: Locate): string {
  const prefix = columnPath(column);
  if (error.instancePath === prefix || !error.instancePath.startsWith(`${prefix}/`)) return '';
  if (locate === undefined) return ` (at \`${error.instancePath.slice(prefix.length)}\`)`;
  return ` (at ${locate(error.instancePath)})`;
}

/** One condition a finding holds under: an `if`'s clause, or a dependent trigger. */
interface Clause {
  /** The condition in words — never empty. */
  text: string;
  /** True for an `else` clause: the finding holds when the condition does NOT. */
  negated: boolean;
  /** The root `items.allOf` digest rule this clause is, when there is one. */
  rule?: ConditionalRule;
  comment?: string;
  key: string;
}

/** "when a = 1" / "unless a = 1" / "when a = 1 and not (b = 2)". */
function clausePhrase(clauses: readonly Clause[]): string {
  const [only] = clauses;
  if (clauses.length === 1 && only !== undefined) return only.negated ? `unless ${only.text}` : `when ${only.text}`;
  return `when ${clauses.map((c) => (c.negated ? `not (${c.text})` : c.text)).join(' and ')}`;
}

const ruleOf = (clauses: readonly Clause[]): ConditionalRule | undefined => clauses.find((c) => c.rule !== undefined)?.rule;
const noteOf = (clauses: readonly Clause[]): string => {
  const comment = clauses.find((c) => c.comment !== undefined)?.comment;
  return comment === undefined ? '' : ` [Schema note: ${comment}]`;
};

/** Root-inline conditional paths (`#/allOf/12/then/…`): the digest's rule index and clause. */
const CONDITIONAL_SCHEMA_PATH = /^#\/allOf\/(\d+)\/(then|else)(?:\/|$)/;
const CONDITIONAL_IF_PATH = /^#\/allOf\/(\d+)\/if$/;

/** Keywords whose next schemaPath segment is a NAME, not a keyword. */
const NAME_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
/** Keywords whose next schemaPath segment is an index. */
const INDEX_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** The `dependentSchemas` / `dependencies` triggers an inline schemaPath passes through. */
function dependentKeysInPath(schemaPath: string): string[] {
  const hash = schemaPath.indexOf('#');
  const fragment = hash === -1 ? schemaPath : schemaPath.slice(hash + 1);
  const segments = fragment.split('/').slice(1);
  const keys: string[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (NAME_KEYWORDS.has(segment)) {
      const name = segments[i + 1];
      if (name === undefined) break;
      if (segment === 'dependentSchemas' || segment === 'dependencies') {
        let decoded = name;
        try {
          decoded = decodeURIComponent(name);
        } catch {
          // keep the raw segment
        }
        keys.push(unescapeSegment(decoded));
      }
      i += 1;
    } else if (INDEX_KEYWORDS.has(segment) || (segment === 'items' && /^\d+$/.test(segments[i + 1] ?? ''))) {
      i += 1;
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Rendering the tree
// ---------------------------------------------------------------------------

interface CondGroup {
  column: string;
  instancePath: string;
  clauses: readonly Clause[];
  errors: AjvErrorLike[];
}

class RowRenderer {
  readonly flags: QCFlag[] = [];
  private readonly groups = new Map<string, CondGroup>();
  private readonly seenColumnFlags = new Set<string>();

  constructor(
    private readonly row: number,
    private readonly ctx: TranslateCtx,
    private readonly locate: Locate | undefined,
    private readonly probe: SchemaProbe | undefined,
  ) {}

  private castFailed(column: string): boolean {
    return this.ctx.castFailures.has(`${String(this.row)} ${column}`);
  }

  /** A value by where it is: `people[2].age` (located), else its key and pointer. */
  private subjectOf(instancePath: string): string {
    const column = columnOf(instancePath) ?? '';
    if (instancePath === columnPath(column)) return column;
    return this.locate !== undefined
      ? this.locate(instancePath)
      : `${column}${instancePath.slice(columnPath(column).length)}`;
  }

  /** The dependent clause an error's schema object applies under, if any. */
  private dependentClause(error: AjvErrorLike, clauses: readonly Clause[]): Clause | null {
    const keys = new Set(dependentKeysInPath(error.schemaPath));
    for (const key of this.probe?.dependentKeys(error.parentSchema) ?? []) keys.add(key);
    if (keys.size === 0) return null;
    const sorted = [...keys].sort();
    const key = `dep:${sorted.join('\u0000')}`;
    if (clauses.some((c) => c.key === key)) return null;
    return { text: sorted.map((k) => `${quoteName(k)} is present`).join(' and '), negated: false, key };
  }

  private withDependent(error: AjvErrorLike, clauses: readonly Clause[]): readonly Clause[] {
    const dependent = this.dependentClause(error, clauses);
    return dependent === null ? clauses : [...clauses, dependent];
  }

  /** The clause a failed `then` / `else` adds. */
  private ifClause(node: IfNode): Clause {
    const error = node.error;
    const match = CONDITIONAL_IF_PATH.exec(error.schemaPath);
    const rule = match === null ? undefined : this.ctx.conditionalByIndex.get(Number(match[1]));
    const parent = isRecord(error.parentSchema) ? error.parentSchema : undefined;
    const ifSchema = parent?.if ?? error.schema;
    // An `if` below the record names its properties by where they are.
    const subject = error.instancePath === '' ? undefined : this.subjectOf(error.instancePath);
    const name = (p: string): string => (subject === undefined ? p : `${subject}.${p}`);
    let text =
      rule?.conditionText ??
      describeCondition(ifSchema, subject) ??
      `the condition at ${error.schemaPath} holds`;
    if (node.clause === 'then') {
      const missing = vacuousProperties(ifSchema, error.data).map(name);
      if (missing.length > 0) {
        const verb = missing.length === 1 ? 'is' : 'are';
        text += ` (${joinAnd(missing)} ${verb} missing, which satisfies the condition)`;
      }
    }
    const comment = rule?.comment ?? (typeof parent?.$comment === 'string' ? parent.$comment : undefined);
    return {
      text,
      negated: node.clause === 'else',
      ...(rule === undefined ? {} : { rule }),
      ...(comment === undefined ? {} : { comment }),
      key: `if:${error.schemaPath}:${node.clause}`,
    };
  }

  /**
   * A root-inline `then`/`else` error with no `if` wrapper in sight (a
   * recording, a filtered list): the digest still knows its condition.
   */
  private digestClause(error: AjvErrorLike): Clause | null {
    const match = CONDITIONAL_SCHEMA_PATH.exec(error.schemaPath);
    if (match === null) return null;
    const rule = this.ctx.conditionalByIndex.get(Number(match[1]));
    if (rule === undefined) return null;
    return {
      text: rule.conditionText,
      negated: match[2] === 'else',
      rule,
      ...(rule.comment === undefined ? {} : { comment: rule.comment }),
      key: `if:#/allOf/${String(rule.index)}/if:${match[2] ?? 'then'}`,
    };
  }

  render(nodes: readonly ErrorNode[], clauses: readonly Clause[]): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'leaf':
          this.leaf(node.error, clauses);
          break;
        case 'union':
          this.union(node, this.withDependent(node.error, clauses));
          break;
        case 'if': {
          const scoped = this.withDependent(node.error, clauses);
          const clause = this.ifClause(node);
          this.render(node.children, scoped.some((c) => c.key === clause.key) ? scoped : [...scoped, clause]);
          break;
        }
        case 'contains':
          this.contains(node, this.withDependent(node.error, clauses));
          break;
        case 'propertyNames':
          this.names(node, this.withDependent(node.error, clauses));
          break;
      }
    }
  }

  private leaf(error: AjvErrorLike, outer: readonly Clause[]): void {
    let clauses = this.withDependent(error, outer);
    if (clauses.length === 0) {
      const digest = this.digestClause(error);
      if (digest !== null) clauses = [digest];
    }
    if (error.instancePath === '') {
      this.rootLeaf(error, clauses);
      return;
    }
    const column = columnOf(error.instancePath) ?? '';
    if (this.castFailed(column)) return;
    if (clauses.length > 0) {
      this.groupConditional(error, column, clauses);
      return;
    }
    this.flags.push(this.keywordFlag(error, column));
  }

  private keywordFlag(error: AjvErrorLike, column: string): QCFlag {
    const meta = this.ctx.metaByName.get(column);
    const body = keywordBody(error, meta?.valueSpec, this.locate);
    return {
      source: 'schema',
      ruleId: schemaPropRuleId(column, 'value'),
      scope: 'cell',
      row: this.row,
      column,
      severity: 'error',
      message: `${body}${locationSuffix(error, column, this.locate)}.${trailers(meta)}`,
      ...(error.data === undefined ? {} : { value: error.data }),
      meta: { keyword: error.keyword, schemaPath: error.schemaPath },
    };
  }

  private rowFlag(error: AjvErrorLike, body: string, clauses: readonly Clause[]): void {
    const rule = ruleOf(clauses);
    const lead = clauses.length === 0 ? '' : `${clausePhrase(clauses)}, `;
    this.flags.push({
      source: 'schema',
      ruleId: `schema:row:${error.keyword}`,
      scope: 'row',
      row: this.row,
      severity: 'error',
      message: `${lead}${body}.${noteOf(clauses)}`,
      meta: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
      },
    });
  }

  private columnFlag(column: string, message: string, error: AjvErrorLike): void {
    if (this.seenColumnFlags.has(column)) return; // first occurrence wins
    this.seenColumnFlags.add(column);
    this.flags.push({
      source: 'schema',
      ruleId: schemaColumnRuleId(column, 'unexpected'),
      scope: 'column',
      column,
      severity: 'error',
      message,
      meta: { keyword: error.keyword, schemaPath: error.schemaPath },
    });
  }

  /** "value is missing" on a cell — for every record, or under its conditions. */
  private requiredCell(error: AjvErrorLike, column: string, clauses: readonly Clause[]): void {
    if (this.castFailed(column)) return;
    if (clauses.length === 0) {
      if (this.ctx.missingRequired.has(column)) return; // the column flag covers it
      this.flags.push({
        source: 'schema',
        ruleId: schemaPropRuleId(column, 'required'),
        scope: 'cell',
        row: this.row,
        column,
        severity: 'error',
        message: REQUIRED_CELL_MESSAGE,
        meta: { keyword: 'required', schemaPath: error.schemaPath },
      });
      return;
    }
    const rule = ruleOf(clauses);
    this.flags.push({
      source: 'schema',
      ruleId: rule === undefined ? schemaPropRuleId(column, 'required') : schemaCondRuleId(rule.index, column),
      scope: 'cell',
      row: this.row,
      column,
      severity: 'error',
      message: `value is missing — this variable is required ${clausePhrase(clauses)}.${noteOf(clauses)}`,
      meta: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
      },
    });
  }

  /** An error about the record itself (`instancePath ''`). */
  private rootLeaf(error: AjvErrorLike, clauses: readonly Clause[]): void {
    const p = error.params;
    switch (error.keyword) {
      case 'required':
        if (typeof p.missingProperty === 'string') {
          this.requiredCell(error, p.missingProperty, clauses);
          return;
        }
        break;
      case 'dependentRequired':
      case 'dependencies':
        if (typeof p.missingProperty === 'string' && typeof p.property === 'string') {
          const trigger: Clause = {
            text: `${quoteName(p.property)} is present`,
            negated: false,
            key: `dep:${p.property}`,
          };
          const scoped = clauses.some((c) => c.key === trigger.key) ? clauses : [...clauses, trigger];
          this.requiredCell(error, p.missingProperty, scoped);
          return;
        }
        break;
      case 'additionalProperties':
        if (typeof p.additionalProperty === 'string') {
          this.columnFlag(p.additionalProperty, notAllowedColumnMessage(p.additionalProperty, 'additionalProperties'), error);
          return;
        }
        break;
      case 'unevaluatedProperties':
        if (typeof p.unevaluatedProperty === 'string') {
          this.columnFlag(p.unevaluatedProperty, notAllowedColumnMessage(p.unevaluatedProperty, 'unevaluatedProperties'), error);
          return;
        }
        break;
      case 'minProperties':
      case 'maxProperties': {
        const limit = num(p.limit);
        const has = isRecord(error.data) ? `has ${plural(Object.keys(error.data).length, 'field')}; ` : '';
        const bound =
          error.keyword === 'maxProperties'
            ? `at most ${formatBound(limit)} allowed`
            : `at least ${formatBound(limit)} required`;
        this.rowFlag(error, `the record ${has}${bound}`, clauses);
        return;
      }
      case 'type': {
        const expected = typeList(p.type);
        const body =
          error.data === undefined
            ? `the record must be ${expected}`
            : `the record is ${typeNoun(jsonTypeOf(error.data))}, not ${expected}`;
        this.rowFlag(error, body, clauses);
        return;
      }
      case 'false schema':
        this.rowFlag(error, 'the schema allows no record here', clauses);
        return;
      case 'not': {
        const ruledOut = describeCondition(error.schema);
        this.rowFlag(
          error,
          ruledOut === null
            ? 'the record matches a schema it must not match'
            : `the record must not satisfy: ${ruledOut}`,
          clauses,
        );
        return;
      }
      default:
        break;
    }
    this.rowFlag(error, genericMessage(error), clauses);
  }

  /** Collect a conditional finding; groups become flags in `finish`. */
  private groupConditional(error: AjvErrorLike, column: string, clauses: readonly Clause[]): void {
    const key = `${clauses.map((c) => c.key).join('\u0001')}\u0000${column}\u0000${error.instancePath}`;
    const group = this.groups.get(key);
    if (group === undefined) this.groups.set(key, { column, instancePath: error.instancePath, clauses, errors: [error] });
    else group.errors.push(error);
  }

  private conditionalFlags(group: CondGroup): QCFlag[] {
    const { column, instancePath, clauses } = group;
    const meta = this.ctx.metaByName.get(column);
    const spec = meta?.valueSpec;
    const rule = ruleOf(clauses);
    const atColumn = instancePath === columnPath(column);
    const negated = clauses.find((c) => c.rule === rule)?.negated ?? false;
    const ruleId = rule === undefined ? schemaPropRuleId(column, 'value') : schemaCondRuleId(rule.index, column);
    const trailer = rule === undefined ? trailers(meta) : '';
    const note = noteOf(clauses);
    const metaOf = (e: AjvErrorLike): QCFlag['meta'] => ({
      keyword: e.keyword,
      schemaPath: e.schemaPath,
      ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
    });
    const first = group.errors[0];
    if (first === undefined) return [];
    const phrase = clausePhrase(clauses);

    // The digest's own target text, for a const-shaped rule at the column.
    const target: ConditionalTarget | undefined =
      rule !== undefined && atColumn
        ? rule.targets.find(
            (t) =>
              t.column === column &&
              (t.clause === 'else') === negated &&
              (t.kind === 'const' || t.kind === 'not-const' || t.kind === 'not-enum'),
          )
        : undefined;
    const subject = this.subjectOf(instancePath);

    if (target !== undefined) {
      // "Found {v}." adds nothing for not-const targets (the found value IS the
      // prohibited one — golden #4 omits it; golden #3 keeps it).
      const found = target.kind === 'not-const' ? '' : ` Found ${renderData(first.data)}.`;
      return [
        {
          source: 'schema',
          ruleId,
          scope: 'cell',
          row: this.row,
          column,
          severity: 'error',
          message: `${phrase}, ${subject} ${target.text}.${found}${note}${trailer}`,
          ...(first.data === undefined ? {} : { value: first.data }),
          meta: metaOf(first),
        },
      ];
    }

    const predicates = group.errors.map((e) => predicate(e, spec));
    if (predicates.every((p): p is string => p !== null)) {
      const text = [...new Set(predicates)].join(' and ');
      const found = group.errors.every((e) => NO_FOUND.has(e.keyword)) ? '' : ` Found ${renderData(first.data)}.`;
      return [
        {
          source: 'schema',
          ruleId,
          scope: 'cell',
          row: this.row,
          column,
          severity: 'error',
          message: `${phrase}, ${subject} ${text}.${found}${note}${trailer}`,
          ...(first.data === undefined ? {} : { value: first.data }),
          meta: metaOf(first),
        },
      ];
    }
    // No predicate phrasing: each error's own sentence, under the condition.
    return group.errors.map(
      (e): QCFlag => ({
        source: 'schema',
        ruleId,
        scope: 'cell',
        row: this.row,
        column,
        severity: 'error',
        message: `${phrase}, ${keywordBody(e, spec, this.locate)}${locationSuffix(e, column, this.locate)}.${note}${trailer}`,
        ...(e.data === undefined ? {} : { value: e.data }),
        meta: metaOf(e),
      }),
    );
  }

  private union(node: UnionNode, clauses: readonly Clause[]): void {
    const error = node.error;
    if (error.instancePath === '') {
      this.rowUnion(node, clauses);
      return;
    }
    const column = columnOf(error.instancePath) ?? '';
    if (this.castFailed(column)) return;
    const branch = discriminatedBranch(error);
    if (branch !== null && node.branches !== null) {
      const own = node.branches[branch];
      if (own !== undefined && own.length > 0) {
        this.render(own, clauses);
        return;
      }
    }
    const meta = this.ctx.metaByName.get(column);
    const passing = error.params.passingSchemas;
    const atColumn = error.instancePath === columnPath(column);
    const spec = atColumn ? meta?.valueSpec : undefined;
    let body: string;
    if (Array.isArray(passing) && passing.length > 1) {
      const options = passing.map((p) => String(Number(p) + 1));
      body =
        `${renderData(error.data)} matches more than one of the exclusive alternatives ` +
        `(options ${joinAnd(options)}) — it must match exactly one`;
    } else {
      // At the column itself the ValueSpec says it best (the §D.7 goldens);
      // inside a nested value there is no ValueSpec, so the branches speak.
      const expectation = atColumn
        ? spec === undefined
          ? 'a value satisfying the schema'
          : collapseExpectation(spec)
        : describeBranches(error.schema);
      body = `${collapseLead(spec, error.data)} — expected ${expectation}`;
    }
    const rule = ruleOf(clauses);
    const lead = clauses.length === 0 ? '' : `${clausePhrase(clauses)}, `;
    this.flags.push({
      source: 'schema',
      ruleId: rule === undefined ? schemaPropRuleId(column, 'value') : schemaCondRuleId(rule.index, column),
      scope: 'cell',
      row: this.row,
      column,
      severity: 'error',
      message:
        `${lead}${body}${locationSuffix(error, column, this.locate)}.` +
        `${noteOf(clauses)}${rule === undefined ? trailers(meta) : ''}`,
      ...(error.data === undefined ? {} : { value: error.data }),
      meta: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
      },
    });
  }

  /** A failed union over the whole record: one row flag naming the alternatives. */
  private rowUnion(node: UnionNode, clauses: readonly Clause[]): void {
    const error = node.error;
    const branches = Array.isArray(error.schema) ? error.schema : null;
    const passing = error.params.passingSchemas;
    const exclusive = error.keyword === 'oneOf';
    if (Array.isArray(passing) && passing.length > 1) {
      const options = passing.map((p) => String(Number(p) + 1));
      this.rowFlag(
        error,
        `the record matches more than one of the exclusive alternatives (options ${joinAnd(options)}) — it must match exactly one`,
        clauses,
      );
      return;
    }
    const soleRequired = branches?.map((b) =>
      isRecord(b) &&
      Object.keys(b).every((k) => k === 'required' || k === 'title' || k === 'description' || k === '$comment') &&
      Array.isArray(b.required) &&
      b.required.length === 1 &&
      typeof b.required[0] === 'string'
        ? b.required[0]
        : null,
    );
    if (soleRequired !== undefined && soleRequired.length > 0 && soleRequired.every((n) => n !== null)) {
      const list = soleRequired.map(quoteName).join(', ');
      this.rowFlag(error, `the record needs ${exclusive ? 'exactly' : 'at least'} one of: ${list}`, clauses);
      return;
    }
    const described = branches?.map((b) => describeCondition(b));
    if (described !== undefined && described.length > 0 && described.every((d): d is string => d !== null)) {
      this.rowFlag(
        error,
        `the record must satisfy ${exclusive ? 'exactly' : 'at least'} one of: ${described.join('; ')}`,
        clauses,
      );
      return;
    }
    const count = branches === null ? '' : ` ${String(branches.length)}`;
    this.rowFlag(
      error,
      `the record satisfies ${exclusive ? 'not exactly one' : 'none'} of the schema's${count} alternatives (schema: ${error.schemaPath})`,
      clauses,
    );
  }

  private contains(node: ContainsNode, clauses: readonly Clause[]): void {
    const error = node.error;
    const body = containsBody(error, node.matches);
    if (error.instancePath === '') {
      this.rowFlag(error, `the record ${body}`, clauses);
      return;
    }
    const column = columnOf(error.instancePath) ?? '';
    if (this.castFailed(column)) return;
    const meta = this.ctx.metaByName.get(column);
    const rule = ruleOf(clauses);
    const lead = clauses.length === 0 ? '' : `${clausePhrase(clauses)}, `;
    this.flags.push({
      source: 'schema',
      ruleId: rule === undefined ? schemaPropRuleId(column, 'value') : schemaCondRuleId(rule.index, column),
      scope: 'cell',
      row: this.row,
      column,
      severity: 'error',
      message:
        `${lead}${body}${locationSuffix(error, column, this.locate)}.` +
        `${noteOf(clauses)}${rule === undefined ? trailers(meta) : ''}`,
      ...(error.data === undefined ? {} : { value: error.data }),
      meta: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
      },
    });
  }

  /** Why a name failed `propertyNames`: "names must match ^[a-z]+$". */
  private nameReason(node: NamesNode): string | null {
    const reasons: string[] = [];
    for (const child of node.children) {
      if (child.kind !== 'leaf') return reasons.length > 0 ? reasons.join(' and ') : null;
      const text = predicate(child.error, undefined);
      if (text !== null && !reasons.includes(`names ${text}`)) reasons.push(`names ${text}`);
    }
    if (reasons.length > 0) return reasons.join(' and ');
    return typeof node.error.params.namePattern === 'string'
      ? `names must match ${node.error.params.namePattern}`
      : null;
  }

  private names(node: NamesNode, clauses: readonly Clause[]): void {
    const error = node.error;
    const name = typeof error.params.propertyName === 'string' ? error.params.propertyName : String(error.params.propertyName);
    const reason = this.nameReason(node);
    if (error.instancePath === '') {
      // A record key the schema's names rule out is a column it does not allow.
      this.columnFlag(name, notAllowedColumnMessage(name, reason ?? 'propertyNames'), error);
      return;
    }
    const column = columnOf(error.instancePath) ?? '';
    if (this.castFailed(column)) return;
    const meta = this.ctx.metaByName.get(column);
    const rule = ruleOf(clauses);
    const lead = clauses.length === 0 ? '' : `${clausePhrase(clauses)}, `;
    this.flags.push({
      source: 'schema',
      ruleId: rule === undefined ? schemaPropRuleId(column, 'value') : schemaCondRuleId(rule.index, column),
      scope: 'cell',
      row: this.row,
      column,
      severity: 'error',
      message:
        `${lead}field name ${quoteName(name)} is not allowed${reason === null ? '' : ` (${reason})`}` +
        `${locationSuffix(error, column, this.locate)}.${noteOf(clauses)}${rule === undefined ? trailers(meta) : ''}`,
      value: name,
      meta: {
        keyword: error.keyword,
        schemaPath: error.schemaPath,
        ...(rule === undefined ? {} : { conditionalIndex: rule.index }),
      },
    });
  }

  finish(): QCFlag[] {
    for (const group of this.groups.values()) this.flags.push(...this.conditionalFlags(group));
    // One finding once: a subschema reached twice (an `allOf` and a
    // dependent entry naming the same `$defs`) raises the same error twice.
    const seen = new Set<string>();
    return this.flags.filter((f) => {
      const key = `${f.scope}\u0000${f.ruleId}\u0000${f.column ?? ''}\u0000${f.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

/**
 * §D.3 — translate one row's Ajv errors into flags. Pure; output sorted by
 * `(row, columnOrdinal, ruleId, message)`. Without a probe the result does
 * not depend on input order; with one the errors are read in Ajv's order,
 * as the worker hands them over.
 */
export function translateRowErrors(
  errors: readonly AjvErrorLike[],
  row: number,
  ctx: TranslateCtx,
  opts?: Locate | TranslateOptions,
): QCFlag[] {
  const { locate, probe }: TranslateOptions = typeof opts === 'function' ? { locate: opts } : (opts ?? {});
  // Ajv emits no `allOf` error of its own; older recordings may carry one.
  const relevant = errors.filter((e) => e.keyword !== 'allOf');
  const tree = buildErrorTree(relevant, probe);
  const renderer = new RowRenderer(row, ctx, locate, probe);
  renderer.render(tree, []);
  const flags = renderer.finish();

  const ordinal = (column: string): number => ctx.ordinalByName.get(column) ?? ctx.ordinalByName.size;
  // Deterministic output: (row is constant) columnOrdinal, ruleId, message.
  return flags.sort((a, b) => {
    const ordA = a.column === undefined ? -1 : ordinal(a.column);
    const ordB = b.column === undefined ? -1 : ordinal(b.column);
    if (ordA !== ordB) return ordA - ordB;
    if (a.column !== b.column) return (a.column ?? '') < (b.column ?? '') ? -1 : 1;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}
