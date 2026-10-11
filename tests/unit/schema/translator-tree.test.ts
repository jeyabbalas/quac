/**
 * The translator over REAL Ajv errors (QuaC's own buildAjv configuration),
 * read as a tree: which errors a failed anyOf/oneOf, if/then/else, contains
 * or propertyNames owns (error-tree.ts), sized exactly by the schema probe
 * (schema-probe.ts) and — where a test says so — by the schemaPath fallback
 * a caller without a probe gets.
 *
 * Each case is a finding from the 2026-10 correctness review: a message that
 * was false, an error that was dropped or leaked, a condition that was lost.
 */
import { describe, expect, it } from 'vitest';
import { buildAjv } from '../../../src/core/schema/ajv-engine';
import { extractConditionals } from '../../../src/core/schema/conditionals';
import { createSchemaProbe } from '../../../src/core/schema/schema-probe';
import { createTranslateCtx, translateRowErrors } from '../../../src/core/schema/translator';
import { formatBound } from '../../../src/core/schema/value-spec';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { AjvErrorLike } from '../../../src/core/schema/translator';
import type { SchemaDraft, SchemaSet } from '../../../src/core/schema/types';

interface Options {
  draft?: SchemaDraft;
  /** Other files of the set, by name (registered as `quac-set:/<name>`). */
  files?: Record<string, unknown>;
  missingRequired?: string[];
  castFailures?: string[];
}

interface Harness {
  flags: (row: unknown, opts?: { probe?: boolean }) => QCFlag[];
  messages: (row: unknown, opts?: { probe?: boolean }) => string[];
  errors: (row: unknown) => AjvErrorLike[];
}

/** `people[2].age`: list items from 1, fields by name — the worker's locate, in miniature. */
function locate(instancePath: string): string {
  const [column = '', ...rest] = instancePath
    .split('/')
    .slice(1)
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  return rest.reduce((at, s) => (/^\d+$/.test(s) ? `${at}[${String(Number(s) + 1)}]` : `${at}.${s}`), column);
}

function harness(schema: Record<string, unknown>, opts: Options = {}): Harness {
  const draft = opts.draft ?? '2020-12';
  const ajv = buildAjv(draft);
  const rootUri = 'quac-set:/root.json';
  const files = [
    { uri: rootUri, json: schema as unknown },
    ...Object.entries(opts.files ?? {}).map(([name, json]) => ({ uri: `quac-set:/${name}`, json })),
  ];
  for (const f of files) ajv.addSchema(f.json as object, f.uri);
  const base = typeof schema.$id === 'string' ? schema.$id : rootUri;
  const validate = ajv.getSchema(`${base}#/items`);
  if (validate === undefined) throw new Error('row schema did not compile');
  const probe = createSchemaProbe(ajv, files, { rowSchema: `${base}#/items` });
  const set = { files: [{ fileId: 'root.json', json: schema }] } as unknown as SchemaSet;
  const ctx = createTranslateCtx([], extractConditionals(set, 'root.json'), {
    missingRequired: opts.missingRequired ?? [],
    castFailures: opts.castFailures ?? [],
  });
  const errors = (row: unknown): AjvErrorLike[] => {
    const valid = validate(row);
    return valid ? [] : ((validate.errors ?? []) as AjvErrorLike[]).map((e) => ({ ...e }));
  };
  const flags = (row: unknown, o: { probe?: boolean } = {}): QCFlag[] =>
    translateRowErrors(errors(row), 0, ctx, { locate, ...(o.probe === false ? {} : { probe }) });
  return {
    errors,
    flags,
    messages: (row, o) =>
      flags(row, o).map((f) => `${f.column ?? `[${f.scope}]`}: ${f.message}`),
  };
}

const array = (items: Record<string, unknown>, rest: Record<string, unknown> = {}): Record<string, unknown> => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'array',
  items,
  ...rest,
});

