/**
 * What a schema check requires, in words — read from the schema alone, for
 * the findings report (core/report/findings.ts).
 *
 * The translator words a FAILURE, from Ajv's error and the value that failed:
 * "130 exceeds the maximum 120 (at household[2].age)". This words the CHECK,
 * from the keyword and the schema object holding it: "must be at most 120",
 * at `household[].age`. Every input is schema text — a keyword, its schema
 * object, a path through the schema, the variable's digest — so nothing a
 * dataset holds can reach the output. That is what lets the findings report
 * be shared without the data.
 */
import { describeCondition } from './conditionals';
import { getAtPointer } from './deref';
import { formatBound } from './value-spec';
import { branchNoun, collapseExpectation, describeBranches, predicate } from './translator';
import type { ValueSpec } from './value-spec';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const quote = (name: string): string => `'${name}'`;

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

const plural = (n: number, noun: string): string =>
  `${formatBound(n)} ${noun}${n === 1 ? '' : 's'}`;

/** Names past this many are counted, not listed. */
const NAME_LIST_CAP = 8;

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAME_LIST_CAP).map(quote);
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${String(more)} more` : joinAnd(shown);
}

const unescapeSegment = (segment: string): string =>
  segment.replaceAll('~1', '/').replaceAll('~0', '~');

/** RFC 6901 segments of a pointer (`''` → none). */
function segmentsOf(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeSegment);
}

/** Ajv's schemaPath fragment segments, percent-decoded where it encoded them. */
function schemaPathSegments(schemaPath: string): string[] | null {
  if (!schemaPath.startsWith('#/')) return null;
  return schemaPath
    .slice(2)
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // keep the raw segment
      }
      return unescapeSegment(decoded);
    });
}

/** Applicators whose next segment is an index or a name, and which add nothing to a value path. */
const PASS_THROUGH_INDEXED = new Set([
  'allOf',
  'anyOf',
  'oneOf',
  'dependentSchemas',
  'dependencies',
]);
const PASS_THROUGH = new Set(['then', 'else', 'if', 'not']);

/**
 * A path through the schema, from a record's variable down, as a value path:
 * `properties/age` → `.age`, `items` → `[]`, `prefixItems/1` → `[2]`,
 * `additionalProperties` → `.*`. Null when a segment is not one this reads.
 */
function valueSuffix(segments: readonly string[]): string | null {
  let out = '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const next = segments[i + 1];
    if (PASS_THROUGH.has(segment)) continue;
    if (PASS_THROUGH_INDEXED.has(segment)) {
      i += 1;
      continue;
    }
    switch (segment) {
      case 'properties':
        if (next === undefined) return null;
        out += `.${next}`;
        i += 1;
        break;
      case 'patternProperties':
        if (next === undefined) return null;
        out += '.*';
        i += 1;
        break;
      case 'additionalProperties':
      case 'unevaluatedProperties':
        out += '.*';
        break;
      case 'prefixItems':
        if (next === undefined || !/^\d+$/.test(next)) return null;
        out += `[${String(Number(next) + 1)}]`;
        i += 1;
        break;
      case 'items':
        // draft-07's tuple form names a position; 2020-12's is every item.
        if (next !== undefined && /^\d+$/.test(next)) {
          out += `[${String(Number(next) + 1)}]`;
          i += 1;
        } else {
          out += '[]';
        }
        break;
      case 'additionalItems':
      case 'unevaluatedItems':
      case 'contains':
        out += '[]';
        break;
      default:
        return null;
    }
  }
  return out;
}

export interface CheckSubject {
  /** `household[].age` — where in the variable's value the check applies; '' at the value itself. */
  path: string;
  /** True when the check is on the variable's whole value. */
  atValue: boolean;
}

/**
 * Where a check applies within its variable, from Ajv's schemaPath — a path
 * through the SCHEMA, so no list position a value had can show in it. The
 * path is found only when it runs from the record schema to the keyword
 * without leaving its file (a `$ref` restarts Ajv's path in the target); null
 * otherwise, or when the variable is not on it.
 */
export function checkSubject(schemaPath: string | undefined, column: string): CheckSubject | null {
  if (schemaPath === undefined) return null;
  const segments = schemaPathSegments(schemaPath);
  if (segments === null || segments.length === 0) return null;
  const inner = segments.slice(0, -1); // the last segment is the keyword itself
  for (let i = 0; i < inner.length - 1; i += 1) {
    const segment = inner[i] ?? '';
    if (PASS_THROUGH.has(segment)) continue;
    if (PASS_THROUGH_INDEXED.has(segment)) {
      i += 1;
      continue;
    }
    if (segment !== 'properties' || inner[i + 1] !== column) return null;
    const suffix = valueSuffix(inner.slice(i + 2));
    if (suffix === null) return null;
    return { path: suffix === '' ? '' : `${column}${suffix}`, atValue: suffix === '' };
  }
  return null;
}

/** Keyword → the params Ajv would report for it, read from the schema instead. */
function paramsFromSchema(keyword: string, value: unknown): Record<string, unknown> | null {
  switch (keyword) {
    case 'const':
      return { allowedValue: value };
    case 'enum':
      return Array.isArray(value) ? { allowedValues: value } : null;
    case 'type':
      return { type: value };
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'minLength':
    case 'maxLength':
    case 'minItems':
    case 'maxItems':
    case 'minProperties':
    case 'maxProperties':
      return typeof value === 'number' ? { limit: value } : null;
    case 'multipleOf':
      return typeof value === 'number' ? { multipleOf: value } : null;
    case 'format':
      return typeof value === 'string' ? { format: value } : null;
    case 'not':
    case 'uniqueItems':
    case 'false schema':
      return {};
    default:
      return null;
  }
}

export interface RequirementInput {
  keyword: string;
  /** The schema object holding the keyword; null when its place is unknown. */
  parent: Record<string, unknown> | null;
  /** The variable's ValueSpec — read only when `atValue`. */
  spec?: ValueSpec;
  /** The check is on the variable's whole value (checkSubject). */
  atValue: boolean;
}

/**
 * What the keyword requires — "must be at most 120", "must have the fields
 * 'name' and 'dob'", "must be one of 'es', 'fr'" — or null when this has no
 * words for it (the report then names the keyword and its place).
 */
export function keywordRequirement(input: RequirementInput): string | null {
  const { keyword, parent } = input;
  const value = parent?.[keyword];
  const spec = input.atValue ? input.spec : undefined;
  switch (keyword) {
    case 'anyOf':
    case 'oneOf': {
      const lead = keyword === 'oneOf' ? 'must match exactly one of: ' : 'must be ';
      if (keyword === 'anyOf' && spec !== undefined) return `must be ${collapseExpectation(spec)}`;
      return Array.isArray(value) ? `${lead}${describeBranches(value)}` : null;
    }
    case 'pattern': {
      if (typeof value !== 'string') return null;
      const gloss = [parent?.description, parent?.title].find(
        (t): t is string => typeof t === 'string',
      );
      return `must match \`${value}\`${gloss === undefined ? '' : ` (${gloss.replace(/\.$/, '')})`}`;
    }
    case 'required': {
      const names = Array.isArray(value)
        ? value.filter((n): n is string => typeof n === 'string')
        : [];
      if (names.length === 0) return null;
      return names.length === 1
        ? `must have the field ${nameList(names)}`
        : `must have the fields ${nameList(names)}`;
    }
    case 'dependentRequired':
    case 'dependencies': {
      if (!isRecord(value)) return null;
      const pairs = Object.entries(value).flatMap(([trigger, needs]) =>
        Array.isArray(needs) && needs.every((n) => typeof n === 'string')
          ? [`${nameList(needs)} when ${quote(trigger)} is present`]
          : [],
      );
      return pairs.length === 0 ? null : `must have ${pairs.join('; ')}`;
    }
    case 'additionalProperties':
    case 'unevaluatedProperties': {
      const names = isRecord(parent?.properties) ? Object.keys(parent.properties) : [];
      if (value === false) {
        return names.length === 0
          ? 'must have no fields'
          : `must have no fields besides ${nameList(names)}`;
      }
      return names.length === 0
        ? 'every field must satisfy the schema given for it'
        : `every field besides ${nameList(names)} must satisfy the schema given for it`;
    }
    case 'propertyNames': {
      if (!isRecord(value)) return value === false ? 'must have no fields' : null;
      const rule = typeof value.pattern === 'string' ? ` must match \`${value.pattern}\`` : null;
      return rule === null
        ? 'field names must satisfy the schema given for them'
        : `field names${rule}`;
    }
    case 'contains': {
      const min = typeof parent?.minContains === 'number' ? parent.minContains : 1;
      const max = typeof parent?.maxContains === 'number' ? parent.maxContains : undefined;
      const noun = branchNoun(value);
      const what = `matching ${noun ?? 'the schema'}`;
      if (max !== undefined) {
        return min === max
          ? `must contain exactly ${plural(min, 'item')} ${what}`
          : `must contain ${formatBound(min)}–${plural(max, 'item')} ${what}`;
      }
      return `must contain at least ${plural(min, 'item')} ${what}`;
    }
    case 'items':
    case 'additionalItems': {
      // `items: false` after `prefixItems` (or draft-07's tuple `items` +
      // `additionalItems: false`): no items past the ones listed.
      const listed = Array.isArray(parent?.prefixItems)
        ? parent.prefixItems.length
        : Array.isArray(parent?.items)
          ? parent.items.length
          : undefined;
      if (value === false && listed !== undefined)
        return `must have at most ${plural(listed, 'item')}`;
      return null;
    }
    case 'unevaluatedItems':
      return value === false ? 'must have no items beyond the ones the schema describes' : null;
    default: {
      const params = paramsFromSchema(keyword, value);
      if (params === null) return null;
      return predicate(
        { keyword, params, schema: value, parentSchema: parent, instancePath: '', schemaPath: '' },
        spec,
      );
    }
  }
}

