/**
 * The digest's record walk (column-meta.ts): which properties are columns,
 * wherever the record schema declares them; which are required
 * unconditionally; ghosts; the meta of columns only `patternProperties` /
 * `additionalProperties` describe; and whether the record schema rejects a
 * column it does not declare.
 */
import { describe, expect, it } from 'vitest';
import {
  columnDigest,
  undeclaredColumnMeta,
  undeclaredColumnVerdict,
} from '../../../src/core/schema/column-meta';
import type { ColumnMeta } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { IntakeEntry, SchemaSet } from '../../../src/core/schema/types';
import { entriesFromDir, entry, fixtureDir } from './helpers';

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';

/** A one-file 2020-12 dataset schema around `items` (plus any root keywords). */
async function setOf(items: unknown, root: Record<string, unknown> = {}, more: IntakeEntry[] = []): Promise<SchemaSet> {
  return buildSchemaSet(
    [entry('root.json', { $schema: DRAFT_2020, type: 'array', items, ...root }), ...more],
    { origin: 'upload' },
  );
}

function metaOf(set: SchemaSet): ColumnMeta[] {
  const digest = columnDigest(set);
  if (digest === null) throw new Error(`no digest: ${JSON.stringify(set.errors)}`);
  return digest.meta;
}

const names = (set: SchemaSet): string[] => metaOf(set).map((m) => m.name);

function column(set: SchemaSet, name: string): ColumnMeta {
  const m = metaOf(set).find((c) => c.name === name);
  if (m === undefined) throw new Error(`no column ${name}`);
  return m;
}

const types = (m: ColumnMeta): string[] => [...m.jsonTypes].sort();

describe('declarations wherever the record schema makes them', () => {
  it('follows `items: {$ref}` — the commonest layout', async () => {
    const set = await setOf(
      { $ref: '#/$defs/row' },
      {
        $defs: {
          row: {
            type: 'object',
            properties: { id: { type: 'string', title: 'Identifier' }, age: { type: 'integer', maximum: 120 } },
            required: ['id'],
          },
        },
      },
    );
    expect(names(set)).toEqual(['id', 'age']);
    expect(column(set, 'id')).toMatchObject({
      title: 'Identifier',
      required: true,
      storageType: 'VARCHAR',
      source: { fileId: 'root.json', pointer: '/$defs/row/properties/id' },
    });
    expect(column(set, 'age')).toMatchObject({ required: false, storageType: 'BIGINT' });
    expect(column(set, 'age').valueSpec).toMatchObject({ kind: 'numeric', max: 120 });
  });

  it('follows a cross-file `$ref` to an `$anchor`', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', { $schema: DRAFT_2020, type: 'array', items: { $ref: 'defs.json#row' } }),
        entry('defs.json', {
          $schema: DRAFT_2020,
          $defs: { row: { $anchor: 'row', properties: { n: { type: 'number' } }, required: ['n'] } },
        }),
      ],
      { origin: 'upload' },
    );
    expect(set.root.rootFileId).toBe('root.json');
    expect(metaOf(set).map((m) => [m.name, m.required, m.storageType])).toEqual([['n', true, 'DOUBLE']]);
  });

  it('walks nested allOf and categories that are themselves allOf or $ref', async () => {
    const set = await setOf(
      {
        properties: { first: { type: 'string' } },
        allOf: [
          { allOf: [{ properties: { a: { type: 'integer' } } }] },
          { $ref: '#/$defs/category' },
          { properties: { last: { type: 'boolean' } } },
        ],
      },
      {
        $defs: {
          category: { allOf: [{ $ref: '#/$defs/inner' }], 'x-variable-group': 'cat' },
          inner: { 'x-variable-group': 'inner', properties: { b: { type: 'number' } } },
        },
      },
    );
    expect(names(set)).toEqual(['first', 'a', 'b', 'last']);
    expect(column(set, 'b').group).toBe('inner');
    expect(column(set, 'b').storageType).toBe('DOUBLE');
  });

  it('reads anyOf / oneOf branches, then / else and dependentSchemas as conditional declarations', async () => {
    const set = await setOf({
      properties: { kind: { enum: ['a', 'b'] } },
      oneOf: [
        { properties: { x: { type: 'integer' } }, required: ['x'] },
        { properties: { y: { type: 'string' } } },
      ],
      if: { properties: { flag: { const: 1 } }, required: ['flag'] },
      then: { properties: { t: { type: 'number' } }, required: ['t'] },
      else: { properties: { e: { type: 'boolean' } } },
      dependentSchemas: { kind: { properties: { d: { type: 'integer' } }, required: ['d'] } },
      not: { properties: { never: { type: 'string' } } },
    });
    // `flag` lives only in the `if` and `never` only in the `not`: neither declares.
    expect(names(set)).toEqual(['kind', 'x', 'y', 't', 'e', 'd']);
    for (const name of ['x', 'y', 't', 'e', 'd']) {
      const m = column(set, name);
      expect(m.required, name).toBe(false);
      expect(m.declarations?.every((d) => d.conditional), name).toBe(true);
    }
    expect(column(set, 'kind').declarations).toEqual([
      { fileId: 'root.json', pointer: '/items/properties/kind', conditional: false },
    ]);
    // A name declared only conditionally takes its alternatives' types.
    expect(column(set, 'x').storageType).toBe('BIGINT');
    expect(column(set, 'e').storageType).toBe('BOOLEAN');
  });

  it('reads draft-07 schema-form `dependencies`, not the array form', async () => {
    const set = await buildSchemaSet(
      [
        entry('root.json', {
          $schema: DRAFT_07,
          type: 'array',
          items: {
            properties: { a: { type: 'string' } },
            dependencies: { a: { properties: { c: { type: 'string' } } }, z: ['a'] },
          },
        }),
      ],
      { origin: 'upload' },
    );
    expect(names(set)).toEqual(['a', 'c']);
  });

  it('a then / else without an `if` is not applied, so it declares nothing', async () => {
    const set = await setOf({ properties: { a: {} }, then: { properties: { b: {} } } });
    expect(names(set)).toEqual(['a']);
  });

  it('counts boolean property schemas', async () => {
    const set = await setOf({ properties: { anything: true, secret: false, id: { type: 'string' } } });
    expect(names(set)).toEqual(['anything', 'secret', 'id']);
    expect(column(set, 'anything')).toMatchObject({ storageType: 'VARCHAR', mixed: true });
    expect(types(column(set, 'anything'))).toEqual([]);
    expect(column(set, 'secret').valueSpec.kind).toBe('opaque');
  });

  it('starts from prefix schemas too, their records first', async () => {
    const set = await setOf(
      { properties: { value: { type: 'number' } } },
      { prefixItems: [{ properties: { header: { type: 'string' } }, required: ['header'] }] },
    );
    expect(names(set)).toEqual(['header', 'value']);
    // What a prefix record requires, that record must have.
    expect(column(set, 'header').required).toBe(true);
    expect(column(set, 'header').declarations?.[0]?.conditional).toBe(true);
  });
});

