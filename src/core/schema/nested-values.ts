/**
 * Nested values — LIST, STRUCT, MAP and JSON columns from a JSON or Parquet
 * dataset — on their way to the Ajv row loop (json-schema-subsystem.md §C.4).
 *
 * The row loop reads such a column as `CAST(to_json(c) AS VARCHAR)` and parses
 * the text here, in the validation worker. Arrow is no route for them:
 * data-table's `bridge.query` documents that it hands a DATE inside a list
 * over as epoch milliseconds, a HUGEINT or DECIMAL inside one as a
 * meaningless number, and @duckdb/node-api has value classes of its own — so
 * the browser and the CLI would each validate a different value. `to_json`
 * writes what the source JSON held: dates and UUIDs as strings, every digit
 * of a 128-bit integer, JSON as itself.
 *
 * Three things the text alone does not settle:
 *
 * 1. **A STRUCT cannot tell a missing field from a null one.** DuckDB reads
 *    `{}` and `{"x": null}` into the same struct, its fields all NULL. QuaC
 *    reads a NULL field as missing when the schema does not allow null there,
 *    and as null when it does — the rule §C.3 applies to a whole column. An
 *    optional field the record left out then passes, a required one is
 *    reported missing, and `"middle_name": null` under a nullable schema
 *    passes. The schema is read the way JSON Schema reads it — `properties`,
 *    then a matching `patternProperties`, then `additionalProperties` — so an
 *    open object DuckDB typed as a struct (a few lab names → values) works
 *    the same. DuckDB also gives a struct every key ANY record has: a field
 *    a closed object does not admit at all is read as missing when NULL, so
 *    one record's stray key is reported once, in that record, and not as a
 *    NULL in all the others. Only an explicit null the schema forbids, in a
 *    field it does not require, goes unseen: DuckDB kept no trace of it. A
 *    MAP keeps its keys and a JSON value its text, so neither is touched.
 * 2. **Non-finite numbers.** `to_json` writes a NaN or ±Infinity DOUBLE (a
 *    Parquet list can hold one) as a bare `NaN` / `Infinity`, which
 *    `JSON.parse` rejects. They are read as null and reported, each by its
 *    path, as a cast finding — never handed to Ajv, where NaN would pass every
 *    `minimum` and `maximum` (§C.3).
 * 3. **Integers past ±(2^53 − 1)** parse to the nearest double, as a BIGINT
 *    column's do (§C.3): the first one in a column earns the precision
 *    warning, naming where it is.
 *
 * And one thing for the messages: a path into a value, written the way the
 * report grid's value inspector shows it — a list's items counted from 1, as
 * DuckDB SQL counts them (`people[2].age`), an array inside a JSON value from
 * 0, as JSONPath does; a field by name, `["my field"]` when the name is not an
 * identifier; a map's entry by its key.
 *
 * The plan is built on the main thread (it needs the schema set and the
 * column's DuckDB type), crosses to the worker as plain data, and is applied
 * there. Pure; node-testable.
 */
import { parseDuckType } from '../duckdb-type';
import type { DuckType } from '../duckdb-type';
import { NON_FINITE_MARK, markNonFinite } from '../nested-json';
import { canonicalKindOf, canonicalValue } from './canonical';
import type { CanonicalKind } from './canonical';
import { escapePointerSegment, getAtPointer } from './deref';
import type { RefResolver, SchemaSite } from './deref';
import { allowsNull } from './value-spec';
import type { SchemaFile } from './types';

/** How one column's `to_json` text maps back onto what the schema expects. */
export type NestedPlan =
  /** A LIST or fixed-size ARRAY: items count from 1. */
  | { kind: 'list'; element: NestedPlan }
  /** A STRUCT: its fields in order, and those whose NULL reads as missing. */
  | { kind: 'struct'; fields: [string, NestedPlan][]; dropNull: string[] }
  /** A MAP: `key` when its keys need a standard rendering (a TIMESTAMP key). */
  | { kind: 'map'; value: NestedPlan; key?: CanonicalKind }
  /** A UNION, which `to_json` writes as `{"tag": value}`: read as the value. */
  | { kind: 'union'; members: [string, NestedPlan][] }
  /** JSON or VARIANT: taken as written; arrays count from 0. */
  | { kind: 'json' }
  /** A scalar: `canonical` when DuckDB's text is not the standard one (canonical.ts). */
  | { kind: 'leaf'; canonical?: CanonicalKind };

