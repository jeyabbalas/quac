/**
 * Nested values on their way to Ajv (src/core/schema/nested-values.ts): the
 * plan built from a column's DuckDB type and its schema, the decode of one
 * cell's `to_json` text, and the paths messages name.
 *
 * The plans are built over the upstream stress schema (vendored in
 * tests/fixtures/nested/) with the DuckDB types its dataset loads as — the
 * pair QuaC reported 15,308 false errors for before nested support.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { createRefResolver } from '../../../src/core/schema/deref';
import {
  buildNestedPlan,
  decodeNestedValue,
  pointerSegments,
  propertySite,
  renderNestedPath,
  toInstancePath,
} from '../../../src/core/schema/nested-values';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { NestedPlan } from '../../../src/core/schema/nested-values';
import type { SchemaSet } from '../../../src/core/schema/types';
import { entry, fixtureDir } from './helpers';

/** What DESCRIBE prints for the stress dataset's nested columns. */
const STRESS_TYPES: Record<string, string> = {
  point: 'STRUCT(x DOUBLE, y DOUBLE, tier VARCHAR)',
  depth5: 'STRUCT(l2 STRUCT(l3 STRUCT(l4 STRUCT(l5 STRUCT(leaf BIGINT)))))',
  key_order: 'STRUCT("2" BIGINT, "1" BIGINT)',
  people: 'STRUCT("name" VARCHAR, age BIGINT, langs VARCHAR[])[]',
  odd_keys:
    'STRUCT(k VARCHAR, score DOUBLE, kind VARCHAR, "my field" JSON, "a.b" BIGINT, "q""k" BOOLEAN, "ünï" VARCHAR)',
  props: 'MAP(VARCHAR, BIGINT)',
  mixed_list: 'JSON[]',
  shifty: 'JSON',
};

let stress: SchemaSet;
const plans = new Map<string, NestedPlan>();

async function setOf(schema: unknown): Promise<SchemaSet> {
  return buildSchemaSet([entry('root.json', schema)], { origin: 'upload' });
}

/** The plan for `column` of `set`, as validation-run builds it. */
function planOf(set: SchemaSet, column: string, type: string): NestedPlan {
  const digest = columnDigest(set);
  const meta = digest?.meta.find((m) => m.name === column);
  if (meta === undefined) throw new Error(`no column ${column}`);
  const resolver = createRefResolver(set);
  return buildNestedPlan(type, propertySite(resolver.fileById(meta.source.fileId), meta.source.pointer), resolver);
}

beforeAll(async () => {
  stress = await buildSchemaSet(
    [
      {
        relativePath: 'nested-stress-tests.schema.json',
        raw: readFileSync(fixtureDir('nested', 'nested-stress-tests.schema.json'), 'utf8'),
      },
    ],
    { origin: 'upload' },
  );
  for (const [column, type] of Object.entries(STRESS_TYPES)) plans.set(column, planOf(stress, column, type));
});

const plan = (column: string): NestedPlan => {
  const p = plans.get(column);
  if (p === undefined) throw new Error(column);
  return p;
};

describe('buildNestedPlan — which NULL struct fields read as missing', () => {
  it('a field whose schema forbids null reads as missing; a nullable one stays null', () => {
    // odd_keys.kind is `type: "string"`; every other field allows null.
    expect(plan('odd_keys')).toMatchObject({ kind: 'struct', dropNull: ['kind'] });
    // key_order."1" is `type: "integer"`, "2" is ["integer", "null"].
    expect(plan('key_order')).toMatchObject({ kind: 'struct', dropNull: ['1'] });
    expect(plan('point')).toMatchObject({ kind: 'struct', dropNull: [] });
  });

  it('walks every level: depth5 drops l2, l4, l5 and leaf, keeps l3', () => {
    const levels: string[][] = [];
    let p: NestedPlan | undefined = plan('depth5');
    while (p?.kind === 'struct') {
      levels.push(p.dropNull);
      p = p.fields[0]?.[1];
    }
    expect(levels).toEqual([['l2'], [], ['l4'], ['l5'], ['leaf']]);
  });

  it('a list of structs plans its element; people keep their nulls (required, nullable)', () => {
    const people = plan('people');
    expect(people.kind).toBe('list');
    expect(people.kind === 'list' ? people.element : null).toMatchObject({ kind: 'struct', dropNull: [] });
  });

  it('a map and a JSON column take values as they are', () => {
    expect(plan('props')).toEqual({ kind: 'map', value: { kind: 'leaf' } });
    expect(plan('mixed_list')).toEqual({ kind: 'list', element: { kind: 'json' } });
    expect(plan('shifty')).toEqual({ kind: 'json' });
  });

  it('follows $ref, and reads open objects through patternProperties and additionalProperties', async () => {
    const set = await setOf({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      items: {
        type: 'object',
        properties: {
          labs: {
            type: 'object',
            patternProperties: { '^hb': { type: ['number', 'null'] } },
            additionalProperties: { type: 'number' },
          },
          visit: { $ref: '#/$defs/visit' },
        },
      },
      $defs: {
        visit: {
          type: 'object',
          properties: { date: { type: 'string' }, note: { type: ['string', 'null'] } },
          additionalProperties: false,
        },
      },
    });
    // hba1c matches the nullable pattern; glucose falls to additionalProperties.
    expect(planOf(set, 'labs', 'STRUCT(hba1c DOUBLE, glucose DOUBLE)')).toMatchObject({
      kind: 'struct',
      dropNull: ['glucose'],
    });
    // DuckDB gave the struct a key one record had (`pulse`): the closed object
    // admits no such field, so its NULL in every other record is missing.
    expect(planOf(set, 'visit', 'STRUCT(date VARCHAR, note VARCHAR, pulse BIGINT)')).toMatchObject({
      kind: 'struct',
      dropNull: ['date', 'pulse'],
    });
  });
});

