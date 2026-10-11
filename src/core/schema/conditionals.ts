/**
 * Static digest of the root schema's `items.allOf` if/then/else blocks
 * (json-schema-subsystem.md §D.2) — what tooltips, the report and Studio
 * print for a column's conditional rules — and the condition wording the
 * translator shares for an `if` anywhere in a schema. Pure extraction — no
 * Ajv, no evaluation.
 */
import { getAtPointer } from './deref';
import { formatBound, renderValue } from './value-spec';
import type { JsonPrimitive } from './value-spec';
import type { SchemaSet } from './types';

export interface ConditionalRule {
  /** Position in the root `items.allOf` array. */
  index: number;
  /** The block's $comment. */
  comment?: string;
  conditions: { column: string; value: JsonPrimitive }[];
  /**
   * "baseline_record = 1" / "a = 1 and b = 0" / disjunctions joined " or " —
   * never empty: a condition this cannot word reads as its location.
   */
  conditionText: string;
  /** `then` targets first, then `else` targets (`clause: 'else'`). */
  targets: ConditionalTarget[];
}

export interface ConditionalTarget {
  column: string;
  /** 'schema' = generic fallback (bare enum / anyOf / anything else). */
  kind: 'const' | 'not-const' | 'not-enum' | 'required' | 'schema';
  value?: JsonPrimitive;
  values?: JsonPrimitive[];
  text: string;
  /** Present on an `else` target: it applies when the condition does NOT hold. */
  clause?: 'else';
}

/** Column → sentinel value → label, for "(Not applicable / structural skip)". */
export type SentinelLabelFor = (column: string, value: string | number) => string | undefined;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isPrimitive = (v: unknown): v is JsonPrimitive =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function labelled(value: JsonPrimitive, label: string | undefined): string {
  return label === undefined ? renderValue(value) : `${renderValue(value)} (${label})`;
}

// ---------------------------------------------------------------------------
// Conditions in words
// ---------------------------------------------------------------------------

/** Keywords a condition carries that change nothing about when it holds. */
const ANNOTATIONS = new Set([
  'title',
  'description',
  '$comment',
  '$id',
  '$schema',
  '$anchor',
  'examples',
  'default',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const isAnnotation = (key: string): boolean => ANNOTATIONS.has(key) || key.startsWith('x-');

const TYPE_WORDS: Readonly<Record<string, string>> = {
  integer: 'an integer',
  number: 'a number',
  string: 'a string',
  boolean: 'a boolean',
  null: 'null',
  array: 'an array',
  object: 'an object',
};

const typeWords = (type: unknown): string | null => {
  const list = typeof type === 'string' ? [type] : Array.isArray(type) ? type : null;
  if (list === null || list.length === 0) return null;
  const words = list.map((t) => (typeof t === 'string' ? (TYPE_WORDS[t] ?? t) : String(t)));
  return words.join(' or ');
};

const valueList = (values: readonly unknown[]): string | null =>
  values.every(isPrimitive) ? values.map((v) => renderValue(v)).join(', ') : null;

const quote = (name: string): string => `'${name}'`;

/**
 * What one value must be for a condition to hold, in words — `status = 'closed'`,
 * `age is at least 18`. Null for a keyword this cannot word.
 */
function describeValue(subject: string, sub: unknown, depth: number): string | null {
  if (sub === true) return null;
  if (sub === false) return `${subject} is absent`;
  if (!isObject(sub) || depth > 4) return null;
  const parts: string[] = [];
  const keys = Object.keys(sub).filter((k) => !isAnnotation(k));
  const min = sub.minimum;
  const max = sub.maximum;
  for (const key of keys) {
    const value = sub[key];
    switch (key) {
      case 'const':
        if (!isPrimitive(value)) return null;
        parts.push(`${subject} = ${renderValue(value)}`);
        break;
      case 'enum': {
        const list = Array.isArray(value) ? valueList(value) : null;
        if (list === null) return null;
        parts.push(`${subject} is one of ${list}`);
        break;
      }
      case 'not': {
        if (isObject(value) && isPrimitive(value.const) && Object.keys(value).length === 1) {
          parts.push(`${subject} is not ${renderValue(value.const)}`);
        } else if (isObject(value) && Array.isArray(value.enum) && Object.keys(value).length === 1) {
          const list = valueList(value.enum);
          if (list === null) return null;
          parts.push(`${subject} is not one of ${list}`);
        } else {
          return null;
        }
        break;
      }
      case 'minimum':
        if (typeof value !== 'number') return null;
        parts.push(
          typeof max === 'number'
            ? `${subject} is between ${formatBound(value)} and ${formatBound(max)}`
            : `${subject} is at least ${formatBound(value)}`,
        );
        break;
      case 'maximum':
        if (typeof value !== 'number') return null;
        if (typeof min !== 'number') parts.push(`${subject} is at most ${formatBound(value)}`);
        break;
      case 'exclusiveMinimum':
        if (typeof value !== 'number') return null;
        parts.push(`${subject} is greater than ${formatBound(value)}`);
        break;
      case 'exclusiveMaximum':
        if (typeof value !== 'number') return null;
        parts.push(`${subject} is less than ${formatBound(value)}`);
        break;
      case 'type': {
        const words = typeWords(value);
        if (words === null) return null;
        parts.push(`${subject} is ${words}`);
        break;
      }
      case 'pattern':
        if (typeof value !== 'string') return null;
        parts.push(`${subject} matches ${value}`);
        break;
      case 'minLength':
        if (typeof value !== 'number') return null;
        parts.push(`${subject} has at least ${formatBound(value)} characters`);
        break;
      case 'maxLength':
        if (typeof value !== 'number') return null;
        parts.push(`${subject} has at most ${formatBound(value)} characters`);
        break;
      case 'format':
        if (typeof value !== 'string') return null;
        parts.push(`${subject} is a valid ${value}`);
        break;
      case 'properties':
      case 'required': {
        const nested = describeObject(sub, depth + 1, subject);
        if (nested === null) return null;
        if (key === 'properties' || !keys.includes('properties')) parts.push(nested);
        break;
      }
      default:
        return null;
    }
  }
  return parts.length === 0 ? null : parts.join(' and ');
}

/** `properties` + `required` of one object condition, each property by name. */
function describeObject(node: Record<string, unknown>, depth: number, prefix?: string): string | null {
  const parts: string[] = [];
  const name = (p: string): string => (prefix === undefined ? p : `${prefix}.${p}`);
  const props = node.properties;
  const described = new Set<string>();
  if (props !== undefined) {
    if (!isObject(props)) return null;
    for (const [p, sub] of Object.entries(props)) {
      if (sub === true) continue;
      const text = describeValue(name(p), sub, depth);
      if (text === null) return null;
      parts.push(text);
      described.add(p);
    }
  }
  const required = node.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) return null;
    for (const p of required) {
      if (typeof p !== 'string') return null;
      if (!described.has(p)) parts.push(`${quote(name(p))} is present`);
    }
  }
  return parts.length === 0 ? null : parts.join(' and ');
}