describe('a required error is "required for every record" only when it is unconditional', () => {
  it('row-level anyOf of required fields is ONE row finding naming the alternatives', () => {
    const h = harness(array({ type: 'object', anyOf: [{ required: ['email'] }, { required: ['phone'] }] }));
    for (const probe of [true, false]) {
      expect(h.messages({ id: 1 }, { probe })).toEqual(["[row]: the record needs at least one of: 'email', 'phone'."]);
    }
    expect(h.flags({ id: 1 })[0]?.ruleId).toBe('schema:row:anyOf');
  });

  it('row-level oneOf: none matched, or more than one', () => {
    const h = harness(array({ type: 'object', oneOf: [{ required: ['email'] }, { required: ['phone'] }] }));
    expect(h.messages({})).toEqual(["[row]: the record needs exactly one of: 'email', 'phone'."]);
    expect(h.messages({ email: 'a', phone: 'b' })).toEqual([
      '[row]: the record matches more than one of the exclusive alternatives (options 1 and 2) — it must match exactly one.',
    ]);
  });

  it('a then-required on the row reads "required when …", not "for every record"', () => {
    const h = harness(
      array({
        type: 'object',
        properties: { status: { type: 'string' } },
        if: { properties: { status: { const: 'closed' } }, required: ['status'] },
        then: { required: ['closed_on'] },
      }),
    );
    for (const probe of [true, false]) {
      expect(h.messages({ status: 'closed' }, { probe })).toEqual([
        "closed_on: value is missing — this variable is required when status = 'closed'.",
      ]);
    }
    expect(h.messages({ status: 'open' })).toEqual([]);
    expect(h.flags({ status: 'closed' })[0]?.ruleId).toBe('schema:prop:closed_on:required');
  });

  it('an else-required reads "unless …"', () => {
    const h = harness(
      array({
        type: 'object',
        if: { properties: { kind: { const: 'a' } }, required: ['kind'] },
        then: true,
        else: { required: ['reason'] },
      }),
    );
    expect(h.messages({ kind: 'b' })).toEqual(["reason: value is missing — this variable is required unless kind = 'a'."]);
  });

  it('dependentSchemas — inline, and behind a $ref (only the probe can tell)', () => {
    const inline = harness(array({ type: 'object', dependentSchemas: { a: { required: ['c'] } } }));
    for (const probe of [true, false]) {
      expect(inline.messages({ a: 1 }, { probe })).toEqual([
        "c: value is missing — this variable is required when 'a' is present.",
      ]);
    }
    const viaRef = harness(
      array({ type: 'object', dependentSchemas: { a: { $ref: '#/$defs/needC' } } }, { $defs: { needC: { required: ['c'] } } }),
    );
    expect(viaRef.messages({ a: 1 })).toEqual(["c: value is missing — this variable is required when 'a' is present."]);
  });

  it('dependentRequired, and draft-07 dependencies in both forms', () => {
    const h = harness(array({ type: 'object', dependentRequired: { a: ['b'] } }));
    expect(h.messages({ a: 1 })).toEqual(["b: value is missing — this variable is required when 'a' is present."]);
    expect(h.flags({ a: 1 })[0]?.ruleId).toBe('schema:prop:b:required');
    const d7 = harness(
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: { type: 'object', dependencies: { c: ['d'], e: { required: ['f'] } } },
      },
      { draft: 'draft-07' },
    );
    expect(d7.messages({ c: 1, e: 2 })).toEqual([
      "d: value is missing — this variable is required when 'c' is present.",
      "f: value is missing — this variable is required when 'e' is present.",
    ]);
  });

  it('missingRequired silences only the unconditional required; a conditional one still reports', () => {
    const schema = array({
      type: 'object',
      required: ['b'],
      if: { properties: { a: { const: 1 } }, required: ['a'] },
      then: { required: ['c'] },
    });
    const h = harness(schema, { missingRequired: ['b', 'c'] });
    expect(h.messages({ a: 1 })).toEqual(['c: value is missing — this variable is required when a = 1.']);
  });
});