/** What the worker needs to read one nested column. */
export interface NestedColumn {
  column: string;
  plan: NestedPlan;
  /** The DuckDB type can hold integers past 2^53 — scan for them. */
  wideIntegers: boolean;
}

// ---------------------------------------------------------------------------
// Main thread: the plan, from the DuckDB type and the property's schema
// ---------------------------------------------------------------------------

const MAX_DEPTH = 12;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function child(site: SchemaSite, segments: readonly (string | number)[], node: unknown): SchemaSite {
  const pointer = segments.reduce<string>(
    (acc, seg) => `${acc}/${typeof seg === 'number' ? String(seg) : escapePointerSegment(seg)}`,
    site.pointer,
  );
  return { file: site.file, pointer, node };
}

/**
 * Every subschema that applies to the value at `site` in place: the site
 * itself, its `$ref` target, and the branches of `allOf`/`anyOf`/`oneOf` and
 * of `then`/`else` — where a property's declaration can live.
 */
function inPlace(site: SchemaSite | null, resolver: RefResolver): SchemaSite[] {
  const out: SchemaSite[] = [];
  const seen = new Set<unknown>();
  const visit = (s: SchemaSite, depth: number): void => {
    const node = s.node;
    if (!isRecord(node) || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    out.push(s);
    if (typeof node.$ref === 'string') {
      const target = resolver.resolve(s.file, `${s.pointer}/$ref`);
      if (target !== null) visit(target, depth + 1);
    }
    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, i) => {
        visit(child(s, [keyword, i], branch), depth + 1);
      });
    }
    for (const keyword of ['then', 'else'] as const) {
      if (isRecord(node[keyword])) visit(child(s, [keyword], node[keyword]), depth + 1);
    }
  };
  if (site !== null) visit(site, 0);
  return out;
}

function patternMatches(pattern: string, name: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(name);
  } catch {
    return false;
  }
}

/**
 * The subschemas JSON Schema applies to field `name` of an object described
 * by `sites`, found the way JSON Schema finds them: its `properties` entry;
 * failing that, every `patternProperties` entry whose pattern matches it;
 * failing that, `additionalProperties` when it is a schema. `closed` says the
 * object admits no such field at all (`additionalProperties` or
 * `unevaluatedProperties` false).
 */
function fieldDeclarations(
  sites: readonly SchemaSite[],
  name: string,
): { sites: SchemaSite[]; closed: boolean } {
  const declared: SchemaSite[] = [];
  for (const s of sites) {
    const properties = (s.node as Record<string, unknown>).properties;
    if (isRecord(properties) && Object.hasOwn(properties, name)) {
      declared.push(child(s, ['properties', name], properties[name]));
    }
  }
  if (declared.length > 0) return { sites: declared, closed: false };
  const patterned: SchemaSite[] = [];
  for (const s of sites) {
    const patterns = (s.node as Record<string, unknown>).patternProperties;
    if (!isRecord(patterns)) continue;
    for (const [pattern, schema] of Object.entries(patterns)) {
      if (patternMatches(pattern, name)) patterned.push(child(s, ['patternProperties', pattern], schema));
    }
  }
  if (patterned.length > 0) return { sites: patterned, closed: false };
  const additional: SchemaSite[] = [];
  let closed = false;
  for (const s of sites) {
    const node = s.node as Record<string, unknown>;
    if (isRecord(node.additionalProperties)) {
      additional.push(child(s, ['additionalProperties'], node.additionalProperties));
    }
    if (node.additionalProperties === false || node.unevaluatedProperties === false) closed = true;
  }
  return { sites: additional, closed: additional.length === 0 && closed };
}