/**
 * An `if` subschema in words — `status = 'closed'`, `age is at least 18`,
 * `'email' is present`, `a = 1 or b = 1`. Null when it holds something this
 * cannot word (the caller then names its location instead). `subject` names
 * the value the condition is about when that is not the record itself — an
 * `if` inside `address` reads `address.country = 'US'`; one on a single
 * value, `age is at least 18`.
 */
export function describeCondition(node: unknown, subject?: string): string | null {
  return conditionWords(node, subject, 0);
}

function conditionWords(node: unknown, subject: string | undefined, depth: number): string | null {
  if (node === true || node === false || !isObject(node) || depth > 4) return null;
  const parts: string[] = [];
  const objectWords = describeObject(node, depth, subject);
  const keys = Object.keys(node).filter((k) => !isAnnotation(k));
  let objectDone = false;
  const valueKeys: Record<string, unknown> = {};
  for (const key of keys) {
    const value = node[key];
    switch (key) {
      case 'properties':
      case 'required':
        if (objectDone) break;
        if (objectWords === null) return null;
        parts.push(objectWords);
        objectDone = true;
        break;
      case 'type':
        // `type: object` on a record's condition only says it is a record.
        if (value === 'object') break;
        valueKeys[key] = value;
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf': {
        if (!Array.isArray(value) || value.length === 0) return null;
        const words = value.map((v) => conditionWords(v, subject, depth + 1));
        if (words.some((w) => w === null)) return null;
        const joined = words.join(key === 'allOf' ? ' and ' : ' or ');
        parts.push(keys.length === 1 || words.length === 1 ? joined : `(${joined})`);
        break;
      }
      case 'not': {
        const inner = conditionWords(value, subject, depth + 1);
        if (inner === null) return null;
        parts.push(`not (${inner})`);
        break;
      }
      default:
        valueKeys[key] = value;
    }
  }
  if (Object.keys(valueKeys).length > 0) {
    const text = describeValue(subject ?? 'the value', valueKeys, depth);
    if (text === null) return null;
    parts.push(text);
  }
  return parts.length === 0 ? null : parts.join(' and ');
}

/**
 * The condition's own properties a value does not have and the condition
 * does not require — a JSON Schema `properties` clause holds for a missing
 * property, so such a condition held without the property in the record.
 */
