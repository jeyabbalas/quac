/**
 * ValueSpec derivation and rendering (json-schema-subsystem.md §C.1, §D.4,
 * §E.1). Pure: walks resolved schema nodes through the read-side RefResolver,
 * never the network. `renderExpectation` is exported standalone — tooltips use
 * it now, the P08 translator reuses it verbatim.
 */
import { escapePointerSegment } from './deref';
import type { RefResolver, SchemaSite } from './deref';

export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON Schema's type names. `array` and `object` are what a nested column —
 * a LIST, STRUCT or MAP from a JSON or Parquet dataset — holds; they decide
 * its storage (`JSON`, below) and never a scalar cast.
 */
export type JsonTypeName = 'integer' | 'number' | 'string' | 'boolean' | 'null' | 'array' | 'object';

export interface Sentinel {
  value: string | number;
  label?: string;
}

export type ValueSpec =
  | {
      kind: 'numeric';
      numType: 'integer' | 'number';
      min?: number;
      max?: number;
      exclusions: Sentinel[];
      sentinels: Sentinel[];
    }
  | { kind: 'codes'; codes: Sentinel[]; sentinels: Sentinel[] }
  | {
      kind: 'string-pattern';
      pattern: string;
      patternTitle?: string;
      patternDescription?: string;
      sentinels: Sentinel[];
    }
  | { kind: 'string-free' | 'boolean'; sentinels: Sentinel[] }
  /** A list: what each item must be, and how many there may be. */
  | { kind: 'array'; items?: ValueSpec; minItems?: number; maxItems?: number }
  /** A record: its declared fields, in schema order; `closed` = no others allowed. */
  | { kind: 'object'; fields: string[]; required: string[]; closed: boolean }
  // Spec §E.1 writes these as one `'mixed' | 'opaque'` member; split so the
  // discriminant narrows (TS keeps a two-literal member un-split).
  | { kind: 'mixed'; rendered?: string }
  | { kind: 'opaque'; rendered?: string };

/** The missing-value codes a spec carries — none for containers, mixed or opaque. */
export function sentinelsOf(spec: ValueSpec): readonly Sentinel[] {
  switch (spec.kind) {
    case 'numeric':
    case 'codes':
    case 'string-pattern':
    case 'string-free':
    case 'boolean':
      return spec.sentinels;
    default:
      return [];
  }
}

/** Every labelled value a spec knows: its codes (if any), then its sentinels. */
export function labelledValuesOf(spec: ValueSpec): readonly Sentinel[] {
  return spec.kind === 'codes' ? [...spec.codes, ...spec.sentinels] : sentinelsOf(spec);
}

/** Digest walk guard (§C.1): refs are chased at most this deep per property. */
const MAX_DEPTH = 12;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function childSite(site: SchemaSite, segment: string | number, node: unknown): SchemaSite {
  const seg = typeof segment === 'number' ? String(segment) : escapePointerSegment(segment);
  return { file: site.file, pointer: `${site.pointer}/${seg}`, node };
}

/** Follow a `$ref` at `site.node`; null when absent or unresolvable. */
function followRef(site: SchemaSite, resolver: RefResolver): SchemaSite | null {
  const record = site.node;
  if (!isObject(record) || typeof record.$ref !== 'string') return null;
  return resolver.resolve(site.file, `${site.pointer}/$ref`);
}

// ---------------------------------------------------------------------------
// §C.1 jsonTypes derivation
// ---------------------------------------------------------------------------

function typeOfValue(v: unknown): JsonTypeName | null {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return null;
}

const JSON_TYPE_NAMES: ReadonlySet<string> = new Set<JsonTypeName>([
  'integer',
  'number',
  'string',
  'boolean',
  'null',
  'array',
  'object',
]);