describe('if / then / else', () => {
  const block = {
    $comment: 'Kind 1 takes x, every other kind y.',
    if: { properties: { kind: { const: 1 } }, required: ['kind'] },
    then: { properties: { b: { const: 'x' } } },
    else: { properties: { b: { const: 'y' } } },
  };

  it('an else failure is reported as the else rule, with a true condition', () => {
    const h = harness(array({ type: 'object', allOf: [block] }));
    for (const probe of [true, false]) {
      expect(h.messages({ kind: 2, b: 'z' }, { probe })).toEqual([
        "b: unless kind = 1, b must be 'y'. Found 'z'. [Schema note: Kind 1 takes x, every other kind y.]",
      ]);
      expect(h.messages({ kind: 1, b: 'z' }, { probe })).toEqual([
        "b: when kind = 1, b must be 'x'. Found 'z'. [Schema note: Kind 1 takes x, every other kind y.]",
      ]);
    }
    expect(h.flags({ kind: 2, b: 'z' })[0]).toMatchObject({ ruleId: 'schema:cond:0:b', meta: { conditionalIndex: 0 } });
  });

  it('an if that is not a const pair still reads as a condition (never "when ,")', () => {
    const h = harness(
      array({
        type: 'object',
        allOf: [
          { if: { properties: { age: { minimum: 18 } }, required: ['age'] }, then: { properties: { b: { enum: ['x', 'y'] } } } },
          { if: { required: ['kind'] }, then: { properties: { k2: { maximum: 5 } } } },
        ],
      }),
    );
    expect(h.messages({ age: 20, b: 'z' })).toEqual(["b: when age is at least 18, b must be one of 'x', 'y'. Found 'z'."]);
    expect(h.messages({ kind: 1, k2: 9 })).toEqual(["k2: when 'kind' is present, k2 must be at most 5. Found 9."]);
  });

  it('a condition held because its property is missing says so', () => {
    const h = harness(
      array({ type: 'object', if: { properties: { a: { const: 1 } } }, then: { properties: { b: { const: 'x' } } } }),
    );
    expect(h.messages({ b: 'z' })).toEqual([
      "b: when a = 1 (a is missing, which satisfies the condition), b must be 'x'. Found 'z'.",
    ]);
  });

  it('then-anyOf across columns is ONE finding under the condition', () => {
    const h = harness(
      array({
        type: 'object',
        if: { properties: { a: { const: 1 } }, required: ['a'] },
        then: { anyOf: [{ required: ['b'] }, { required: ['c'] }] },
      }),
    );
    expect(h.messages({ a: 1 })).toEqual(["[row]: when a = 1, the record needs at least one of: 'b', 'c'."]);
  });

  it('an if at property level, and one in a nested value, name their properties by path', () => {
    const h = harness(
      array({
        type: 'object',
        properties: {
          address: {
            type: 'object',
            if: { properties: { country: { const: 'US' } }, required: ['country'] },
            then: { required: ['zip'] },
          },
          people: {
            type: 'array',
            items: {
              type: 'object',
              if: { properties: { kind: { const: 'child' } }, required: ['kind'] },
              then: { properties: { age: { maximum: 17 } } },
            },
          },
        },
      }),
    );
    expect(h.messages({ address: { country: 'US' } })).toEqual([
      "address: when address.country = 'US', address must have the field 'zip'.",
    ]);
    expect(h.messages({ people: [{ kind: 'adult', age: 40 }, { kind: 'child', age: 30 }] })).toEqual([
      "people: when people[2].kind = 'child', people[2].age must be at most 17. Found 30.",
    ]);
  });

  it('a conditional in a $ref’d category file keeps its condition', () => {
    const h = harness(array({ type: 'object', allOf: [{ $ref: 'cat.json' }] }), {
      files: {
        'cat.json': {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          allOf: [{ if: { properties: { q: { const: 1 } }, required: ['q'] }, then: { properties: { r: { const: 'q' } } } }],
        },
      },
    });
    expect(h.messages({ q: 1, r: 'z' })).toEqual(["r: when q = 1, r must be 'q'. Found 'z'."]);
  });
});

