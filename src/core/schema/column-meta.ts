/**
 * ColumnMeta — the single per-column digest (json-schema-subsystem.md §E.1).
 * Powers casting (P09), translation (P08), tooltips, pertinence, and the
 * report. Built once per SchemaSet; deterministic, pure, node-testable.
 *
 * A column is a property the record schema declares, wherever it declares
 * it. The walk starts at the record schemas the dataset shape names (2020-12
 * `items` / `prefixItems`, draft-07 `items` / `additionalItems` — see
 * dataset-shape.ts) and follows every in-place applicator, in document order,
 * depth first:
 *
 *   unconditional  `$ref` (any file, `$anchor`s too), `$dynamicRef`, `allOf`
 *   conditional    `anyOf` / `oneOf` branches, `then` / `else`,
 *                  `dependentSchemas`, schema-form `dependencies`
 *
 * `not` and `if` subschemas declare nothing — one rules a value out, the
 * other only picks `then` or `else`. Every `properties` entry met along the
 * way is a declaration of its name, boolean property schemas included. So
 * `items: {"$ref": "#/$defs/row"}`, a category behind a `$ref` that is itself
 * an `allOf`, and the variants of a `oneOf` all digest — the HESP layout
 * (`items.allOf` category refs followed by if/then blocks) as before.
 *
 * One ColumnMeta per name, in first-declaration order:
 *
 * - strings (title, description, unit, …), `group` and `source` come from the
 *   first declaration;
 * - `jsonTypes` are the types a value can have and still pass every
 *   UNCONDITIONAL declaration (a declaration that says nothing about type
 *   constrains nothing); a name declared only conditionally takes the union
 *   of its alternatives' types — the casting target is a best reading there,
 *   and alternatives can never widen what the unconditional ones allow;
 * - `valueSpec` comes from the first unconditional declaration, else the
 *   first;
 * - `required` means UNCONDITIONALLY required: named by a `required` reached
 *   from the record schema through `$ref` / `allOf` only. A `required` inside
 *   an `anyOf`, a `then` or a `dependentSchemas` holds in some records, not
 *   all, and Ajv reports it where it holds.
 *
 * A name required unconditionally but declared under no `properties` at all
 * (`required: ["ghost"]`) still gets a ColumnMeta (`declared: false`), so a
 * dataset without it is told so once, by pertinence, not row by row.
 * `undeclaredColumnMeta` describes a dataset column no `properties` names,
 * from the `patternProperties` / `additionalProperties` /
 * `unevaluatedProperties` that apply to it; `undeclaredColumnVerdict` says
 * whether the record schema rejects such a column.
 */
import { analyzeRootFile } from './dataset-shape';
import type { RootAnalysis } from './dataset-shape';
import { createRefResolver, escapePointerSegment } from './deref';
import type { RefResolver, SchemaSite } from './deref';
import { extractConditionals } from './conditionals';
import type { ConditionalRule, SentinelLabelFor } from './conditionals';
import {
  deriveJsonTypesOrNull,
  deriveValueSpec,
  intersectJsonTypes,
  labelledValuesOf,
  storageTypeFor,
} from './value-spec';
import type { JsonTypeName, StorageType, ValueSpec } from './value-spec';
import type { SchemaSet } from './types';

/** One place the schema declares a property: `…/properties/<name>` in a file. */
export interface DeclarationRef {
  fileId: string;
  pointer: string;
  /** Reached through anyOf/oneOf/then/else/dependentSchemas/dependencies (or a prefix schema). */
  conditional: boolean;
}