/** null ⇒ unconstrained (any type). */
function jsonTypesOf(
  site: SchemaSite,
  resolver: RefResolver,
  depth: number,
  seen: Set<unknown>,
): ReadonlySet<JsonTypeName> | null {
  const node = site.node;
  if (typeof node === 'boolean') return node ? null : new Set();
  if (!isObject(node) || depth > MAX_DEPTH || seen.has(node)) return null;
  seen.add(node);
  try {
    const contributions: (ReadonlySet<JsonTypeName> | null)[] = [];

    if (typeof node.$ref === 'string') {
      const target = followRef(site, resolver);
      contributions.push(target === null ? null : jsonTypesOf(target, resolver, depth + 1, seen));
    }
    if (typeof node.type === 'string' || Array.isArray(node.type)) {
      const names = (Array.isArray(node.type) ? node.type : [node.type]).filter(
        (t): t is JsonTypeName => typeof t === 'string' && JSON_TYPE_NAMES.has(t),
      );
      contributions.push(new Set(names));
    }
    if (Object.hasOwn(node, 'const')) {
      const t = typeOfValue(node.const);
      contributions.push(new Set(t === null ? [] : [t]));
    }
    if (Array.isArray(node.enum)) {
      const set = new Set<JsonTypeName>();
      for (const v of node.enum) {
        const t = typeOfValue(v);
        if (t !== null) set.add(t);
      }
      contributions.push(set);
    }
    for (const keyword of ['anyOf', 'oneOf'] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      const union = new Set<JsonTypeName>();
      let unconstrained = false;
      for (const [i, branch] of branches.entries()) {
        const branchTypes = jsonTypesOf(
          childSite(childSite(site, keyword, branches), i, branch),
          resolver,
          depth + 1,
          seen,
        );
        if (branchTypes === null) unconstrained = true;
        else for (const t of branchTypes) union.add(t);
      }
      contributions.push(unconstrained ? null : union);
    }
    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((branch, i) => {
        contributions.push(
          jsonTypesOf(
            childSite(childSite(site, 'allOf', node.allOf), i, branch),
            resolver,
            depth + 1,
            seen,
          ),
        );
      });
    }
    // `if`/`then`/`else`/`not` contribute nothing (value constraints, not storage).

    const constrained = contributions.filter((c): c is ReadonlySet<JsonTypeName> => c !== null);
    if (constrained.length === 0) return null;
    let result = new Set(constrained[0]);
    for (const c of constrained.slice(1)) {
      // integer ⊂ number for intersection purposes.
      result = new Set(
        [...result].filter((t) => c.has(t) || (t === 'integer' && c.has('number'))),
      );
    }
    return result;
  } finally {
    seen.delete(node);
  }
}

export function deriveJsonTypes(site: SchemaSite, resolver: RefResolver): ReadonlySet<JsonTypeName> {
  return jsonTypesOf(site, resolver, 0, new Set()) ?? new Set();
}

/**
 * Whether a value at `site` may be null: true when its type set includes
 * `null`, and when the schema leaves the type open (no `type`, `const` or
 * `enum` anywhere in reach) — where `deriveJsonTypes` cannot say, since it
 * reports "any type" and "no type" alike as an empty set.
 */
export function allowsNull(site: SchemaSite, resolver: RefResolver): boolean {
  const types = jsonTypesOf(site, resolver, 0, new Set());
  return types === null || types.has('null');
}

/**
 * `JSON` is the target of a variable that holds arrays or objects. A nested
 * column (LIST, STRUCT, MAP) or a JSON one keeps the type the dataset gave it
 * — every nested or JSON column does, whatever its schema says (casting.ts) —
 * so `JSON` only ever converts TEXT: a CSV, TSV or Excel cell holding
 * `[1, 2, 3]` is parsed into DuckDB's JSON type, and one that does not parse
 * is a cast finding like any other.
 */
export type StorageType = 'BIGINT' | 'DOUBLE' | 'VARCHAR' | 'BOOLEAN' | 'JSON';

/** §C.1 storage mapping. Mixed/empty/opaque type sets land VARCHAR + mixed. */
export function storageTypeFor(jsonTypes: ReadonlySet<JsonTypeName>): {
  storageType: StorageType;
  mixed: boolean;
} {
  const t = new Set(jsonTypes);
  t.delete('null');
  const has = (...names: JsonTypeName[]): boolean =>
    t.size === names.length && names.every((n) => t.has(n));
  if (has('integer')) return { storageType: 'BIGINT', mixed: false };
  if (has('number') || has('integer', 'number')) return { storageType: 'DOUBLE', mixed: false };
  if (has('string')) return { storageType: 'VARCHAR', mixed: false };
  if (has('boolean')) return { storageType: 'BOOLEAN', mixed: false };
  if (has('array') || has('object') || has('array', 'object')) {
    return { storageType: 'JSON', mixed: false };
  }
  return { storageType: 'VARCHAR', mixed: true };
}