describe('unions', () => {
  it('collapsing a union silences only its own branch errors — not unrelated ones on the same value', () => {
    const nested = harness(
      array({
        type: 'object',
        properties: {
          v: { type: 'object', properties: { k: { maximum: 9 } }, oneOf: [{ required: ['a'] }, { required: ['b'] }] },
        },
      }),
    );
    for (const probe of [true, false]) {
      const messages = nested.messages({ v: { k: 12 } }, { probe });
      expect(messages).toContain('v: 12 exceeds the maximum 9 (at v.k).');
      expect(messages).toHaveLength(2);
    }
    const column = harness(
      array({
        type: 'object',
        properties: { s: { type: 'string', maxLength: 3, anyOf: [{ pattern: '^A' }, { pattern: '^B' }] } },
      }),
    );
    for (const probe of [true, false]) {
      const messages = column.messages({ s: 'CCCCCC' }, { probe });
      expect(messages).toContain("s: 'CCCCCC' has 6 characters; at most 3 allowed.");
      expect(messages).toHaveLength(2);
    }
  });

  it('narrowing to the one type-compatible branch reports only that branch', () => {
    const h = harness(
      array({
        type: 'object',
        properties: {
          v: {
            anyOf: [
              { type: 'string', enum: ['N/A', 'unknown'] },
              { type: 'object', properties: { k: { maximum: 9 } } },
            ],
          },
          w: { anyOf: [{ type: 'integer', const: -9 }, { type: 'string', maxLength: 3 }] },
        },
      }),
    );
    for (const probe of [true, false]) {
      expect(h.messages({ v: { k: 12 }, w: 'toolong' }, { probe })).toEqual([
        'v: 12 exceeds the maximum 9 (at v.k).',
        "w: 'toolong' has 7 characters; at most 3 allowed.",
      ]);
    }
  });

  it('an enum/const-only branch never narrows: 50.5 is not reported as a bad code', () => {
    const h = harness(
      array({
        type: 'object',
        properties: { v: { anyOf: [{ type: 'integer', minimum: 0, maximum: 100 }, { enum: [-9, -8] }] } },
      }),
    );
    const flags = h.flags({ v: 50.5 });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.message).toBe('50.5 is not valid — expected a value satisfying the schema.');
    expect(flags[0]?.meta?.keyword).toBe('anyOf');
  });

  it('$ref’d branches (HESP-style missing-value codes) collapse to one flag, with or without the probe', () => {
    const h = harness(
      array(
        { type: 'object', properties: { inc: { anyOf: [{ type: 'integer', minimum: 0 }, { $ref: '#/$defs/na' }, { $ref: '#/$defs/rf' }] } } },
        { $defs: { na: { const: -666 }, rf: { const: -777 } } },
      ),
    );
    for (const probe of [true, false]) {
      const flags = h.flags({ inc: -5 }, { probe });
      expect(flags).toHaveLength(1);
      expect(flags[0]?.meta?.keyword).toBe('anyOf');
    }
  });

  it('a $ref’d code list whose own oneOf sits at its root keeps its $defs branches (HESP yes/no codes)', () => {
    const h = harness(
      array({ type: 'object', properties: { yn: { $ref: '#/$defs/yesNo' } } }, {
        $defs: {
          yesNo: { oneOf: [{ const: 0 }, { const: 1 }, { $ref: '#/$defs/refused' }] },
          refused: { const: -777 },
        },
      }),
    );
    for (const probe of [true, false]) {
      const flags = h.flags({ yn: 9 }, { probe });
      expect(flags).toHaveLength(1);
      expect(flags[0]?.meta?.keyword).toBe('oneOf');
    }
  });

  it('two unions on one value — the column’s own and a conditional one — are two findings', () => {
    const h = harness(
      array({
        type: 'object',
        properties: { n: { anyOf: [{ type: 'integer', maximum: 20 }, { const: -777 }] } },
        allOf: [
          {
            if: { properties: { k: { const: 1 } }, required: ['k'] },
            then: { properties: { n: { anyOf: [{ type: 'integer', minimum: 1 }, { enum: [-777] }] } } },
          },
        ],
      }),
    );
    for (const probe of [true, false]) {
      expect(h.flags({ k: 1, n: 'x' }, { probe }).map((f) => f.ruleId)).toEqual([
        'schema:cond:0:n',
        'schema:prop:n:value',
      ]);
    }
  });

  it('a oneOf matching two branches says so truthfully', () => {
    const h = harness(
      array({ type: 'object', properties: { n: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'number', maximum: 100 }] } } }),
    );
    expect(h.messages({ n: 5 })).toEqual([
      'n: 5 matches more than one of the exclusive alternatives (options 1 and 2) — it must match exactly one.',
    ]);
  });
});