export interface ColumnMeta {
  name: string;
  title?: string;
  description?: string;
  /** x-variable-group of the schema object holding the first declaration. */
  group?: string;
  role?: string;
  unit?: string;
  universe?: string;
  derivation?: string;
  /** Property-level $comment. */
  comment?: string;
  /** Unconditionally required: named by a `required` reached through `$ref` / `allOf` only. */
  required: boolean;
  jsonTypes: ReadonlySet<JsonTypeName>;
  storageType: StorageType;
  mixed: boolean;
  valueSpec: ValueSpec;
  /** Indices into the digest's ConditionalRule[] (array positions). */
  conditionals: { asTarget: number[]; asCondition: number[] };
  /** The first declaration (a ghost: the `required` entry naming it). */
  source: { fileId: string; pointer: string };
  /**
   * `false` when no `properties` declares the name: a ghost (required, never
   * declared) or a column described only by `patternProperties` /
   * `additionalProperties` (`undeclaredColumnMeta`). Absent = declared.
   */
  declared?: false;
  /** Every declaration of the name, in schema order (empty for a ghost). */
  declarations?: DeclarationRef[];
}

export interface ColumnDigest {
  meta: ColumnMeta[];
  conditionals: ConditionalRule[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Walk depth guard: in-place applicator chains deeper than this are cycles in all but name. */
const MAX_WALK_DEPTH = 32;

function childSite(site: SchemaSite, segments: readonly (string | number)[], node: unknown): SchemaSite {
  const tail = segments
    .map((s) => (typeof s === 'number' ? String(s) : escapePointerSegment(s)))
    .join('/');
  return { file: site.file, pointer: `${site.pointer}/${tail}`, node };
}

/** Ajv's reading of a `patternProperties` key: Unicode mode, plain mode when that does not compile. */
function patternMatches(pattern: string, name: string): boolean {
  for (const flags of ['u', '']) {
    try {
      return new RegExp(pattern, flags).test(name);
    } catch {
      // try the next reading
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The record walk
// ---------------------------------------------------------------------------

/** How a walk position was reached. */
interface Mode {
  /** Through an alternative or a condition: holds in some records only. */
  conditional: boolean;
  /** `required` arrays met here count toward ColumnMeta.required. */
  requiredCounts: boolean;
}

interface WalkDeclaration {
  name: string;
  site: SchemaSite;
  conditional: boolean;
  group?: string;
}

interface WalkOpen {
  kind: 'pattern' | 'additional' | 'unevaluated';
  pattern?: string;
  site: SchemaSite;
  /** The schema object holding the keyword. */
  owner: Record<string, unknown>;
  conditional: boolean;
}

interface WalkNode {
  site: SchemaSite;
  conditional: boolean;
}

interface RecordWalk {
  declarations: WalkDeclaration[];
  /** Unconditionally required names, first mention first, each with the site of its `required` entry. */
  required: Map<string, SchemaSite>;
  open: WalkOpen[];
  /** Every schema object the walk visited (once per mode). */
  nodes: WalkNode[];
}

const modeRank = (mode: Mode): number => (!mode.conditional ? 2 : mode.requiredCounts ? 1 : 0);

function walkRecord(starts: readonly { site: SchemaSite; mode: Mode }[], resolver: RefResolver): RecordWalk {
  const walk: RecordWalk = { declarations: [], required: new Map(), open: [], nodes: [] };
  /** Strongest mode each site was visited in: a weaker revisit adds nothing. */
  const best = new Map<string, number>();

  const visit = (site: SchemaSite, mode: Mode, depth: number): void => {
    const node = site.node;
    if (!isObject(node) || depth > MAX_WALK_DEPTH) return;
    const key = `${site.file.fileId}#${site.pointer}`;
    const rank = modeRank(mode);
    if ((best.get(key) ?? -1) >= rank) return;
    best.set(key, rank);
    walk.nodes.push({ site, conditional: mode.conditional });

    const group = str(node['x-variable-group']);
    if (isObject(node.properties)) {
      for (const [name, propNode] of Object.entries(node.properties)) {
        walk.declarations.push({
          name,
          site: childSite(site, ['properties', name], propNode),
          conditional: mode.conditional,
          ...(group === undefined ? {} : { group }),
        });
      }
    }
    if (mode.requiredCounts && Array.isArray(node.required)) {
      node.required.forEach((name, i) => {
        if (typeof name === 'string' && !walk.required.has(name)) {
          walk.required.set(name, childSite(site, ['required', i], name));
        }
      });
    }
    if (isObject(node.patternProperties)) {
      for (const [pattern, schema] of Object.entries(node.patternProperties)) {
        walk.open.push({
          kind: 'pattern',
          pattern,
          site: childSite(site, ['patternProperties', pattern], schema),
          owner: node,
          conditional: mode.conditional,
        });
      }
    }
    for (const [keyword, kind] of [
      ['additionalProperties', 'additional'],
      ['unevaluatedProperties', 'unevaluated'],
    ] as const) {
      if (!Object.hasOwn(node, keyword)) continue;
      walk.open.push({
        kind,
        site: childSite(site, [keyword], node[keyword]),
        owner: node,
        conditional: mode.conditional,
      });
    }

    const branch: Mode = { conditional: true, requiredCounts: false };
    const each = (keyword: string, entries: unknown, entryMode: Mode): void => {
      if (!Array.isArray(entries)) return;
      entries.forEach((entry, i) => {
        visit(childSite(site, [keyword, i], entry), entryMode, depth + 1);
      });
    };
    // In-place applicators, in the order the schema writes them.
    for (const [keyword, value] of Object.entries(node)) {
      switch (keyword) {
        case '$ref':
        case '$dynamicRef': {
          if (typeof value !== 'string') break;
          const target = resolver.resolve(site.file, `${site.pointer}/${keyword}`);
          if (target !== null) visit(target, mode, depth + 1);
          break;
        }
        case 'allOf':
          each(keyword, value, mode);
          break;
        case 'anyOf':
        case 'oneOf':
          each(keyword, value, branch);
          break;
        case 'then':
        case 'else':
          // Without an `if`, `then` and `else` are not applied at all.
          if (Object.hasOwn(node, 'if')) visit(childSite(site, [keyword], value), branch, depth + 1);
          break;
        case 'dependentSchemas':
        case 'dependencies':
          if (!isObject(value)) break;
          for (const [name, schema] of Object.entries(value)) {
            // `dependencies` also takes the dependentRequired form (an array of names).
            if (isObject(schema)) visit(childSite(site, [keyword, name], schema), branch, depth + 1);
          }
          break;
        default:
          break;
      }
    }
  };

  for (const { site, mode } of starts) visit(site, mode, 0);
  return walk;
}

/** Where the walk starts: the prefix schemas (their records first), then the record schema. */
function walkStarts(analysis: RootAnalysis): { site: SchemaSite; mode: Mode }[] {
  const starts = analysis.prefixSites.map((site) => ({
    site,
    // A prefix schema describes one record: its declarations hold there only,
    // but what it requires, that record must have.
    mode: { conditional: true, requiredCounts: true },
  }));
  if (analysis.recordSite !== null) {
    starts.push({ site: analysis.recordSite, mode: { conditional: false, requiredCounts: true } });
  }
  return starts;
}

// ---------------------------------------------------------------------------
// Declarations → ColumnMeta
// ---------------------------------------------------------------------------

type Strings = Record<
  'title' | 'description' | 'comment' | 'role' | 'unit' | 'universe' | 'derivation',
  string | undefined
>;

/** Property node + one level of `$ref` target, sibling keywords winning. */
function mergedStrings(propSite: SchemaSite, resolver: RefResolver): Strings {
  const propNode = isObject(propSite.node) ? propSite.node : {};
  let target: Record<string, unknown> | undefined;
  if (typeof propNode.$ref === 'string') {
    const resolved = resolver.resolve(propSite.file, `${propSite.pointer}/$ref`);
    if (resolved !== null && isObject(resolved.node)) target = resolved.node;
  }
  const pick = (key: string): string | undefined => str(propNode[key]) ?? (target ? str(target[key]) : undefined);
  return {
    title: pick('title'),
    description: pick('description'),
    comment: pick('$comment'),
    role: pick('x-role'),
    unit: pick('x-unit'),
    universe: pick('x-universe'),
    derivation: pick('x-derivation'),
  };
}

/**
 * The types a value can have across `sites`: the intersection over the
 * unconditional ones (null = unconstrained), or — when every site is
 * conditional — the union of the alternatives. Empty = unconstrained.
 */
function typesAcross(
  sites: readonly { site: SchemaSite; conditional: boolean }[],
  resolver: RefResolver,
): ReadonlySet<JsonTypeName> {
  const unconditional = sites.filter((s) => !s.conditional);
  if (unconditional.length > 0) {
    let types: ReadonlySet<JsonTypeName> | null = null;
    for (const { site } of unconditional) {
      const t = deriveJsonTypesOrNull(site, resolver);
      if (t !== null) types = types === null ? t : intersectJsonTypes(types, t);
    }
    return types ?? new Set();
  }
  const union = new Set<JsonTypeName>();
  for (const { site } of sites) {
    const t = deriveJsonTypesOrNull(site, resolver);
    if (t === null) return new Set();
    for (const name of t) union.add(name);
  }
  return union;
}

function metaFrom(
  name: string,
  sites: readonly { site: SchemaSite; conditional: boolean; group?: string }[],
  required: boolean,
  resolver: RefResolver,
  declared: boolean,
): ColumnMeta {
  const first = sites[0];
  if (first === undefined) throw new Error('metaFrom: no site');
  const primary = sites.find((s) => !s.conditional) ?? first;
  const strings = mergedStrings(first.site, resolver);
  const jsonTypes = typesAcross(sites, resolver);
  const { storageType, mixed } = storageTypeFor(jsonTypes);
  return {
    name,
    ...(strings.title === undefined ? {} : { title: strings.title }),
    ...(strings.description === undefined ? {} : { description: strings.description }),
    ...(first.group === undefined ? {} : { group: first.group }),
    ...(strings.role === undefined ? {} : { role: strings.role }),
    ...(strings.unit === undefined ? {} : { unit: strings.unit }),
    ...(strings.universe === undefined ? {} : { universe: strings.universe }),
    ...(strings.derivation === undefined ? {} : { derivation: strings.derivation }),
    ...(strings.comment === undefined ? {} : { comment: strings.comment }),
    required,
    jsonTypes,
    storageType,
    mixed,
    valueSpec: deriveValueSpec(primary.site, resolver),
    conditionals: { asTarget: [], asCondition: [] },
    source: { fileId: first.site.file.fileId, pointer: first.site.pointer },
    ...(declared ? {} : { declared: false as const }),
    declarations: declared
      ? sites.map((s) => ({ fileId: s.site.file.fileId, pointer: s.site.pointer, conditional: s.conditional }))
      : [],
  };
}

/** Whether `owner`'s own `patternProperties` match `name`. */
const ownPatternMatches = (owner: Record<string, unknown>, name: string): boolean =>
  isObject(owner.patternProperties) &&
  Object.keys(owner.patternProperties).some((pattern) => patternMatches(pattern, name));

/**
 * The schemas that apply to an undeclared name, as Ajv applies them: every
 * `patternProperties` entry matching it, and every `additionalProperties`
 * whose own object has no pattern for it; only when none of those evaluates
 * the name, the `unevaluatedProperties` schemas. Boolean entries describe
 * nothing (`true` allows any value, `false` none).
 */
function undeclaredSites(walk: RecordWalk, name: string): WalkOpen[] {
  const describes = (o: WalkOpen): boolean => isObject(o.site.node);
  const evaluating = walk.open.filter(
    (o) =>
      (o.kind === 'pattern' && o.pattern !== undefined && patternMatches(o.pattern, name)) ||
      (o.kind === 'additional' && !ownPatternMatches(o.owner, name)),
  );
  if (evaluating.length > 0) return evaluating.filter(describes);
  return walk.open.filter((o) => o.kind === 'unevaluated' && describes(o));
}

/** A ghost's (or an undeclared column's) meta: from the schemas that apply to it, else unconstrained. */
function undeclaredMeta(
  name: string,
  walk: RecordWalk,
  resolver: RefResolver,
  required: boolean,
  fallbackSource: SchemaSite | undefined,
): ColumnMeta | null {
  const sites = undeclaredSites(walk, name);
  if (sites.length > 0) return metaFrom(name, sites, required, resolver, false);
  if (fallbackSource === undefined) return null;
  const { storageType, mixed } = storageTypeFor(new Set());
  return {
    name,
    required,
    jsonTypes: new Set(),
    storageType,
    mixed,
    valueSpec: { kind: 'opaque' },
    conditionals: { asTarget: [], asCondition: [] },
    source: { fileId: fallbackSource.file.fileId, pointer: fallbackSource.pointer },
    declared: false,
    declarations: [],
  };
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

interface SetWalk {
  walk: RecordWalk;
  resolver: RefResolver;
  analysis: RootAnalysis;
}

function walkSet(set: SchemaSet, rootFileId: string): SetWalk | null {
  const resolver = createRefResolver(set);
  const root = resolver.fileById(rootFileId);
  if (root === undefined) return null;
  const analysis = analyzeRootFile(root, resolver);
  return { walk: walkRecord(walkStarts(analysis), resolver), resolver, analysis };
}

function buildDigest(set: SchemaSet, rootFileId: string): ColumnDigest {
  const walked = walkSet(set, rootFileId);
  const meta: ColumnMeta[] = [];
  const byName = new Map<string, ColumnMeta>();
  if (walked !== null) {
    const { walk, resolver } = walked;

    const grouped = new Map<string, Map<string, WalkDeclaration>>();
    for (const declaration of walk.declarations) {
      let sites = grouped.get(declaration.name);
      if (sites === undefined) {
        sites = new Map();
        grouped.set(declaration.name, sites);
      }
      const key = `${declaration.site.file.fileId}#${declaration.site.pointer}`;
      const seen = sites.get(key);
      // One entry per site; a site met both ways counts as unconditional.
      if (seen === undefined) sites.set(key, declaration);
      else if (seen.conditional && !declaration.conditional) sites.set(key, { ...seen, conditional: false });
    }
    for (const [name, sites] of grouped) {
      const column = metaFrom(name, [...sites.values()], walk.required.has(name), resolver, true);
      meta.push(column);
      byName.set(name, column);
    }
    for (const [name, requiredSite] of walk.required) {
      if (byName.has(name)) continue;
      const ghost = undeclaredMeta(name, walk, resolver, true, requiredSite);
      if (ghost === null) continue;
      meta.push(ghost);
      byName.set(name, ghost);
    }
  }

  const labelFor: SentinelLabelFor = (columnName, value) => {
    const spec = byName.get(columnName)?.valueSpec;
    if (spec === undefined) return undefined;
    return labelledValuesOf(spec).find((s) => s.value === value && s.label !== undefined)?.label;
  };
  const conditionals = extractConditionals(set, rootFileId, labelFor);

  conditionals.forEach((rule, position) => {
    for (const target of rule.targets) {
      const column = byName.get(target.column);
      if (column && !column.conditionals.asTarget.includes(position)) {
        column.conditionals.asTarget.push(position);
      }
    }
    for (const condition of rule.conditions) {
      const column = byName.get(condition.column);
      if (column && !column.conditionals.asCondition.includes(position)) {
        column.conditionals.asCondition.push(position);
      }
    }
  });

  return { meta, conditionals };
}

/** §E.1 entry point: full per-column digest with conditional cross-indexes. */
export function buildColumnMeta(set: SchemaSet, rootFileId: string): ColumnMeta[] {
  return buildDigest(set, rootFileId).meta;
}

const digestCache = new WeakMap<SchemaSet, ColumnDigest | null>();

/** Null while the set has no resolved root or carries fatal load errors. */
const blocked = (set: SchemaSet): boolean =>
  set.root.rootFileId === undefined || set.errors.some((e) => e.severity === 'fatal');

/**
 * Memoized digest accessor shared by the UI and later phases. Null while the
 * set has no resolved root or carries fatal load errors — SchemaSet snapshots
 * are immutable, so the WeakMap entry can never go stale.
 */
export function columnDigest(set: SchemaSet): ColumnDigest | null {
  if (digestCache.has(set)) return digestCache.get(set) ?? null;
  const rootFileId = set.root.rootFileId;
  const digest = blocked(set) || rootFileId === undefined ? null : buildDigest(set, rootFileId);
  digestCache.set(set, digest);
  return digest;
}

const walkCache = new WeakMap<SchemaSet, SetWalk | null>();

function setWalk(set: SchemaSet): SetWalk | null {
  if (walkCache.has(set)) return walkCache.get(set) ?? null;
  const rootFileId = set.root.rootFileId;
  const walked = blocked(set) || rootFileId === undefined ? null : walkSet(set, rootFileId);
  walkCache.set(set, walked);
  return walked;
}

/**
 * The meta of a dataset column that no `properties` declares, from what the
 * record schema says about such columns: every `patternProperties` entry
 * whose pattern matches the name (Ajv's reading: Unicode mode, plain when
 * that does not compile), else a schema-valued `additionalProperties`, else a
 * schema-valued `unevaluatedProperties` — wherever the walk met them. Null
 * when nothing describes it (no such keyword, or only boolean ones), and for
 * a name the digest already holds. `declared: false`, `required: false`.
 */
export function undeclaredColumnMeta(set: SchemaSet, name: string): ColumnMeta | null {
  const walked = setWalk(set);
  if (walked === null) return null;
  if (columnDigest(set)?.meta.some((m) => m.name === name) === true) return null;
  return undeclaredMeta(name, walked.walk, walked.resolver, false, undefined);
}

/** What the record schema makes of a column it does not declare — see `undeclaredColumnVerdict`. */
export type UndeclaredVerdict = 'rejected' | 'allowed' | 'unknown';

/**
 * Whether the record schema rejects a column it does not declare:
 *
 * - `rejected` — an unconditional `additionalProperties: false` or
 *   `unevaluatedProperties: false` leaves the name unevaluated (no matching
 *   `patternProperties`, no other `additionalProperties`), or an
 *   unconditional `propertyNames` rules the name out;
 * - `allowed` — nothing rejects it;
 * - `unknown` — only a conditional schema (an `anyOf` branch, a `then`, a
 *   prefix record's schema) rejects it, or a `propertyNames` too rich to
 *   read statically.
 *
 * A static reading for messages and severities; Ajv stays the judge of each
 * record at run time.
 */
export function undeclaredColumnVerdict(set: SchemaSet, name: string): UndeclaredVerdict {
  const walked = setWalk(set);
  if (walked === null) return 'unknown';
  const { walk, analysis } = walked;
  if (analysis.recordSite === null && analysis.prefixSites.length === 0) {
    return analysis.shape.record === false ? 'unknown' : 'allowed';
  }
  return verdictOf(walk, name);
}

/** Does `node` evaluate `name` as an additional property (a matching pattern, or a non-false `additionalProperties`)? */
function evaluatesAdditional(node: Record<string, unknown>, name: string): boolean {
  if (isObject(node.patternProperties) && Object.keys(node.patternProperties).some((p) => patternMatches(p, name))) {
    return true;
  }
  return Object.hasOwn(node, 'additionalProperties') && node.additionalProperties !== false;
}

function verdictOf(walk: RecordWalk, name: string): UndeclaredVerdict {
  let unknown = false;
  const reject = (conditional: boolean): boolean => {
    if (!conditional) return true;
    unknown = true;
    return false;
  };
  for (const { site, conditional } of walk.nodes) {
    const node = site.node as Record<string, unknown>;
    if (Object.hasOwn(node, 'propertyNames')) {
      const verdict = propertyNameVerdict(node.propertyNames, name);
      if (verdict === 'fail' && reject(conditional)) return 'rejected';
      if (verdict === 'unknown') unknown = true;
    }
    const declaredHere = isObject(node.properties) && Object.hasOwn(node.properties, name);
    const patternHere =
      isObject(node.patternProperties) &&
      Object.keys(node.patternProperties).some((p) => patternMatches(p, name));
    if (declaredHere || patternHere) continue;
    if (node.additionalProperties === false && reject(conditional)) return 'rejected';
    if (node.unevaluatedProperties === false) {
      const evaluators = walk.nodes.filter((n) => evaluatesAdditional(n.site.node as Record<string, unknown>, name));
      if (evaluators.length === 0) {
        if (reject(conditional)) return 'rejected';
      } else if (evaluators.every((n) => n.conditional)) {
        unknown = true;
      }
    }
  }
  return unknown ? 'unknown' : 'allowed';
}

/** Keywords of a `propertyNames` schema that say nothing about a name. */
const NAME_ANNOTATIONS = new Set(['title', 'description', '$comment', 'examples', 'default', '$id', '$schema']);

/** `propertyNames` against one name: `fail` / `pass`, or `unknown` beyond the simple keywords. */
function propertyNameVerdict(schema: unknown, name: string): 'pass' | 'fail' | 'unknown' {
  if (schema === true) return 'pass';
  if (schema === false) return 'fail';
  if (!isObject(schema)) return 'unknown';
  let unknown = false;
  const length = Array.from(name).length;
  for (const [keyword, value] of Object.entries(schema)) {
    switch (keyword) {
      case 'pattern':
        if (typeof value !== 'string') unknown = true;
        else if (!patternMatches(value, name)) return 'fail';
        break;
      case 'minLength':
        if (typeof value === 'number' && length < value) return 'fail';
        break;
      case 'maxLength':
        if (typeof value === 'number' && length > value) return 'fail';
        break;
      case 'const':
        if (value !== name) return 'fail';
        break;
      case 'enum':
        if (Array.isArray(value) && !value.includes(name)) return 'fail';
        break;
      case 'type': {
        const types = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
        if (!types.includes('string')) return 'fail';
        break;
      }
      default:
        if (!NAME_ANNOTATIONS.has(keyword) && !keyword.startsWith('x-')) unknown = true;
    }
  }
  return unknown ? 'unknown' : 'pass';
}

// ---------------------------------------------------------------------------
// Missing variables (§E.3)
// ---------------------------------------------------------------------------

export interface MissingVariable {
  name: string;
  title?: string;
  description?: string;
  group?: string;
  required: boolean;
}

/** §E.3 report-Sheet-2 artifact: required first, then optional, schema order. */
export function missingVariables(
  meta: readonly ColumnMeta[],
  datasetColumns: readonly string[],
): MissingVariable[] {
  const present = new Set(datasetColumns);
  const absent = meta.filter((m) => !present.has(m.name));
  const project = (m: ColumnMeta): MissingVariable => ({
    name: m.name,
    ...(m.title === undefined ? {} : { title: m.title }),
    ...(m.description === undefined ? {} : { description: m.description }),
    ...(m.group === undefined ? {} : { group: m.group }),
    required: m.required,
  });
  return [...absent.filter((m) => m.required), ...absent.filter((m) => !m.required)].map(project);
}