// ---------------------------------------------------------------------------
// §E.1 ValueSpec folding
// ---------------------------------------------------------------------------

type Atom =
  | { kind: 'numeric'; numType: 'integer' | 'number'; min?: number; max?: number; notEnum: (string | number)[] }
  | { kind: 'const'; value: string | number; label?: string; viaRef: boolean }
  | { kind: 'pattern'; pattern: string; title?: string; description?: string }
  | { kind: 'string' }
  | { kind: 'boolean' }
  /** `type: "null"`, `const: null`, a null in an `enum`: allowed, but never what a value IS. */
  | { kind: 'null' }
  | { kind: 'array'; site: SchemaSite }
  | { kind: 'object'; site: SchemaSite }
  | { kind: 'opaque' };

function constAtom(node: Record<string, unknown>, viaRef: boolean): Atom | null {
  const value = node.const;
  if (value === null) return { kind: 'null' };
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const label = typeof node.title === 'string' ? node.title : undefined;
  return { kind: 'const', value, viaRef, ...(label === undefined ? {} : { label }) };
}

function notValues(node: Record<string, unknown>): (string | number)[] {
  const not = node.not;
  if (!isObject(not)) return [];
  const raw = Array.isArray(not.enum) ? not.enum : Object.hasOwn(not, 'const') ? [not.const] : [];
  return raw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
}

