/**
 * P22 task 1, unit leg — every `SchemaLoadCode` has a designed message.
 *
 * The schema subsystem is luckier than the rules linter: all 15 codes are
 * built by one module (`core/schema/messages.ts`) and stamped with a severity
 * by one function (`loadError`), so the surface can be exercised exactly
 * rather than approximately. This spec calls every builder with inputs chosen
 * to be hostile — real V8 `SyntaxError` text, real Ajv output, a URL with a
 * query string, a path with a space — and asserts what comes back is a
 * designed message.
 *
 * `CASES` is `satisfies Record<SchemaLoadCode, …>`, so a sixteenth code fails
 * `npm run typecheck` before any test runs. `SCHEMA_LOAD_SEVERITY` is already
 * an exhaustive runtime map; the severity assertion below is what keeps a new
 * code from being registered here with the wrong one.
 *
 * `E_PARSE` and `E_META` are `framed` — two of the four codes in the app that
 * quote the engine by design. Everything V8 or Ajv says lands after QuaC's
 * colon, and the test proves it stays there even when the engine hands over
 * something ugly.
 */
import { describe, expect, it } from 'vitest';
import {
  autoPreferredMessage,
  badFragmentMessage,
  dupIdMessage,
  fetchCorsMessage,
  fetchHttpMessage,
  indexBasenameMessage,
  indexNoMatchMessage,
  loadError,
  metaMessage,
  mixedDraftMessage,
  nonSchemaIgnoredMessage,
  noSchemasMessage,
  parseMessage,
  retrievalFallbackMessage,
  rootNotArrayMessage,
  rootNotTabularMessage,
  unresolvedRefMessage,
} from '../../../src/core/schema/messages';
import { SCHEMA_LOAD_SEVERITY } from '../../../src/core/schema/types';
import type { SchemaLoadCode } from '../../../src/core/schema/types';
import { designProblems, findEngineText } from '../support/designedMessage';
import type { MessagePolicy } from '../support/designedMessage';

/** V8's JSON.parse text, in the three shapes current runtimes produce. */
const V8_PARSE_ERRORS = [
  `Unexpected token 'T', "This file i"... is not valid JSON`,
  `Expected property name or '}' in JSON at position 12 (line 1 column 13)`,
  'Unterminated string in JSON at position 4096 (line 90 column 3)',
  'Unexpected end of JSON input',
];

/** Ajv's own words, as `validateSchema` and `ajv.errors[0]` produce them. */
const AJV_ERRORS = [
  'must be object,boolean',
  "must have required property '$ref'",
  'must NOT have additional properties',
  'schema is invalid: data/properties/age/type must be equal to one of the allowed values',
];

interface Case {
  policy: MessagePolicy;
  /** Every message this code can produce, from the real builders. */
  messages: readonly string[];
}

