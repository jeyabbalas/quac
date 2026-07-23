/**
 * ColumnMeta — the single per-column digest (json-schema-subsystem.md §E.1).
 * Powers casting (P09), translation (P08), tooltips, pertinence, and the
 * report. Built once per SchemaSet by walking root `items.allOf` category
 * refs in schema order; deterministic merge, pure, node-testable.
 */
import { createRefResolver, escapePointerSegment } from './deref';
import type { RefResolver, SchemaSite } from './deref';
import { extractConditionals } from './conditionals';
import type { ConditionalRule, SentinelLabelFor } from './conditionals';
import { deriveJsonTypes, deriveValueSpec, storageTypeFor } from './value-spec';
import type { JsonTypeName, StorageType, ValueSpec } from './value-spec';
import type { SchemaSet } from './types';

export interface ColumnMeta {
  name: string;
  title?: string;
  description?: string;
  /** x-variable-group (category file root). */
  group?: string;
  role?: string;
  unit?: string;
  universe?: string;
  derivation?: string;
  /** Property-level $comment. */
  comment?: string;
  required: boolean;
  jsonTypes: ReadonlySet<JsonTypeName>;
  storageType: StorageType;
  mixed: boolean;
  valueSpec: ValueSpec;
  /** Indices into the digest's ConditionalRule[] (array positions). */
  conditionals: { asTarget: number[]; asCondition: number[] };
  source: { fileId: string; pointer: string };
}

export interface ColumnDigest {
  meta: ColumnMeta[];
  conditionals: ConditionalRule[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Property node + one level of `$ref` target, sibling keywords winning. */
function mergedStrings(
  propNode: Record<string, unknown>,
  propSite: SchemaSite,
  resolver: RefResolver,
): Record<'title' | 'description' | 'comment' | 'role' | 'unit' | 'universe' | 'derivation', string | undefined> {
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

function buildDigest(set: SchemaSet, rootFileId: string): ColumnDigest {
  const resolver = createRefResolver(set);
  const root = resolver.fileById(rootFileId);
  const meta: ColumnMeta[] = [];
  const byName = new Map<string, ColumnMeta>();

  const rootJson = root?.json;
  const items = root !== undefined && isObject(rootJson) && isObject(rootJson.items) ? rootJson.items : undefined;
  const allOf = items !== undefined && Array.isArray(items.allOf) ? items.allOf : [];

  /** One property-bearing schema object: a category file root, an inline allOf entry, or `items` itself. */
  const addCategory = (category: SchemaSite): void => {
    const categoryNode = category.node;
    if (!isObject(categoryNode)) return;
    const properties = categoryNode.properties;
    if (!isObject(properties)) return;
    const group = str(categoryNode['x-variable-group']);
    const required = new Set(
      Array.isArray(categoryNode.required) ? categoryNode.required.filter((r): r is string => typeof r === 'string') : [],
    );

    for (const [name, propNode] of Object.entries(properties)) {
      if (!isObject(propNode) || byName.has(name)) continue;
      const pointer = `${category.pointer}/properties/${escapePointerSegment(name)}`;
      const propSite: SchemaSite = { file: category.file, pointer, node: propNode };
      const strings = mergedStrings(propNode, propSite, resolver);
      const jsonTypes = deriveJsonTypes(propSite, resolver);
      const { storageType, mixed } = storageTypeFor(jsonTypes);
      const column: ColumnMeta = {
        name,
        ...(strings.title === undefined ? {} : { title: strings.title }),
        ...(strings.description === undefined ? {} : { description: strings.description }),
        ...(group === undefined ? {} : { group }),
        ...(strings.role === undefined ? {} : { role: strings.role }),
        ...(strings.unit === undefined ? {} : { unit: strings.unit }),
        ...(strings.universe === undefined ? {} : { universe: strings.universe }),
        ...(strings.derivation === undefined ? {} : { derivation: strings.derivation }),
        ...(strings.comment === undefined ? {} : { comment: strings.comment }),
        required: required.has(name),
        jsonTypes,
        storageType,
        mixed,
        valueSpec: deriveValueSpec(propSite, resolver),
        conditionals: { asTarget: [], asCondition: [] },
        source: { fileId: category.file.fileId, pointer },
      };
      meta.push(column);
      byName.set(name, column);
    }
  };

  // Generic schemas declare properties directly on `items` (mini, tiny);
  // HESP-style schemas hold them behind category refs in `items.allOf`.
  if (root !== undefined && items !== undefined) {
    addCategory({ file: root, pointer: '/items', node: items });
  }
  allOf.forEach((entry, i) => {
    if (root === undefined || !isObject(entry)) return;
    if (typeof entry.$ref === 'string') {
      const category = resolver.resolve(root, `/items/allOf/${String(i)}/$ref`);
      if (category !== null) addCategory(category);
      return;
    }
    // Inline allOf entries with `properties` count too; if/then blocks have
    // none at the top level and fall through harmlessly.
    if (!isObject(entry.if)) {
      addCategory({ file: root, pointer: `/items/allOf/${String(i)}`, node: entry });
    }
  });

  const labelFor: SentinelLabelFor = (columnName, value) => {
    const spec = byName.get(columnName)?.valueSpec;
    if (spec === undefined || spec.kind === 'mixed' || spec.kind === 'opaque') return undefined;
    const pools = spec.kind === 'codes' ? [spec.codes, spec.sentinels] : [spec.sentinels];
    for (const pool of pools) {
      const hit = pool.find((s) => s.value === value);
      if (hit?.label !== undefined) return hit.label;
    }
    return undefined;
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

/**
 * Memoized digest accessor shared by the UI and later phases. Null while the
 * set has no resolved root or carries fatal load errors — SchemaSet snapshots
 * are immutable, so the WeakMap entry can never go stale.
 */
export function columnDigest(set: SchemaSet): ColumnDigest | null {
  if (digestCache.has(set)) return digestCache.get(set) ?? null;
  const rootFileId = set.root.rootFileId;
  const blocked = rootFileId === undefined || set.errors.some((e) => e.severity === 'fatal');
  const digest = blocked ? null : buildDigest(set, rootFileId);
  digestCache.set(set, digest);
  return digest;
}

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