function itemSite(sites: readonly SchemaSite[]): SchemaSite | null {
  for (const s of sites) {
    const items = (s.node as Record<string, unknown>).items;
    if (isRecord(items)) return child(s, ['items'], items);
  }
  return null;
}

/** A MAP's values: the schema's `additionalProperties`, else its first `patternProperties`. */
function mapValueSite(sites: readonly SchemaSite[]): SchemaSite | null {
  for (const s of sites) {
    const node = s.node as Record<string, unknown>;
    if (isRecord(node.additionalProperties)) {
      return child(s, ['additionalProperties'], node.additionalProperties);
    }
    if (isRecord(node.patternProperties)) {
      const [first] = Object.entries(node.patternProperties);
      if (first !== undefined) return child(s, ['patternProperties', first[0]], first[1]);
    }
  }
  return null;
}

function planFor(type: DuckType, site: SchemaSite | null, resolver: RefResolver, depth: number): NestedPlan {
  if (depth > MAX_DEPTH) return { kind: 'json' };
  switch (type.kind) {
    case 'list':
    case 'array':
      return {
        kind: 'list',
        element: planFor(type.element, itemSite(inPlace(site, resolver)), resolver, depth + 1),
      };
    case 'struct': {
      const sites = inPlace(site, resolver);
      const fields: [string, NestedPlan][] = [];
      const dropNull: string[] = [];
      for (const [name, fieldType] of type.fields) {
        const declared = fieldDeclarations(sites, name);
        fields.push([name, planFor(fieldType, declared.sites[0] ?? null, resolver, depth + 1)]);
        // Missing, not null, where EVERY declaration of the field rules null
        // out — and where the object admits no such field at all. DuckDB gives
        // a struct every key ANY record has, so one record's stray `pulse`
        // turns up as a NULL `pulse` in all the others; read as present, the
        // closed object would reject it in every one of them. The record that
        // really holds a `pulse` still has it, and Ajv still names it.
        const ruledOut =
          declared.sites.length > 0
            ? declared.sites.every((d) => !allowsNull(d, resolver))
            : declared.closed;
        if (ruledOut) dropNull.push(name);
      }
      return { kind: 'struct', fields, dropNull };
    }
    case 'map': {
      const key = type.key.kind === 'scalar' ? canonicalKindOf(type.key.name) : undefined;
      return {
        kind: 'map',
        value: planFor(type.value, mapValueSite(inPlace(site, resolver)), resolver, depth + 1),
        ...(key === undefined ? {} : { key }),
      };
    }
    case 'union':
      return {
        kind: 'union',
        members: type.members.map(([name, member]) => [name, planFor(member, site, resolver, depth + 1)]),
      };
    case 'json':
    case 'variant':
      return { kind: 'json' };
    case 'scalar': {
      const canonical = canonicalKindOf(type.name);
      return canonical === undefined ? { kind: 'leaf' } : { kind: 'leaf', canonical };
    }
  }
}

/**
 * The plan for one column: its DuckDB type text and the schema node of its
 * property (null for a column the schema does not declare — every NULL field
 * then stays null).
 */
export function buildNestedPlan(
  typeText: string,
  site: SchemaSite | null,
  resolver: RefResolver,
): NestedPlan {
  return planFor(parseDuckType(typeText), site, resolver, 0);
}

/** The schema node a ColumnMeta's `source` names, or null when it no longer resolves. */
export function propertySite(
  file: SchemaFile | undefined,
  pointer: string,
): SchemaSite | null {
  if (file === undefined) return null;
  const at = getAtPointer(file.json, pointer);
  return at.found ? { file, pointer, node: at.value } : null;
}

// ---------------------------------------------------------------------------
// Worker: decode one cell
// ---------------------------------------------------------------------------

export type PathSegment = string | number;

export interface DecodedValue {
  value: unknown;
  /** Where a NaN or ±Infinity was, now null — each with the token DuckDB wrote. */
  nonFinite: { path: PathSegment[]; token: string }[];
  /** The first integer past ±(2^53 − 1), if the scan was asked for and found one. */
  unsafeInteger: { path: PathSegment[]; text: string } | null;
  /** The text did not parse at all (JSON a lenient DuckDB cast accepted): `value` is undefined. */
  unreadable?: true;
}