/** The atom one JSON type name yields, with the keywords that apply to it. */
function typeAtom(type: string, site: SchemaSite): Atom {
  const node = site.node as Record<string, unknown>;
  switch (type) {
    case 'integer':
    case 'number':
      return {
        kind: 'numeric',
        numType: type,
        ...(typeof node.minimum === 'number' ? { min: node.minimum } : {}),
        ...(typeof node.maximum === 'number' ? { max: node.maximum } : {}),
        notEnum: notValues(node),
      };
    case 'string':
      if (typeof node.pattern === 'string') {
        return {
          kind: 'pattern',
          pattern: node.pattern,
          ...(typeof node.title === 'string' ? { title: node.title } : {}),
          ...(typeof node.description === 'string' ? { description: node.description } : {}),
        };
      }
      return { kind: 'string' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'null':
      return { kind: 'null' };
    case 'array':
      return { kind: 'array', site };
    case 'object':
      return { kind: 'object', site };
    default:
      return { kind: 'opaque' };
  }
}

function flatten(site: SchemaSite, resolver: RefResolver, viaRef: boolean, depth: number): Atom[] {
  const node = site.node;
  if (!isObject(node) || depth > MAX_DEPTH) return [{ kind: 'opaque' }];

  if (typeof node.$ref === 'string') {
    const target = followRef(site, resolver);
    if (target === null) return [{ kind: 'opaque' }];
    const atoms = flatten(target, resolver, true, depth + 1);
    // Sibling `title` overrides the referenced def's label/title — only
    // meaningful when the target yields a single atom (§E.1).
    if (atoms.length === 1 && typeof node.title === 'string') {
      const atom = atoms[0];
      if (atom !== undefined && (atom.kind === 'const' || atom.kind === 'pattern')) {
        return [
          atom.kind === 'const' ? { ...atom, label: node.title } : { ...atom, title: node.title },
        ];
      }
    }
    return atoms;
  }

  const branchKeyword = Array.isArray(node.anyOf) ? 'anyOf' : Array.isArray(node.oneOf) ? 'oneOf' : null;
  if (branchKeyword !== null) {
    // Each branch establishes its own provenance: only a branch-level `$ref`
    // marks its consts as sentinel-def-derived (viaRef resets to false here).
    const branches = node[branchKeyword] as unknown[];
    return branches.flatMap((branch, i) =>
      flatten(
        childSite(childSite(site, branchKeyword, branches), i, branch),
        resolver,
        false,
        depth + 1,
      ),
    );
  }

  if (Array.isArray(node.allOf) && node.allOf.length === 1) {
    return flatten(childSite(childSite(site, 'allOf', node.allOf), 0, node.allOf[0]), resolver, viaRef, depth + 1);
  }

  if (Object.hasOwn(node, 'const')) {
    const atom = constAtom(node, viaRef);
    return atom === null ? [{ kind: 'opaque' }] : [atom];
  }
  if (Array.isArray(node.enum)) {
    return node.enum.map((v): Atom => {
      if (v === null) return { kind: 'null' };
      return typeof v === 'string' || typeof v === 'number'
        ? { kind: 'const', value: v, viaRef }
        : { kind: 'opaque' };
    });
  }

  // `type: "integer"` or `type: ["integer", "null"]`: one atom per name, the
  // node's keywords applying to each (JSON Schema applies `minimum` to the
  // numbers and `pattern` to the strings of a multi-type node alike).
  const typeNames =
    typeof node.type === 'string'
      ? [node.type]
      : Array.isArray(node.type)
        ? node.type.filter((t): t is string => typeof t === 'string')
        : null;
  if (typeNames !== null && typeNames.length > 0) return typeNames.map((t) => typeAtom(t, site));

  // No `type`: a node that only says what its items or properties are still
  // describes an array or an object.
  if (isObject(node.items) || Array.isArray(node.prefixItems)) return [{ kind: 'array', site }];
  if (isObject(node.properties)) return [{ kind: 'object', site }];

  return [{ kind: 'opaque' }];
}

function toSentinel(atom: Extract<Atom, { kind: 'const' }>): Sentinel {
  return { value: atom.value, ...(atom.label === undefined ? {} : { label: atom.label }) };
}

const stringKeys = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const nonNegativeInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

function arraySpec(site: SchemaSite, resolver: RefResolver, depth: number): ValueSpec {
  const node = site.node as Record<string, unknown>;
  const minItems = nonNegativeInt(node.minItems);
  const maxItems = nonNegativeInt(node.maxItems);
  const items = isObject(node.items)
    ? specAt(childSite(site, 'items', node.items), resolver, depth + 1)
    : undefined;
  return {
    kind: 'array',
    ...(items === undefined || items.kind === 'opaque' ? {} : { items }),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
  };
}

function objectSpec(site: SchemaSite): ValueSpec {
  const node = site.node as Record<string, unknown>;
  const fields = isObject(node.properties) ? Object.keys(node.properties) : [];
  const closed =
    !isObject(node.patternProperties) &&
    (node.additionalProperties === false || node.unevaluatedProperties === false);
  return { kind: 'object', fields, required: stringKeys(node.required), closed };
}

/** The noun phrase one atom contributes to a mixed expectation (`an integer or an array`). */
function atomNoun(atom: Atom): string | null {
  switch (atom.kind) {
    case 'numeric':
      return atom.numType === 'integer' ? 'an integer' : 'a number';
    case 'pattern':
    case 'string':
      return 'text';
    case 'boolean':
      return 'a boolean';
    case 'array':
      return 'an array';
    case 'object':
      return 'an object';
    case 'const':
      return 'a listed code';
    default:
      return null;
  }
}

function joinOr(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words.at(-1) ?? ''}`;
}

function specAt(site: SchemaSite, resolver: RefResolver, depth: number): ValueSpec {
  const opaquePointer = `${site.file.relativePath}#${site.pointer}`;
  if (depth > MAX_DEPTH) {
    return { kind: 'opaque', rendered: `a value satisfying the schema at ${opaquePointer}` };
  }
  const all = flatten(site, resolver, false, depth);

  if (all.some((a) => a.kind === 'opaque')) {
    return { kind: 'opaque', rendered: `a value satisfying the schema at ${opaquePointer}` };
  }
  // Null never decides what a value is: `["integer", "null"]` is an integer
  // spec (the tooltip's Type line says the null).
  const atoms = all.filter((a) => a.kind !== 'null');
  if (atoms.length === 0) {
    return all.length === 0
      ? { kind: 'opaque', rendered: `a value satisfying the schema at ${opaquePointer}` }
      : { kind: 'opaque', rendered: 'null' };
  }

  const containers = atoms.filter((a) => a.kind === 'array' || a.kind === 'object');
  if (containers.length > 0) {
    const only = containers[0];
    if (atoms.length === 1 && only !== undefined) {
      return only.kind === 'array' ? arraySpec(only.site, resolver, depth) : objectSpec(only.site);
    }
    // A container among other shapes (`shifty`: a number, a word or a list):
    // name every shape, once each, in schema order.
    const nouns = [...new Set(atoms.map(atomNoun).filter((n): n is string => n !== null))];
    return { kind: 'mixed', rendered: joinOr(nouns) };
  }

  const numerics = atoms.filter((a) => a.kind === 'numeric');
  const consts = atoms.filter((a) => a.kind === 'const');
  const patterns = atoms.filter((a) => a.kind === 'pattern');
  const strings = atoms.filter((a) => a.kind === 'string');
  const booleans = atoms.filter((a) => a.kind === 'boolean');

  const first = numerics[0];
  if (first !== undefined && patterns.length === 0 && strings.length === 0 && booleans.length === 0) {
    const sentinels = consts.map(toSentinel);
    const labelByValue = new Map(sentinels.map((s) => [s.value, s.label]));
    const exclusions = numerics
      .flatMap((n) => n.notEnum)
      .map((value): Sentinel => {
        const label = labelByValue.get(value);
        return { value, ...(label === undefined ? {} : { label }) };
      });
    return {
      kind: 'numeric',
      numType: numerics.some((n) => n.numType === 'number') ? 'number' : 'integer',
      ...(first.min === undefined ? {} : { min: first.min }),
      ...(first.max === undefined ? {} : { max: first.max }),
      exclusions,
      sentinels,
    };
  }
  const pattern = patterns[0];
  if (pattern !== undefined && numerics.length === 0 && strings.length === 0 && booleans.length === 0) {
    return {
      kind: 'string-pattern',
      pattern: pattern.pattern,
      ...(pattern.title === undefined ? {} : { patternTitle: pattern.title }),
      ...(pattern.description === undefined ? {} : { patternDescription: pattern.description }),
      // String sentinels ride alongside a pattern def (split_origin_household_id).
      sentinels: consts.map(toSentinel),
    };
  }
  if (consts.length > 0 && numerics.length === 0 && patterns.length === 0 && strings.length === 0 && booleans.length === 0) {
    // Codes vs sentinels split (spec-silent, decided): consts reached via a
    // `$ref`'d def are missing-value sentinels; inline consts are codes.
    return {
      kind: 'codes',
      codes: consts.filter((c) => !c.viaRef).map(toSentinel),
      sentinels: consts.filter((c) => c.viaRef).map(toSentinel),
    };
  }
  if (strings.length > 0 && numerics.length === 0 && patterns.length === 0 && booleans.length === 0) {
    return { kind: 'string-free', sentinels: consts.map(toSentinel) };
  }
  if (booleans.length > 0 && numerics.length === 0 && patterns.length === 0 && strings.length === 0) {
    return { kind: 'boolean', sentinels: consts.map(toSentinel) };
  }
  return { kind: 'mixed' };
}