describe('contains', () => {
  const h = harness(
    array({
      type: 'object',
      properties: {
        once: { type: 'array', contains: { const: 'x' }, maxContains: 1 },
        some: { type: 'array', contains: { const: 'x' }, minContains: 2, maxContains: 3 },
        any: { type: 'array', items: { type: 'string' }, contains: { const: 'x' } },
      },
    }),
  );

  it('counts the matches against min and max, and leaks no item errors', () => {
    expect(h.messages({ once: ['x', 'x'] })).toEqual([
      "once: has 2 matching items; at most 1 allowed — expected an item that is 'x'.",
    ]);
    expect(h.messages({ some: ['x', 'x', 'x', 'x'] })).toEqual([
      "some: has 4 matching items; at most 3 allowed — expected an item that is 'x'.",
    ]);
    expect(h.messages({ some: ['x', 'y'] })).toEqual([
      "some: has 1 matching item; at least 2 required — expected an item that is 'x'.",
    ]);
    expect(h.messages({ any: ['y', 'z'] })).toEqual([
      "any: has no item matching the schema — expected an item that is 'x'.",
    ]);
  });

  it('without the probe it still leaks nothing', () => {
    expect(h.messages({ any: ['y', 'z'] }, { probe: false })).toEqual([
      "any: has no item matching the schema — expected an item that is 'x'.",
    ]);
  });
});

describe('column names', () => {
  it('a key holding / or ~ is its own name, not its JSON Pointer escape', () => {
    const h = harness(array({ type: 'object', properties: { 'bp (mm/Hg)': { maximum: 200 }, 'a~b': { type: 'string' } } }));
    const flags = h.flags({ 'bp (mm/Hg)': 250, 'a~b': 1 });
    expect(flags.map((f) => [f.column, f.ruleId])).toEqual([
      ['a~b', 'schema:prop:a~b:value'],
      ['bp (mm/Hg)', 'schema:prop:bp (mm/Hg):value'],
    ]);
  });

  it("the empty key is the column '' — not the record", () => {
    const h = harness(array({ type: 'object', properties: { '': { maxLength: 2 } }, required: [''] }));
    expect(h.flags({ '': 'abc' })).toMatchObject([
      { column: '', ruleId: 'schema:prop::value', scope: 'cell', message: "'abc' has 3 characters; at most 2 allowed." },
    ]);
    expect(h.flags({})).toMatchObject([{ column: '', ruleId: 'schema:prop::required', scope: 'cell' }]);
  });

  it('a key the digest does not know still gets its findings', () => {
    const h = harness(array({ type: 'object', patternProperties: { '^x_': { type: 'integer', maximum: 5 } } }));
    expect(h.messages({ x_b: 9 })).toEqual(['x_b: 9 exceeds the maximum 5.']);
  });
});

describe('bounds keep every digit', () => {
  it('no false statements from rounding', () => {
    const h = harness(
      array({
        type: 'object',
        properties: {
          a: { minimum: 0.00005 },
          b: { exclusiveMinimum: 2.71828 },
          c: { maximum: 0 },
          d: { maximum: 50000000 },
        },
      }),
    );
    expect(h.messages({ a: 0.00001, b: 2.7181, c: 0.001, d: 75000000 })).toEqual([
      'a: 0.00001 is below the minimum 0.00005.',
      'b: 2.7181 must be greater than 2.71828.',
      'c: 0.001 exceeds the maximum 0.',
      'd: 75000000 exceeds the maximum 50,000,000.',
    ]);
  });

  it('formatBound: grouping for the integer part, every fraction digit, no exponent for small bounds', () => {
    expect([1234567.25, -1234.5, -0.5, 1e-7, 1.5e-7, 5e-324, 1e21, 0].map(formatBound)).toEqual([
      '1,234,567.25',
      '-1,234.5',
      '-0.5',
      '0.0000001',
      '0.00000015',
      '5e-324',
      '1e+21',
      '0',
    ]);
  });
});

