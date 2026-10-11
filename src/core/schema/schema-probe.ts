/**
 * The translator's window into the compiled schema set — worker-only.
 *
 * Ajv reports an applicator's failure flat: the sub-errors of a failed
 * `anyOf`, `oneOf`, `if`, `contains` or `propertyNames` come as one
 * contiguous block immediately BEFORE the applicator's own error, and an
 * error inside a `$ref`'d subschema carries the TARGET's schemaPath
 * (`#/$defs/needB/required`), so no prefix of a schemaPath says which
 * applicator an error belongs to. The probe answers that exactly, by asking
 * Ajv again: `errorsAt` validates the same data against one subschema (a
 * union branch, a `then`, the `contains` schema) and the error count is the
 * block's size (error-tree.ts). `locate` finds a schema object — Ajv's
 * `verbose` errors carry the very objects the files were registered with —
 * and `dependentKeys` says when a subschema applies only through
 * `dependentSchemas` / draft-07 `dependencies`, which emit no wrapper error.
 *
 * Imports Ajv TYPES only: the worker owns the Ajv instance and hands it in.
 * The translator takes a probe through its options, never by import, so Ajv
 * stays out of the entry chunk (translator.ts is entry-reachable).
 */
import type AjvCore from 'ajv/dist/core';
import type { AnyValidateFunction } from 'ajv/dist/core';
import type { AjvErrorLike } from './translator';

/** A schema object's place: its file's registration key and an RFC 6901 pointer. */
export interface SchemaLocation {
  uri: string;
  pointer: string;
}

export interface SchemaProbe {
  /** Where a schema object (or a keyword's array value) sits; null when it is not one of the registered files'. */
  locate(node: unknown): SchemaLocation | null;
  /**
   * The errors validating `data` against the subschema at `uri`/`pointer`
   * produces — `[]` when it passes, null when the subschema cannot be
   * compiled on its own.
   */
  errorsAt(uri: string, pointer: string, data: unknown): AjvErrorLike[] | null;
  /**
   * The `dependentSchemas` / `dependencies` keys under which ONLY this schema
   * object applies to a record — `[]` when it also applies without one, or
   * when the probe was given no row schema to tell.
   */
  dependentKeys(node: unknown): readonly string[];
}

export interface SchemaProbeOptions {
  /** The row validator's schema ref — `<rootBase>#/items` — what a record must satisfy. */
  rowSchema?: string;
}

/** Keywords whose value is data, not schema: never walked for `$id`s or subschemas. */
const DATA_KEYWORDS = new Set(['const', 'enum', 'default', 'examples']);

/** Keywords whose single value is a subschema. */
const SUBSCHEMA_KEYWORDS = [
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'additionalProperties',
  'unevaluatedProperties',
  'additionalItems',
  'unevaluatedItems',
] as const;

/** Keywords whose array value lists subschemas. */
const SUBSCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** Keywords whose object value maps names to subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties'] as const;

/** Keywords whose object value maps a TRIGGER property to a subschema. */
const DEPENDENT_KEYWORDS = ['dependentSchemas', 'dependencies'] as const;

const REF_KEYWORDS = ['$ref', '$dynamicRef', '$recursiveRef'] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const escapeSegment = (segment: string): string =>
  segment.replaceAll('~', '~0').replaceAll('/', '~1');

const unescapeSegment = (segment: string): string =>
  segment.replaceAll('~1', '/').replaceAll('~0', '~');

