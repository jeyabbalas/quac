/**
 * Data-dictionary projection over a SchemaSet (Load-view Preview panel, UIX-4).
 *
 * The extraction itself belongs to `json-schema-data-dictionary`; this module
 * owns the QuaC-side contract around it — which documents we hand over, which
 * options we pin, the row/category shape the DOM renders, and the search
 * primitives. DOM-free and `src/app`-free, so it is node-testable.
 *
 * The extractor arrives as an INJECTED PORT (`SchemaToTable`), the FetchJson /
 * RuleCodecs idiom: node tests import `schemaDocumentsToTable` statically, the
 * browser hands over a dynamically-imported one. Every package import here is
 * type-only and erased by `verbatimModuleSyntax`, so naming the package in this
 * file costs the entry chunk nothing.
 *
 * DELIBERATE OVERLAP with column-meta.ts: both describe the same variables.
 * `columnDigest` feeds validation (casting, translation, Ajv attribution) and
 * splits missing-value codes from real ones by PROVENANCE (value-spec.ts:333 —
 * a `const` reached through a `$ref`'d def is a sentinel); the package uses a
 * word/number heuristic. What the dictionary adds is category titles and
 * descriptions, `format`, itemized constraints QuaC does not model, open `x-*`
 * passthrough, and a third `measurement` value kind. The row count is pinned
 * equal to `columnDigest`'s in CI (tests/unit/schema/data-dictionary.test.ts)
 * so the two descriptions can never disagree about WHICH variables exist, and
 * `extraLabel` reuses `buildTooltip`'s words where they overlap. Replacing
 * column-meta with the package is out of scope.
 */
import type {
  ConstraintItem,
  DataDictionaryTable,
  JsonSchema,
  JsonValue,
  SchemaDocumentInput,
  SchemaToTableOptions,
  ValidValue,
} from 'json-schema-data-dictionary';
import type { SchemaSet } from './types';

/** The injected extraction port. */
export type SchemaToTable = (
  input: (JsonSchema | SchemaDocumentInput)[],
  options?: SchemaToTableOptions,
) => DataDictionaryTable;

/**
 * Pinned so the dictionary's row count always equals `columnDigest`'s.
 *
 * Both flags default to TRUE in the package. With them on, a schema carrying
 * `patternProperties` or open `additionalProperties` gains pseudo-variable rows
 * (`/regex/`, `…`) that QuaC's digest has no concept of — the dictionary would
 * then print "268 variables" two sections below a pertinence strip printing
 * "265/265" on the same page. Off, HESP produces exactly 265 rows / 12
 * categories, equal to `columnDigest(set).meta.length`.
 */
export const DICTIONARY_OPTIONS: SchemaToTableOptions = {
  includePatternProperties: false,
  includeOpenContentRows: false,
};

export type ValueKind = 'value' | 'measurement' | 'sentinel';

export interface DictionaryValue {
  kind: ValueKind;
  /** null for a `measurement` range — the bounds live in `label`. */
  code: string | null;
  label: string;
  note?: string;
  condition?: string;
}

export interface DictionaryConstraint {
  keyword: string;
  text: string;
  condition?: string;
}

export interface DictionaryExtra {
  label: string;
  text: string;
  /** Arrays/objects: the DOM folds these into a <details> rather than a line. */
  nested: boolean;
}

export interface DictionaryRow {
  name: string;
  /** title\ndescription\n$comment — the DOM renders it `white-space: pre-line`. */
  description: string;
  type: string;
  format: string;
  /** Stably partitioned: substantive first, sentinels last. */
  values: readonly DictionaryValue[];
  /** Index of the first sentinel; === values.length when there are none. */
  sentinelStart: number;
  constraints: readonly DictionaryConstraint[];
  extras: readonly DictionaryExtra[];
  /** Lowercased search corpus, built once (search is per-keystroke). */
  haystack: string;
}

export interface DictionaryCategory {
  title: string;
  slug?: string;
  description?: string;
  rows: readonly DictionaryRow[];
}

export interface DictionaryModel {
  categories: readonly DictionaryCategory[];
  rowCount: number;
  /** Non-fatal extraction notes (unresolved `$ref`s, …). HESP produces none. */
  warnings: readonly string[];
}

/** §E.2's caps, applied per cell; the overflow folds into a <details>. */
export const VALUE_CAP = 12;
export const CONSTRAINT_CAP = 6;
export const EXTRA_CAP = 4;

// ---------------------------------------------------------------------------
// Input mapping
// ---------------------------------------------------------------------------

/**
 * `set.schemas` — the classified-plus-promoted list, NOT `set.files`: ignored
 * non-schema files (a manifest.json, a README) must not reach the extractor.
 * `retrievalUri` is the same canonical base `deref.ts` resolves refs against
 * (`quac-set:/…` for uploads, the fetched URL for URL mode), so relative
 * `$ref`s resolve identically in both origins.
 */
