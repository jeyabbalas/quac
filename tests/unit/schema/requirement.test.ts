/**
 * What a schema check requires, worded from the schema alone
 * (schema/requirement.ts): the keyword table, where in a value a check
 * applies, and the conditions a keyword's place puts it under.
 */
import { describe, expect, it } from 'vitest';
import {
  checkSubject,
  conditionsAt,
  keywordRequirement,
} from '../../../src/core/schema/requirement';
import type { ValueSpec } from '../../../src/core/schema/value-spec';

const words = (keyword: string, parent: Record<string, unknown>, atValue = false): string | null =>
  keywordRequirement({ keyword, parent, atValue });

describe('keywordRequirement — one sentence per keyword, from the schema object', () => {
  it('words bounds, lengths and counts', () => {
    expect(words('maximum', { maximum: 2100 })).toBe('must be at most 2,100');
    expect(words('minimum', { minimum: 0.00005 })).toBe('must be at least 0.00005');
    expect(words('exclusiveMinimum', { exclusiveMinimum: 0 })).toBe('must be greater than 0');
    expect(words('exclusiveMaximum', { exclusiveMaximum: 1 })).toBe('must be less than 1');
    expect(words('multipleOf', { multipleOf: 0.01 })).toBe('must be a multiple of 0.01');
    expect(words('maxLength', { maxLength: 1 })).toBe('must have at most 1 character');
    expect(words('minLength', { minLength: 3 })).toBe('must have at least 3 characters');
    expect(words('minItems', { minItems: 1 })).toBe('must have at least 1 item');
    expect(words('maxProperties', { maxProperties: 4 })).toBe('must have at most 4 fields');
  });

  it('words values, types and formats', () => {
    expect(words('enum', { enum: ['es', 'fr'] })).toBe("must be one of 'es', 'fr'");
    expect(words('const', { const: -666 })).toBe('must be -666');
    expect(words('type', { type: ['integer', 'null'] })).toBe('must be an integer or null');
    expect(words('format', { format: 'date' })).toBe('must be a valid date (YYYY-MM-DD)');
    expect(words('uniqueItems', { uniqueItems: true })).toBe('must not repeat items');
    expect(words('not', { not: { const: 'x' } })).toBe("must not be 'x'");
  });

  it('labels a code from the variable’s own value spec, at the value only', () => {
    const spec: ValueSpec = {
      kind: 'codes',
      codes: [{ value: -666, label: 'Not applicable' }],
      sentinels: [],
      valueType: 'integer',
    } as unknown as ValueSpec;
    expect(
      keywordRequirement({ keyword: 'const', parent: { const: -666 }, spec, atValue: true }),
    ).toBe('must be -666 (Not applicable)');
    expect(
      keywordRequirement({ keyword: 'const', parent: { const: -666 }, spec, atValue: false }),
    ).toBe('must be -666');
  });

  it('puts a pattern in code, glossed by its own schema object', () => {
    expect(words('pattern', { pattern: '^HH[0-9]{8}$', description: 'Household id.' })).toBe(
      'must match `^HH[0-9]{8}$` (Household id)',
    );
    expect(words('pattern', { pattern: '^[a-z]+$' })).toBe('must match `^[a-z]+$`');
  });

  it('names the fields an object needs, or may have — never a field a value had', () => {
    expect(words('required', { required: ['name', 'dob'] })).toBe(
      "must have the fields 'name' and 'dob'",
    );
    expect(words('required', { required: ['city'] })).toBe("must have the field 'city'");
    expect(
      words('additionalProperties', { properties: { a: {}, b: {} }, additionalProperties: false }),
    ).toBe("must have no fields besides 'a' and 'b'");
    expect(words('propertyNames', { propertyNames: { pattern: '^[a-z]+$' } })).toBe(
      'field names must match `^[a-z]+$`',
    );
    expect(words('dependentRequired', { dependentRequired: { card: ['billing'] } })).toBe(
      "must have 'billing' when 'card' is present",
    );
  });

  it('counts the items a closed tuple allows', () => {
    expect(words('items', { prefixItems: [{}, {}], items: false })).toBe(
      'must have at most 2 items',
    );
    expect(words('additionalItems', { items: [{}], additionalItems: false })).toBe(
      'must have at most 1 item',
    );
  });

  it('words a union from its branches, or from the variable’s spec at the value', () => {
    expect(words('anyOf', { anyOf: [{ type: 'string' }, { type: 'object' }] })).toBe(
      'must be text or an object',
    );
    expect(words('oneOf', { oneOf: [{ type: 'integer' }, { type: 'null' }] })).toBe(
      'must match exactly one of: an integer or null',
    );
    const spec = {
      kind: 'numeric',
      numType: 'integer',
      min: 0,
      max: 9,
      sentinels: [],
      exclusions: [],
    } as unknown as ValueSpec;
    expect(
      keywordRequirement({ keyword: 'anyOf', parent: { anyOf: [] }, spec, atValue: true }),
    ).toBe('must be an integer 0–9');
  });

  it('words `contains` with its counts', () => {
    expect(words('contains', { contains: { const: 'self' } })).toBe(
      "must contain at least 1 item matching 'self'",
    );
    expect(
      words('contains', { contains: { type: 'string' }, minContains: 2, maxContains: 2 }),
    ).toBe('must contain exactly 2 items matching text');
    expect(
      words('contains', { contains: { $ref: '#/$defs/x' }, minContains: 1, maxContains: 3 }),
    ).toBe('must contain 1–3 items matching the schema');
  });

  it('has no words for a keyword it does not know — the report then names it', () => {
    expect(words('x-custom', { 'x-custom': 1 })).toBeNull();
  });
});

