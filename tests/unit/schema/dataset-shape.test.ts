/**
 * The dataset shape (dataset-shape.ts): which schema each record must
 * satisfy, per draft, and which constraints apply to the array as a whole —
 * through a root `$ref`, merged across `allOf`, with everything QuaC does not
 * check reported.
 */
import { describe, expect, it } from 'vitest';
import { datasetShape, schemaRefUri } from '../../../src/core/schema/dataset-shape';
import type { DatasetShape } from '../../../src/core/schema/dataset-shape';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { IntakeEntry, SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

const DRAFTS = {
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
} as const;

async function shapeOf(root: Record<string, unknown>, more: IntakeEntry[] = []): Promise<DatasetShape> {
  const set = await buildSchemaSet([entry('root.json', root), ...more], { origin: 'upload' });
  const shape = datasetShape(set);
  if (shape === null) throw new Error(`no shape: ${JSON.stringify(set.errors)}`);
  return shape;
}

const ROOT = 'quac-set:/root.json';
const at = (pointer: string, uri = ROOT) => ({ uri, pointer });

describe('record schemas', () => {
  it('2020-12: items for every record', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'object', properties: { a: {} } },
    });
    expect(shape).toEqual({
      record: at('/items'),
      prefix: [],
      minItems: 1,
      uniqueItems: true,
      unsupported: [],
      warnings: [],
    });
  });

  it('2020-12: prefixItems for the first records, items for the rest (false = no more records)', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      type: 'array',
      prefixItems: [{ properties: { h: {} } }, true],
      items: false,
    });
    expect(shape.prefix).toEqual([at('/prefixItems/0'), at('/prefixItems/1')]);
    expect(shape.record).toBe(false);
    const open = await shapeOf({ $schema: DRAFTS['2020-12'], prefixItems: [{}] });
    expect(open.record).toBeNull();
  });

  for (const draft of ['draft-07', '2019-09'] as const) {
    it(`${draft}: a tuple items, then additionalItems`, async () => {
      const shape = await shapeOf({
        $schema: DRAFTS[draft],
        type: 'array',
        items: [{ properties: { h: {} } }],
        additionalItems: { properties: { v: {} } },
      });
      expect(shape.prefix).toEqual([at('/items/0')]);
      expect(shape.record).toEqual(at('/additionalItems'));
      const closed = await shapeOf({ $schema: DRAFTS[draft], items: [{}], additionalItems: false });
      expect(closed.record).toBe(false);
      const open = await shapeOf({ $schema: DRAFTS[draft], items: [{}] });
      expect(open.record).toBeNull();
      // An object `items` covers every record; additionalItems then means nothing.
      const plain = await shapeOf({ $schema: DRAFTS[draft], items: { properties: { a: {} } }, additionalItems: false });
      expect(plain.record).toEqual(at('/items'));
      expect(plain.prefix).toEqual([]);
    });
  }

  it('draft-07 knows no prefixItems', async () => {
    const shape = await shapeOf({ $schema: DRAFTS['draft-07'], type: 'array', prefixItems: [{}], items: { properties: {} } });
    expect(shape.prefix).toEqual([]);
    expect(shape.record).toEqual(at('/items'));
  });

  it('unevaluatedItems stands in for the rest when nothing else evaluates them', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      prefixItems: [{}],
      unevaluatedItems: { properties: { v: {} } },
    });
    expect(shape.record).toEqual(at('/unevaluatedItems'));
    // With contains, which records it reaches depends on the data.
    const withContains = await shapeOf({
      $schema: DRAFTS['2020-12'],
      prefixItems: [{}],
      contains: {},
      unevaluatedItems: false,
    });
    expect(withContains.unsupported).toEqual(['unevaluatedItems']);
    // With items, it can never apply.
    const moot = await shapeOf({ $schema: DRAFTS['2020-12'], items: {}, unevaluatedItems: false });
    expect(moot.unsupported).toEqual([]);
  });
});

