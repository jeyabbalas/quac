/**
 * Static digest of the root schema's `items.allOf` if/then blocks
 * (json-schema-subsystem.md §D.2). Pure extraction — no Ajv, no evaluation;
 * the P08 translator matches Ajv errors back to these by allOf index, and
 * tooltips/report render `conditionText`/`target.text` verbatim.
 */
import { getAtPointer } from './deref';
import { renderValue } from './value-spec';
import type { JsonPrimitive } from './value-spec';
import type { SchemaSet } from './types';

export interface ConditionalRule {
  /** Position in the root `items.allOf` array. */
  index: number;
  /** The block's $comment. */
  comment?: string;
  conditions: { column: string; value: JsonPrimitive }[];
  /** "baseline_record = 1" / "a = 1 and b = 0" / disjunctions joined " or ". */
  conditionText: string;
  targets: ConditionalTarget[];
}

export interface ConditionalTarget {
  column: string;
  /** 'schema' = generic fallback (bare enum / anyOf / anything else). */
  kind: 'const' | 'not-const' | 'not-enum' | 'schema';
  value?: JsonPrimitive;
  values?: JsonPrimitive[];
  text: string;
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

function targetFor(
  column: string,
  schema: Record<string, unknown>,
  labelFor: SentinelLabelFor,
): ConditionalTarget {
  const lookupLabel = (v: JsonPrimitive): string | undefined =>
    typeof v === 'string' || typeof v === 'number' ? labelFor(column, v) : undefined;

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
  return { column, kind: 'schema', text: 'must satisfy the conditional constraint (see schema)' };
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

function extractTargets(then: Record<string, unknown>, labelFor: SentinelLabelFor): ConditionalTarget[] {
  const targets: ConditionalTarget[] = [];
  const addProperties = (props: unknown): void => {
    if (!isObject(props)) return;
    for (const [column, sub] of Object.entries(props)) {
      if (isObject(sub)) targets.push(targetFor(column, sub, labelFor));
    }
  };
  addProperties(then.properties);
  // then.allOf (4 HESP blocks, spec-silent): flatten `properties` sub-blocks;
  // `anyOf` sub-blocks are cross-column constraints — one generic 'schema'
  // target per mentioned column so asTarget cross-indexes stay meaningful.
  if (Array.isArray(then.allOf)) {
    for (const sub of then.allOf) {
      if (!isObject(sub)) continue;
      addProperties(sub.properties);
      if (Array.isArray(sub.anyOf)) {
        for (const column of columnsInAnyOf(sub.anyOf)) {
          if (!targets.some((t) => t.column === column && t.kind === 'schema')) {
            targets.push({
              column,
              kind: 'schema',
              text: 'must satisfy the conditional constraint (see schema)',
            });
          }
        }
      }
    }
  }
  return targets;
}

/**
 * Walk root `items.allOf` and digest every entry containing `if`. `index` is
 * the entry's position in the array (category `$ref` entries keep their slots,
 * so indexes match Ajv `schemaPath` segments in P08).
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
    if (!isObject(block) || !isObject(block.if) || !isObject(block.then)) return;
    const ifNode = block.if;

    let conditions: { column: string; value: JsonPrimitive }[];
    let conditionText: string;
    if (Array.isArray(ifNode.anyOf)) {
      // Disjunctive condition (HESP allOf[175]): flatten branches, join " or ".
      const branchPairs = ifNode.anyOf
        .filter(isObject)
        .map((branch) => conditionPairs(branch))
        .filter((pairs) => pairs.length > 0);
      conditions = branchPairs.flat();
      conditionText = branchPairs.map(conditionClause).join(' or ');
    } else {
      conditions = conditionPairs(ifNode);
      conditionText = conditionClause(conditions);
    }

    rules.push({
      index,
      ...(typeof block.$comment === 'string' ? { comment: block.$comment } : {}),
      conditions,
      conditionText,
      targets: extractTargets(block.then, labelFor),
    });
  });
  return rules;
}

/** One-liner used by tooltips, report, and Studio: "when {cond}, {target}". */
export function conditionalOneLiner(rule: ConditionalRule, target: ConditionalTarget): string {
  return `when ${rule.conditionText}, ${target.text}`;
}