const CASES = {
  E_PARSE: {
    policy: 'framed',
    messages: V8_PARSE_ERRORS.map((engine) => parseMessage('core/core.schema.json', engine)),
  },
  E_DUP_ID: {
    policy: 'pure',
    messages: [
      dupIdMessage('https://hesp.example/core', 'core/core.schema.json', 'archive/core.json'),
    ],
  },
  E_UNRESOLVED_REF: {
    policy: 'pure',
    messages: [
      unresolvedRefMessage(
        'core/core.schema.json',
        '../common/defs.json#/$defs/money',
        '/items/properties/wage_income_annual',
        'defs.json',
      ),
    ],
  },
  E_BAD_FRAGMENT: {
    policy: 'pure',
    messages: [
      badFragmentMessage(
        'core/core.schema.json',
        'common/defs.json#/$defs/nope',
        '/$defs/nope',
        'common/defs.json',
      ),
    ],
  },
  E_NO_SCHEMAS: { policy: 'pure', messages: [noSchemasMessage()] },
  E_META: {
    policy: 'framed',
    messages: AJV_ERRORS.map((ajv) =>
      metaMessage('core/core.schema.json', '2020-12', ajv, '/properties/age'),
    ).concat(metaMessage('draft7/root.schema.json', 'unknown', AJV_ERRORS[0] ?? '', '')),
  },
  E_MIXED_DRAFT: {
    policy: 'pure',
    messages: [mixedDraftMessage(['draft-07', '2020-12'], '2020-12')],
  },
  E_ROOT_NOT_TABULAR: {
    policy: 'pure',
    messages: [rootNotTabularMessage('core/core.schema.json')],
  },
  E_FETCH: {
    policy: 'pure',
    messages: [
      fetchCorsMessage('https://raw.example.org/schemas/core.json?ref=main'),
      fetchHttpMessage('https://raw.example.org/schemas/core.json', 404),
      fetchHttpMessage('https://raw.example.org/schemas/core.json', 500),
    ],
  },
  W_RETRIEVAL_FALLBACK: {
    policy: 'pure',
    messages: [retrievalFallbackMessage('core/core.schema.json', '../common/defs.json')],
  },
  W_ROOT_NOT_ARRAY: { policy: 'pure', messages: [rootNotArrayMessage('core/core.schema.json')] },
  W_INDEX_BASENAME: {
    policy: 'pure',
    messages: [indexBasenameMessage('core.schema.json', 'core/core.schema.json')],
  },
  W_INDEX_NO_MATCH: { policy: 'pure', messages: [indexNoMatchMessage()] },
  I_AUTO_PREFERRED: {
    policy: 'pure',
    messages: [
      autoPreferredMessage('core/core.schema.json', ['orphan.json']),
      autoPreferredMessage('core/core.schema.json', ['orphan.json', 'stray.json']),
    ],
  },
  I_NON_SCHEMA_IGNORED: {
    policy: 'pure',
    messages: [nonSchemaIgnoredMessage('mixed/notes.txt')],
  },
} satisfies Record<SchemaLoadCode, Case>;

const entries = Object.entries(CASES) as [SchemaLoadCode, Case][];

describe('schema load copy — every SchemaLoadCode is a designed message', () => {
  it('every builder produces a message that satisfies its policy', () => {
    const failures: string[] = [];
    for (const [code, { policy, messages }] of entries) {
      expect(messages.length, `${code} has no sample`).toBeGreaterThan(0);
      for (const message of messages) {
        for (const problem of designProblems(message, policy)) {
          failures.push(`[${code} · ${policy}] ${problem} — in ${JSON.stringify(message)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('loadError stamps the severity the code declares', () => {
    for (const [code, { messages }] of entries) {
      const error = loadError(code, messages[0] ?? 'x');
      expect(error.severity, code).toBe(SCHEMA_LOAD_SEVERITY[code]);
    }
  });

  it('E_PARSE keeps V8’s words after the colon, never before it', () => {
    for (const engine of V8_PARSE_ERRORS) {
      const message = parseMessage('core/core.schema.json', engine);
      const cut = message.indexOf(': ');
      expect(cut, engine).toBeGreaterThan(0);
      expect(message.slice(0, cut)).toBe('`core/core.schema.json` is not valid JSON');
    }
    // …and the quoted-file stutter V8 appends is dropped rather than pasted:
    // the message must not echo the file's own contents back at the reader.
    expect(parseMessage('a.json', V8_PARSE_ERRORS[0] ?? '')).not.toContain('This file i');
  });

  it('E_META keeps Ajv’s words after the colon, never before it', () => {
    for (const ajv of AJV_ERRORS) {
      const message = metaMessage('core/core.schema.json', '2020-12', ajv, '/properties/age');
      const cut = message.indexOf(': ');
      expect(cut, ajv).toBeGreaterThan(0);
      expect(message.slice(0, cut)).toBe('`core/core.schema.json` is not a valid 2020-12 schema');
    }
  });

  it('no pure message carries engine vocabulary anywhere in it', () => {
    for (const [code, { policy, messages }] of entries) {
      if (policy !== 'pure') continue;
      for (const message of messages) {
        expect(findEngineText(message), `${code}: ${message}`).toEqual([]);
      }
    }
  });
});