describe('merging the declarations of one name', () => {
  it('intersects the unconditional declarations, integer inside number either way round', async () => {
    const set = await setOf({
      properties: { v: { type: ['integer', 'string'] }, w: { type: 'number' } },
      allOf: [{ properties: { v: { type: 'integer' }, w: { type: 'integer' } } }],
    });
    expect(types(column(set, 'v'))).toEqual(['integer']);
    expect(types(column(set, 'w'))).toEqual(['integer']);
    expect(column(set, 'w').storageType).toBe('BIGINT');
  });

  it('keeps strings, group and source from the first declaration, the spec from the first unconditional one', async () => {
    const set = await setOf({
      anyOf: [{ properties: { v: { title: 'From the branch', type: 'integer', maximum: 3 } } }],
      allOf: [{ 'x-variable-group': 'g', properties: { v: { title: 'From allOf', type: 'integer', maximum: 9 } } }],
    });
    const v = column(set, 'v');
    expect(v.title).toBe('From the branch');
    expect(v.source.pointer).toBe('/items/anyOf/0/properties/v');
    expect(v.valueSpec).toMatchObject({ kind: 'numeric', max: 9 });
    // Conditional alternatives never widen what the unconditional declaration allows.
    expect(types(v)).toEqual(['integer']);
    expect(v.declarations?.map((d) => d.conditional)).toEqual([true, false]);
  });

  it('an untyped unconditional declaration leaves the type open whatever the branches say', async () => {
    const set = await setOf({
      properties: { v: { title: 'Any value' } },
      if: { required: ['k'] },
      then: { properties: { v: { type: 'integer' } } },
    });
    expect(types(column(set, 'v'))).toEqual([]);
    expect(column(set, 'v')).toMatchObject({ storageType: 'VARCHAR', mixed: true });
  });

  it('a name declared only in alternatives of different types is mixed', async () => {
    const set = await setOf({
      oneOf: [{ properties: { w: { type: 'integer' } } }, { properties: { w: { type: 'string' } } }],
    });
    expect(types(column(set, 'w'))).toEqual(['integer', 'string']);
    expect(column(set, 'w')).toMatchObject({ storageType: 'VARCHAR', mixed: true });
  });
});

