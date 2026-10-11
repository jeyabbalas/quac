/**
 * §D.2 conditional digest over the real HESP root: 171 rules, target kinds,
 * disjunctive/conjunctive condition text, then.allOf flattening, comments.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import {
  conditionalOneLiner,
  describeCondition,
  extractConditionals,
} from '../../../src/core/schema/conditionals';
import type { ConditionalRule } from '../../../src/core/schema/conditionals';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, fixtureDir } from './helpers';

let set: SchemaSet;
let rules: ConditionalRule[];

beforeAll(async () => {
  set = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
    origin: 'upload',
  });
  const digest = columnDigest(set);
  if (digest === null) throw new Error('HESP digest unexpectedly null');
  rules = digest.conditionals;
});

const at = (index: number): ConditionalRule => {
  const rule = rules.find((r) => r.index === index);
  if (rule === undefined) throw new Error(`no rule at allOf index ${String(index)}`);
  return rule;
};

describe('extractConditionals over HESP', () => {
  it('digests all 171 if/then blocks with allOf positions preserved', () => {
    expect(rules).toHaveLength(171);
    // Category refs hold slots 0–11; the first conditional sits at 12.
    expect(rules[0]?.index).toBe(12);
    expect(rules.every((r) => r.comment !== undefined && r.comment.length > 0)).toBe(true);
  });

  it('baseline_record block → 2 const targets with sentinel labels', () => {
    const rule = at(12);
    expect(rule.conditions).toEqual([{ column: 'baseline_record', value: 1 }]);
    expect(rule.conditionText).toBe('baseline_record = 1');
    expect(rule.comment).toBe(
      'Skip pattern: baseline records have no prior-wave move comparison.',
    );
    expect(rule.targets).toEqual([
      {
        column: 'moved_since_last_wave',
        kind: 'const',
        value: -666,
        text: 'must be -666 (Not applicable / structural skip)',
      },
      {
        column: 'move_reason',
        kind: 'const',
        value: -666,
        text: 'must be -666 (Not applicable / structural skip)',
      },
    ]);
  });

  it('moved_since_last_wave = 1 block → not-const target', () => {
    const rule = at(14);
    expect(rule.conditionText).toBe('moved_since_last_wave = 1');
    expect(rule.targets).toEqual([
      {
        column: 'move_reason',
        kind: 'not-const',
        value: -666,
        text:
          'must not be -666 (Not applicable / structural skip) — a substantive or ' +
          'item-missing value is required',
      },
    ]);
  });

  it('if.anyOf disjunction (allOf[175]) joins clauses with " or "', () => {
    const rule = at(175);
    expect(rule.conditionText).toBe(
      'income_drop_12m = 1 or household_job_loss_12m = 1 or ' +
        'major_unplanned_expense_12m = 1 or disaster_displacement_12m = 1',
    );
    expect(rule.conditions).toHaveLength(4);
    expect(rule.targets.map((t) => [t.column, t.kind])).toEqual([
      ['primary_shock_type', 'not-const'],
      ['largest_shock_amount', 'not-const'],
    ]);
  });

  it('multi-property if (allOf[176]) joins clauses with " and "', () => {
    const rule = at(176);
    expect(rule.conditions).toHaveLength(4);
    expect(rule.conditionText).toBe(
      'income_drop_12m = 0 and household_job_loss_12m = 0 and ' +
        'major_unplanned_expense_12m = 0 and disaster_displacement_12m = 0',
    );
  });

  it('then.allOf blocks flatten: property targets + per-column anyOf fallbacks', () => {
    const rule = at(156);
    const anyOfTargets = rule.targets.filter((t) => t.kind === 'schema');
    expect(anyOfTargets.map((t) => t.column)).toEqual([
      'checking_owned',
      'savings_owned',
      'prepaid_account_owned',
      'money_market_cd_owned',
    ]);
    expect(anyOfTargets[0]?.text).toBe('must satisfy the conditional constraint (see schema)');
    const notConsts = rule.targets.filter((t) => t.kind === 'not-const');
    expect(notConsts).toHaveLength(6);
    expect(rule.targets.filter((t) => t.kind === 'const')).toEqual([
      { column: 'alternative_service_12m', kind: 'const', value: 0, text: 'must be 0 (No)' },
    ]);
  });

  it('not-enum target renders quoted string values with labels', () => {
    const rule = at(179);
    expect(rule.targets).toEqual([
      {
        column: 'split_origin_household_id',
        kind: 'not-enum',
        values: ['NA'],
        text:
          "must not be 'NA' (Not applicable / not a split-off household) — a substantive " +
          'or item-missing value is required',
      },
    ]);
  });

  it('without a label lookup the texts degrade gracefully', () => {
    const bare = extractConditionals(set, 'core/core.schema.json');
    const rule = bare.find((r) => r.index === 12);
    expect(rule?.targets[0]?.text).toBe('must be -666');
  });
});

describe('extractConditionals beyond the HESP shapes', () => {
  const digest = (allOf: unknown[]): ConditionalRule[] =>
    extractConditionals(
      { files: [{ fileId: 'r.json', json: { type: 'array', items: { type: 'object', allOf } } }] } as unknown as SchemaSet,
      'r.json',
    );

  it('digests else symmetrically: its targets are marked, its one-liner says "unless"', () => {
    const [rule] = digest([
      {
        if: { properties: { kind: { const: 1 } }, required: ['kind'] },
        then: { properties: { b: { const: 'x' } } },
        else: { properties: { b: { const: 'y' } }, required: ['why'] },
      },
    ]);
    expect(rule?.conditionText).toBe('kind = 1');
    expect(rule?.targets).toEqual([
      { column: 'b', kind: 'const', value: 'x', text: "must be 'x'" },
      { column: 'b', kind: 'const', value: 'y', text: "must be 'y'", clause: 'else' },
      { column: 'why', kind: 'required', text: 'is required', clause: 'else' },
    ]);
    if (rule === undefined) throw new Error('no rule');
    expect(rule.targets.map((t) => conditionalOneLiner(rule, t))).toEqual([
      "when kind = 1, must be 'x'",
      "unless kind = 1, must be 'y'",
      "'why' is required unless kind = 1",
    ]);
  });

  it('never leaves the condition blank: a bare required, a range, an unwordable condition', () => {
    const rules = digest([
      { if: { required: ['kind'] }, then: { properties: { b: { maximum: 5 } } } },
      { if: { properties: { age: { minimum: 18, maximum: 65 } }, required: ['age'] }, then: { required: ['job'] } },
      { if: { properties: { tags: { contains: { const: 'x' } } } }, then: { required: ['t'] } },
    ]);
    expect(rules.map((r) => r.conditionText)).toEqual([
      "'kind' is present",
      'age is between 18 and 65',
      'the condition at #/items/allOf/2/if holds',
    ]);
    expect(rules[0]?.targets).toEqual([{ column: 'b', kind: 'schema', text: 'must be at most 5' }]);
  });

  it('describes generic targets by what they ask, keeping the HESP cross-column fallback', () => {
    const [rule] = digest([
      {
        if: { properties: { a: { const: 1 } }, required: ['a'] },
        then: { properties: { e: { enum: ['x', 'y'] }, p: { pattern: '^Z' }, z: false } },
      },
    ]);
    expect(rule?.targets.map((t) => t.text)).toEqual(["must be one of 'x', 'y'", 'must match ^Z', 'must be absent']);
  });
});

describe('describeCondition', () => {
  it('words the common shapes, and gives up (null) on what it cannot word', () => {
    expect(describeCondition({ properties: { a: { const: 1 }, b: { const: 'x' } }, required: ['a', 'b'] })).toBe(
      "a = 1 and b = 'x'",
    );
    expect(describeCondition({ anyOf: [{ properties: { a: { const: 1 } } }, { properties: { b: { const: 1 } } }] })).toBe(
      'a = 1 or b = 1',
    );
    expect(describeCondition({ properties: { a: { not: { const: 0 } } } })).toBe('a is not 0');
    expect(describeCondition({ properties: { a: { enum: [1, 2] } } })).toBe('a is one of 1, 2');
    expect(describeCondition({ type: 'object', required: ['email'] })).toBe("'email' is present");
    expect(describeCondition({ properties: { country: { const: 'US' } } }, 'address')).toBe("address.country = 'US'");
    expect(describeCondition({ minimum: 18 }, 'age')).toBe('age is at least 18');
    expect(describeCondition({ minProperties: 2 })).toBeNull();
    expect(describeCondition(true)).toBeNull();
  });
});
