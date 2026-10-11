/**
 * The dataset as JSON Schema describes it: the root schema is the schema of
 * an ARRAY of records, and QuaC validates that array record by record. This
 * module reads, from the root, which schema each record must satisfy and
 * which constraints apply to the array as a whole — so nothing the root says
 * is silently dropped.
 *
 * Record schemas, by draft (the root file's draft, as Ajv is built for it):
 *
 *   2020-12             `prefixItems` for the first records, `items` for the rest
 *   draft-07 / 2019-09  `items: [..]` (a tuple) for the first records,
 *                       `additionalItems` for the rest; `items: {..}` for all
 *
 * `unevaluatedItems` stands in for the rest when nothing else evaluates them
 * (no `items`, no `contains`). The whole-array keywords QuaC checks are
 * `minItems`, `maxItems`, `uniqueItems` and `contains` (with `minContains` /
 * `maxContains` from 2019-09 on); anything else that constrains the array —
 * `not`, `if`, `anyOf`, `oneOf`, `const`, `enum`, a dynamic ref — is listed
 * as unsupported, so the run can say it was not checked.
 *
 * A root that only points elsewhere — `{"$ref": "#/$defs/dataset"}`, or an
 * `allOf` of one such — is followed, in any file. Keywords next to a `$ref`
 * and in the entries of a root `allOf` all apply (JSON Schema reads them as
 * one conjunction), so they are merged: `minItems` takes the largest bound,
 * `maxItems` the smallest, `uniqueItems` either; a record schema given twice
 * cannot be merged and is reported.
 *
 * Pure and node-testable; the SchemaRefs it returns address a subschema the
 * way the validation worker registers files (`ajv.getSchema(schemaRefUri(ref))`).
 */
import { createFileResolver, createRefResolver, escapePointerSegment } from './deref';
import type { RefResolver, SchemaSite } from './deref';
import type { SchemaDraft, SchemaFile, SchemaSet } from './types';

/** A subschema by the URI its file is registered under and its JSON Pointer in that file. */
export interface SchemaRef {
  /** The file's `retrievalUri` — the key the validation worker registers it under. */
  uri: string;
  /** RFC 6901 pointer within the file (`''` = the document). */
  pointer: string;
}

export interface DatasetShape {
  /**
   * The schema every record past the prefix must satisfy: 2020-12 `items`,
   * draft-07 / 2019-09 object `items` or tuple `additionalItems` (or
   * `unevaluatedItems` standing in for them). `false` = no record past the
   * prefix is allowed; `null` = those records are unconstrained.
   */
  record: SchemaRef | false | null;
  /** One schema per leading record: 2020-12 `prefixItems`, or a draft-07 / 2019-09 tuple `items`. */
  prefix: SchemaRef[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  /**
   * How many records must match `schema`: draft-07 says at least one (no
   * maximum); 2019-09 and 2020-12 read `minContains` (default 1, and 0 means
   * `contains` never fails) and `maxContains`.
   */
  contains?: { schema: SchemaRef; min: number; max?: number };
  /** Root keywords that constrain the array and that QuaC does not check. */
  unsupported: string[];
  /** Plain sentences for everything the user must be told — the unsupported keywords among them. */
  warnings: string[];
}

/** `ajv.getSchema` key for a SchemaRef: `uri#pointer`, each pointer segment URI-encoded. */
export function schemaRefUri(ref: SchemaRef): string {
  return `${ref.uri}#${ref.pointer.split('/').map(encodeURIComponent).join('/')}`;
}

/** What the root analysis hands the digest and root detection, beside the shape. */
export interface RootAnalysis {
  shape: DatasetShape;
  /** The record schema's site (object or boolean node); null when `shape.record` is null or false. */
  recordSite: SchemaSite | null;
  prefixSites: SchemaSite[];
  /** The root describes records at all: it has `items` (any form) or `prefixItems`. */
  tabular: boolean;
  /** The root's `type` allows an array (absent counts). */
  arrayTyped: boolean;
  /** Records are described by a schema object: an object `items`/`additionalItems`, or a prefix. */
  objectRecords: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Root keywords that constrain the array and that QuaC reads. */
const ARRAY_KEYWORDS = [
  'type',
  'items',
  'prefixItems',
  'additionalItems',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'unevaluatedItems',
] as const;
type ArrayKeyword = (typeof ARRAY_KEYWORDS)[number];

/**
 * Root keywords that constrain the array as a whole and that QuaC does not
 * check. (Keywords for other types — `properties`, `minLength` — never apply
 * to an array, so they constrain nothing here.)
 */
const UNSUPPORTED_KEYWORDS = ['not', 'anyOf', 'oneOf', 'const', 'enum', '$dynamicRef', '$recursiveRef'];

/** `$ref` / `allOf` merge depth guard (a chain longer than this is a cycle in all but name). */
const MAX_DEPTH = 16;

function child(site: SchemaSite, segments: readonly (string | number)[], node: unknown): SchemaSite {
  const tail = segments
    .map((s) => (typeof s === 'number' ? String(s) : escapePointerSegment(s)))
    .join('/');
  return { file: site.file, pointer: `${site.pointer}/${tail}`, node };
}

const refOf = (site: SchemaSite): SchemaRef => ({ uri: site.file.retrievalUri, pointer: site.pointer });

const nonNegativeInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const keywordList = (keywords: readonly string[]): string =>
  keywords.map((k) => `\`${k}\``).join(', ');

interface Found {
  /** The schema object holding the keyword. */
  owner: SchemaSite;
  value: unknown;
}

/**
 * Analyse the dataset schema rooted at `rootFile`. Never throws; a root that
 * describes no records comes back with `tabular: false` and an empty shape.
 */
export function analyzeRootFile(rootFile: SchemaFile, resolver: RefResolver): RootAnalysis {
  const draft: SchemaDraft = rootFile.draft === 'unknown' ? '2020-12' : rootFile.draft;
  const found = new Map<ArrayKeyword, Found>();
  const extra = new Map<ArrayKeyword, Found[]>();
  const unsupported = new Set<string>();
  const warnings: string[] = [];
  const visiting = new Set<string>();

  const collect = (site: SchemaSite, depth: number): void => {
    const node = site.node;
    if (!isObject(node) || depth > MAX_DEPTH) return;
    const key = `${site.file.fileId}#${site.pointer}`;
    if (visiting.has(key)) return;
    visiting.add(key);
    for (const keyword of ARRAY_KEYWORDS) {
      if (!Object.hasOwn(node, keyword)) continue;
      const entry: Found = { owner: site, value: node[keyword] };
      if (found.has(keyword)) extra.set(keyword, [...(extra.get(keyword) ?? []), entry]);
      else found.set(keyword, entry);
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (Object.hasOwn(node, keyword)) unsupported.add(keyword);
    }
    // `then` / `else` mean nothing without an `if` (and an `if` nothing without them).
    if (Object.hasOwn(node, 'if') && (Object.hasOwn(node, 'then') || Object.hasOwn(node, 'else'))) {
      unsupported.add('if');
    }
    if (typeof node.$ref === 'string') {
      const target = resolver.resolve(site.file, `${site.pointer}/$ref`);
      if (target !== null) collect(target, depth + 1);
    }
    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((entry, i) => {
        collect(child(site, ['allOf', i], entry), depth + 1);
      });
    }
  };