/** One condition a check holds under, in words. */
interface Condition {
  text: string;
  negated: boolean;
}

/**
 * The conditions a keyword's place puts it under — an `if`'s `then` / `else`,
 * a `dependentSchemas` entry — from the keyword's pointer in its file, outer
 * condition first: "when status = 'closed'", "unless …", "when 'b' is present".
 * Null when there are none.
 */
export function conditionsAt(json: unknown, pointer: string): string | null {
  const segments = segmentsOf(pointer);
  const conditions: Condition[] = [];
  let container = '';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (segment === 'then' || segment === 'else') {
      const node = getAtPointer(json, container);
      if (node.found && isRecord(node.value) && Object.hasOwn(node.value, 'if')) {
        const text = describeCondition(node.value.if) ?? `the condition at ${container}/if holds`;
        conditions.push({ text, negated: segment === 'else' });
      }
    } else if (
      (segment === 'dependentSchemas' || segment === 'dependencies') &&
      segments[i + 1] !== undefined
    ) {
      const node = getAtPointer(json, `${container}/${segment}`);
      if (node.found && isRecord(node.value)) {
        conditions.push({ text: `${quote(segments[i + 1] ?? '')} is present`, negated: false });
      }
    }
    container += `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  }
  if (conditions.length === 0) return null;
  const [only] = conditions;
  if (conditions.length === 1 && only !== undefined)
    return only.negated ? `unless ${only.text}` : `when ${only.text}`;
  return `when ${conditions.map((c) => (c.negated ? `not (${c.text})` : c.text)).join(' and ')}`;
}