export function vacuousProperties(ifNode: unknown, data: unknown): string[] {
  if (!isObject(ifNode) || !isObject(ifNode.properties) || !isObject(data)) return [];
  const required = Array.isArray(ifNode.required) ? ifNode.required : [];
  return Object.keys(ifNode.properties).filter((p) => !required.includes(p) && !Object.hasOwn(data, p));
}

// ---------------------------------------------------------------------------
// The root `items.allOf` digest
// ---------------------------------------------------------------------------

/** `if.properties[c].const` pairs from one plain condition object. */
function conditionPairs(ifNode: Record<string, unknown>): { column: string; value: JsonPrimitive }[] {
  const props = ifNode.properties;
  if (!isObject(props)) return [];
  const pairs: { column: string; value: JsonPrimitive }[] = [];
  for (const [column, sub] of Object.entries(props)) {
    if (isObject(sub) && isPrimitive(sub.const)) pairs.push({ column, value: sub.const });
  }
  return pairs;
}

function conditionClause(pairs: readonly { column: string; value: JsonPrimitive }[]): string {
  return pairs.map((p) => `${p.column} = ${renderValue(p.value)}`).join(' and ');
}

const GENERIC_TARGET = 'must satisfy the conditional constraint (see schema)';

/** What a then/else property schema asks of its column, as `must …` text — or null. */
export function predicateText(schema: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (isAnnotation(key)) continue;
    switch (key) {
      case 'enum': {
        const list = Array.isArray(value) ? valueList(value) : null;
        if (list === null) return null;
        parts.push(`must be one of ${list}`);
        break;
      }
      case 'type': {
        const words = typeWords(value);
        if (words === null) return null;
        parts.push(`must be ${words}`);
        break;
      }
      case 'minimum':
        if (typeof value !== 'number') return null;
        parts.push(`must be at least ${formatBound(value)}`);
        break;
      case 'maximum':
        if (typeof value !== 'number') return null;
        parts.push(`must be at most ${formatBound(value)}`);
        break;
      case 'exclusiveMinimum':
        if (typeof value !== 'number') return null;
        parts.push(`must be greater than ${formatBound(value)}`);
        break;
      case 'exclusiveMaximum':
        if (typeof value !== 'number') return null;
        parts.push(`must be less than ${formatBound(value)}`);
        break;
      case 'pattern':
        if (typeof value !== 'string') return null;
        parts.push(`must match ${value}`);
        break;
      case 'minLength':
        if (typeof value !== 'number') return null;
        parts.push(`must have at least ${formatBound(value)} characters`);
        break;
      case 'maxLength':
        if (typeof value !== 'number') return null;
        parts.push(`must have at most ${formatBound(value)} characters`);
        break;
      case 'format':
        if (typeof value !== 'string') return null;
        parts.push(`must be a valid ${value}`);
        break;
      case 'multipleOf':
        if (typeof value !== 'number') return null;
        parts.push(`must be a multiple of ${String(value)}`);
        break;
      default:
        return null;
    }
  }
  return parts.length === 0 ? null : parts.join(' and ');
}