/** Long integer tokens outside strings are rare enough to gate the scan on the text. */
const LONG_INTEGER = /(?:^|[^\d.eE+-])-?\d{16,}(?![\d.eE])/;

/** `JSON.parse`'s reviver context (ES2025 "source text access"): the token as written. */
interface ReviverContext {
  source?: string;
}

/** Whether this engine hands a reviver the source text (Node 21+, Chrome 114+, Safari 18.4+). */
const SOURCE_ACCESS: boolean = (() => {
  let seen = false;
  JSON.parse('1', ((_key: string, value: unknown, context?: ReviverContext) => {
    seen = context?.source === '1';
    return value;
  }) as (key: string, value: unknown) => unknown);
  return seen;
})();

/**
 * Parse, remembering the digits of every integer token past ±(2^53 − 1), by
 * the object (or array) that holds it and its key there — `JSON.parse` rounds
 * them, and a message should quote what the file said. Engines without
 * source text access hand over no context; the scan then falls back to the
 * rounded number.
 */
function parseKeepingWideDigits(text: string): {
  value: unknown;
  digits: Map<object, Map<string, string>>;
} {
  const digits = new Map<object, Map<string, string>>();
  const reviver = function (this: object, key: string, value: unknown, context?: ReviverContext): unknown {
    const source = context?.source;
    if (
      typeof value === 'number' &&
      !Number.isSafeInteger(value) &&
      source !== undefined &&
      /^-?\d+$/.test(source)
    ) {
      let byKey = digits.get(this);
      if (byKey === undefined) digits.set(this, (byKey = new Map<string, string>()));
      byKey.set(key, source);
    }
    return value;
  };
  const value: unknown = JSON.parse(text, reviver);
  // A wide integer that IS the whole value sits in JSON.parse's own wrapper
  // (`{"": value}`), which the walk below never sees: file it under `ROOT`.
  if (typeof value === 'number') {
    for (const [holder, byKey] of digits) {
      const wrapper = holder as Record<string, unknown>;
      const root = byKey.get('');
      if (root !== undefined && Object.keys(wrapper).length === 1 && wrapper[''] === value) {
        digits.set(ROOT, new Map([['', root]]));
        break;
      }
    }
  }
  return { value, digits };
}

/** The holder the walk uses for a cell's whole value. */
const ROOT: object = Object.freeze({});

/**
 * Parse `text`, reading bare non-finite tokens (`NaN`, `inf`, …) as marked
 * strings when the strict parse fails. Null when even that fails.
 */
function parseCell(
  text: string,
  scan: boolean,
): { value: unknown; digits: Map<object, Map<string, string>> | null; marked: boolean } | null {
  const parse = (source: string): { value: unknown; digits: Map<object, Map<string, string>> | null } =>
    scan ? parseKeepingWideDigits(source) : { value: JSON.parse(source) as unknown, digits: null };
  try {
    return { ...parse(text), marked: false };
  } catch {
    // NaN and Infinity are rare; so is anything worse.
  }
  try {
    return { ...parse(markNonFinite(text)), marked: true };
  } catch {
    return null;
  }
}

/**
 * Parse one cell's `to_json` text and fit it to the schema's view: STRUCT
 * nulls the schema does not allow become missing fields, non-finite numbers
 * become null (and are reported), DuckDB's text for a timestamp, interval,
 * blob or float becomes the standard one (canonical.ts), a UNION's tag goes,
 * and — when asked — the first unsafe integer is located (or, `perKey`, the
 * first under each top-level key). Mutates only the freshly parsed value.
 */