describe('formats say which standard they hold a value to', () => {
  const h = harness(
    array({
      type: 'object',
      properties: {
        dt: { type: 'string', format: 'date-time' },
        t: { type: 'string', format: 'time' },
        dur: { type: 'string', format: 'duration' },
        d: { type: 'string', format: 'date' },
        u: { type: 'string', format: 'uri' },
      },
    }),
  );

  it('an ISO 8601 value with no offset is told it needs one', () => {
    expect(h.messages({ dt: '2024-01-15T08:30:00', t: '14:30:45' })).toEqual([
      "dt: '2024-01-15T08:30:00' is not a valid RFC 3339 date-time — it needs a time-zone offset such as Z or +05:30.",
      "t: '14:30:45' is not a valid RFC 3339 time — it needs a time-zone offset such as Z or +05:30.",
    ]);
  });

  it('anything else is told the form', () => {
    expect(h.messages({ dt: '2024-02-30T08:30:00Z', dur: 'PT1.5S', d: '2024-02-30', u: 'example.com' })).toEqual([
      "d: '2024-02-30' is not a valid date (YYYY-MM-DD).",
      "dt: '2024-02-30T08:30:00Z' is not a valid RFC 3339 date-time (YYYY-MM-DDThh:mm:ssZ).",
      "dur: 'PT1.5S' is not a valid RFC 3339 duration — it takes whole numbers only, no fractions.",
      "u: 'example.com' is not a valid absolute URI (with a scheme, such as https:).",
    ]);
  });
});

describe('record-level keywords', () => {
  it('closed objects: one column flag per rejected key, naming the keyword', () => {
    const add = harness(array({ type: 'object', properties: { a: {} }, additionalProperties: false }));
    expect(add.flags({ a: 1, extra: 2 })).toMatchObject([
      {
        scope: 'column',
        column: 'extra',
        ruleId: 'schema:column:extra:unexpected',
        message: "Column 'extra' is not allowed by the schema (additionalProperties is false).",
      },
    ]);
    const unev = harness(array({ type: 'object', allOf: [{ properties: { a: {} } }], unevaluatedProperties: false }));
    expect(unev.messages({ a: 1, extra: 2 })).toEqual([
      "extra: Column 'extra' is not allowed by the schema (unevaluatedProperties is false).",
    ]);
  });

  it('a schema-valued additionalProperties gives ordinary cell findings', () => {
    const h = harness(array({ type: 'object', properties: { a: {} }, additionalProperties: { type: 'integer' } }));
    expect(h.messages({ a: 1, extra: 'x' })).toEqual(["extra: 'x' is a string, not an integer."]);
  });

  it('propertyNames on the record rules out a column, saying why', () => {
    const h = harness(array({ type: 'object', propertyNames: { pattern: '^[a-z_]+$' } }));
    expect(h.messages({ ok: 1, 'Bad Name': 2 })).toEqual([
      "Bad Name: Column 'Bad Name' is not allowed by the schema (names must match ^[a-z_]+$).",
    ]);
  });

  it('min/maxProperties count the record’s fields', () => {
    const h = harness(array({ type: 'object', maxProperties: 2, minProperties: 1 }));
    expect(h.messages({ a: 1, b: 2, c: 3 })).toEqual(['[row]: the record has 3 fields; at most 2 allowed.']);
    expect(h.messages({})).toEqual(['[row]: the record has 0 fields; at least 1 required.']);
  });

  it('a record that is not an object says what it is', () => {
    const h = harness(array({ type: 'object' }));
    expect(h.messages(5)).toEqual(['[row]: the record is a number, not an object.']);
  });
});

describe('property names inside a value', () => {
  const h = harness(
    array({
      type: 'object',
      properties: {
        short: { type: 'object', propertyNames: { maxLength: 3 } },
        listed: { type: 'object', propertyNames: { enum: ['x', 'y'] } },
      },
    }),
  );
  it('say what names must be — not only for patterns', () => {
    expect(h.messages({ short: { abcd: 1 }, listed: { q: 1 } })).toEqual([
      "listed: field name 'q' is not allowed (names must be one of 'x', 'y').",
      "short: field name 'abcd' is not allowed (names must have at most 3 characters).",
    ]);
  });
});

