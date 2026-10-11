/**
 * What the loader now says about a schema set before any run
 * (`buildSchemaSet` → drafts, `metaValidate`, `engineChecks`):
 * unsupported and unrecognised drafts, patterns no regular-expression dialect
 * accepts, a record schema Ajv cannot compile, and the checks QuaC will not
 * make (unchecked formats, an empty enum, draft-07 `$ref` siblings).
 */
import { describe, expect, it } from 'vitest';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { entry } from './helpers';
import type { SchemaLoadCode, SchemaSet } from '../../../src/core/schema/types';

const DRAFT7 = 'http://json-schema.org/draft-07/schema#';

const build = (schema: unknown, ...extra: [string, unknown][]): Promise<SchemaSet> =>
  buildSchemaSet([entry('root.json', schema), ...extra.map(([path, json]) => entry(path, json))], {
    origin: 'upload',
  });

const codes = (set: SchemaSet): SchemaLoadCode[] => set.errors.map((e) => e.code);
const find = (set: SchemaSet, code: SchemaLoadCode) => set.errors.find((e) => e.code === code);

describe('drafts at load', () => {
  it('refuses draft-04 with the upgrade path, fatally', async () => {
    const set = await build({
      $schema: 'http://json-schema.org/draft-04/schema#',
      type: 'array',
      items: { type: 'object', properties: { n: { maximum: 5, exclusiveMaximum: true } } },
    });
    const error = find(set, 'E_UNSUPPORTED_DRAFT');
    expect(error?.severity).toBe('fatal');
    expect(error?.message).toContain('`http://json-schema.org/draft-04/schema#`');
    expect(error?.message).toContain('draft-06, draft-07, 2019-09 and 2020-12');
    expect(codes(set)).not.toContain('E_META');
  });

  it('reads https / #-less draft-07 URIs as draft-07 — no E_META', async () => {
    for (const $schema of [
      'https://json-schema.org/draft-07/schema',
      'http://json-schema.org/draft-07/schema',
    ]) {
      const set = await build({ $schema, type: 'array', items: { type: 'object' } });
      expect(set.files[0]?.draft, $schema).toBe('draft-07');
      expect(
        set.errors.filter((e) => e.severity !== 'info'),
        $schema,
      ).toEqual([]);
    }
  });

  it('warns about a custom $schema and validates it as 2020-12', async () => {
    const set = await build({
      $schema: 'https://example.org/my-meta',
      type: 'array',
      items: { type: 'object' },
    });
    expect(find(set, 'W_UNKNOWN_DRAFT')?.message).toBe(
      '`root.json` declares `$schema` `https://example.org/my-meta`, which QuaC does not recognise; it is read as JSON Schema 2020-12.',
    );
    expect(set.errors.some((e) => e.severity === 'fatal')).toBe(false);
  });

  it('accepts draft-06', async () => {
    const set = await build({
      $schema: 'http://json-schema.org/draft-06/schema#',
      type: 'array',
      items: { type: 'object', properties: { n: { exclusiveMaximum: 10 } } },
    });
    expect(set.files[0]?.draft).toBe('draft-06');
    expect(set.errors.filter((e) => e.severity !== 'info')).toEqual([]);
  });
});

describe('E_COMPILE — a schema that cannot validate says so at load', () => {
  it('names a pattern no dialect accepts, by file and pointer', async () => {
    const set = await build({
      type: 'array',
      items: { type: 'object', properties: { code: { type: 'string', pattern: '(?i)^ab' } } },
    });
    const error = find(set, 'E_COMPILE');
    expect(error?.severity).toBe('fatal');
    expect(error?.message).toMatch(
      /^`root\.json` has a `pattern` that is not a valid regular expression \(at `\/items\/properties\/code\/pattern`\): `\(\?i\)\^ab` — .+\.$/,
    );
  });

  it('names a patternProperties key the same way', async () => {
    const set = await build({
      type: 'array',
      items: { type: 'object', patternProperties: { '(x': {} } },
    });
    expect(find(set, 'E_COMPILE')?.message).toContain(
      'a `patternProperties` name that is not a valid regular expression',
    );
  });

  it('lets a pattern through that only the non-Unicode dialect accepts', async () => {
    const set = await build({
      type: 'array',
      items: {
        type: 'object',
        properties: { phone: { type: 'string', pattern: '^\\d{3}\\-\\d{4}$' } },
      },
    });
    expect(codes(set)).not.toContain('E_COMPILE');
  });

  it('reports what Ajv itself cannot compile in the record schema', async () => {
    // The ref graph resolves this target; Ajv only takes a `#…` $dynamicRef.
    const set = await build({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      items: { type: 'object', properties: { tree: { $dynamicRef: 'root.json#/$defs/node' } } },
      $defs: { node: { type: 'object' } },
    });
    expect(find(set, 'E_COMPILE')?.message).toBe(
      '`root.json` could not be prepared for validation: "$dynamicRef" only supports hash fragment reference.',
    );
  });

  it('does not compile on top of an existing fatal (no second report of a broken ref)', async () => {
    const set = await build({ type: 'array', items: { $ref: 'missing.json' } });
    expect(codes(set)).toContain('E_UNRESOLVED_REF');
    expect(codes(set)).not.toContain('E_COMPILE');
  });
});

describe('warnings about checks QuaC will not make', () => {
  it('lists unchecked formats once, sorted', async () => {
    const set = await build({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          a: { type: 'string', format: 'datetime' },
          b: { type: 'string', format: 'password' },
          c: { type: 'string', format: 'date-time' },
          d: { type: 'string', format: 'datetime' },
        },
      },
    });
    expect(set.errors.filter((e) => e.code === 'W_UNCHECKED_FORMAT')).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message:
          'QuaC does not check these formats, so values are not tested against them: `datetime`, `password`.',
      }),
    ]);
  });

  it('warns about an empty enum, which no value can satisfy', async () => {
    const set = await build({
      type: 'array',
      items: { type: 'object', properties: { k: { enum: [] } } },
    });
    expect(find(set, 'W_EMPTY_ENUM')?.message).toContain('(at `/items/properties/k/enum`)');
    expect(set.errors.some((e) => e.severity === 'fatal')).toBe(false);
  });

  it('warns, for draft-07, about checks beside $ref that the draft ignores', async () => {
    const set = await build({
      $schema: DRAFT7,
      type: 'array',
      items: {
        type: 'object',
        properties: { age: { $ref: '#/definitions/int', maximum: 120, title: 'Age' } },
      },
      definitions: { int: { type: 'integer' } },
    });
    expect(find(set, 'W_REF_SIBLINGS')?.message).toBe(
      '`root.json` puts `maximum` next to `$ref` (at `/items/properties/age`); in draft-06 and draft-07 every keyword beside `$ref` is ignored, so QuaC does not check them. Move them into an `allOf` together with the `$ref`, or declare `$schema` 2020-12, where they apply.',
    );
    const set2020 = await build({
      type: 'array',
      items: { type: 'object', properties: { age: { $ref: '#/$defs/int', maximum: 120 } } },
      $defs: { int: { type: 'integer' } },
    });
    expect(codes(set2020)).not.toContain('W_REF_SIBLINGS');
  });
});