function decode(
  text: string,
  plan: NestedPlan | undefined,
  scanWideIntegers: boolean,
  perKey: boolean,
): DecodedValue & { unsafeByKey: Map<string, { path: PathSegment[]; text: string }> } {
  const scan = scanWideIntegers && LONG_INTEGER.test(text);
  const nonFinite: DecodedValue['nonFinite'] = [];
  const unsafeByKey = new Map<string, { path: PathSegment[]; text: string }>();
  const parsed = parseCell(text, scan);
  if (parsed === null) {
    return { value: undefined, nonFinite, unsafeInteger: null, unreadable: true, unsafeByKey };
  }
  const { digits, marked } = parsed;
  let unsafeInteger: DecodedValue['unsafeInteger'] = null;

  const walk = (
    v: unknown,
    p: NestedPlan | undefined,
    path: PathSegment[],
    holder: object,
    key: string,
  ): unknown => {
    if (typeof v === 'string') {
      if (marked && v.startsWith(NON_FINITE_MARK)) {
        nonFinite.push({ path: [...path], token: v.slice(NON_FINITE_MARK.length) });
        return null;
      }
      return p?.kind === 'leaf' && p.canonical !== undefined ? canonicalValue(p.canonical, v) : v;
    }
    if (typeof v === 'number') {
      if (scan && Number.isInteger(v) && !Number.isSafeInteger(v)) {
        const slot = perKey ? String(path[0] ?? '') : '';
        const seen = perKey ? unsafeByKey.has(slot) : unsafeInteger !== null;
        const written = digits?.get(holder)?.get(key);
        // With the source text at hand, only an integer TOKEN counts: a double
        // written `1.7976931348623157e308` has lost nothing it ever had.
        if (!seen && (written !== undefined || !SOURCE_ACCESS)) {
          const found = { path: [...path], text: written ?? String(v) };
          if (perKey) unsafeByKey.set(slot, found);
          else unsafeInteger = found;
        }
      }
      return p?.kind === 'leaf' && p.canonical !== undefined ? canonicalValue(p.canonical, v) : v;
    }
    if (Array.isArray(v)) {
      const element = p?.kind === 'list' ? p.element : p?.kind === 'json' ? p : undefined;
      for (let i = 0; i < v.length; i += 1) {
        path.push(i);
        v[i] = walk(v[i], element, path, v, String(i));
        path.pop();
      }
      return v;
    }
    if (isRecord(v)) {
      if (p?.kind === 'union') {
        // `to_json` writes a UNION as `{"tag": value}`; the value is the value.
        const [tag, ...rest] = Object.keys(v);
        const member = tag === undefined ? undefined : p.members.find(([name]) => name === tag);
        if (tag !== undefined && rest.length === 0 && member !== undefined) {
          return walk(v[tag], member[1], path, v, tag);
        }
        return v;
      }
      if (p?.kind === 'struct') {
        for (const name of p.dropNull) {
          if (Object.hasOwn(v, name) && v[name] === null) Reflect.deleteProperty(v, name);
        }
      }
      if (p?.kind === 'map' && p.key !== undefined) {
        // A TIMESTAMP (or BLOB, …) map key is text in standard form too.
        const keyKind = p.key;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v)) {
          const canonicalKey = String(canonicalValue(keyKind, k));
          path.push(canonicalKey);
          const result = walk(v[k], p.value, path, v, k);
          path.pop();
          Object.defineProperty(out, canonicalKey, { value: result, writable: true, enumerable: true, configurable: true });
        }
        return out;
      }
      for (const k of Object.keys(v)) {
        const next =
          p?.kind === 'struct'
            ? p.fields.find(([name]) => name === k)?.[1]
            : p?.kind === 'map'
              ? p.value
              : p?.kind === 'json'
                ? p
                : undefined;
        path.push(k);
        const result = walk(v[k], next, path, v, k);
        path.pop();
        // defineProperty, not assignment: a `__proto__` field must stay a field.
        if (result !== v[k]) {
          Object.defineProperty(v, k, { value: result, writable: true, enumerable: true, configurable: true });
        }
      }
      return v;
    }
    return v;
  };

  const value = walk(parsed.value, plan, [], ROOT, '');
  return { value, nonFinite, unsafeInteger, unsafeByKey };
}