/** `#`-free form of a URL, or null when it does not parse against `base`. */
function resolveUrl(ref: string, base: string): string | null {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

const withoutFragment = (url: string): string => {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
};

/** A pointer as Ajv's `getSchema` fragment wants it: each segment percent-encoded. */
const fragmentOf = (pointer: string): string =>
  pointer
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

interface Edge {
  target: object;
  /** Set when the edge is a `dependentSchemas` / `dependencies` entry. */
  dependentKey?: string;
}

export function createSchemaProbe(
  ajv: AjvCore,
  files: readonly { uri: string; json: unknown }[],
  opts: SchemaProbeOptions = {},
): SchemaProbe {
  const locations = new WeakMap<object, SchemaLocation>();
  const bases = new WeakMap<object, string>();
  /** Absolute document URL (no fragment) → the object it names. */
  const documents = new Map<string, object>();
  /** `<document>#<anchor>` → the object. */
  const anchors = new Map<string, object>();
  let hasDependents = false;

  const walk = (node: unknown, uri: string, pointer: string, base: string): void => {
    if (Array.isArray(node)) {
      if (!locations.has(node)) locations.set(node, { uri, pointer });
      node.forEach((item, i) => {
        walk(item, uri, `${pointer}/${String(i)}`, base);
      });
      return;
    }
    if (!isObject(node)) return;
    if (locations.has(node)) return; // shared instance: first registration wins
    let here = base;
    const id = node.$id;
    if (typeof id === 'string' && id !== '') {
      if (id.startsWith('#')) {
        // draft-07 plain-name fragment: an anchor in the current document.
        anchors.set(`${withoutFragment(base)}${id}`, node);
      } else {
        const resolved = resolveUrl(id, base);
        if (resolved !== null) {
          here = withoutFragment(resolved);
          documents.set(here, node);
        }
      }
    }
    for (const key of ['$anchor', '$dynamicAnchor'] as const) {
      const name = node[key];
      if (typeof name === 'string' && name !== '') anchors.set(`${withoutFragment(here)}#${name}`, node);
    }
    locations.set(node, { uri, pointer });
    bases.set(node, here);
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if ((DEPENDENT_KEYWORDS as readonly string[]).includes(key) && isObject(value)) hasDependents = true;
      walk(value, uri, `${pointer}/${escapeSegment(key)}`, here);
    }
  };

  for (const file of files) {
    if (isObject(file.json)) documents.set(withoutFragment(file.uri), file.json);
    walk(file.json, file.uri, '', file.uri);
  }

  const locate = (node: unknown): SchemaLocation | null =>
    node !== null && typeof node === 'object' ? (locations.get(node) ?? null) : null;

  const validators = new Map<string, AnyValidateFunction | null>();
  const validatorAt = (uri: string, pointer: string): AnyValidateFunction | null => {
    const key = `${uri}#${fragmentOf(pointer)}`;
    if (validators.has(key)) return validators.get(key) ?? null;
    let validate: AnyValidateFunction | null;
    try {
      validate = ajv.getSchema(key) ?? null;
    } catch {
      validate = null;
    }
    validators.set(key, validate);
    return validate;
  };

  const errorsAt = (uri: string, pointer: string, data: unknown): AjvErrorLike[] | null => {
    const validate = validatorAt(uri, pointer);
    if (validate === null) return null;
    let valid: unknown;
    try {
      valid = validate(data);
    } catch {
      return null;
    }
    if (typeof valid !== 'boolean') return null; // an $async schema: not ours to await
    if (valid) return [];
    return (validate.errors ?? []).map((e): AjvErrorLike => ({ ...e }));
  };

  /** The object a `$ref` names, by our own index first and Ajv's resolution second. */
  const refTarget = (from: object, ref: string): object | null => {
    const base = bases.get(from) ?? '';
    const absolute = resolveUrl(ref, base);
    if (absolute === null) return null;
    const hash = absolute.indexOf('#');
    const document = hash === -1 ? absolute : absolute.slice(0, hash);
    const fragment = hash === -1 ? '' : absolute.slice(hash + 1);
    const root = documents.get(document);
    if (root !== undefined) {
      if (fragment === '') return root;
      if (fragment.startsWith('/')) {
        let node: unknown = root;
        for (const raw of fragment.split('/').slice(1)) {
          let segment: string;
          try {
            segment = unescapeSegment(decodeURIComponent(raw));
          } catch {
            return null;
          }
          if (Array.isArray(node)) node = node[Number(segment)];
          else if (isObject(node) && Object.hasOwn(node, segment)) node = node[segment];
          else return null;
        }
        return node !== null && typeof node === 'object' ? node : null;
      }
      const anchored = anchors.get(`${document}#${fragment}`);
      if (anchored !== undefined) return anchored;
    }
    try {
      const schema = ajv.getSchema(absolute)?.schema;
      return typeof schema === 'object' ? schema : null;
    } catch {
      return null;
    }
  };

  const edgesOf = (node: object): Edge[] => {
    if (!isObject(node)) return [];
    const edges: Edge[] = [];
    const push = (value: unknown, dependentKey?: string): void => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        edges.push(dependentKey === undefined ? { target: value } : { target: value, dependentKey });
      }
    };
    for (const key of SUBSCHEMA_KEYWORDS) push(node[key]);
    for (const key of SUBSCHEMA_ARRAY_KEYWORDS) {
      const value = node[key];
      if (Array.isArray(value)) for (const item of value) push(item);
    }
    const items = node.items;
    if (Array.isArray(items)) for (const item of items) push(item);
    else push(items);
    for (const key of SUBSCHEMA_MAP_KEYWORDS) {
      const value = node[key];
      if (isObject(value)) for (const sub of Object.values(value)) push(sub);
    }
    for (const key of DEPENDENT_KEYWORDS) {
      const value = node[key];
      if (!isObject(value)) continue;
      for (const [trigger, sub] of Object.entries(value)) {
        if (!Array.isArray(sub)) push(sub, trigger);
      }
    }
    for (const key of REF_KEYWORDS) {
      const ref = node[key];
      if (typeof ref !== 'string') continue;
      const target = refTarget(node, ref);
      if (target !== null) edges.push({ target });
    }
    return edges;
  };

  let dependentIndex: WeakMap<object, Set<string>> | null = null;
  const buildDependentIndex = (): WeakMap<object, Set<string>> => {
    const index = new WeakMap<object, Set<string>>();
    if (!hasDependents || opts.rowSchema === undefined) return index;
    let row: unknown;
    try {
      row = ajv.getSchema(opts.rowSchema)?.schema;
    } catch {
      row = undefined;
    }
    if (row === null || typeof row !== 'object') return index;

    // What applies to a record without a trigger: everything reachable from
    // the row schema except through a dependent entry.
    const plain = new Set<object>([row]);
    const pending: { keys: readonly string[]; target: object }[] = [];
    const queue: object[] = [row];
    // An array iterator reads the length each step: items pushed meanwhile are visited.
    for (const node of queue) {
      for (const edge of edgesOf(node)) {
        if (edge.dependentKey !== undefined) {
          pending.push({ keys: [edge.dependentKey], target: edge.target });
          continue;
        }
        if (!plain.has(edge.target)) {
          plain.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    // Every dependent subtree, with the chain of triggers that leads to it —
    // a `dependentSchemas` inside another applies only when both are present.
    const seen = new Set<string>();
    for (const { keys, target } of pending) {
      const stack: object[] = [target];
      const visited = new Set<object>();
      for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        if (visited.has(node)) continue;
        visited.add(node);
        if (!plain.has(node)) {
          let known = index.get(node);
          if (known === undefined) {
            known = new Set();
            index.set(node, known);
          }
          for (const key of keys) known.add(key);
        }
        for (const edge of edgesOf(node)) {
          if (edge.dependentKey !== undefined) {
            const chain = [...keys, edge.dependentKey];
            const id = `${chain.join('\u0000')}\u0001${String(locations.get(edge.target)?.pointer)}`;
            if (!seen.has(id) && chain.length <= 8) {
              seen.add(id);
              pending.push({ keys: chain, target: edge.target });
            }
            continue;
          }
          stack.push(edge.target);
        }
      }
    }
    return index;
  };

  const dependentKeys = (node: unknown): readonly string[] => {
    if (node === null || typeof node !== 'object') return [];
    dependentIndex ??= buildDependentIndex();
    const keys = dependentIndex.get(node);
    return keys === undefined ? [] : [...keys].sort();
  };

  return { locate, errorsAt, dependentKeys };
}