describe('a root that points elsewhere', () => {
  it('follows a $ref root in the same file', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      $ref: '#/$defs/dataset',
      title: 'Dataset',
      $defs: { dataset: { type: 'array', maxItems: 5, items: { $ref: '#/$defs/row' } }, row: { properties: { a: {} } } },
    });
    expect(shape.record).toEqual(at('/$defs/dataset/items'));
    expect(shape.maxItems).toBe(5);
    expect(shape.warnings).toEqual([]);
  });

  it('follows a $ref root into another file, and an allOf of one $ref', async () => {
    const defs = entry('defs.json', {
      $schema: DRAFTS['2020-12'],
      $defs: { dataset: { type: 'array', items: { properties: { a: {} } }, contains: { required: ['a'] } } },
    });
    const viaRef = await shapeOf({ $schema: DRAFTS['2020-12'], $ref: 'defs.json#/$defs/dataset' }, [defs]);
    expect(viaRef.record).toEqual(at('/$defs/dataset/items', 'quac-set:/defs.json'));
    expect(viaRef.contains).toEqual({ schema: at('/$defs/dataset/contains', 'quac-set:/defs.json'), min: 1 });
    const viaAllOf = await shapeOf(
      { $schema: DRAFTS['2020-12'], allOf: [{ $ref: 'defs.json#/$defs/dataset' }] },
      [defs],
    );
    expect(viaAllOf.record).toEqual(viaRef.record);
  });

  it('merges keywords beside a $ref and across allOf: tightest bounds, any uniqueItems', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      $ref: '#/$defs/base',
      minItems: 1,
      maxItems: 10,
      allOf: [{ maxItems: 5 }],
      $defs: { base: { type: 'array', minItems: 3, uniqueItems: true, items: { properties: {} } } },
    });
    expect(shape).toMatchObject({ minItems: 3, maxItems: 5, uniqueItems: true, record: at('/$defs/base/items') });
  });

  it('a record schema given twice cannot be merged: the first is used and the rest reported', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      items: { properties: { a: {} } },
      allOf: [{ items: { properties: { b: {} } } }],
    });
    expect(shape.record).toEqual(at('/items'));
    expect(shape.unsupported).toEqual(['items']);
    expect(shape.warnings).toEqual([
      "The dataset's `items` is declared in more than one place; QuaC checks only the first.",
    ]);
  });
});

describe('whole-array keywords', () => {
  it('contains, per draft', async () => {
    const seven = await shapeOf({ $schema: DRAFTS['draft-07'], items: {}, contains: { const: 1 }, minContains: 3 });
    expect(seven.contains).toEqual({ schema: at('/contains'), min: 1 });
    const twenty = await shapeOf({
      $schema: DRAFTS['2020-12'],
      items: {},
      contains: { required: ['flag'] },
      minContains: 2,
      maxContains: 3,
    });
    expect(twenty.contains).toEqual({ schema: at('/contains'), min: 2, max: 3 });
    const never = await shapeOf({ $schema: DRAFTS['2019-09'], items: {}, contains: {}, minContains: 0 });
    expect(never.contains).toEqual({ schema: at('/contains'), min: 0 });
  });

  it('reports what it does not check, in keywords and in a sentence', async () => {
    const shape = await shapeOf({
      $schema: DRAFTS['2020-12'],
      type: 'array',
      items: {},
      not: { maxItems: 0 },
      anyOf: [{ minItems: 1 }],
      if: { minItems: 2 },
      then: { uniqueItems: true },
    });
    expect(shape.unsupported).toEqual(['not', 'anyOf', 'if']);
    expect(shape.warnings).toEqual([
      'The schema\'s root keywords `not`, `anyOf`, `if` constrain the dataset as a whole; QuaC checks records one by one and does not check them.',
    ]);
  });

  it('a type list naming array is fine; a root type that rules out arrays is told', async () => {
    expect((await shapeOf({ type: ['array', 'null'], items: {} })).warnings).toEqual([]);
    expect((await shapeOf({ type: 'object', items: {} })).warnings).toEqual([
      "The schema's root `type` is `object`, but a dataset is an array of records: QuaC checks each record against the record schema and ignores the root `type`.",
    ]);
  });
});

describe('schemaRefUri and the set-level accessor', () => {
  it('encodes each pointer segment for Ajv', () => {
    expect(schemaRefUri({ uri: ROOT, pointer: '/$defs/my row/items' })).toBe(`${ROOT}#/%24defs/my%20row/items`);
    expect(schemaRefUri({ uri: ROOT, pointer: '' })).toBe(`${ROOT}#`);
  });

  it('is null without a resolved root, and memoized per set', async () => {
    const cycle = await buildSchemaSet(entriesFromDir(fixtureDir('synthetic', 'cycle')), { origin: 'upload' });
    expect(datasetShape(cycle)).toBeNull();
    const hesp: SchemaSet = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), {
      origin: 'upload',
    });
    const shape = datasetShape(hesp);
    expect(shape).toBe(datasetShape(hesp));
    expect(shape).toEqual({
      record: at('/items', 'quac-set:/core/core.schema.json'),
      prefix: [],
      minItems: 1,
      uniqueItems: true,
      unsupported: [],
      warnings: [],
    });
  });
});