export function deriveValueSpec(site: SchemaSite, resolver: RefResolver): ValueSpec {
  return specAt(site, resolver, 0);
}

// ---------------------------------------------------------------------------
// §D.4 rendering
// ---------------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat('en-US');

/** Range bounds get thousands separators; code/sentinel values render as-is. */
export function formatBound(v: number): string {
  return numberFormat.format(v);
}

export function renderValue(v: string | number | boolean | null): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null) return 'null';
  return String(v);
}

function renderSentinelList(sentinels: readonly Sentinel[]): string {
  return sentinels
    .map((s) => (s.label === undefined ? renderValue(s.value) : `${renderValue(s.value)} ${s.label}`))
    .join(', ');
}

/** Codes render `{v} {title}` joined by `; `, capped at 8 (§D.4). */
function renderCodeList(codes: readonly Sentinel[]): string {
  const rendered = codes
    .slice(0, 8)
    .map((c) => (c.label === undefined ? renderValue(c.value) : `${renderValue(c.value)} ${c.label}`));
  const more = codes.length - 8;
  const suffix = more > 0 ? `; … (${String(more)} more — see column tooltip)` : '';
  return rendered.join('; ') + suffix;
}

function numericBase(spec: Extract<ValueSpec, { kind: 'numeric' }>): string {
  const noun = spec.numType === 'integer' ? 'an integer' : 'a number';
  if (spec.min !== undefined && spec.max !== undefined) {
    return `${noun} ${formatBound(spec.min)}–${formatBound(spec.max)}`;
  }
  if (spec.min !== undefined) return `${noun} at least ${formatBound(spec.min)}`;
  if (spec.max !== undefined) return `${noun} at most ${formatBound(spec.max)}`;
  return noun;
}