describe('decodeNestedValue', () => {
  it('drops the planned NULL fields at every depth, and nothing else', () => {
    const { value } = decodeNestedValue(
      '{"l2":{"l3":{"l4":null}}}',
      plan('depth5'),
      false,
    );
    expect(value).toEqual({ l2: { l3: {} } });
    const kept = decodeNestedValue('{"x":null,"y":null,"tier":null}', plan('point'), false);
    expect(kept.value).toEqual({ x: null, y: null, tier: null });
  });

  it('reads NaN and ±Infinity as null and reports each path', () => {
    const decoded = decodeNestedValue('[1.5,NaN,{"v":-Infinity}]', { kind: 'json' }, false);
    expect(decoded.value).toEqual([1.5, null, { v: null }]);
    expect(decoded.nonFinite).toEqual([
      { path: [1], token: 'NaN' },
      { path: [2, 'v'], token: '-Infinity' },
    ]);
  });

  it('locates the first integer past 2^53 with the digits the text held', () => {
    const decoded = decodeNestedValue(
      '[0,9007199254740991,9007199254740993,9223372036854775807]',
      { kind: 'list', element: { kind: 'leaf' } },
      true,
    );
    expect(decoded.unsafeInteger).toEqual({ path: [2], text: '9007199254740993' });
    // The whole value, too — it sits in JSON.parse's own wrapper.
    expect(decodeNestedValue('-9223372036854775808', { kind: 'json' }, true).unsafeInteger).toEqual({
      path: [],
      text: '-9223372036854775808',
    });
    // A huge DOUBLE is no integer token: nothing to report.
    expect(decodeNestedValue('[1.7976931348623157e308]', { kind: 'json' }, true).unsafeInteger).toBeNull();
    // Not asked to look: nothing found.
    expect(decodeNestedValue('[9007199254740993]', { kind: 'json' }, false).unsafeInteger).toBeNull();
  });

  it('keeps JavaScript-hostile keys as plain fields', () => {
    const { value } = decodeNestedValue(
      '{"__proto__":null,"toJSON":1,"constructor":NaN}',
      { kind: 'struct', fields: [], dropNull: ['__proto__'] },
      false,
    );
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value as object)).toEqual(['toJSON', 'constructor']);
    expect((value as Record<string, unknown>).constructor).toBeNull();
  });
});

describe('renderNestedPath', () => {
  const people = [null, { name: null }, { name: 'Ada', langs: ['en', null] }];
  it('counts list items from 1, as DuckDB SQL and the value inspector do', () => {
    expect(renderNestedPath('people', [2, 'langs', 1], people, plan('people'))).toBe('people[3].langs[2]');
  });

  it('counts an array inside a JSON value from 0, as JSONPath does', () => {
    expect(renderNestedPath('shifty', [0], [9, 9], plan('shifty'))).toBe('shifty[0]');
    expect(renderNestedPath('mixed_list', [3, 'k'], [1, 2, 3, { k: 12 }], plan('mixed_list'))).toBe(
      'mixed_list[4].k',
    );
  });

  it('quotes a field name that is not an identifier, and every map key', () => {
    expect(renderNestedPath('odd_keys', ['my field'], {}, plan('odd_keys'))).toBe('odd_keys["my field"]');
    expect(renderNestedPath('odd_keys', ['q"k'], {}, plan('odd_keys'))).toBe('odd_keys["q\\"k"]');
    expect(renderNestedPath('key_order', ['2'], { '2': 1 }, plan('key_order'))).toBe('key_order["2"]');
    expect(renderNestedPath('props', ['size'], { size: 1 }, plan('props'))).toBe('props["size"]');
  });

  it('round-trips Ajv instance paths', () => {
    expect(pointerSegments('/odd_keys/a~1b/q~0k')).toEqual(['odd_keys', 'a/b', 'q~k']);
    expect(toInstancePath('odd_keys', ['a/b', 2])).toBe('/odd_keys/a~1b/2');
  });
});