describe('required means unconditionally required', () => {
  it('collects required across allOf and $ref, never through anyOf / then / dependentSchemas', async () => {
    const set = await setOf(
      {
        required: ['a'],
        properties: { a: {}, c: {}, d: {}, e: {}, f: {}, g: {} },
        allOf: [{ required: ['b'] }, { $ref: '#/$defs/needsC' }, { anyOf: [{ required: ['d'] }] }],
        if: { required: ['a'] },
        then: { required: ['e'] },
        dependentSchemas: { a: { required: ['f'] } },
        oneOf: [{ required: ['g'] }],
      },
      { $defs: { needsC: { required: ['c'] } } },
    );
    const required = metaOf(set)
      .filter((m) => m.required)
      .map((m) => m.name)
      .sort();
    // `b` is required but declared nowhere: a ghost (below), still required.
    expect(required).toEqual(['a', 'b', 'c']);
  });

  it("splits required away from properties (HESP's categories, the nested example's items)", async () => {
    const set = await setOf({
      required: ['id', 'when'],
      allOf: [{ properties: { id: { type: 'string' } } }, { properties: { when: { type: 'string' } } }],
    });
    expect(metaOf(set).map((m) => [m.name, m.required])).toEqual([
      ['id', true],
      ['when', true],
    ]);
  });
});

describe('ghosts — required, never declared', () => {
  it('get a ColumnMeta once, after the declared columns', async () => {
    const set = await setOf({
      properties: { id: { type: 'string' } },
      required: ['id', 'ghost'],
    });
    expect(names(set)).toEqual(['id', 'ghost']);
    expect(column(set, 'ghost')).toMatchObject({
      required: true,
      declared: false,
      storageType: 'VARCHAR',
      mixed: true,
      valueSpec: { kind: 'opaque' },
      source: { fileId: 'root.json', pointer: '/items/required/1' },
      declarations: [],
    });
    expect(column(set, 'id').declared).toBeUndefined();
  });

  it('take their type from a matching patternProperties entry', async () => {
    const set = await setOf({
      properties: { id: {} },
      patternProperties: { '^x_': { type: 'integer', title: 'An x' } },
      required: ['x_1'],
    });
    expect(column(set, 'x_1')).toMatchObject({
      required: true,
      declared: false,
      storageType: 'BIGINT',
      title: 'An x',
    });
  });
});

describe('undeclaredColumnMeta', () => {
  const schema = {
    properties: { id: { type: 'string' } },
    patternProperties: {
      '^x_': { type: 'integer', maximum: 5 },
      '_n$': { type: 'number' },
    },
    additionalProperties: { type: 'string' },
  };

  it('describes a column by every patternProperties entry matching it', async () => {
    const set = await setOf(schema);
    expect(undeclaredColumnMeta(set, 'x_b')).toMatchObject({
      name: 'x_b',
      required: false,
      declared: false,
      storageType: 'BIGINT',
      valueSpec: { kind: 'numeric', max: 5 },
      source: { fileId: 'root.json', pointer: '/items/patternProperties/^x_' },
    });
    // Both patterns apply: an integer that is also a number.
    expect(undeclaredColumnMeta(set, 'x_n')?.storageType).toBe('BIGINT');
  });

  it("applies another object's additionalProperties beside a pattern match, as Ajv does", async () => {
    const set = await setOf({
      allOf: [
        { patternProperties: { '^x_': { type: ['integer', 'string'] } } },
        { additionalProperties: { type: 'integer' } },
      ],
    });
    expect(undeclaredColumnMeta(set, 'x_1')?.storageType).toBe('BIGINT');
  });

  it('falls back to additionalProperties, then unevaluatedProperties', async () => {
    expect(undeclaredColumnMeta(await setOf(schema), 'other')?.storageType).toBe('VARCHAR');
    const uneval = await setOf({ properties: { id: {} }, unevaluatedProperties: { type: 'boolean' } });
    expect(undeclaredColumnMeta(uneval, 'flag')?.storageType).toBe('BOOLEAN');
  });

  it('is null for a declared name, when nothing describes the column, and for boolean keywords', async () => {
    const set = await setOf(schema);
    expect(undeclaredColumnMeta(set, 'id')).toBeNull();
    expect(undeclaredColumnMeta(await setOf({ properties: { id: {} } }), 'other')).toBeNull();
    expect(undeclaredColumnMeta(await setOf({ additionalProperties: false }), 'other')).toBeNull();
    expect(undeclaredColumnMeta(await setOf({ additionalProperties: true }), 'other')).toBeNull();
  });

  it('reads a pattern Ajv compiles only without the u flag', async () => {
    const set = await setOf({ patternProperties: { '^\\-x$': { type: 'integer' } } });
    expect(undeclaredColumnMeta(set, '-x')?.storageType).toBe('BIGINT');
  });
});