export function toSchemaDocuments(set: SchemaSet): SchemaDocumentInput[] {
  return set.schemas.map((file) => ({
    uri: file.retrievalUri,
    name: file.relativePath,
    schema: file.json as JsonSchema,
  }));
}

/** The root file's retrievalUri — `rootUri` pins extraction to QuaC's root. */
export function rootUriOf(set: SchemaSet): string | undefined {
  const rootFileId = set.root.rootFileId;
  if (rootFileId === undefined) return undefined;
  return set.schemas.find((f) => f.fileId === rootFileId)?.retrievalUri;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const KIND_ORDER: Record<ValueKind, number> = { value: 0, measurement: 0, sentinel: 1 };

function valueKindOf(value: ValidValue): ValueKind {
  return value.kind ?? 'value';
}

/** `-666` / `"HH1"` / `true` → display text; objects/arrays are JSON. */
function renderCode(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toDictionaryValue(value: ValidValue): DictionaryValue {
  const kind = valueKindOf(value);
  // A `measurement` carries `value: null` and puts the range in `label` ("1–20").
  // Rendering the code for one would print a literal "null" beside it.
  const code = kind === 'measurement' || value.value === null ? null : renderCode(value.value);
  return {
    kind,
    code,
    label: value.label ?? '',
    ...(value.description === undefined ? {} : { note: value.description }),
    ...(value.condition === undefined ? {} : { condition: value.condition }),
  };
}

/**
 * Substantive values first, missing-value codes last, order preserved within
 * each group. HESP hands 2 of 265 rows over unpartitioned, and the DOM prints
 * a `Missing-value codes` separator at the boundary — so this cannot be left
 * to input order.
 */
function partitionValues(values: readonly ValidValue[]): {
  values: DictionaryValue[];
  sentinelStart: number;
} {
  const sorted = [...values]
    .map((v, index) => ({ v, index }))
    .sort((a, b) => KIND_ORDER[valueKindOf(a.v)] - KIND_ORDER[valueKindOf(b.v)] || a.index - b.index)
    .map((entry) => toDictionaryValue(entry.v));
  const firstSentinel = sorted.findIndex((v) => v.kind === 'sentinel');
  return { values: sorted, sentinelStart: firstSentinel === -1 ? sorted.length : firstSentinel };
}

function toDictionaryConstraint(item: ConstraintItem): DictionaryConstraint {
  return {
    keyword: item.keyword,
    text: item.text,
    ...(item.condition === undefined ? {} : { condition: item.condition }),
  };
}

/**
 * `x-unit` → `Unit`, `x-universe` → `Universe`, `default` → `Default`. The
 * words are `buildTooltip`'s (tooltips.ts:80-83) for the same facts, so the
 * dictionary and the Report grid's header tooltips read alike.
 */
export function extraLabel(key: string): string {
  const words = key.replace(/^x-/, '').replaceAll(/[-_]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toExtras(info: Record<string, JsonValue> | null): DictionaryExtra[] {
  if (info === null) return [];
  return Object.entries(info).map(([key, value]) => {
    const nested = value !== null && typeof value === 'object';
    return {
      label: extraLabel(key),
      text: nested ? JSON.stringify(value, null, 1) : String(value),
      nested,
    };
  });
}

/**
 * Everything the filter can match, lowercased once at build time: name,
 * description, type, format, every value's code/label/note/condition, every
 * constraint's keyword/text/condition, every extra's RAW key as well as its
 * display label and value (so `x-unit` and `Unit` both hit), and the category
 * title (so `employment` narrows to that category).
 */
function buildHaystack(
  name: string,
  description: string,
  type: string,
  format: string,
  values: readonly DictionaryValue[],
  constraints: readonly DictionaryConstraint[],
  info: Record<string, JsonValue> | null,
  extras: readonly DictionaryExtra[],
  categoryTitle: string,
): string {
  const parts: string[] = [name, description, type, format, categoryTitle];
  for (const value of values) {
    parts.push(value.code ?? '', value.label, value.note ?? '', value.condition ?? '');
  }
  for (const constraint of constraints) {
    parts.push(constraint.keyword, constraint.text, constraint.condition ?? '');
  }
  if (info !== null) parts.push(...Object.keys(info));
  for (const extra of extras) parts.push(extra.label, extra.text);
  return parts.join(' ').toLowerCase();
}

/**
 * SchemaSet → the rendered model. Pure: the extractor is the only moving part
 * and it is handed in.
 */
export function buildDictionaryModel(set: SchemaSet, schemaToTable: SchemaToTable): DictionaryModel {
  const documents = toSchemaDocuments(set);
  // The package throws `schemaDocumentsToTable requires a non-empty array…` on
  // an empty input — a set whose files were all ignored must not reach it.
  if (documents.length === 0) return { categories: [], rowCount: 0, warnings: [] };

  const rootUri = rootUriOf(set);
  const table = schemaToTable(documents, {
    ...DICTIONARY_OPTIONS,
    ...(rootUri === undefined ? {} : { rootUri }),
  });

  const categories = table.categories.map((category) => ({
    title: category.title,
    ...(category.id === '' ? {} : { slug: category.id }),
    ...(category.description === undefined ? {} : { description: category.description }),
    rows: category.rows.map((row) => {
      const { values, sentinelStart } = partitionValues(row['Valid values']);
      const constraints = row.Constraints.map(toDictionaryConstraint);
      const info = row['Additional information'];
      const extras = toExtras(info);
      const name = row['Variable name'];
      const description = row.Description;
      const type = row['Data type'];
      const format = row.Format;
      return {
        name,
        description,
        type,
        format,
        values,
        sentinelStart,
        constraints,
        extras,
        haystack: buildHaystack(
          name,
          description,
          type,
          format,
          values,
          constraints,
          info,
          extras,
          category.title,
        ),
      };
    }),
  }));

  return {
    categories,
    rowCount: categories.reduce((sum, c) => sum + c.rows.length, 0),
    warnings: table.warnings,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Trim, lowercase, split on whitespace. `''` → `[]` (matches everything). */
export function parseQuery(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/**
 * Token-AND substring, case-insensitive. Deliberately not plain substring
 * (`income annual` must find `partner_earnings_annual`) and deliberately not
 * fuzzy/regex (unpredictable for a dictionary filter).
 */
export function rowMatches(row: DictionaryRow, tokens: readonly string[]): boolean {
  return tokens.every((token) => row.haystack.includes(token));
}

/**
 * Split at `cap`, returning BOTH halves — unlike tooltips.ts's `capped`, which
 * drops the tail. A cell folds its overflow into a `<details>`; a dictionary
 * that permanently hides constraint text is not a dictionary.
 */
export function capped<T>(
  items: readonly T[],
  cap: number,
): { shown: readonly T[]; hidden: readonly T[] } {
  if (items.length <= cap) return { shown: items, hidden: [] };
  return { shown: items.slice(0, cap), hidden: items.slice(cap) };
}

// ---------------------------------------------------------------------------
// Memoized accessor
// ---------------------------------------------------------------------------

/**
 * Keyed on SchemaSet IDENTITY, never `setId`: `applyRootSelection`
 * (root-detection.ts:199) returns `{ ...set, root: { ...set.root, rootFileId } }`
 * — a NEW SchemaSet carrying the SAME setId. A setId-keyed cache would serve
 * the dictionary built against the unresolved root forever after the user picks
 * one in the IndexPickerModal. Snapshots are immutable, so an identity key can
 * never go stale (column-meta.ts:175 is the same pattern).
 */
const modelCache = new WeakMap<SchemaSet, Promise<DictionaryModel>>();

let extractorPromise: Promise<SchemaToTable> | null = null;

/**
 * Memoized dynamic import (entry-chunk discipline). The whole package gzips to
 * ~23 KB against 262 KB of headroom, so the size budget is NOT the reason —
 * first paint is: the entry chunk is ~22 KB, and a static import would grow
 * eagerly-loaded JS by ~40-50% to serve a tab most users never open.
 */
function loadExtractor(): Promise<SchemaToTable> {
  extractorPromise ??= import('json-schema-data-dictionary').then((m) => m.schemaDocumentsToTable);
  return extractorPromise;
}

/**
 * The DOM's entry point: a memoized promise per set, or null when there is
 * nothing to browse.
 *
 * Blocks ONLY on "no root / no schemas" — deliberately NOT on any fatal, which
 * is where `columnDigest` blocks. json-schema-subsystem.md §A.5 is explicit:
 * fatal set-level errors block VALIDATION, not schema browsing. A data
 * dictionary is schema browsing, and an `E_ROOT_NOT_TABULAR` object root still
 * produces a perfectly good one-category dictionary. Do not "fix" this to
 * match columnDigest.
 *
 * The promise (not the value) is cached, so two mounts share one computation.
 * A rejected promise stays cached, which is correct: the same set fails the
 * same way.
 */
export function dictionaryModel(set: SchemaSet): Promise<DictionaryModel> | null {
  if (set.root.rootFileId === undefined) return null;
  if (set.schemas.length === 0 || set.errors.some((e) => e.code === 'E_NO_SCHEMAS')) return null;
  let pending = modelCache.get(set);
  if (pending === undefined) {
    pending = loadExtractor().then((schemaToTable) => buildDictionaryModel(set, schemaToTable));
    modelCache.set(set, pending);
  }
  return pending;
}
