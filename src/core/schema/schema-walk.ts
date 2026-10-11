/**
 * A schema-aware walk over one schema document: every subschema, by the
 * keywords that hold subschemas in draft-06 through 2020-12 — and nothing
 * else. `enum`, `const`, `default`, `examples` and unknown keywords hold
 * data, so a `"format"` or `"pattern"` inside an enum value, or a property
 * that happens to be NAMED `pattern`, is never mistaken for a keyword.
 *
 * Also the load-time checks that need no Ajv (`staticSchemaProblems`): a
 * `pattern` or `patternProperties` name that is no regular expression even
 * without the `u` flag, and an empty `enum`.
 *
 * Pure; never throws.
 */

export type SchemaVisitor = (node: Record<string, unknown>, pointer: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const escape = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1');

/** Keywords whose value is an object mapping names to subschemas. */
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
/** Keywords whose value is one subschema. */
const SCHEMA_SINGLES = [
  'additionalProperties',
  'unevaluatedProperties',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
  'contentSchema',
];
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

/** Deeper than this is a pathological document; the walk stops rather than overflow. */
const MAX_DEPTH = 256;

/** Visit every object subschema of `json` (boolean schemas have nothing to visit), pre-order. */
export function walkSchema(json: unknown, visit: SchemaVisitor, pointer = ''): void {
  const walk = (node: unknown, at: string, depth: number): void => {
    if (!isRecord(node) || depth > MAX_DEPTH) return;
    visit(node, at);
    for (const key of SCHEMA_MAPS) {
      const map = node[key];
      if (!isRecord(map)) continue;
      for (const [name, sub] of Object.entries(map)) {
        walk(sub, `${at}/${key}/${escape(name)}`, depth + 1);
      }
    }
    for (const key of SCHEMA_SINGLES) walk(node[key], `${at}/${key}`, depth + 1);
    for (const key of SCHEMA_ARRAYS) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      list.forEach((sub, i) => {
        walk(sub, `${at}/${key}/${String(i)}`, depth + 1);
      });
    }
    const items = node.items;
    if (Array.isArray(items)) {
      items.forEach((sub, i) => {
        walk(sub, `${at}/items/${String(i)}`, depth + 1);
      });
    } else {
      walk(items, `${at}/items`, depth + 1);
    }
    // draft-07 `dependencies`: each value is a property list or a subschema.
    const dependencies = node.dependencies;
    if (isRecord(dependencies)) {
      for (const [name, sub] of Object.entries(dependencies)) {
        walk(sub, `${at}/dependencies/${escape(name)}`, depth + 1);
      }
    }
  };
  walk(json, pointer, 0);
}

export type StaticProblem =
  | { kind: 'pattern' | 'patternProperties'; pointer: string; pattern: string; reason: string }
  | { kind: 'empty-enum'; pointer: string };

/**
 * Why `pattern` is no regular expression even in the non-Unicode dialect, or
 * null when it compiles in one of the two (QuaC's engine tries `u` first).
 */
export function regexProblem(pattern: string): string | null {
  try {
    new RegExp(pattern, 'u');
    return null;
  } catch {
    // try the non-Unicode dialect
  }
  try {
    new RegExp(pattern);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // V8: "Invalid regular expression: /(?i)x/: Invalid group" — keep the reason.
    const reason = /:\s*([^:]+)$/.exec(message)?.[1] ?? message;
    return reason.trim();
  }
}

/** The problems a schema document carries that need no Ajv to find, in document order. */
export function staticSchemaProblems(json: unknown): StaticProblem[] {
  const problems: StaticProblem[] = [];
  walkSchema(json, (node, pointer) => {
    if (typeof node.pattern === 'string') {
      const reason = regexProblem(node.pattern);
      if (reason !== null) {
        problems.push({
          kind: 'pattern',
          pointer: `${pointer}/pattern`,
          pattern: node.pattern,
          reason,
        });
      }
    }
    if (isRecord(node.patternProperties)) {
      for (const name of Object.keys(node.patternProperties)) {
        const reason = regexProblem(name);
        if (reason !== null) {
          problems.push({
            kind: 'patternProperties',
            pointer: `${pointer}/patternProperties/${escape(name)}`,
            pattern: name,
            reason,
          });
        }
      }
    }
    if (Array.isArray(node.enum) && node.enum.length === 0) {
      problems.push({ kind: 'empty-enum', pointer: `${pointer}/enum` });
    }
  });
  return problems;
}

/**
 * The draft-06/07 assertion and applicator keywords: next to `$ref` those
 * drafts ignore every one of them (draft-07 Core §8.3). Annotations
 * (`title`, `description`, …), `definitions` and `$id` are not listed — they
 * check nothing, and `definitions` holds the targets refs point into.
 */
export const DRAFT7_VALIDATION_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'enum',
  'const',
  'multipleOf',
  'maximum',
  'exclusiveMaximum',
  'minimum',
  'exclusiveMinimum',
  'maxLength',
  'minLength',
  'pattern',
  'items',
  'additionalItems',
  'maxItems',
  'minItems',
  'uniqueItems',
  'contains',
  'maxProperties',
  'minProperties',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'dependencies',
  'propertyNames',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'format',
  'contentMediaType',
  'contentEncoding',
]);

/**
 * Where a draft-06/07 document puts checks beside `$ref`, and which. A
 * document's own root is left out — the engine keeps its keywords, because
 * the index file's `items` must stay reachable for the record schema.
 */
export function refSiblings(json: unknown): { pointer: string; keywords: string[] }[] {
  const found: { pointer: string; keywords: string[] }[] = [];
  walkSchema(json, (node, pointer) => {
    if (pointer === '' || typeof node.$ref !== 'string') return;
    const keywords = Object.keys(node).filter((k) => DRAFT7_VALIDATION_KEYWORDS.has(k));
    if (keywords.length > 0) found.push({ pointer, keywords });
  });
  return found;
}