function targetFor(
  column: string,
  schema: unknown,
  labelFor: SentinelLabelFor,
): ConditionalTarget {
  const lookupLabel = (v: JsonPrimitive): string | undefined =>
    typeof v === 'string' || typeof v === 'number' ? labelFor(column, v) : undefined;

  if (schema === false) return { column, kind: 'schema', text: 'must be absent' };
  if (!isObject(schema)) return { column, kind: 'schema', text: GENERIC_TARGET };
  if (isPrimitive(schema.const)) {
    const value = schema.const;
    return {
      column,
      kind: 'const',
      value,
      text: `must be ${labelled(value, lookupLabel(value))}`,
    };
  }
  const not = schema.not;
  if (isObject(not)) {
    if (isPrimitive(not.const)) {
      const value = not.const;
      return {
        column,
        kind: 'not-const',
        value,
        text: `must not be ${labelled(value, lookupLabel(value))} — a substantive or item-missing value is required`,
      };
    }
    if (Array.isArray(not.enum)) {
      const values = not.enum.filter(isPrimitive);
      const list = values.map((v) => labelled(v, lookupLabel(v))).join(', ');
      return {
        column,
        kind: 'not-enum',
        values,
        text: `must not be ${list} — a substantive or item-missing value is required`,
      };
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.every(isPrimitive)) {
    const list = schema.enum.map((v: JsonPrimitive) => labelled(v, lookupLabel(v))).join(', ');
    return { column, kind: 'schema', text: `must be one of ${list}` };
  }
  return { column, kind: 'schema', text: predicateText(schema) ?? GENERIC_TARGET };
}

/** Column names mentioned by an `anyOf` sub-constraint (cross-column target). */
function columnsInAnyOf(branches: readonly unknown[]): string[] {
  const columns: string[] = [];
  for (const branch of branches) {
    if (!isObject(branch) || !isObject(branch.properties)) continue;
    for (const column of Object.keys(branch.properties)) {
      if (!columns.includes(column)) columns.push(column);
    }
  }
  return columns;
}

function extractTargets(clause: Record<string, unknown>, labelFor: SentinelLabelFor): ConditionalTarget[] {
  const targets: ConditionalTarget[] = [];
  const addProperties = (props: unknown): void => {
    if (!isObject(props)) return;
    for (const [column, sub] of Object.entries(props)) {
      if (isObject(sub) || sub === false) targets.push(targetFor(column, sub, labelFor));
    }
  };
  const addRequired = (required: unknown): void => {
    if (!Array.isArray(required)) return;
    for (const column of required) {
      if (typeof column !== 'string') continue;
      if (targets.some((t) => t.column === column && t.kind === 'required')) continue;
      targets.push({ column, kind: 'required', text: 'is required' });
    }
  };
  addProperties(clause.properties);
  addRequired(clause.required);
  // then.allOf (4 HESP blocks, spec-silent): flatten `properties` sub-blocks;
  // `anyOf` sub-blocks are cross-column constraints — one generic 'schema'
  // target per mentioned column so asTarget cross-indexes stay meaningful.
  if (Array.isArray(clause.allOf)) {
    for (const sub of clause.allOf) {
      if (!isObject(sub)) continue;
      addProperties(sub.properties);
      addRequired(sub.required);
      if (Array.isArray(sub.anyOf)) {
        for (const column of columnsInAnyOf(sub.anyOf)) {
          if (!targets.some((t) => t.column === column && t.kind === 'schema')) {
            targets.push({ column, kind: 'schema', text: GENERIC_TARGET });
          }
        }
      }
    }
  }
  return targets;
}

/**
 * Walk root `items.allOf` and digest every entry containing `if` with a
 * `then` or an `else`. `index` is the entry's position in the array
 * (category `$ref` entries keep their slots, so indexes match Ajv
 * `schemaPath` segments).
 */
export function extractConditionals(
  set: SchemaSet,
  rootFileId: string,
  labelFor: SentinelLabelFor = () => undefined,
): ConditionalRule[] {
  const root = set.files.find((f) => f.fileId === rootFileId);
  if (root === undefined) return [];
  const allOf = getAtPointer(root.json, '/items/allOf');
  if (!allOf.found || !Array.isArray(allOf.value)) return [];

  const rules: ConditionalRule[] = [];
  allOf.value.forEach((block, index) => {
    if (!isObject(block) || !isObject(block.if)) return;
    const then = isObject(block.then) ? block.then : null;
    const otherwise = isObject(block.else) ? block.else : null;
    if (then === null && otherwise === null) return;
    const ifNode = block.if;

    let conditions: { column: string; value: JsonPrimitive }[];
    let pairsText: string;
    if (Array.isArray(ifNode.anyOf)) {
      // Disjunctive condition (HESP allOf[175]): flatten branches, join " or ".
      const branchPairs = ifNode.anyOf
        .filter(isObject)
        .map((branch) => conditionPairs(branch))
        .filter((pairs) => pairs.length > 0);
      conditions = branchPairs.flat();
      pairsText = branchPairs.map(conditionClause).join(' or ');
    } else {
      conditions = conditionPairs(ifNode);
      pairsText = conditionClause(conditions);
    }
    // The const pairs word HESP's conditions exactly; anything they do not
    // cover (a range, a bare `required`) is worded from the schema, and a
    // condition nothing can word is named by its place — never left blank.
    const worded = describeCondition(ifNode);
    const coversAll = pairsText !== '' && (worded === null || worded === pairsText);
    const conditionText = coversAll
      ? pairsText
      : (worded ?? (pairsText !== '' ? pairsText : `the condition at #/items/allOf/${String(index)}/if holds`));

    rules.push({
      index,
      ...(typeof block.$comment === 'string' ? { comment: block.$comment } : {}),
      conditions,
      conditionText,
      targets: [
        ...(then === null ? [] : extractTargets(then, labelFor)),
        ...(otherwise === null
          ? []
          : extractTargets(otherwise, labelFor).map((t): ConditionalTarget => ({ ...t, clause: 'else' }))),
      ],
    });
  });
  return rules;
}

/**
 * One-liner used by tooltips, report, and Studio: "when {cond}, {target}" —
 * "unless {cond}, …" for an `else` target, "'b' is required when {cond}" for a
 * required one.
 */
export function conditionalOneLiner(rule: ConditionalRule, target: ConditionalTarget): string {
  const lead = target.clause === 'else' ? 'unless' : 'when';
  if (target.kind === 'required') return `${quote(target.column)} is required ${lead} ${rule.conditionText}`;
  return `${lead} ${rule.conditionText}, ${target.text}`;
}
