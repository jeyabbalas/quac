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
import { formatBound, renderExpectation, renderValue } from './value-spec';
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
}

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

function renderData(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return renderValue(value);
  }
  return value === undefined ? 'value' : JSON.stringify(value);
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

/** ` (at \`/2/street\`)` suffix for errors nested below the column value. */
function deepPathSuffix(error: AjvErrorLike, column: string): string {
  const prefix = `/${column}`;
  if (error.instancePath === prefix || !error.instancePath.startsWith(`${prefix}/`)) return '';
  return ` (at \`${error.instancePath.slice(prefix.length)}\`)`;
}

function stableErrorOrder(a: AjvErrorLike, b: AjvErrorLike): number {
  if (a.instancePath !== b.instancePath) return a.instancePath < b.instancePath ? -1 : 1;
  if (a.schemaPath !== b.schemaPath) return a.schemaPath < b.schemaPath ? -1 : 1;
  if (a.keyword !== b.keyword) return a.keyword < b.keyword ? -1 : 1;
  const pa = JSON.stringify(a.params);
  const pb = JSON.stringify(b.params);
  return pa < pb ? -1 : pa > pb ? 1 : 0;
}

/** §D.6 keyword table — one flag per remaining single-keyword error. */
function keywordFlag(error: AjvErrorLike, row: number, column: string, meta: ColumnMeta | undefined): QCFlag {
  const spec = meta?.valueSpec;
  const suffix = deepPathSuffix(error, column);
  let message: string;
  switch (error.keyword) {
    case 'pattern': {
      const pattern = typeof error.params.pattern === 'string' ? error.params.pattern : '';
      const description = spec?.kind === 'string-pattern' ? spec.patternDescription : undefined;
      const gloss = description === undefined ? '' : ` — ${description.replace(/\.$/, '')}`;
      message = `${renderData(error.data)} does not match the expected format (pattern ${pattern}${gloss}).`;
      break;
    }
    case 'enum': {
      const allowed = Array.isArray(error.params.allowedValues) ? error.params.allowedValues : [];
      const list = allowed.map(renderData).join(', ');
      message = `${renderData(error.data)} is not an allowed value — expected one of ${list}.`;
      break;
    }
    case 'type': {
      const expected = Array.isArray(error.params.type)
        ? error.params.type.join(' or ')
        : String(error.params.type);
      const actual = error.data === null ? 'null' : typeof error.data;
      message = `must be ${article(expected)} ${expected}, got ${actual}.`;
      break;
    }
    case 'minimum':
    case 'maximum': {
      const limit = typeof error.params.limit === 'number' ? error.params.limit : NaN;
      message =
        error.keyword === 'minimum'
          ? `${renderData(error.data)} is below the minimum ${formatBound(limit)}.`
          : `${renderData(error.data)} exceeds the maximum ${formatBound(limit)}.`;
      break;
    }
    case 'const': {
      const allowed = error.params.allowedValue;
      const rendered = renderData(allowed);
      let label: string | undefined;
      if (spec !== undefined && (typeof allowed === 'string' || typeof allowed === 'number')) {
        const pools =
          spec.kind === 'codes'
            ? [spec.codes, spec.sentinels]
            : spec.kind === 'mixed' || spec.kind === 'opaque'
              ? []
              : [spec.sentinels];
        for (const pool of pools) {
          const hit = pool.find((s) => s.value === allowed);
          if (hit?.label !== undefined) {
            label = hit.label;
            break;
          }
        }
      }
      message = `must be ${rendered}${label === undefined ? '' : ` (${label})`}.`;
      break;
    }
    default:
      message = genericMessage(error);
  }
  return {
    source: 'schema',
    ruleId: schemaPropRuleId(column, 'value'),
    scope: 'cell',
    row,
    column,
    severity: 'error',
    message: `${message}${suffix}${trailers(meta)}`,
    ...(error.data === undefined ? {} : { value: error.data }),
    meta: { keyword: error.keyword, schemaPath: error.schemaPath },
  };
}

/**
 * §D.3 — translate one row's Ajv errors into flags. Pure; output sorted by
 * `(row, columnOrdinal, ruleId)` and independent of input error order.
 */
export function translateRowErrors(errors: readonly AjvErrorLike[], row: number, ctx: TranslateCtx): QCFlag[] {
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
        for (const error of group) flags.push(keywordFlag(error, row, column, meta));
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
    const required = plainErrors.find((e) => e.keyword === 'required');
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

    // 3e. anyOf/oneOf collapse — union error at exactly the column path.
    const union = plainErrors.find(
      (e) => (e.keyword === 'anyOf' || e.keyword === 'oneOf') && e.instancePath === `/${column}`,
    );
    if (union !== undefined) {
      const spec = meta?.valueSpec;
      const expectation =
        spec === undefined ? 'a value satisfying the schema' : collapseExpectation(spec);
      const multiMatch =
        Array.isArray(union.params.passingSchemas) && union.params.passingSchemas.length > 1
          ? ' (matches more than one exclusive option)'
          : '';
      flags.push({
        source: 'schema',
        ruleId: schemaPropRuleId(column, 'value'),
        scope: 'cell',
        row,
        column,
        severity: 'error',
        message: `${collapseLead(spec, union.data)} — expected ${expectation}${multiMatch}.${trailers(meta)}`,
        ...(union.data === undefined ? {} : { value: union.data }),
        meta: { keyword: union.keyword, schemaPath: union.schemaPath },
      });
      continue; // every other non-conditional bucket error is branch sub-noise
    }

    // 3f. Remaining single-keyword errors → one flag each.
    for (const error of plainErrors) flags.push(keywordFlag(error, row, column, meta));
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