  const root: SchemaSite = { file: rootFile, pointer: '', node: rootFile.json };
  collect(root, 0);

  // ---- Whole-array bounds: every occurrence applies, so take the tightest. ----
  const all = (keyword: ArrayKeyword): Found[] => {
    const first = found.get(keyword);
    return first === undefined ? [] : [first, ...(extra.get(keyword) ?? [])];
  };
  const mins = all('minItems')
    .map((f) => nonNegativeInt(f.value))
    .filter((v): v is number => v !== undefined);
  const maxes = all('maxItems')
    .map((f) => nonNegativeInt(f.value))
    .filter((v): v is number => v !== undefined);
  const unique = all('uniqueItems').some((f) => f.value === true);

  // ---- Record schemas: these cannot be merged when given twice. ----
  const twice = (['items', 'prefixItems', 'additionalItems', 'contains', 'unevaluatedItems'] as const).filter(
    (k) => (extra.get(k)?.length ?? 0) > 0,
  );
  for (const keyword of twice) {
    unsupported.add(keyword);
  }

  const items = found.get('items');
  const prefixItems = found.get('prefixItems');
  const additionalItems = found.get('additionalItems');

  // The tuple form of `items` is draft-07 / 2019-09; a 2020-12 schema using it
  // fails meta-validation first, so reading it as a tuple here is only robustness.
  let prefixFrom: { keyword: 'items' | 'prefixItems'; entry: Found } | null = null;
  let rest: Found | undefined;
  if (items !== undefined && Array.isArray(items.value)) {
    prefixFrom = { keyword: 'items', entry: items };
    rest = draft === '2020-12' ? undefined : additionalItems;
  } else if (draft === '2020-12' && prefixItems !== undefined && Array.isArray(prefixItems.value)) {
    prefixFrom = { keyword: 'prefixItems', entry: prefixItems };
    rest = items;
  } else {
    rest = items;
  }

  const prefixSites: SchemaSite[] = [];
  if (prefixFrom !== null) {
    const { keyword, entry } = prefixFrom;
    (entry.value as unknown[]).forEach((schema, i) => {
      prefixSites.push(child(entry.owner, [keyword, i], schema));
    });
  }