describe('checkSubject — where in the variable, from a path through the schema', () => {
  it('reads list items and fields, and nothing a value held', () => {
    expect(
      checkSubject('#/allOf/2/properties/household/items/properties/age/maximum', 'household'),
    ).toEqual({
      path: 'household[].age',
      atValue: false,
    });
    expect(checkSubject('#/properties/labs/additionalProperties/minimum', 'labs')).toEqual({
      path: 'labs.*',
      atValue: false,
    });
    expect(checkSubject('#/properties/t/prefixItems/1/type', 't')).toEqual({
      path: 't[2]',
      atValue: false,
    });
    expect(
      checkSubject('#/allOf/4/properties/notes/anyOf/1/properties/interpreter/enum', 'notes'),
    ).toEqual({
      path: 'notes.interpreter',
      atValue: false,
    });
  });

  it('is at the value when no step goes inside it', () => {
    expect(checkSubject('#/properties/reference_year/anyOf/0/maximum', 'reference_year')).toEqual({
      path: '',
      atValue: true,
    });
    expect(checkSubject('#/allOf/12/then/properties/move_reason/const', 'move_reason')).toEqual({
      path: '',
      atValue: true,
    });
  });

  it('gives up where Ajv’s path restarts in a `$ref` target, or misses the variable', () => {
    expect(checkSubject('../../common/defs.json#/$defs/record_id/pattern', 'record_id')).toBeNull();
    expect(checkSubject('#/$defs/phone/pattern', 'phones')).toBeNull();
    expect(checkSubject('#/properties/other/maximum', 'mine')).toBeNull();
    expect(checkSubject(undefined, 'mine')).toBeNull();
  });
});

describe('conditionsAt — the conditions a keyword’s place puts it under', () => {
  const schema = {
    items: {
      allOf: [
        {
          if: { properties: { status: { const: 'closed' } }, required: ['status'] },
          then: { properties: { end: { type: 'string' } } },
          else: { properties: { end: { type: 'null' } } },
        },
      ],
      dependentSchemas: { card: { required: ['billing'] } },
    },
  };

  it('words a then, an else and a dependent trigger', () => {
    expect(conditionsAt(schema, '/items/allOf/0/then/properties/end/type')).toBe(
      "when status = 'closed'",
    );
    expect(conditionsAt(schema, '/items/allOf/0/else/properties/end/type')).toBe(
      "unless status = 'closed'",
    );
    expect(conditionsAt(schema, '/items/dependentSchemas/card/required')).toBe(
      "when 'card' is present",
    );
  });

  it('is null for a keyword no condition governs', () => {
    expect(conditionsAt(schema, '/items/allOf/0/if/properties/status/const')).toBeNull();
    expect(conditionsAt({ properties: { a: { maximum: 1 } } }, '/properties/a/maximum')).toBeNull();
  });
});