/** True when any excluded value would otherwise fall inside the numeric range. */
function exclusionsOverlapRange(spec: Extract<ValueSpec, { kind: 'numeric' }>): boolean {
  return spec.exclusions.some((e) => {
    if (typeof e.value !== 'number') return false;
    if (spec.min !== undefined && e.value < spec.min) return false;
    if (spec.max !== undefined && e.value > spec.max) return false;
    return true;
  });
}

const itemCount = (n: number): string => `${formatBound(n)} item${n === 1 ? '' : 's'}`;

/** `an array of at most 3 items, each an integer 0–9`. */
function renderArrayExpectation(spec: Extract<ValueSpec, { kind: 'array' }>): string {
  const { minItems: min, maxItems: max } = spec;
  let text = 'an array';
  if (min !== undefined && max !== undefined) {
    text += min === max ? ` of exactly ${itemCount(min)}` : ` of ${formatBound(min)}–${itemCount(max)}`;
  } else if (max !== undefined) {
    text += ` of at most ${itemCount(max)}`;
  } else if (min !== undefined && min > 0) {
    text += ` of at least ${itemCount(min)}`;
  }
  if (spec.items !== undefined) text += `, each ${renderExpectation(spec.items)}`;
  return text;
}

/** Fields past this many are summarised (`… and 4 more`). */
const OBJECT_FIELD_CAP = 8;

/** `an object with fields x, y, tier (no other fields)`. */
function renderObjectExpectation(spec: Extract<ValueSpec, { kind: 'object' }>): string {
  if (spec.fields.length === 0) return spec.closed ? 'an empty object' : 'an object';
  const shown = spec.fields.slice(0, OBJECT_FIELD_CAP);
  const more = spec.fields.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${String(more)} more` : shown.join(', ');
  const noun = spec.fields.length === 1 ? 'field' : 'fields';
  return `an object with ${noun} ${list}${spec.closed ? ' (no other fields)' : ''}`;
}

/** §D.4 expectation string. Pure; the P08 translator embeds it verbatim. */
export function renderExpectation(spec: ValueSpec): string {
  switch (spec.kind) {
    case 'numeric': {
      let text = numericBase(spec);
      if (spec.exclusions.length > 0 && exclusionsOverlapRange(spec)) {
        text += ' (sentinel codes are not valid substantive values)';
      }
      if (spec.sentinels.length > 0) {
        text += `, or a missing-value code (${renderSentinelList(spec.sentinels)})`;
      }
      return text;
    }
    case 'codes':
      return `one of: ${renderCodeList([...spec.codes, ...spec.sentinels])}`;
    case 'string-pattern': {
      const gloss = spec.patternTitle ?? spec.patternDescription;
      let text = `text matching ${spec.pattern}`;
      if (gloss !== undefined) text += ` (${gloss})`;
      if (spec.sentinels.length > 0) {
        text += `, or one of: ${renderCodeList(spec.sentinels)}`;
      }
      return text;
    }
    case 'string-free': {
      let text = 'text';
      if (spec.sentinels.length > 0) {
        text += `, or a missing-value code (${renderSentinelList(spec.sentinels)})`;
      }
      return text;
    }
    case 'boolean': {
      let text = 'a boolean';
      if (spec.sentinels.length > 0) {
        text += `, or a missing-value code (${renderSentinelList(spec.sentinels)})`;
      }
      return text;
    }
    case 'array':
      return renderArrayExpectation(spec);
    case 'object':
      return renderObjectExpectation(spec);
    case 'mixed':
      return spec.rendered ?? 'a value of one of several types (see schema)';
    case 'opaque':
      return spec.rendered ?? 'a value satisfying the schema';
  }
}
