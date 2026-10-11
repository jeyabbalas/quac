/**
 * Ajv error → QCFlag translator (json-schema-subsystem.md §D). Pure and
 * deterministic: string templating over the P07 digests (ColumnMeta /
 * ValueSpec / ConditionalRule), no Ajv imports, `Intl.NumberFormat('en-US')`
 * via value-spec's formatBound. Golden messages (§D.7) are pinned
 * character-exact in tests/unit/schema/translator.test.ts.
 *
 * Spec deviations (goldens + P02 fixture manifests win over §D prose; see
 * phase-08 Deferred notes): trailers attach only to `schema:prop:<col>:value`
 * messages; conditional messages include the target column name; the
 * anyOf/oneOf collapse for string-pattern specs renders
 * "a {patternTitle} ({humanized regex})" instead of §D.4's "text matching …".
 */
import { formatBound, labelledValuesOf, renderExpectation, renderValue } from './value-spec';
import type { ValueSpec } from './value-spec';
import type { ColumnMeta } from './column-meta';
import type { ConditionalRule } from './conditionals';
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
  readonly missingColumns: ReadonlySet<string>;
  /** Keys `` `${row} ${column}` `` (§C.2). */
  readonly castFailures: ReadonlySet<string>;
}

/** Precompute the per-run lookups; P09's worker builds one per validation run. */
export function createTranslateCtx(
  meta: readonly ColumnMeta[],
  conditionals: readonly ConditionalRule[],
  opts: { missingColumns?: Iterable<string>; castFailures?: Iterable<string> } = {},
): TranslateCtx {
  const metaByName = new Map<string, ColumnMeta>();
  const ordinalByName = new Map<string, number>();
  meta.forEach((m, i) => {
    metaByName.set(m.name, m);
    ordinalByName.set(m.name, i);
  });
  const conditionalByIndex = new Map<number, ConditionalRule>();
  for (const rule of conditionals) conditionalByIndex.set(rule.index, rule);
  return {
    metaByName,
    ordinalByName,
    conditionalByIndex,
    missingColumns: new Set(opts.missingColumns ?? []),
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

const quoteName = (name: unknown): string => `'${String(name)}'`;

const plural = (n: number, noun: string): string =>
  `${formatBound(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Ajv's `format` names, as a reader would say them. */
const FORMAT_NOUNS: Readonly<Record<string, string>> = {
  date: 'date (YYYY-MM-DD)',
  'date-time': 'date and time (ISO 8601)',
  time: 'time of day',
  duration: 'duration (ISO 8601)',
  email: 'email address',
  'idn-email': 'email address',
  hostname: 'host name',
  ipv4: 'IPv4 address',
  ipv6: 'IPv6 address',
  uri: 'URI',
  'uri-reference': 'URI reference',
  iri: 'IRI',
  uuid: 'UUID',
  regex: 'regular expression',
  'json-pointer': 'JSON Pointer',
};

/** What one union branch accepts, in a word or two — from the branch alone, no `$ref` followed. */
function branchNoun(branch: unknown): string | null {
  if (branch === true) return 'any value';
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return null;
  const node = branch as Record<string, unknown>;
  if (Object.hasOwn(node, 'const')) return renderData(node.const);
  if (Array.isArray(node.enum)) return `one of ${node.enum.map(renderData).join(', ')}`;
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

/** The JSON types a union branch accepts, read off the branch alone; null = cannot tell. */
function branchTypes(branch: unknown): ReadonlySet<string> | null {
  if (branch === false) return new Set();
  if (typeof branch !== 'object' || branch === null || Array.isArray(branch)) return null;
  const node = branch as Record<string, unknown>;
  if (typeof node.$ref === 'string') return null;
  if (typeof node.type === 'string') return new Set([node.type]);
  if (Array.isArray(node.type)) return new Set(node.type.map(String));
  if (Object.hasOwn(node, 'const')) return new Set([jsonTypeOf(node.const)]);
  if (Array.isArray(node.enum)) return new Set(node.enum.map(jsonTypeOf));
  return null;
}

/**
 * The one branch of a failed union whose type admits the value, when exactly
 * one does and every branch says its type outright: `{"k": 12}` against a
 * number, a word or a `{k: 0–9}` object can only have meant the object, and
 * the useful finding is the object branch's own — `12 exceeds the maximum 9`
 * — not "is not valid". A branch behind a `$ref` cannot be read here, so a
 * union of `$ref`'d sentinel codes (HESP) never narrows.
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

// ---------------------------------------------------------------------------
// §D.3 translation pipeline
// ---------------------------------------------------------------------------

const CONDITIONAL_SCHEMA_PATH = /^#\/allOf\/(\d+)\/(?:then|else)\//;

interface Bucket {
  column: string;
  errors: AjvErrorLike[];
}

function bucketColumn(error: AjvErrorLike): string | null {
  if (error.instancePath !== '') {
    const segment = error.instancePath.split('/')[1];
    return segment === undefined || segment === '' ? null : segment;
  }
  if (error.keyword === 'required' && typeof error.params.missingProperty === 'string') {
    return error.params.missingProperty;
  }
  return null;
}

/**
 * ` (at people[2].age)` for an error below the column's own value, '' for
 * one at it. Without a `locate`, the path is the JSON Pointer below the
 * column: `` (at `/2/street`) ``.
 */
function locationSuffix(error: AjvErrorLike, column: string, locate?: Locate): string {
  const prefix = `/${column}`;
  if (error.instancePath === prefix || !error.instancePath.startsWith(`${prefix}/`)) return '';
  if (locate === undefined) return ` (at \`${error.instancePath.slice(prefix.length)}\`)`;
  return ` (at ${locate(error.instancePath)})`;
}

function stableErrorOrder(a: AjvErrorLike, b: AjvErrorLike): number {
  if (a.instancePath !== b.instancePath) return a.instancePath < b.instancePath ? -1 : 1;
  if (a.schemaPath !== b.schemaPath) return a.schemaPath < b.schemaPath ? -1 : 1;
  if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
  const pa = JSON.stringify(a.params);
  const pb = JSON.stringify(b.params);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** A finite number from Ajv's params, or NaN. */
const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);

/**
 * §D.6 keyword table — one sentence per remaining single-keyword error,
 * without its final period (the caller adds the location first).
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
      const list = allowed.map(renderData).join(', ');
      return `${renderData(data)} is not an allowed value — expected one of ${list}`;
    }
    case 'type': {
      const expected = Array.isArray(error.params.type)
        ? error.params.type.join(' or ')
        : String(error.params.type);
      return `must be ${article(expected)} ${expected}, got ${jsonTypeOf(data)}`;
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
      const rendered = renderData(allowed);
      let label: string | undefined;
      if (spec !== undefined && (typeof allowed === 'string' || typeof allowed === 'number')) {
        label = labelledValuesOf(spec).find((s) => s.value === allowed && s.label !== undefined)?.label;
      }
      return `must be ${rendered}${label === undefined ? '' : ` (${label})`}`;
    }
    case 'required':
      return `required field ${quoteName(error.params.missingProperty)} is missing`;
    case 'dependentRequired':
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
      const has = typeof data === 'object' && data !== null ? Object.keys(data).length : NaN;
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
    case 'contains': {
      const min = error.params.minContains;
      return typeof min === 'number' && min > 1
        ? `has fewer than ${formatBound(min)} items matching the schema`
        : 'has no item matching the schema';
    }
    case 'maxLength':
    case 'minLength': {
      const length = typeof data === 'string' ? Array.from(data).length : NaN;
      const limit = num(error.params.limit);
      return error.keyword === 'maxLength'
        ? `${renderData(data)} has ${plural(length, 'character')}; at most ${formatBound(limit)} allowed`
        : `${renderData(data)} has ${plural(length, 'character')}; at least ${formatBound(limit)} required`;
    }
    case 'format': {
      const format = String(error.params.format);
      return `${renderData(data)} is not a valid ${FORMAT_NOUNS[format] ?? `'${format}' value`}`;
    }
    case 'false schema':
      return 'no value is allowed here';
    case 'not':
      return `${renderData(data)} is a value the schema rules out`;
    default:
      return genericMessage(error);
  }
}

/** §D.6 keyword table — one flag per remaining single-keyword error. */
function keywordFlag(
  error: AjvErrorLike,
  row: number,
  column: string,
  meta: ColumnMeta | undefined,
  locate?: Locate,
): QCFlag {
  const body = keywordBody(error, meta?.valueSpec, locate);
  return {
    source: 'schema',
    ruleId: schemaPropRuleId(column, 'value'),
    scope: 'cell',
    row,
    column,
    severity: 'error',
    message: `${body}${locationSuffix(error, column, locate)}.${trailers(meta)}`,
    ...(error.data === undefined ? {} : { value: error.data }),
    meta: { keyword: error.keyword, schemaPath: error.schemaPath },
  };
}

/** One flag for a union no branch of which the value satisfies (§D.3e). */
function unionFlag(
  union: AjvErrorLike,
  row: number,
  column: string,
  meta: ColumnMeta | undefined,
  locate?: Locate,
): QCFlag {
  const multiMatch =
    Array.isArray(union.params.passingSchemas) && union.params.passingSchemas.length > 1
      ? ' (matches more than one exclusive option)'
      : '';
  // At the column itself the ValueSpec says it best (the §D.7 goldens);
  // inside a nested value there is no ValueSpec, so the branches speak.
  const atColumn = union.instancePath === `/${column}`;
  const spec = atColumn ? meta?.valueSpec : undefined;
  const expectation = atColumn
    ? spec === undefined
      ? 'a value satisfying the schema'
      : collapseExpectation(spec)
    : describeBranches(union.schema);
  return {
    source: 'schema',
    ruleId: schemaPropRuleId(column, 'value'),
    scope: 'cell',
    row,
    column,
    severity: 'error',
    message:
      `${collapseLead(spec, union.data)} — expected ${expectation}${multiMatch}` +
      `${locationSuffix(union, column, locate)}.${trailers(meta)}`,
    ...(union.data === undefined ? {} : { value: union.data }),
    meta: { keyword: union.keyword, schemaPath: union.schemaPath },
  };
}

const isUnder = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Ajv reports a bad field NAME twice: the name's own failure inside the
 * `propertyNames` subschema (`'LDL-C' does not match … pattern`), then the
 * `propertyNames` error itself. One finding: the second, told the pattern the
 * first one tested.
 */
function foldPropertyNames(errors: readonly AjvErrorLike[]): AjvErrorLike[] {
  const wrappers = errors.filter((e) => e.keyword === 'propertyNames');
  if (wrappers.length === 0) return [...errors];
  const inner = (e: AjvErrorLike): AjvErrorLike | undefined =>
    wrappers.find(
      (w) => e !== w && e.instancePath === w.instancePath && e.schemaPath.startsWith(`${w.schemaPath}/`),
    );
  const patternFor = new Map<AjvErrorLike, string>();
  const kept: AjvErrorLike[] = [];
  for (const e of errors) {
    const wrapper = inner(e);
    if (wrapper === undefined) {
      kept.push(e);
      continue;
    }
    if (e.keyword === 'pattern' && typeof e.params.pattern === 'string') {
      patternFor.set(wrapper, e.params.pattern);
    }
  }
  return kept.map((e) => {
    const pattern = patternFor.get(e);
    return pattern === undefined ? e : { ...e, params: { ...e.params, namePattern: pattern } };
  });
}

/**
 * §D.3e for every union in a bucket, outermost first. A union whose value
 * only one branch could have meant hands over to that branch's own errors
 * (`discriminatedBranch`); any other collapses to ONE flag and silences
 * everything at or below it — the branch sub-errors are noise. At the column
 * itself this is the §D.3e collapse exactly; inside a nested value it is the
 * same rule one level down.
 */
function settleUnions(
  errors: readonly AjvErrorLike[],
  row: number,
  column: string,
  meta: ColumnMeta | undefined,
  locate?: Locate,
): QCFlag[] {
  let remaining = foldPropertyNames(errors);
  const flags: QCFlag[] = [];
  const unions = remaining
    .filter((e) => e.keyword === 'anyOf' || e.keyword === 'oneOf')
    .sort((a, b) => a.instancePath.length - b.instancePath.length || stableErrorOrder(a, b));
  for (const union of unions) {
    if (!remaining.includes(union)) continue; // an outer union already spoke for it
    const at = union.instancePath;
    const branch = discriminatedBranch(union);
    if (branch !== null) {
      // The other branches' type mismatches at this very value are not findings.
      const narrowed = remaining.filter(
        (e) => e !== union && !(e.instancePath === at && e.keyword === 'type'),
      );
      if (narrowed.some((e) => isUnder(e.instancePath, at))) {
        remaining = narrowed;
        continue;
      }
    }
    remaining = remaining.filter((e) => e !== union && !isUnder(e.instancePath, at));
    flags.push(unionFlag(union, row, column, meta, locate));
  }
  for (const error of remaining) flags.push(keywordFlag(error, row, column, meta, locate));
  return flags;
}

/**
 * §D.3 — translate one row's Ajv errors into flags. Pure; output sorted by
 * `(row, columnOrdinal, ruleId)` and independent of input error order.
 */
export function translateRowErrors(
  errors: readonly AjvErrorLike[],
  row: number,
  ctx: TranslateCtx,
  locate?: Locate,
): QCFlag[] {
  // 1. Drop wrappers.
  const relevant = errors.filter((e) => e.keyword !== 'if' && e.keyword !== 'allOf');

  // 2. Bucket by column; collect row-level leftovers.
  const buckets = new Map<string, Bucket>();
  const rowLevel: AjvErrorLike[] = [];
  for (const error of relevant) {
    const column = bucketColumn(error);
    if (column === null) {
      rowLevel.push(error);
      continue;
    }
    const bucket = buckets.get(column);
    if (bucket === undefined) buckets.set(column, { column, errors: [error] });
    else bucket.errors.push(error);
  }

  const flags: QCFlag[] = [];
  const ordinal = (column: string): number => ctx.ordinalByName.get(column) ?? ctx.ordinalByName.size;
  const sortedBuckets = [...buckets.values()].sort(
    (a, b) => ordinal(a.column) - ordinal(b.column) || (a.column < b.column ? -1 : 1),
  );

  for (const bucket of sortedBuckets) {
    const { column } = bucket;
    const meta = ctx.metaByName.get(column);
    const bucketErrors = [...bucket.errors].sort(stableErrorOrder);

    // 3a. Cast failure on this cell → the cast flag already covers it.
    if (ctx.castFailures.has(`${String(row)} ${column}`)) continue;

    // 3d. Conditional errors → one flag per (allOfIndex, column) group.
    const conditionalErrors = new Map<number, AjvErrorLike[]>();
    const plainErrors: AjvErrorLike[] = [];
    for (const error of bucketErrors) {
      const match = CONDITIONAL_SCHEMA_PATH.exec(error.schemaPath);
      if (match !== null) {
        const index = Number(match[1]);
        const group = conditionalErrors.get(index);
        if (group === undefined) conditionalErrors.set(index, [error]);
        else group.push(error);
      } else {
        plainErrors.push(error);
      }
    }
    for (const [index, group] of [...conditionalErrors.entries()].sort((a, b) => a[0] - b[0])) {
      const rule = ctx.conditionalByIndex.get(index);
      const first = group[0];
      if (rule === undefined || first === undefined) {
        for (const error of group) flags.push(keywordFlag(error, row, column, meta, locate));
        continue;
      }
      const target = rule.targets.find((t) => t.column === column);
      const targetText = target?.text ?? 'must satisfy the conditional constraint (see schema)';
      // "Found {v}." adds nothing for not-const targets (the found value IS the
      // prohibited one — golden #4 omits it; golden #3 keeps it).
      const found = target?.kind === 'not-const' ? '' : ` Found ${renderData(first.data)}.`;
      const note = rule.comment === undefined ? '' : ` [Schema note: ${rule.comment}]`;
      flags.push({
        source: 'schema',
        ruleId: schemaCondRuleId(index, column),
        scope: 'cell',
        row,
        column,
        severity: 'error',
        message: `when ${rule.conditionText}, ${column} ${targetText}.${found}${note}`,
        ...(first.data === undefined ? {} : { value: first.data }),
        meta: { keyword: first.keyword, schemaPath: first.schemaPath, conditionalIndex: index },
      });
    }

    if (plainErrors.length === 0) continue;

    // 3b/3c. Missing column ⇒ its column flag covers required; required cell.
    // Only the row's own `required` (at the root) means the CELL is missing; a
    // `required` deeper down names a field missing inside the value (3f).
    const required = plainErrors.find((e) => e.keyword === 'required' && e.instancePath === '');
    if (required !== undefined) {
      if (!ctx.missingColumns.has(column)) {
        flags.push({
          source: 'schema',
          ruleId: schemaPropRuleId(column, 'required'),
          scope: 'cell',
          row,
          column,
          severity: 'error',
          message: REQUIRED_CELL_MESSAGE,
          meta: { keyword: 'required', schemaPath: required.schemaPath },
        });
      }
      continue;
    }

    // 3e. anyOf/oneOf collapse, at the column and inside it; 3f. the rest,
    // one flag per single-keyword error.
    flags.push(...settleUnions(plainErrors, row, column, meta, locate));
  }

  // 4. Row-level leftovers.
  const seenUnexpected = new Set<string>();
  for (const error of rowLevel.sort(stableErrorOrder)) {
    if (error.keyword === 'unevaluatedProperties') {
      const column = typeof error.params.unevaluatedProperty === 'string' ? error.params.unevaluatedProperty : '';
      if (seenUnexpected.has(column)) continue; // first occurrence wins
      seenUnexpected.add(column);
      flags.push({
        source: 'schema',
        ruleId: schemaColumnRuleId(column, 'unexpected'),
        scope: 'column',
        column,
        severity: 'error',
        message: unexpectedColumnMessage(column),
        meta: { keyword: error.keyword, schemaPath: error.schemaPath },
      });
      continue;
    }
    flags.push({
      source: 'schema',
      ruleId: `schema:row:${error.keyword}`,
      scope: 'row',
      row,
      severity: 'error',
      message: genericMessage(error),
      meta: { keyword: error.keyword, schemaPath: error.schemaPath },
    });
  }

  // Deterministic output: (row is constant) columnOrdinal, ruleId, message.
  return flags.sort((a, b) => {
    const ordA = a.column === undefined ? -1 : ordinal(a.column);
    const ordB = b.column === undefined ? -1 : ordinal(b.column);
    if (ordA !== ordB) return ordA - ordB;
    if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });
}