describe('undeclaredColumnVerdict', () => {
  it('rejected: additionalProperties false, or unevaluatedProperties false with nothing to evaluate it', async () => {
    expect(undeclaredColumnVerdict(await setOf({ properties: { a: {} }, additionalProperties: false }), 'b')).toBe(
      'rejected',
    );
    const hespLike = await setOf({
      allOf: [{ $ref: '#/$defs/cat' }],
      unevaluatedProperties: false,
    }, { $defs: { cat: { properties: { a: {} } } } });
    expect(undeclaredColumnVerdict(hespLike, 'b')).toBe('rejected');
  });

  it('allowed: an open record, a matching pattern, a schema-valued additionalProperties', async () => {
    expect(undeclaredColumnVerdict(await setOf({ properties: { a: {} } }), 'b')).toBe('allowed');
    const patterned = await setOf({
      properties: { a: {} },
      patternProperties: { '^x_': {} },
      additionalProperties: false,
    });
    expect(undeclaredColumnVerdict(patterned, 'x_1')).toBe('allowed');
    expect(undeclaredColumnVerdict(patterned, 'y')).toBe('rejected');
    const evaluated = await setOf({
      allOf: [{ additionalProperties: { type: 'string' } }],
      unevaluatedProperties: false,
    });
    expect(undeclaredColumnVerdict(evaluated, 'b')).toBe('allowed');
  });

  it('reads propertyNames: rejected by a failing pattern or length, unknown past the simple keywords', async () => {
    const named = await setOf({ propertyNames: { pattern: '^[a-z_]+$', maxLength: 8 } });
    expect(undeclaredColumnVerdict(named, 'ok_name')).toBe('allowed');
    expect(undeclaredColumnVerdict(named, 'Bad')).toBe('rejected');
    expect(undeclaredColumnVerdict(named, 'much_too_long')).toBe('rejected');
    expect(undeclaredColumnVerdict(await setOf({ propertyNames: { format: 'email' } }), 'x')).toBe('unknown');
    expect(undeclaredColumnVerdict(await setOf({ propertyNames: false }), 'x')).toBe('rejected');
  });

  it('unknown: only a conditional schema rejects the name', async () => {
    const branchy = await setOf({
      properties: { a: {} },
      anyOf: [{ additionalProperties: false, properties: { a: {} } }, { required: ['a'] }],
    });
    expect(undeclaredColumnVerdict(branchy, 'b')).toBe('unknown');
  });

  it('HESP rejects a column its categories do not declare', async () => {
    const hesp = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), { origin: 'upload' });
    expect(undeclaredColumnVerdict(hesp, 'not_a_hesp_column')).toBe('rejected');
  });
});

describe('the HESP layout is digested as before', () => {
  it('265 declared columns, each first declared unconditionally in its category', async () => {
    const hesp = await buildSchemaSet(entriesFromDir(fixtureDir('hesp', 'json_schema')), { origin: 'upload' });
    const meta = metaOf(hesp);
    expect(meta).toHaveLength(265);
    expect(meta.every((m) => m.declared === undefined)).toBe(true);
    for (const m of meta) {
      const first = m.declarations?.[0];
      expect(first?.conditional, m.name).toBe(false);
      expect(first?.fileId.startsWith('core/categories/'), m.name).toBe(true);
      expect(m.source).toEqual({ fileId: first?.fileId, pointer: first?.pointer });
    }
    // The if/then blocks re-declare their targets conditionally; they add no column.
    const moveReason = meta.find((m) => m.name === 'move_reason');
    expect(moveReason?.declarations?.some((d) => d.conditional)).toBe(true);
  });
});
