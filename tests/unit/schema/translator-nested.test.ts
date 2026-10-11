/**
 * The translator on errors INSIDE a value (json-schema-subsystem.md §D.3 for
 * nested data): real Ajv errors, from QuaC's own Ajv configuration, over
 * values shaped as nested-values.ts hands them over — so the error shapes
 * the rules read (union branch errors, `uniqueItems`'s pair, `propertyNames`'
 * double report) are Ajv's, not a recording's.
 */
import { describe, expect, it } from 'vitest';
import { buildAjv } from '../../../src/core/schema/ajv-engine';
import { pointerSegments, renderNestedPath } from '../../../src/core/schema/nested-values';
import { createTranslateCtx, translateRowErrors } from '../../../src/core/schema/translator';
import type { NestedPlan } from '../../../src/core/schema/nested-values';
import type { AjvErrorLike } from '../../../src/core/schema/translator';

const ROW_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      maxItems: 2,
      items: {
        type: ['object', 'null'],
        properties: {
          name: { type: 'string' },
          age: { type: ['integer', 'null'], minimum: 0, maximum: 120 },
          langs: { type: 'array', items: { enum: ['en', 'fr'] }, uniqueItems: true },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    mixed: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'number' },
          { type: 'string' },
          { type: 'object', properties: { k: { type: 'integer', maximum: 9 } }, required: ['k'] },
        ],
      },
    },
    shifty: {
      oneOf: [{ type: 'integer' }, { type: 'object', properties: { n: { type: 'integer', maximum: 9 } } }],
    },
    labs: {
      type: 'object',
      propertyNames: { pattern: '^[a-z]+$' },
      additionalProperties: { type: 'number', minimum: 0 },
    },
    tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    pairs: { type: 'array', items: { type: 'object' }, uniqueItems: true },
  },
};

const PLANS: Record<string, NestedPlan> = {
  people: {
    kind: 'list',
    element: {
      kind: 'struct',
      fields: [
        ['name', { kind: 'leaf' }],
        ['age', { kind: 'leaf' }],
        ['langs', { kind: 'list', element: { kind: 'leaf' } }],
      ],
      dropNull: [],
    },
  },
  mixed: { kind: 'list', element: { kind: 'json' } },
  shifty: { kind: 'json' },
  labs: { kind: 'map', value: { kind: 'leaf' } },
  tags: { kind: 'list', element: { kind: 'leaf' } },
  pairs: { kind: 'list', element: { kind: 'json' } },
};

const ajv = buildAjv('2020-12');
const validate = ajv.compile(ROW_SCHEMA);
const ctx = createTranslateCtx([], []);

/** Validate one row and translate its errors, located as the worker locates them. */
function messages(row: Record<string, unknown>): string[] {
  const valid = validate(row);
  const errors = valid ? [] : ((validate.errors ?? []) as AjvErrorLike[]);
  const locate = (instancePath: string): string => {
    const [column, ...rest] = pointerSegments(instancePath);
    if (column === undefined) return '';
    return renderNestedPath(column, rest, row[column], PLANS[column]);
  };
  return translateRowErrors(errors, 0, ctx, locate).map((f) => `${String(f.column)}: ${f.message}`);
}

describe('locating errors inside a value', () => {
  it('names the list item and field, counting items from 1', () => {
    expect(messages({ people: [{ name: 'Ada', age: 36 }, { name: 'Bo', age: 130 }] })).toEqual([
      'people: 130 exceeds the maximum 120 (at people[2].age).',
    ]);
  });

  it('a field missing inside an item is that item’s finding, not the cell’s', () => {
    expect(messages({ people: [{ age: 3 }] })).toEqual([
      "people: required field 'name' is missing (at people[1]).",
    ]);
  });

  it('container keywords read as sentences', () => {
    expect(
      messages({ people: [{ name: 'a' }, { name: 'b' }, { name: 'c', nick: 'x' }] }),
    ).toEqual([
      // Within a column, findings sort by message (translateRowErrors' order).
      "people: field 'nick' is not allowed here (at people[3]).",
      'people: has 3 items; at most 2 allowed.',
    ]);
  });
});

describe('unions inside a value', () => {
  it('a value only one branch could mean gets that branch’s own finding', () => {
    expect(messages({ mixed: [1, 'two', { k: 12 }] })).toEqual([
      'mixed: 12 exceeds the maximum 9 (at mixed[3].k).',
    ]);
    expect(messages({ shifty: { n: 12 } })).toEqual(['shifty: 12 exceeds the maximum 9 (at shifty.n).']);
  });

  it('a value no branch admits collapses to one finding naming the shapes', () => {
    expect(messages({ mixed: [true] })).toEqual([
      'mixed: true is not valid — expected a number, text or an object (at mixed[1]).',
    ]);
    expect(messages({ shifty: 1.5 })).toEqual([
      'shifty: 1.5 is not valid — expected a value satisfying the schema.',
    ]);
  });
});

describe('items that repeat', () => {
  it('names the later item as repeating the earlier, on both of Ajv’s code paths', () => {
    // A typed item schema takes Ajv's hash-map walk…
    expect(messages({ tags: ['a', 'b', 'a'] })).toEqual([
      'tags: tags[3] repeats tags[1] — items must be unique.',
    ]);
    // …an untyped-scalar one the pairwise walk, which names the pair the other way round.
    expect(messages({ pairs: [{ a: 1 }, { b: 2 }, { a: 1 }] })).toEqual([
      'pairs: pairs[3] repeats pairs[1] — items must be unique.',
    ]);
    expect(messages({ people: [{ name: 'a', langs: ['en', 'en'] }] })).toEqual([
      'people: people[1].langs[2] repeats people[1].langs[1] — items must be unique (at people[1].langs).',
    ]);
  });
});

describe('field names', () => {
  it('a bad field name is one finding, told the pattern', () => {
    expect(messages({ labs: { ldl: 1, 'LDL-C': 2 } })).toEqual([
      "labs: field name 'LDL-C' is not allowed (names must match ^[a-z]+$).",
    ]);
  });

  it('a map value names its key', () => {
    expect(messages({ labs: { ldl: -1 } })).toEqual(['labs: -1 is below the minimum 0 (at labs["ldl"]).']);
  });
});