/** One cell's `to_json` text, read with its column's plan (see `decode`). */
export function decodeNestedValue(
  text: string,
  plan: NestedPlan | undefined,
  scanWideIntegers: boolean,
): DecodedValue {
  const d = decode(text, plan, scanWideIntegers, false);
  return {
    value: d.value,
    nonFinite: d.nonFinite,
    unsafeInteger: d.unsafeInteger,
    ...(d.unreadable === true ? { unreadable: true as const } : {}),
  };
}

export interface DecodedRecord {
  /** The record as the file wrote it — any JSON value, an object for a well-formed dataset. */
  value: unknown;
  /** Bare NaN / Infinity tokens (DuckDB reads them; JSON has no word for them), now null. */
  nonFinite: { path: PathSegment[]; token: string }[];
  /** The first integer past ±(2^53 − 1) under each top-level key. */
  unsafeIntegers: ReadonlyMap<string, { path: PathSegment[]; text: string }>;
  unreadable: boolean;
}

/**
 * One JSON record's exact text, parsed as the file wrote it: nothing dropped,
 * nothing renamed, an explicit null kept as null and a missing key missing.
 */
export function decodeRecord(text: string, scanWideIntegers: boolean): DecodedRecord {
  const decoded = decode(text, { kind: 'json' }, scanWideIntegers, true);
  return {
    value: decoded.value,
    nonFinite: decoded.nonFinite,
    unsafeIntegers: decoded.unsafeByKey,
    unreadable: decoded.unreadable === true,
  };
}

// ---------------------------------------------------------------------------
// Paths, for messages
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fieldStep = (name: string): string =>
  IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;

/**
 * `column` followed by the steps of `path` into `value`, numbered as the
 * value inspector numbers them: `people[2].age`, `odd_keys["my field"]`,
 * `props["key_001"]`, `shifty[0]`. `value` is the decoded cell — whether a
 * step indexes an array or names a key is read off it, so a JSON value's
 * `{"2": …}` stays a key.
 */
export function renderNestedPath(
  column: string,
  path: readonly PathSegment[],
  value: unknown,
  plan: NestedPlan | undefined,
): string {
  let out = column;
  let v = value;
  let p = plan;
  for (const seg of path) {
    if (p?.kind === 'union') p = unionMemberFor(p, v);
    if (Array.isArray(v)) {
      const index = typeof seg === 'number' ? seg : Number(seg);
      out += p?.kind === 'list' ? `[${String(index + 1)}]` : `[${String(index)}]`;
      v = v[index];
      p = p?.kind === 'list' ? p.element : p?.kind === 'json' ? p : undefined;
      continue;
    }
    const key = String(seg);
    out += p?.kind === 'map' ? `[${JSON.stringify(key)}]` : fieldStep(key);
    v = isRecord(v) && Object.hasOwn(v, key) ? v[key] : undefined;
    p =
      p?.kind === 'struct'
        ? p.fields.find(([name]) => name === key)?.[1]
        : p?.kind === 'map'
          ? p.value
          : p?.kind === 'json'
            ? p
            : undefined;
  }
  return out;
}

/** The UNION member a decoded value came from, judged by its shape (for numbering only). */
function unionMemberFor(plan: Extract<NestedPlan, { kind: 'union' }>, value: unknown): NestedPlan | undefined {
  const fits = (p: NestedPlan): boolean =>
    Array.isArray(value)
      ? p.kind === 'list' || p.kind === 'json'
      : isRecord(value)
        ? p.kind === 'struct' || p.kind === 'map' || p.kind === 'json'
        : p.kind === 'leaf';
  return plan.members.find(([, p]) => fits(p))?.[1];
}

/** An Ajv `instancePath` (`/people/1/age`) as unescaped segments, column first. */
export function pointerSegments(instancePath: string): string[] {
  if (instancePath === '') return [];
  return instancePath
    .split('/')
    .slice(1)
    .map((seg) => seg.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** Segments back to an Ajv-style `instancePath`. */
export function toInstancePath(column: string, path: readonly PathSegment[]): string {
  return [column, ...path].map((seg) => `/${escapePointerSegment(String(seg))}`).join('');
}