  let restSite: SchemaSite | null = null;
  let restValue: unknown;
  if (rest !== undefined) {
    const keyword = rest === additionalItems ? 'additionalItems' : 'items';
    restSite = child(rest.owner, [keyword], rest.value);
    restValue = rest.value;
  }
  const unevaluated = found.get('unevaluatedItems');
  if (unevaluated !== undefined && draft !== 'draft-07') {
    if (restSite === null && found.get('contains') === undefined) {
      // Nothing else evaluates the records past the prefix: this is their schema.
      restSite = child(unevaluated.owner, ['unevaluatedItems'], unevaluated.value);
      restValue = unevaluated.value;
    } else if (restSite === null) {
      // `contains` evaluates the records it matches, so which records
      // `unevaluatedItems` reaches depends on the data.
      unsupported.add('unevaluatedItems');
    }
    // With `items` (or `additionalItems`) present every record is evaluated:
    // `unevaluatedItems` can never apply, so there is nothing to report.
  }

  let record: SchemaRef | false | null = null;
  let recordSite: SchemaSite | null = null;
  if (restSite !== null) {
    if (restValue === false) {
      record = false;
    } else if (restValue === true || restValue === undefined) {
      record = null;
    } else {
      record = refOf(restSite);
      recordSite = restSite;
    }
  }

  // ---- contains ----
  let contains: DatasetShape['contains'];
  const containsEntry = found.get('contains');
  if (containsEntry !== undefined) {
    const schema = refOf(child(containsEntry.owner, ['contains'], containsEntry.value));
    if (draft === 'draft-07') {
      contains = { schema, min: 1 };
    } else {
      const min = nonNegativeInt(found.get('minContains')?.value) ?? 1;
      const max = nonNegativeInt(found.get('maxContains')?.value);
      contains = { schema, min, ...(max === undefined ? {} : { max }) };
    }
  }

  // ---- type ----
  const typeValue = found.get('type')?.value;
  const typeNames =
    typeof typeValue === 'string'
      ? [typeValue]
      : Array.isArray(typeValue)
        ? typeValue.filter((t): t is string => typeof t === 'string')
        : null;
  const arrayTyped = typeNames === null || typeNames.includes('array');
  if (!arrayTyped) {
    const listed = typeNames.map((t) => `\`${t}\``).join(' or ');
    warnings.push(
      `The schema's root \`type\` is ${listed === '' ? 'empty' : listed}, ` +
        'but a dataset is an array of records: QuaC checks each record against the record schema ' +
        'and ignores the root `type`.',
    );
  }

  for (const keyword of twice) {
    warnings.push(
      `The dataset's \`${keyword}\` is declared in more than one place; QuaC checks only the first.`,
    );
  }
  const notChecked = [...unsupported].filter((k) => !twice.includes(k as (typeof twice)[number]));
  if (notChecked.length > 0) {
    warnings.push(
      `The schema's root ${plural(notChecked.length, 'keyword', 'keywords')} ${keywordList(notChecked)} ` +
        `${plural(notChecked.length, 'constrains', 'constrain')} the dataset as a whole; QuaC checks ` +
        `records one by one and does not check ${plural(notChecked.length, 'it', 'them')}.`,
    );
  }

  const shape: DatasetShape = {
    record,
    prefix: prefixSites.map(refOf),
    ...(mins.length === 0 ? {} : { minItems: Math.max(...mins) }),
    ...(maxes.length === 0 ? {} : { maxItems: Math.min(...maxes) }),
    ...(found.has('uniqueItems') ? { uniqueItems: unique } : {}),
    ...(contains === undefined ? {} : { contains }),
    unsupported: [...unsupported],
    warnings,
  };

  const tabular = prefixSites.length > 0 || restSite !== null;
  const objectRecords = prefixSites.length > 0 || isObject(restValue);
  return { shape, recordSite, prefixSites, tabular, arrayTyped, objectRecords };
}

/** `analyzeRootFile` over a list of files (root detection works before a set exists). */
export function analyzeRoot(files: readonly SchemaFile[], rootFileId: string): RootAnalysis | null {
  const rootFile = files.find((f) => f.fileId === rootFileId);
  if (rootFile === undefined) return null;
  return analyzeRootFile(rootFile, createFileResolver(files));
}

const analysisCache = new WeakMap<SchemaSet, RootAnalysis | null>();

/** The memoized root analysis of a set; null without a resolved root. */
export function rootAnalysis(set: SchemaSet): RootAnalysis | null {
  if (analysisCache.has(set)) return analysisCache.get(set) ?? null;
  const rootFileId = set.root.rootFileId;
  const rootFile =
    rootFileId === undefined ? undefined : set.files.find((f) => f.fileId === rootFileId);
  const analysis = rootFile === undefined ? null : analyzeRootFile(rootFile, createRefResolver(set));
  analysisCache.set(set, analysis);
  return analysis;
}

/**
 * The dataset's shape — the record schemas and the whole-array constraints of
 * the set's root. Null while the set has no resolved root.
 */
export function datasetShape(set: SchemaSet): DatasetShape | null {
  return rootAnalysis(set)?.shape ?? null;
}