describe('items past what the schema admits', () => {
  it('items: false after prefixItems, and draft-07 additionalItems', () => {
    const h = harness(
      array({ type: 'object', properties: { pt: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }], items: false } } }),
    );
    expect(h.messages({ pt: [1, 2, 3] })).toEqual(['pt: has 3 items; at most 2 allowed.']);
    const d7 = harness(
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'array',
        items: { type: 'object', properties: { pt: { type: 'array', items: [{ type: 'number' }], additionalItems: false } } },
      },
      { draft: 'draft-07' },
    );
    expect(d7.messages({ pt: [1, 2] })).toEqual(['pt: has 2 items; at most 1 allowed.']);
  });

  it('a long enum is capped in the message', () => {
    const values = Array.from({ length: 40 }, (_, i) => i + 1);
    const h = harness(array({ type: 'object', properties: { c: { enum: values } } }));
    expect(h.messages({ c: 99 })).toEqual([
      'c: 99 is not an allowed value — expected one of 1, 2, 3, 4, 5, 6, 7, 8, … (32 more).',
    ]);
  });
});

describe('suppression', () => {
  it('a cast failure silences only that cell — required included, other cells kept', () => {
    const h = harness(
      array({ type: 'object', properties: { x: { type: 'integer' }, y: { maximum: 1 } }, required: ['x'] }),
      { castFailures: ['0 x'] },
    );
    expect(h.messages({ y: 5 })).toEqual(['y: 5 exceeds the maximum 1.']);
  });
});

describe('the probe', () => {
  it('locates schema objects by identity and re-validates a branch', () => {
    const schema = array({ type: 'object', properties: { v: { anyOf: [{ type: 'integer' }, { $ref: '#/$defs/c' }] } } }, {
      $defs: { c: { const: 'x' } },
    });
    const ajv = buildAjv('2020-12');
    ajv.addSchema(schema, 'quac-set:/root.json');
    const probe = createSchemaProbe(ajv, [{ uri: 'quac-set:/root.json', json: schema }], {
      rowSchema: 'quac-set:/root.json#/items',
    });
    const items = schema.items as { properties: { v: { anyOf: unknown[] } } };
    expect(probe.locate(items.properties.v.anyOf)).toEqual({ uri: 'quac-set:/root.json', pointer: '/items/properties/v/anyOf' });
    expect(probe.errorsAt('quac-set:/root.json', '/items/properties/v/anyOf/1', 'y')?.map((e) => e.keyword)).toEqual(['const']);
    expect(probe.errorsAt('quac-set:/root.json', '/items/properties/v/anyOf/1', 'x')).toEqual([]);
    expect(probe.locate({})).toBeNull();
  });

  it('knows a subschema that applies only through dependentSchemas — and one that also applies plainly', () => {
    const needC = { required: ['c'] };
    const shared = { required: ['d'] };
    const schema = array(
      {
        type: 'object',
        allOf: [{ $ref: '#/$defs/shared' }],
        dependentSchemas: { a: { $ref: '#/$defs/needC' }, b: { $ref: '#/$defs/shared' } },
      },
      { $defs: { needC, shared } },
    );
    const ajv = buildAjv('2020-12');
    ajv.addSchema(schema, 'quac-set:/root.json');
    const probe = createSchemaProbe(ajv, [{ uri: 'quac-set:/root.json', json: schema }], {
      rowSchema: 'quac-set:/root.json#/items',
    });
    expect(probe.dependentKeys(needC)).toEqual(['a']);
    expect(probe.dependentKeys(shared)).toEqual([]);
  });

  it('a block that does not check out falls back to the schemaPath reading, never to a crash', () => {
    const h = harness(array({ type: 'object', properties: { v: { anyOf: [{ type: 'integer' }, { type: 'string' }] } } }));
    const errors = h.errors({ v: true });
    // Drop a branch error: the block no longer matches what the probe expects.
    const broken = errors.filter((e) => !(e.keyword === 'type' && e.schemaPath.endsWith('/1/type')));
    const ajv = buildAjv('2020-12');
    const probe = createSchemaProbe(ajv, []);
    const flags = translateRowErrors(broken, 0, createTranslateCtx([], []), { probe });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.meta?.keyword).toBe('anyOf');
  });

  it('the same row translates the same way twice', () => {
    const h = harness(
      array({
        type: 'object',
        properties: { v: { anyOf: [{ type: 'integer' }, { type: 'string', maxLength: 2 }] } },
        if: { properties: { v: { const: 'abc' } }, required: ['v'] },
        then: { required: ['w'] },
      }),
    );
    expect(h.messages({ v: 'abc' })).toEqual(h.messages({ v: 'abc' }));
  });
});
