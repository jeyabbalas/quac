/**
 * Data-dictionary extraction over a SchemaSet (Load-view Preview panel, UIX-4).
 *
 * The extraction AND the rendering belong to `json-schema-data-dictionary`:
 * since its 0.7.0 the panel is the package's own `<json-data-dictionary>`
 * component — skip patterns you can follow, ranked search, a sticky column
 * header, resizable columns — which replaced the table, search and row
 * projection QuaC used to build itself. This module owns only the QuaC-side
 * contract around the extraction: which documents we hand over, which options
 * we pin, the root the table is pinned to, and the memoized table. DOM-free and
 * `src/app`-free, so it is node-testable.
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
 * passthrough, a third `measurement` value kind, and a row per field inside a
 * nested variable. The top-level row count is pinned equal to `columnDigest`'s
 * in CI (tests/unit/schema/data-dictionary.test.ts) so the two descriptions can
 * never disagree about WHICH variables exist.
 * Replacing column-meta with the package is out of scope.
 */
import type {
  DataDictionaryTable,
  JsonSchema,
  SchemaDocumentInput,
  SchemaToTableOptions,
} from 'json-schema-data-dictionary';
import type { SchemaSet } from './types';

/** The injected extraction port. */
export type SchemaToTable = (
  input: (JsonSchema | SchemaDocumentInput)[],
  options?: SchemaToTableOptions,
) => DataDictionaryTable;

/**
 * Pinned so the dictionary's TOP-LEVEL rows always equal `columnDigest`'s
 * variables.
 *
 * All three flags default to TRUE in the package. With the first two on, a
 * schema carrying `patternProperties` or open `additionalProperties` gains
 * pseudo-variable rows (`/regex/`, `…`) that QuaC's digest has no concept of —
 * the dictionary would then print "268 variables" two sections below a
 * pertinence strip printing "265/265" on the same page.
 *
 * `expandNested` stays ON: an object- or array-valued variable keeps its own
 * row and is followed by one row per field inside it (`address.city`,
 * `visits[].date`), indented, with `__depth` ≥ 1. That is how a reader learns
 * what a nested column holds, and since QuaC validates nested values field by
 * field it is also where a finding like `(at visits[2].date)` points. The
 * dataset still has ONE column for `visits`: those rows are fields, not
 * variables, and `topLevelRows` keeps them out of every variable count. HESP
 * is flat — 265 rows / 12 categories either way.
 */
export const DICTIONARY_OPTIONS: SchemaToTableOptions = {
  includePatternProperties: false,
  includeOpenContentRows: false,
  expandNested: true,
};

/** The rows that are variables — dataset columns — not fields inside one. */
export function topLevelRows(table: DataDictionaryTable): DataDictionaryTable['rows'] {
  return table.rows.filter((row) => (row.__depth ?? 0) === 0);
}

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

/**
 * SchemaSet → the package's table, pinned to QuaC's root with QuaC's options.
 * Pure: the extractor is the only moving part and it is handed in. Null when
 * there is nothing to extract — the package throws `schemaDocumentsToTable
 * requires a non-empty array…` on an empty input, and a set whose files were
 * all ignored must not reach it.
 */
export function buildDictionaryTable(
  set: SchemaSet,
  schemaToTable: SchemaToTable,
): DataDictionaryTable | null {
  const documents = toSchemaDocuments(set);
  if (documents.length === 0) return null;
  const rootUri = rootUriOf(set);
  return schemaToTable(documents, {
    ...DICTIONARY_OPTIONS,
    ...(rootUri === undefined ? {} : { rootUri }),
  });
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
const tableCache = new WeakMap<SchemaSet, Promise<DataDictionaryTable | null>>();

let extractorPromise: Promise<SchemaToTable> | null = null;

/**
 * Memoized dynamic import (entry-chunk discipline). The package serves one
 * Load-view tab most users never open, so it stays out of the entry chunk; the
 * panel's own import of `renderDataDictionary` resolves to the same lazy chunk.
 */
function loadExtractor(): Promise<SchemaToTable> {
  extractorPromise ??= import('json-schema-data-dictionary').then((m) => m.schemaDocumentsToTable);
  return extractorPromise;
}

/**
 * The panel's entry point: a memoized promise of the table per set, or null
 * when there is nothing to browse.
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
export function dictionaryTable(set: SchemaSet): Promise<DataDictionaryTable | null> | null {
  if (set.root.rootFileId === undefined) return null;
  if (set.schemas.length === 0 || set.errors.some((e) => e.code === 'E_NO_SCHEMAS')) return null;
  let pending = tableCache.get(set);
  if (pending === undefined) {
    pending = loadExtractor().then((schemaToTable) => buildDictionaryTable(set, schemaToTable));
    tableCache.set(set, pending);
  }
  return pending;
}
