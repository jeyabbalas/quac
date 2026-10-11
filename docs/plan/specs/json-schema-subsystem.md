# Spec: JSON-Schema Validation Subsystem

> Audience: P06 (loading & root detection), P07 (digests & pertinence), P08 (FlagStore & translator), P09 (validation engine), P14 (integration), P20 (headless in-process validator — §F protocol, §C casting; contract in `headless.md` §3).
> Depends on: `architecture.md` (canonical `__row__`, `quac_raw`/`quac_typed`, QCFlag), `data-table-api.md`.
> Ground truth calibration target: `tests/fixtures/hesp/json_schema/` — 14 files, draft 2020-12, `$id`s under
> `https://schemas.example.org/hesp/...`, root `core/core.schema.json` = `type:"array"`, `items` = `allOf`[12 category
> refs] + **171 if/then blocks** (each with a `required` guard in `if` and a `$comment`), `unevaluatedProperties:false`,
> `uniqueItems`, `minItems:1`; 265 properties, all required; sentinels −666/−777/−888/−999 (+`-6666..-9999` year
> variants; string sentinels `"NA"`/`"REFUSED"`/… for `split_origin_household_id`).

Module root: `src/core/schema/`. All pure logic is node-testable; only the validation worker and DuckDB calls need the browser tier (or `@duckdb/node-api` in node).

```
types.ts            # every interface below
schema-set.ts       # §A file intake, classification, SchemaSet assembly
ref-graph.ts        # §A URI resolution, ref edges, unresolved-ref detection
root-detection.ts   # §A candidate scoring, indexFileId resolution
ajv-engine.ts       # §B Ajv construction, registration, compile-by-pointer
column-meta.ts      # §E per-column digest (ValueSpec, x-*, provenance)
value-spec.ts       # §C+§D ValueSpec derivation + rendering
conditionals.ts     # §D static if/then digest (ConditionalRule[])
casting.ts          # §C CastPlan derivation + SQL generation
row-shaping.ts      # §C DuckDB row → JSON object normalization
translator.ts       # §D Ajv errors → QCFlag[] (pure)
tooltips.ts         # §E ColumnMeta → data-table tooltip content
validation-run.ts   # §F orchestrator (main thread; SQL dataset checks live here)
validation.worker.ts / worker-protocol.ts   # §F Ajv execution off main thread
```

(Shared `src/core/pertinence.ts` implements §E.5; it consumes this subsystem's ColumnMeta plus rules-file target lists.)

---

## A. Schema-set loading and root detection

### A.1 Data model

```ts
interface SchemaFile {
  fileId: string;            // stable within the set: relativePath (uploads) or absolute URL (URL mode)
  relativePath: string;      // uploads: webkitRelativePath minus common root dir; single file: its name;
                             // URLs: path relative to inferred common base, else full URL
  retrievalUri: string;      // canonical base for RFC 3986 resolution:
                             //   uploads: `quac-set:/${relativePath}` ; URLs: fetched URL (post-redirect)
  raw: string;               // original text (droppable after parse for large sets)
  json: unknown;
  declaredId?: string;       // root $id resolved against retrievalUri (absolute, fragment stripped)
  draft: '2020-12' | '2019-09' | 'draft-07' | 'unknown';   // 'unknown' ⇒ treated as 2020-12
  classification: 'schema' | 'non-schema' | 'invalid-json';
  refs: RefEdge[];
}

interface RefEdge {
  fromPointer: string;       // JSON Pointer of the $ref keyword within the file
  refValue: string;
  resolvedUri: string;       // absolute, fragment stripped
  fragment: string | null;   // '#/$defs/yes_no' → '/$defs/yes_no'
  fragmentKind: 'pointer' | 'anchor' | null;
  targetFileId: string | null;   // null ⇒ unresolved
}

interface SchemaSet {
  setId: string;             // SHA-256 over sorted (relativePath, raw) pairs, first 16 hex chars
  origin: 'upload' | 'url';
  files: SchemaFile[];
  schemas: SchemaFile[];     // classification 'schema' + files promoted by being ref targets
  ignored: { fileId: string; reason: 'non-schema' | 'not-json' | 'unsupported-extension' }[];
  idIndex: Map<string, string>;      // declaredId → fileId
  pathIndex: Map<string, string>;    // retrievalUri → fileId
  root: RootDetectionResult;
  errors: SchemaLoadError[];
}

interface RootDetectionResult {
  status: 'auto' | 'auto-preferred' | 'ambiguous' | 'none' | 'error';
  rootFileId?: string;
  candidates: RootCandidate[];       // for the IndexPickerModal
  indexFileId?: string;              // shareable id, §A.4
}
interface RootCandidate { fileId: string; declaredId?: string; title?: string; arrayOfObjects: boolean; inDegree: number; }
```

### A.2 Intake & classification algorithm

1. **Collect.** Uploads: accept `.json` (case-insensitive); everything else → `ignored: unsupported-extension` (drops README.md, .DS_Store silently). Strip the single common leading directory from `webkitRelativePath` — **uploads only**: a URL's first `/`-delimited segment is its scheme, and stripping it ate `http:` out of every message built at intake, which §A.1 relativization (later, and off `fileId`) could no longer repair (UX-10). URLs: fetch (`Accept: application/schema+json, application/json`), record post-redirect URL as `retrievalUri`.
2. **Parse.** `JSON.parse` after UTF-8 BOM strip. Failure → `invalid-json`, error `E_PARSE`.
3. **Classify.** Object with ≥1 own key of {`$schema`, `$id`, `type`, `properties`, `items`, `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `$defs`, `definitions`, `$ref`, `enum`, `required`, `const`} ⇒ schema. HESP `manifest.json` matches none ⇒ non-schema, ignored with info notice. Bare `true`/`false` ⇒ non-schema (cannot be a tabular root; noted). **Referenced-file override:** any ref target is promoted to `schemas`.
   - *Manifest as hint only:* if exactly one non-schema file has an `entrypoints` object whose values match loaded `relativePath`s, remember those fileIds as `manifestHints` — used **only** to order modal candidates, never to auto-select (HESP's manifest names a file that does not exist; hints must tolerate dangling entries).
4. **`$id`/draft extraction.** `declaredId` = root `$id` resolved against `retrievalUri`, fragment stripped. Draft from `$schema` suffix. Build `idIndex`/`pathIndex`; second file declaring an indexed `$id` → fatal `E_DUP_ID` naming both files.
5. **Ref scan.** Deep-walk each schema; record a `RefEdge` at every string-valued `$ref` (and `$dynamicRef`, treated identically for graph purposes). Walk `$ref` siblings too (2020-12 allows them).
6. **Resolve each ref** (the 3 HESP styles fall out of one rule):
   a. `base` = nearest ancestor `$id` in-file (chain implemented for correctness; HESP has none embedded), else `declaredId`, else `retrievalUri`.
   b. `resolvedUri` = `new URL(refValue, base)`, fragment split. Fragment-only refs resolve to the same file — no graph edge.
   c. **Match, in order:** (1) `idIndex[resolvedUri]`; (2) `pathIndex[resolvedUri]`; (3) *retrieval-base fallback*: recompute using `retrievalUri` as base, retry (1)+(2) — covers moved files with stale `$id`s (warning); (4) URL sets only: enqueue fetch of the retrieval-base URI (crawl caps: 64 files, depth 8, http(s) only, **never** for `quac-set:` bases, **never** `$id`-derived URIs — HESP `$id`s at schemas.example.org are non-dereferenceable); (5) unresolved → `E_UNRESOLVED_REF` (file, pointer, refValue, tried URIs).
   d. **Fragment pre-check** (nicer than Ajv's failures): pointer must dereference in target JSON; anchor must exist. Failure → `E_BAD_FRAGMENT`.
7. **Crawl loop** (URL mode): repeat 5–6 until no unresolved fetchable refs or caps hit. Fetch failure → `E_FETCH` with manual-upload fallback copy ("The server may not allow cross-origin access. Download the file and upload it instead.").

### A.3 Root detection

1. `G` = file-level digraph over `schemas` from resolved edges (self/parallel edges collapsed).
2. `C` = in-degree-0 nodes.
3. `arrayOfObjects(f)` = root has `type:"array"` — or a type array containing `"array"`, or no `type` but `items`/`prefixItems` — AND it describes records (an object/`$ref` `items`, a draft-07 tuple `items`, `prefixItems`). A root that is only a `$ref` (or an `allOf` of one) to such a schema, in any file, qualifies through it (`isArrayOfObjectsRoot`, `dataset-shape.ts`). Matches `core.schema.json`.
4. Decide:
   - `|C| = 1` → `auto` (HESP today).
   - `|C| > 1`: `A = {c ∈ C : arrayOfObjects(c)}`; `|A| = 1` → `auto-preferred` + dismissible notice ("Using core.schema.json as the index; X is also unreferenced"). Else → `ambiguous` → **IndexPickerModal** over `C`, ordered: manifest hints, then array-shaped, then by path; rows show `relativePath`, `title`, shape badge, "why ambiguous" note.
   - `|C| = 0`, schemas non-empty (cycle) → `none` → modal over **all** schemas ("These files reference each other in a cycle; choose the entry point.").
   - No schemas → `E_NO_SCHEMAS` (fatal).
5. Post-selection: chosen root must be `arrayOfObjects`; if not, warn but allow; if it describes no records at all (no `items`, `prefixItems` or `$ref` to a schema that has them) → fatal `E_ROOT_NOT_TABULAR`.

### A.3b The dataset shape (`dataset-shape.ts`)

`datasetShape(set)` reads, from the chosen root, which schema each record must satisfy and what the array as a whole must satisfy — so nothing the root says is silently dropped:

| Root (by the root file's draft) | Records |
|---|---|
| 2020-12 | `prefixItems[i]` for record i, `items` for the rest (`false`: no more records) |
| draft-07 / 2019-09 | a tuple `items: [..]` for the first records, `additionalItems` for the rest; an object `items` for all |
| any | `unevaluatedItems` stands in for the rest when nothing else evaluates them |

Whole-array keywords checked: `minItems`, `maxItems`, `uniqueItems` (JSON equality — key order and `1` vs `1.0` do not matter, a missing key and a `null` do), `contains` with `minContains` / `maxContains` (2019-09+; draft-07: at least one). A root that only points elsewhere (`{"$ref": "#/$defs/dataset"}`, or an `allOf` of one) is followed in any file, keywords beside it merged (largest `minItems`, smallest `maxItems`). Anything else that constrains the array — `not`, `if`, an array-level `anyOf`/`oneOf`, `const`/`enum`, a dynamic ref — is listed in `unsupported` and reported as one `schema:dataset:unchecked` warning. The worker compiles each record schema by its `schemaRefUri` (`uri#pointer`, segments URI-encoded) and checks the dataset-wide keywords over every record (§F).

### A.4 `indexFileId` (share-URL contract — consumed by `url-params.md`)

`indexFileId` = first available of **(1)** `declaredId` (stable across upload vs URL delivery — it lives inside the file), **(2)** absolute URL, **(3)** `relativePath`. Share URL param: `index=<encodeURIComponent(indexFileId)>`.

On load with `index=`: resolve by exact `declaredId` → exact `retrievalUri`/URL → exact `relativePath` → unique basename (warning) → no match: show modal anyway + warning "the shared index reference didn't match any loaded file." A matched `index` **always suppresses the modal**, even in `ambiguous`/`none` states. When the user resolves the modal manually, compute `indexFileId` immediately so Share embeds it.

### A.5 Pre-checks & user-facing copy

Run all; report all at once (never stop at first). Fatal set-level errors block validation, not schema browsing.

| Code | Check | Severity | Copy template |
|---|---|---|---|
| `E_PARSE` | JSON.parse fails | fatal (file) | "`{path}` is not valid JSON: {reason} (near position {n})." — `{path}` is the `fileId` (upload display path / retrieval URL), i.e. the same string the card's *Ignored files* line prints, so one file is never named two ways; "(near position {n})" only when the engine gives one; `{reason}` drops V8's own "…, \"snippet\"… is not valid JSON" tail, which would otherwise close the sentence with the clause it opened with (UX-10) |
| `E_DUP_ID` | two files share `$id` | fatal (set) | "Two files declare the same `$id` `{id}`: `{a}` and `{b}`. Each schema file needs a unique `$id`." |
| `E_UNRESOLVED_REF` | ref matches no file post-crawl | fatal (set) | "`{path}` references `{ref}` (at {pointer}), but no loaded file matches. Upload the folder containing `{expectedName}`, or check the reference." |
| `E_BAD_FRAGMENT` | pointer/anchor missing in target | fatal (set) | "`{path}` references `{ref}`, but `{fragment}` does not exist in `{target}`." |
| `E_NO_SCHEMAS` | zero schema files | fatal | "None of the loaded files look like JSON Schemas. QuaC looked for keys like `$schema`, `type`, or `properties`." |
| `E_META` | Ajv `validateSchema` fails | fatal (file) | "`{path}` is not a valid {draft} schema: {first Ajv message} at `{instancePath}`." |
| `E_MIXED_DRAFT` | mixed `$schema` drafts | warning | "Files use different JSON Schema drafts ({list}); QuaC validates using the index file's draft ({draft})." |
| `E_ROOT_NOT_TABULAR` | root describes no records | fatal | "The index schema `{path}` does not describe a table (expected `type: \"array\"` with `items`)." |
| `E_UNSUPPORTED_DRAFT` | draft-04 / draft-03 `$schema` | fatal (file) | names the file and the draft, lists the supported drafts and the upgrade steps (`exclusiveMaximum: true` → a number, `id` → `$id`, …) |
| `E_COMPILE` | the record schema does not compile | fatal | a `pattern` / `patternProperties` name that is no regular expression in either ECMA-262 dialect (file + pointer), or Ajv's own compile failure (an unresolvable ref) — found at LOAD, not as a stage error mid-run |
| `W_UNKNOWN_DRAFT` | a `$schema` QuaC does not know | warning | read as 2020-12 |
| `W_REF_SIBLINGS` | draft-06/07: keywords beside `$ref` | warning | names what those drafts ignore (and QuaC with them) |
| `W_EMPTY_ENUM` | `enum: []` | warning | valid JSON Schema that no value satisfies |
| `W_UNCHECKED_FORMAT` | `format` values QuaC does not check | warning | lists them once (misspellings, vendor formats, OpenAPI's no-op `float`/`double`/`password`/`binary`) |
| `E_FETCH` | URL fetch fails | fatal (file) | CORS-aware copy per `url-params.md §CORS` |

---

## B. Ajv integration

### B.1 Construction (decided config — `ajv-engine.ts`, `keywords.ts`, `formats.ts`, `drafts.ts`)

```ts
function buildAjv(draft: SchemaDraft) {
  // draft-06 and draft-07: the draft-07 class (+ the draft-06 meta-schema); 2019-09; 2020-12 (default)
  const ajv = new Ctor({
    allErrors: true,      // QC needs every failure
    verbose: true,        // errors carry schema/parentSchema/data → translator needs titles, the probe needs identity
    strict: false,        // user schemas carry x-universe/x-unit/x-role/…
    validateSchema: true,
    coerceTypes: false,   // the validator judges the dataset's own values (§C)
    ownProperties: true,  // a column named `constructor` or `toString` is a property, not Object.prototype's
    $data: false,
    logger: false,        // unknown formats are reported once, at load (W_UNCHECKED_FORMAT)
    code: { optimize: 1, regExp: tolerantRegExp },  // Unicode mode, plain ECMA-262 when `u` refuses a pattern
  });
  useExactMultipleOf(ajv);   // decimal multipleOf: 19.99 % 0.01 = 0 (Ajv's float division says otherwise)
  addStandardFormats(ajv);   // RFC 3339 date/time/date-time/duration, uuid, email/idn-email,
                             // hostname/idn-hostname, uri/uri-reference/iri/iri-reference, uri-template, regex …
  return ajv;
}
```

- **Draft routing:** ONE instance per set, class chosen by the **root file's** draft (`readDraft` recognises every spelling of a known meta-schema URI: http/https, with or without `#`); files missing `$schema` read as 2020-12; draft-04/03 refused (`E_UNSUPPORTED_DRAFT`); a custom `$schema` reads as 2020-12 with `W_UNKNOWN_DRAFT`. A file declaring ANOTHER known draft is still registered (validation off) so cross-file refs resolve, and `E_MIXED_DRAFT` says it is read with the root's draft.
- **Prepared documents** (`prepareSchemaForAjv`): what Ajv registers is the user's JSON, except — in a copy — a property literally named `__proto__` (moved to `patternProperties["^__proto__$"]`, which Ajv honours), draft-06/07 keywords beside `$ref` (dropped, as those drafts specify; `W_REF_SIBLINGS`), and `enum: []` (an `allOf` with `false`). The worker prepares each document once and hands the same objects to the translator's probe (§D.3).
- **Formats** are asserted (2020-12 makes that an option; QC wants it), by their standards: RFC 3339 §5.6 (`T`/`t` only, offset `Z` or `±hh:mm`, fractional seconds as text, leap seconds only at 23:59:60 UTC) and Appendix A durations (whole numbers, weeks alone); RFC 4122 `uuid` without a `urn:` prefix; IDNA2008 approximated for `idn-hostname`/`idn-email` (UTS #46 mapping via the URL parser plus CONTEXTJ/CONTEXTO/Bidi rules). ajv-formats' OpenAPI/Ajv extensions stay registered; the no-op ones are named in `W_UNCHECKED_FORMAT`.
- **Load-time compile:** `buildSchemaSet` runs `engineChecks(set)` (the lazy `ajv-engine` chunk — Ajv never enters the entry bundle), compiling every record schema the dataset shape names, so a schema that cannot validate says so at load (`E_COMPILE`); a root picked in the IndexPicker gets the same check.
- **CSP note:** Ajv codegen needs `unsafe-eval`; QuaC ships no blocking CSP, and Ajv lives in the validation worker anyway.

Conformance (JSON-Schema-Test-Suite, required + optional, QuaC's exact construction): draft-07 1848/1856, 2019-09 2287/2309, 2020-12 2278/2353, draft-06 1358/1361. The remainder: `$dynamicRef` edge cases, `unevaluated*` with `if` but no `then`, stack-deep nested-`$id` relative refs, draft-07 `content*` assertion, and the suite's "format is only an annotation by default" checks (QuaC asserts formats by design).

### B.2 Registration & synthetic `$id`s

```ts
for (const f of set.schemas) ajv.addSchema(f.json, f.retrievalUri);
// registered under BOTH the key (retrievalUri) and the schema's own $id (Ajv reads it)
```

Never mutate user JSON. The synthetic identifier is the registration **key**: `quac-set:/` + POSIX-normalized `relativePath` (e.g. `quac-set:/core/categories/income.json`). `new URL('../../common/defs.json', 'quac-set:/core/categories/income.json')` resolves correctly, so relative refs behave identically with or without `$id`s. The same URIs back `pathIndex`, so pre-checks and Ajv can never disagree. Pre-validate every file with `ajv.validateSchema(json)` and collect ALL `E_META` errors before any `addSchema` (which throws on first).

### B.3 Row validator — compile `items` by pointer

```ts
const rootBase = rootFile.declaredId ?? rootFile.retrievalUri;
const validateRow = ajv.getSchema(`${rootBase}#/items`);
```

`getSchema` with a pointer fragment compiles the subschema in place — base URI stays the root file's, so `"$ref": "categories/identification.json"` resolves exactly as in whole-document validation. **`unevaluatedProperties` correctness:** the keyword and all cousin applicators (12 allOf refs + 171 if/thens) live inside the same `items` object, so annotation collection is self-contained; pointer-compiled semantics equal whole-array semantics. Asserted by the P09 smoke test: one extra property ⇒ exactly one `unevaluatedProperties` error through the pointer-compiled function.

Array-level keywords are **NOT** validated by handing Ajv the whole array — at 1M rows that is a multi-GB materialization and an O(n²) `uniqueItems`. The worker validates each record against its record schema (§A.3b: `prefixItems` / tuple positions, then `items` / `additionalItems`), and checks the array-level keywords over all of them: `uniqueItems` by a 64-bit fingerprint of each record's canonical JSON (sorted keys), `contains` by counting matches, `items: false` by counting records past the prefix; `minItems`/`maxItems` are counts (`validation-run.ts`).

### B.4 Execution model — chunked per-row in a dedicated Web Worker (decided)

Rejected: whole-array validation (multi-GB materialization, no progress, O(n²) uniqueItems, error-storm OOM risk) and main-thread chunks (guaranteed jank; the 5,117-line root's compile alone is a visible stall).

```
main thread: validation-run.ts          QC worker: validation.worker.ts
  bridge.query(batch N+1) ──rows──▶       compile once; per batch:
  (single-slot pipeline: fetch of N+1     row-shape → validateRow → translate
   overlaps validation of N)  ◀─flags──   post {flags, counts, timing}
```

Rows cross as `unknown[][]` in the init message's column order (arrays structured-clone several × faster than 5,000 objects × 265 keys) — or, for a JSON dataset, as each record's own text; the worker builds each record (§C.3). Batch default **5,000 rows**; batch SQL uses a **range predicate on `__row__`** (`WHERE __row__ >= a AND __row__ < b`), never `OFFSET`.

---

## C. What the validator reads — the dataset's own values

**Decision (v1.2, superseding v1's "schema-driven SQL casting is primary"): the validator judges the values the dataset holds, as JSON — never DuckDB's casts or DuckDB's reading of them.** JSON Schema judges JSON values; DuckDB is a table engine and a lossy JSON reader for this purpose: `read_json` turns ISO date, time and UUID strings into `DATE`/`TIMESTAMP`/`UUID` (dropping a `Z`, applying an offset, swapping the `T` for a space, lower-casing a UUID), reads a missing key and an explicit `null` as the same `NULL` (top level and inside a struct), and gives a struct every key any record has; `TRY_CAST` reads `yes` as true, `1_000` as 1000 and `' 42 '` as 42. Validating those readings produced false errors on valid data (`2024-01-15T08:30:00+05:30` reported as an invalid date-time) and passed invalid data (an explicit `null` where the schema forbids it; the string `"42"` under `type: integer`). `quac_typed` — the schema's cast — still exists, for the rules engine and the report (§C.5); validation never reads it. Ajv `coerceTypes` stays off.

### C.0 Row sources (`row-source.ts`, `worker-protocol.ts` `RowSourceKind`)

| Dataset | The record the validator judges | Module |
|---|---|---|
| JSON | **the file's own record, exactly** — re-split from the file's bytes at run time (`json-records.ts`), parsed in the worker (`nested-values.ts decodeRecord`): a missing key is missing, an explicit `null` is null, ISO text, UUID case and key names as written | `json-records.ts` |
| Parquet | each value **as JSON writes it**, the types JSON lacks in standard text (§C.2) | `canonical.ts` |
| CSV / TSV / XLSX | each cell's **text, read as the JSON value it spells** where the schema allows that type (§C.1) | `text-cells.ts` |

- **Every dataset column is part of every record** (§C.3) — the schema, not QuaC, decides what an extra column means.
- **Corrected cells** (a correction rule changed them) are read from the corrected `data` instead, in every mode: per batch, `CASE WHEN d.c IS DISTINCT FROM t.c THEN COALESCE(CAST(to_json(d.c) AS VARCHAR), '') END` against `quac_typed` (`''` = corrected to NULL), decoded with the corrected column's plan. The pipeline passes `corrected: true` only when an enabled correction rule runs.
- **Names**: a JSON or Parquet record keeps the names it was written with — a column ingest hygiene renamed (`" padded "` → `padded`, `__meta` → `meta`) reaches the validator under its source name, and its flags name the dataset column. A CSV header is matched as trimmed (hygiene's reading is the CSV convention).
- **A JSON file's own records unavailable** (the bytes are not at hand, or the element count differs from the loaded row count) → the run validates DuckDB's reading (`typed`) and says so in one `schema:dataset:source` warning.
- **JSON column-scope findings** (missing / extra columns) use the keys the records really have — the worker reports them (`keysSeen`) — not DuckDB's column names (DuckDB names a `""` key `C1` and renames a case-colliding `name` to `name_1`).

### C.1 Text cells (`text-cells.ts`)

A cell is the JSON value it spells when the schema allows that value's type (`ColumnMeta.jsonTypes`; empty = anything), and otherwise the text itself:

| Text | Read as | Notes |
|---|---|---|
| JSON's number grammar (RFC 8259 §6): `-12`, `0.5`, `1e5`, `-0` | number | no `+`, no leading zero, a digit on both sides of `.`: `+5`, `007`, `.5`, `5.`, `1,000`, `1_000`, `NaN`, `Infinity` are text. An integral value is an integer (`2.0`). Past ±(2^53 − 1): the nearest double + the precision warning (§C.3), never "not a whole number". Past ±1.8e308: a cast finding |
| `true` / `false` in any letter case | boolean | Excel and Python write `TRUE`, `True`. `yes`, `t`, `1`, `on` are text |
| `[…]` / `{…}` that `JSON.parse` accepts | array / object | strict JSON: `[1,]` is text |
| anything else | string, **exactly as written** | spaces kept |

Spaces around a number, a boolean or JSON text are ignored (JSON ignores them); a string keeps every character. So `42` under `type: integer` is 42, under `type: string` the text `"42"`, and under `["string","integer"]` 42 — while `0042` there is the text `"0042"`. The boolean-or-code pattern (`anyOf: [{type: boolean}, {const: -99}]`) reads `false` as false and `-99` as −99.

When the text spells no value of any allowed type and text itself is not allowed, the cell is a **cast finding** (`schema:prop:<col>:cast`, error), left out of the record, and Ajv's errors at it are dropped (`castKeys` → `TranslateCtx.castFailures`): `'twelve hundred' is not a valid integer.`, `1.5 is not a whole number — this variable takes integer values.`, `'[1, 2' is not valid JSON — this variable takes an array, written as JSON text.`, `'yes' is not a valid true/false value.` A cell of only spaces is text, not a missing value (`'   ' is not a valid integer.`); an empty cell is missing (§C.3).

Excel cells are read as the values they hold, not as the sheet displays them (`ingest/excel.ts`): numbers as their digits (`1234.5`, not `1,234.50`; `0.125`, not `12.5%`), dates as ISO 8601 (`2024-01-15`, `2024-01-15T08:30:00` when the value has a time of day or the format shows one, `08:30:00` for a time), booleans `TRUE`/`FALSE`.

### C.2 Typed values (`canonical.ts`; transports)

A value reaches the validator as JSON writes it; no value is converted to another JSON type first (a number under `type: string` is a `type` finding, as in any JSON Schema validator):

| DuckDB | JSON value |
|---|---|
| BOOLEAN; VARCHAR, ENUM, BIT; integers; DOUBLE; DECIMAL | true/false; a string; a number (DECIMAL and 64/128-bit integers read from their digits) |
| FLOAT | the shortest decimal that is that float (`0.1`, not `0.10000000149011612`) |
| DATE | `2024-01-15` (RFC 3339 full-date); BC dates and `infinity` keep DuckDB's text and fail `format: date` |
| TIME, TIME_NS | `08:30:00.5` — no offset, so RFC 3339 `format: time` rejects it, rightly |
| TIME WITH TIME ZONE | `08:30:00+05:30`, `08:30:00Z` |
| TIMESTAMP, _S, _MS, _NS | `2024-01-15T08:30:00.5` — no offset, so RFC 3339 `date-time` rejects it, rightly |
| TIMESTAMP WITH TIME ZONE | `2024-01-15T03:00:00Z` (the UTC instant; both runtimes run DuckDB in UTC) |
| INTERVAL | ISO 8601 duration: `P1Y2M3DT4H5M6.5S`, `PT0S`; mixed signs have no ISO form and come out signed per component (`P1M-2D`), which no duration format accepts |
| UUID | RFC 4122 lowercase |
| BLOB | base64 (RFC 4648) |
| UNION | the member value (`to_json` writes `{"tag": value}`) |
| VARIANT | its JSON (`CAST(v AS JSON)`) |
| LIST/ARRAY, STRUCT, MAP, JSON | array, object, object (keys in standard text), the JSON value — §C.4 |

Transports (`worker-protocol.ts CellTransport`): `native` (the engine's JS value — VARCHAR, BOOLEAN, integers up to 32 bits, DOUBLE: exact on both runtimes), `number` (`CAST(c AS VARCHAR)` of BIGINT/UBIGINT/HUGEINT/UHUGEINT/DECIMAL/FLOAT — both runtimes hand a 64-bit integer over as a rounded number, which silenced the precision warning), `json` (`CAST(to_json(c) AS VARCHAR)` read with the column's plan, standard text for each leaf). A browser-only caveat: data-table's Parquet loader converts a text column whose values all look like ISO dates or times into `DATE`/`TIMESTAMP`/`TIME` (its `detectTemporalColumns`), so in the browser such a column reaches the validator in the standard text of its converted type (`T` separator, a UTC `Z` dropped where it matched the session zone, trailing fractional zeros dropped); the CLI reads the file's text. JSON files are not affected (§C.0).

### C.3 Null / missing / extra (row shaping, in the worker — `row-shaping.ts`)

| State | Presented to Ajv | Consequence |
|---|---|---|
| JSON record: key missing / explicit `null` | absent / `null` | exactly as JSON Schema reads them: `required` sees a missing key; `type` sees a null |
| CSV/Parquet SQL `NULL` (empty cell) | **absent** (unless the column's `jsonTypes` includes `null` → JSON null) | the text/Parquet convention: an empty cell is a missing value; `required` fires → "value is missing" |
| Column entirely absent from the dataset | absent; its unconditional `required` errors folded into one column-scope flag (`missingRequired`) | one `schema:column:<c>:missing` flag (error when required, info when optional) |
| **Extra column** (no property declares it) | **in the record**, read by the patternProperties / additionalProperties schema that covers it (`undeclaredColumnMeta`), else as text | the schema decides: rejected (`additionalProperties`/`unevaluatedProperties: false`) → ONE column-scope `schema:column:<c>:unexpected` error per run (the engine dedupes, counts once); covered by a schema → checked like any column; allowed by an open schema → one `schema:column:<c>:undescribed` **info** after the run |
| An integer past ±(2^53 − 1) | the nearest double | `schema:prop:<col>:precision` warning, once per column, with the digits — top level and nested |
| NaN / ±Infinity (any spelling DuckDB writes) | absent (or null inside a value) | `schema:prop:<col>:cast` "not a finite number", Ajv errors at those paths dropped |

### C.4 Nested values (LIST, STRUCT, MAP, JSON) — `nested-values.ts`, `core/duckdb-type.ts`, `core/nested-json.ts`

A JSON dataset's nested values are part of its exact records (§C.0) — none of the struct caveats below apply to them. A Parquet dataset's (and a corrected cell's) are read as their `to_json` text with the column's plan:

1. **Types are read whole.** `describeColumns` returns DuckDB's full type text; `core/duckdb-type.ts` reads it into a tree.
2. **Never cast** for the validator; `quac_typed` keeps nested columns untouched (§C.5).
3. **Read as JSON text**, decoded in the worker with the plan (main thread, from the DuckDB type + the property's schema): standard text for every leaf that needs one (§C.2), a UNION's tag dropped, a MAP's timestamp keys in standard text.
4. **STRUCT nulls follow the schema** (Parquet only). DuckDB reads `{}` and `{"x": null}` into the same struct. A NULL field reads as **missing** when the schema does not allow null there, as **null** when it does — §C.3's rule, one level down; a field the object does not admit at all reads as missing when NULL. Parquet has no "missing field" of its own, so nothing is lost.
5. **Non-finite numbers.** `to_json` writes NaN/±Infinity bare (and a JSON cast keeps `nan`, `inf`); the worker reads them as null, emits one cast flag per cell naming every path (`NaN and Infinity are not finite numbers (at readings[2], readings[3]).`), and drops Ajv errors at or below those paths. Text that does not parse at all is a cast finding (`'[1,' could not be read as a JSON value.`), never a stage failure.
6. **Integers past ±(2^53 − 1)** — the precision warning with digits and location (`value at counts[3] exceeds …`); a huge DOUBLE (`1.79e308`) does not count.
7. **Paths in messages** are written as the report grid's value inspector shows them: list items from 1 (`people[2].age`), an array inside a JSON value from 0 (`shifty[0]`), a non-identifier field quoted (`odd_keys["my field"]`), a map entry by key (`labs["ldl"]`). A JSON dataset's paths are numbered by the column's grid type too.

Every other read that shows row values to people — the Excel Data sheet, the Load preview, a rule's finding and its correction before/after, a JS correction's input — reads nested columns the same way (`core/nested-json.ts`).

### C.5 `quac_typed` — the rules' typed columns (`casting.ts`)

For the rules engine (and the report's Data sheet), each schema column — and each column a patternProperties / additionalProperties schema covers — is cast to a storage type derived from its `jsonTypes`:

| `jsonTypes` (minus `null`) | Storage |
|---|---|
| `{integer}` | `BIGINT` (integer ladder: DOUBLE-integrality first, then BIGINT — V19) |
| `{number}` or `{integer,number}` | `DOUBLE` |
| `{string}` | `VARCHAR` |
| `{boolean}` | `BOOLEAN` |
| `{array}`, `{object}` or both | `JSON` (text → `TRY_CAST(raw AS JSON)`) |
| mixed / empty / opaque | `VARCHAR` + `mixed` |
| *(any)* over a nested or JSON raw column | its own type, untouched |
| a column nothing in the schema covers | passthrough |

These casts are DuckDB's (lenient) and serve SQL convenience only: a cell that does not cast is NULL in `quac_typed`, and the validator — which reads the cell itself — reports it.

## D. Error → flag mapping (the translator)

### D.1 Contract

Flags use the canonical `QCFlag` (`architecture.md §5`). `message` is a self-contained sentence **excluding the column name and ruleId** (the annotation column / `flag.column` supply the name; `core/flags/messages.ts` prefixes the ruleId). Determinism: flags per batch sorted by `(row, columnOrdinal, ruleId)`; pure string templating over precomputed digests; `Intl.NumberFormat('en-US')` fixed; sentinels render ASCII (`-666`).

### D.2 Precomputed digests (built once at schema load, §E)

- `ColumnMeta` per column (§E.1) — `valueSpec` (rendered expectation + sentinel value→label map), `title`, `unit`, `universe`, `comment`.
- `ConditionalRule[]` — static digest of root `items.allOf` entries containing `if`:

```ts
interface ConditionalRule {
  index: number;                 // position in items.allOf
  comment?: string;              // the block's $comment
  conditions: { column: string; value: JsonPrimitive }[];   // from if.properties[c].const
  conditionText: string;         // "baseline_record = 1" / "a = 1 and b = 0"
  targets: ConditionalTarget[];
}
interface ConditionalTarget {
  column: string;
  kind: 'const' | 'not-const' | 'not-enum' | 'schema';   // 'schema' = generic fallback
  value?: JsonPrimitive; values?: JsonPrimitive[];
  text: string;   // "must be -666 (Not applicable / structural skip)" |
                  // "must not be -666 (Not applicable) — a substantive or item-missing value is required"
}
```

Extraction: `then.properties` — `const` → kind `const`; `not.const`/`not.enum` → not-kinds; anything else → `schema` with "must satisfy the conditional constraint (see schema)". `else` is digested symmetrically, under the negated condition ("unless kind = 1, b must be 'y'"). The digest feeds tooltips and the root-`allOf` rule ids; the translator words every `if` it meets, wherever it sits, from the `if` subschema itself (§D.3).

### D.3 Translation pipeline (pure, per row — `translator.ts`, `error-tree.ts`, `schema-probe.ts`)

```ts
function translateRowErrors(errors: AjvErrorLike[], row: number, ctx: TranslateCtx,
                            opts?: { locate?: Locate; probe?: SchemaProbe }): QCFlag[]
// ctx: columnMeta, conditionals, missingRequired, castFailures
```

**Errors are a tree.** With `allErrors`, a failing applicator's sub-errors are a CONTIGUOUS block immediately before its own error — `anyOf`, `oneOf`, `if` (`params.failingKeyword` then/else), `contains`, `propertyNames` — and errors inside a `$ref`'d subschema carry the TARGET's schemaPath, so a schemaPath prefix cannot say which applicator they belong to. The **probe** (worker-only; built over the very documents Ajv holds, §B.1) sizes each block exactly by re-validating the value against each branch (or `then`/`else`, the `contains` schema per item, the `propertyNames` schema per name), segmenting a union's block by branch; a block that does not check out (size, instance paths) falls back to the schemaPath reading, which is also the no-probe path. `dependentSchemas` / draft-07 schema-form `dependencies` emit no wrapper: their errors are recognised by location — under the keyword inline, or reachable only through it (`probe.dependentKeys`). Reading is independent of error order.

Rendering, per tree node:
1. **Unions** (`anyOf`/`oneOf`) narrow to one branch only when every branch states an explicit `type` and exactly one admits the value — that branch's errors are reported, nothing of the others'; otherwise ONE flag (the column's ValueSpec at the column itself, the branches' shapes inside a value) silences ONLY that union's own block. A `oneOf` matching more than one branch says so truthfully ("5 matches more than one of the exclusive alternatives (options 1 and 2) — it must match exactly one"). At the record level a union becomes one row flag naming the alternatives ("the record needs at least one of: 'email', 'phone'").
2. **Conditions** anywhere — the record, a property, a `$ref`'d category file, inside a value — word their errors with the condition read off the `if` subschema ("when status = 'closed', …", "unless kind = 1, …", "when 'a' is present, …"); a condition that held because its property is missing says so. A conditional `required` reads "value is missing — this variable is required when …". Root `items.allOf` conditionals keep `schema:cond:<i>:<col>`.
3. **`contains`**: one flag from its params (min and max), no item errors.
4. **`propertyNames`**: one flag per bad name, with the reason from its block; `value` is the name.
5. **Columns**: the first instancePath segment, UNESCAPED (`~1` → `/`, `~0` → `~`); `'/'` is the column named `""`, `''` the record itself. A root `required` / `additionalProperties` / `unevaluatedProperties` / `propertyNames` / `dependentRequired` names its column from params.
6. **Suppression**: a cast finding covers every error AT its cell (and below); a required variable absent from the dataset (`missingRequired`, error-level column flag) covers its UNCONDITIONAL root `required` errors — never a conditional one.
7. **Rejected columns**: a root `additionalProperties` / `unevaluatedProperties` error for key k → column-scope `schema:column:<k>:unexpected` ("Column 'x' is not allowed by the schema (additionalProperties is false)."); the engine keeps one per run and counts it once. A schema-valued additionalProperties / patternProperties check is an ordinary cell error.
8. Everything else → one flag per single-keyword error via the keyword table (§D.6); nothing is ever dropped silently.

Dataset-scope flags (duplicates, `contains`, record counts, empty, pertinence, missing/extra columns) come from the worker's dataset checks and `validation-run.ts`, not this function.

### D.4 ValueSpec rendering (`renderExpectation`)

- `numeric`: `an integer {min}–{max}` (or `a number …`; open ends "at least/at most {x}"), then `, or a missing-value code ({-666 Not applicable, -777 Refused, …})` if sentinels exist; append `(sentinel codes are not valid substantive values)` when the numeric branch carries `not:{enum:[sentinels]}` and the range would otherwise include them.
- `codes`: `one of: {v} {title}; …` (≤8 rendered, then `; … ({n} more — see column tooltip)`), sentinels folded in with labels.
- `string-pattern`: `text matching {pattern}` + `({def title/description})`.
- `string-free`/`boolean`/`opaque`: plain type words; opaque → "a value satisfying the schema at {pointer}".
- Trailer enrichment (all cell templates, fixed order when present): `[Unit: {x-unit}]`, `[Universe: {x-universe}]`, `[Note: {property $comment}]`.

### D.5 Schema ruleId format (grouping key for Sheet 4 tallies)

```
schema:prop:<column>:value        in-cell constraint (collapsed unions, type, range, enum, const, not, pattern, format,
                                  and conditionals outside root items.allOf)
schema:prop:<column>:required     absent cell in a required column (unconditional, or conditional — the message says when)
schema:prop:<column>:cast         a text cell that spells no allowed value; NaN/±Infinity (message differentiates)
schema:prop:<column>:precision    an integer beyond ±(2^53−1) (warning, once per column)
schema:cond:<allOfIndex>:<column> root items.allOf if/then/else violation attributed to the target
schema:row:<keyword>              a record-level finding with no single column (a record-level anyOf/oneOf, minProperties …)
schema:column:<column>:missing    variable absent from the dataset (error when required, info when optional)
schema:column:<column>:unexpected dataset column the schema rejects (additionalProperties / unevaluatedProperties false)
schema:column:<column>:undescribed dataset column the schema allows but does not describe (info)
schema:column:<column>:case-mismatch   near-miss header (warning)
schema:dataset:duplicate-records | min-items | max-items | items | contains | empty | pertinence
schema:dataset:no-overlap         schema and dataset share no column at all (§H edge 20)
schema:dataset:unchecked          root keywords about the whole dataset QuaC does not check (warning)
schema:dataset:source             a JSON file validated from DuckDB's reading, its records unavailable (warning)
schema:advisory:<fileId>          category/root-level $comment soft checks (info, dataset scope)
```

Stable for an unchanged schema set (allOf index is positional — acceptable: ids are within-report provenance, not cross-version keys).

`schema:advisory:<fileId>` repeats the file that its own message already names in short form (`"Schema note ({file}): {text}"`, §D.6), and for URL-loaded sets `fileId` is the retrieval URL — 106 characters in the bundled example. That duplication is resolved **display-side** (`qc-report-spec.md` §1): the Findings panel and the grid popover print the message and carry the id separately. **`fileId` stays the id's basis** — the `relativePath` swap deferred in `phase-14-run-report.md:117-119` is not needed and was not taken, so no spec deviation is spent here and the ids pinned in `tests/fixtures/hesp/data/seeded-violations.json` and `tests/fixtures/synthetic/mini/mini_expected_flags.json` are untouched.

### D.6 Keyword coverage (exactly the HESP inventory + fallback — every row needs a golden test)

| Keyword (≈count in HESP) | Handling | Scope | Template / behavior |
|---|---|---|---|
| `const` (881) | in unions → collapsed; standalone → cell | cell | `must be {v} ({title})` |
| `$ref` (673) | transparent (digests pre-resolve) | — | never surfaces |
| `title` (564) | enrichment | — | display names, code labels |
| `required` (203) | cell vs column split (§C.3) | cell/column | cell: "value is missing…"; column: "Variable '{col}' ({title}) is required by the schema but not present in the dataset." |
| `$comment` (175) | property-level → trailer + tooltip; category/root-level → `schema:advisory:*` info flags | —/dataset | `[Note: …]` / "Schema note ({file}): {text}" |
| `not` (174) | then-blocks → not-kinds; numeric-branch exclusions → ValueSpec | cell | "must not be -666 (Not applicable) — a substantive or item-missing value is required" |
| `if`/`then`/`else` (171) | §D.3.2 — anywhere | cell (target) | "when {cond}, {target text}. Found {v}." / "unless {cond}, …" |
| `type` (169) | collapsed or standalone | cell | `'abc' is a string, not an integer`; `1.5 is a number, not an integer`; `null is not allowed here — expected a string` |
| `minimum`/`maximum` (~150) | collapsed or standalone | cell | `{v} is below the minimum {min}` / `exceeds the maximum {max}` |
| `anyOf` (125) / `oneOf` (57) | collapse drivers (§D.3.1) | cell / row | ValueSpec template; oneOf multi-match → "{v} matches more than one of the exclusive alternatives (options 1 and 2) — it must match exactly one" |
| `enum` (37) | collapsed or standalone | cell | `{v} is not an allowed value — expected one of {list}` (≤8, then "… (n more)") |
| `pattern` (5) | cell | cell | `'{v}' does not match the expected format (pattern {regex} — {def title/description})` |
| `allOf` (5) | wrapper dropped | — | — |
| `uniqueItems` (1) | the worker, by JSON equality of whole records (§B.3) | dataset | "Rows {a} and {b} are identical records — the schema requires all records to be unique." |
| `minItems` (1) / `maxItems` | counts | dataset | "The dataset has {n} records; the schema requires at least {min}." / "… allows at most {max} records." |
| root `contains` / `minContains` / `maxContains` | the worker counts matching records | dataset | "{n} records match the schema's 'contains' condition; it requires at least 1 record to." |
| root `prefixItems` / tuple `items` + `items: false` | per-position record schemas; records past the prefix counted | dataset | "The dataset has {n} records; the schema allows at most {k} records." |
| `items`/`$defs` (1 each) | structural | — | — |
| `unevaluatedProperties` (1) / `additionalProperties` (record level) | Ajv, over records holding every column; one per column per run | column | "Column '{col}' is not allowed by the schema (unevaluatedProperties is false)." |
| `description` (33) | tooltips, missing-vars sheet | — | — |
| `x-unit` (108) / `x-universe` (149) | trailers + tooltips | — | `[Unit: …] [Universe: …]` |
| `x-role` (26) / `x-variable-group` (12) / `x-derivation` (7) | tooltips only | — | — |
| `required` *inside* a value | cell (the column) | cell | `required field '{name}' is missing (at {path}).` — only the row's own `required` (instancePath `''`) means the CELL is missing (§D.3c) |
| `additionalProperties` / `unevaluatedProperties` inside a value | cell | cell | `field '{name}' is not allowed here (at {path}).` |
| `propertyNames` | cell | cell | `field name '{name}' is not allowed (names must match {pattern}).` — the name's own sub-error is folded in |
| `maxItems` / `minItems`, `maxProperties` / `minProperties` | cell | cell | `has {n} items; at most {limit} allowed.` |
| `uniqueItems` (inside a value) | cell | cell | `{path of later} repeats {path of earlier} — items must be unique.` (Ajv's two code paths name the pair in opposite orders; ordered here) |
| `maxLength` / `minLength`, `format`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf`, `contains`, `dependentRequired`, `dependencies`, `false schema`, `not` | cell | cell | plain sentences (`'2024-02-30' is not a valid date (YYYY-MM-DD)`; `'2024-01-15T08:30:00' is not a valid RFC 3339 date-time — it needs a time-zone offset such as Z or +05:30`; `'PT1.5S' is not a valid RFC 3339 duration (P1Y2M3DT4H5M6S — whole numbers only)`); bounds keep every digit |
| `anyOf` / `oneOf` *inside* a value | collapse at that path | cell | `{v} is not valid — expected {branch shapes} (at {path}).` When exactly one branch's declared type admits the value, its own errors are reported instead (`12 exceeds the maximum 9 (at mixed[3].k)`); a `$ref`'d branch never narrows, so HESP's sentinel unions collapse as before |
| **any other keyword** | generic fallback | cell/row | `value fails the '{keyword}' constraint {params-summary} (schema: {schemaPath})` — no error is ever dropped silently |

Values quoted in a message are cut at 80 characters (`flag.value` keeps them whole). An error below the column's own value ends `(at {path})` before its final period (§C.4.7).

### D.7 Golden message examples (all HESP-real; seed the P08 tests verbatim)

1. anyOf collapse (range + sentinels), `wage_income_annual = 75000000`:
   `75000000 exceeds the maximum 50,000,000 — expected an integer 0–50,000,000, or a missing-value code (-666 Not applicable / structural skip, -777 Refused, -888 Don't know / unavailable, -999 Not collected / processing missing). [Unit: currency units per year] [Universe: Households reporting wages, salaries, commissions, and tips.]`
2. anyOf collapse with exclusions, `selfemp_income_annual = -555`:
   `-555 is not valid — expected an integer -5,000,000–50,000,000 (sentinel codes are not valid substantive values), or a missing-value code (-666 …, -777 …, -888 …, -999 …). [Unit: currency units per year]`
3. if/then const, `baseline_record = 1`, `move_reason = 3`:
   `when baseline_record = 1, move_reason must be -666 (Not applicable / structural skip). Found 3. [Schema note: Skip pattern: baseline records have no prior-wave move comparison.]`
4. if/then not-const, `moved_since_last_wave = 1`, `move_reason = -666`:
   `when moved_since_last_wave = 1, move_reason must not be -666 (Not applicable / structural skip) — a substantive or item-missing value is required. [Schema note: Applicability: households that moved must provide a substantive or item-missing move reason, not structural NA.]`
5. pattern, `record_id = 'HH1234_W01'`:
   `'HH1234_W01' does not match the expected format (pattern ^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$ — Household identifier followed by '_W' and a two-digit wave number).`
6. oneOf with string sentinels, `split_origin_household_id = 'HH12'`:
   `'HH12' is not valid — expected a Household identifier ('HH' followed by eight digits), or one of: 'NA' Not applicable / not a split-off household; 'REFUSED' Refused; 'DONT_KNOW' Don't know; 'NOT_COLLECTED' Not collected. [Universe: Split-off households.]`
7. required (cell), empty `partner_age`: `value is missing — this variable is required for every record.`
8. missing column `net_worth`: `Variable 'net_worth' (Net worth) is required by the schema but not present in the dataset.`
9. cast failures: `'twelve hundred' is not a valid integer.` / `412.75 is not a whole number — this variable takes integer values.`
10. dataset duplicate: `Rows 41 and 87 are identical records — the schema requires all records to be unique.`

---

## E. Derived artifacts

### E.1 ColumnMeta — the single per-column digest (powers casting, translation, tooltips, pertinence, report)

```ts
interface ColumnMeta {
  name: string;
  title?: string; description?: string;
  group?: string;                    // x-variable-group (category file root)
  role?: string; unit?: string; universe?: string; derivation?: string;   // x-*
  comment?: string;                  // property-level $comment
  required: boolean;
  jsonTypes: ReadonlySet<'integer'|'number'|'string'|'boolean'|'null'>;
  storageType: ColumnCast['storageType']; mixed: boolean;
  valueSpec: ValueSpec;
  conditionals: { asTarget: number[]; asCondition: number[] };   // indices into ConditionalRule[]
  source: { fileId: string; pointer: string };
}

type ValueSpec =
  | { kind: 'numeric'; numType: 'integer'|'number'; min?: number; max?: number;
      exclusions: Sentinel[]; sentinels: Sentinel[] }
  | { kind: 'codes';   codes: Sentinel[]; sentinels: Sentinel[] }
  | { kind: 'string-pattern'; pattern: string; patternTitle?: string; patternDescription?: string; sentinels: Sentinel[] }
  | { kind: 'string-free' | 'boolean'; sentinels: Sentinel[] }
  | { kind: 'mixed' | 'opaque'; rendered?: string };
interface Sentinel { value: string | number; label?: string; }
```

Built by `buildColumnMeta(set, rootFileId)` — a walk from each record schema the dataset shape names (§A.3b) through every in-place applicator: `$ref` (any file, `$anchor`s included), `allOf`, `anyOf`, `oneOf`, `if`→`then`/`else`, `dependentSchemas`, draft-07 schema-form `dependencies` — never into `not` or an `if` itself. Every `properties` declaration it meets counts, boolean property schemas included (`items: {"$ref": "#/$defs/row"}`, the commonest layout, once yielded NO columns and validated nothing). Per name, in document order (the HESP layout — `items.properties` + `items.allOf` category refs — is unchanged, 265 columns, 171 conditionals): strings (title, unit, …) from the first declaration; `jsonTypes` = what a value can be and still pass every UNCONDITIONAL declaration, alternatives (union branches, then/else) widening only within that; `declarations` lists every site (`{fileId, pointer, conditional}`). `required` = UNCONDITIONALLY required (a `required` reached through `$ref`/`allOf` only — one inside `anyOf`, `then`, `dependentSchemas` … is the translator's, worded with its condition). A name that is unconditionally required but declared nowhere becomes a ghost meta (`declared: false`, unconstrained) so it is reported missing once. Per property: resolve refs, fold `anyOf`/`oneOf` branches — `{type:integer|number, min/max}` → numeric core; `{const, title}` (direct or via sentinel-def `$ref`) → sentinel; oneOf-of-consts → codes; `{type:string, pattern}` → string-pattern; unresolvable/deep → opaque. Sentinel titles come from the referenced def, overridable by sibling `title`.

`undeclaredColumnMeta(set, name)` gives a column no `properties` declares the meta of the record-level `patternProperties` entries matching its name (Ajv's regex reading: Unicode, then plain), else of a schema-valued `additionalProperties` / `unevaluatedProperties` — how such a column's text is read (§C.1) and cast for the rules (§C.5); null when nothing covers it.

### E.2 Column-header tooltips (`tooltips.ts` → `setColumnHeaderTooltip`)

- `title` = `meta.title ?? name`; `description` = `meta.description`.
- `items` (omit empty): `Type`; `Allowed` = `renderExpectation(valueSpec)` (codes as `values:` chips, cap 12 + "+n more"); `Missing-value codes` = sentinels as `"-666 — Not applicable / structural skip"`; `Unit` / `Universe` / `Role` / `Group`; `Conditional rules` = asTarget one-liners ("when {conditionText}, {target.text}"), cap 5 + "+n more"; `Note` = `meta.comment`; `Required` = "yes". The report view also appends a `QC rules` item per column from rules-file targets (`qc-report-spec.md §tooltips`).

### E.3 Missing-variables artifact (report Sheet 2)

`missingVariables(meta[], datasetColumns)` → `{name, title?, description?, group?, required}[]`, required first then optional, schema declaration order. Also emitted as `schema:column:<c>:missing` flags (required → error; optional-declared → info).

### E.4 Per-column rule summaries

`summarizeColumnRules(meta, conditionals): string[]` — expectation string, "required", each conditional-as-target one-liner, property $comment. Reused verbatim by tooltips, the report appendix, and the Studio's column browser.

### E.5 Data-pertinence check (shared `core/pertinence.ts`)

```ts
interface PertinenceResult {
  score: number;                    // matched / max(1, schemaRequired.length || schemaDeclared.length)
  matched: string[]; missingRequired: string[]; missingOptional: string[];
  extra: string[];
  caseMismatches: { dataset: string; schema: string }[];   // NFC+trim+casefold equal, exact unequal
  verdict: 'ok' | 'warn' | 'block';
}
```

- **Matching: exact, case-sensitive only.** Near-misses detected and reported as `schema:column:<c>:case-mismatch` warnings ("Found column 'AGE'; the schema defines 'age'. Rename the column to validate it."). No silent auto-mapping in v1 — the report must reflect the user's actual headers.
- **Thresholds:** denominator = required variables (fallback: all declared). `score < 0.5` → `block`; `0.5 ≤ score < 1` → `warn`; `= 1` → `ok` (extras may still warn). Zero-property universe → `null`, skip; the `schema:dataset:pertinence` info flag for that case is emitted by the engines.
- Rules with missing targets are skipped-with-flag (see `qc-rules-engine.md`); the per-file `Targets: n/m present` line on the Rules slot card is the linter's, and is a different surface from the one below.

#### Three-way cross-check (`crossCheckInputs`)

The Load view holds three artifacts that all claim to describe the same table, so there are **three pairs**, not
one. Each is the same question `computePertinence` answers — what fraction of the names B expects appear in A's
name universe? — so there is no second matching rule:

| Edge | Universe | Expected names |
| --- | --- | --- |
| `data-schema` | `DatasetSession.columns` (the *sanitized* headers) | `columnDigest(set).meta` — required, falling back to all declared |
| `data-rules` | `DatasetSession.columns` | distinct `targetVariables` of `validate`/`correct` rules |
| `schema-rules` | `columnDigest(set).meta[].name` | the same distinct rule targets |

An edge exists only when both its artifacts are loaded and carry names — a zero-column dataset is nothing to
compare against, not a 0% match — so `edges.length` is only ever 0, 1, or 3. The overall verdict is the worst edge
present (`ok` when there is none); the **weakest** edge (lowest score, ties by the order above) is the one the copy
reports.

**Triangulation.** Call an edge *bad* at `score < 0.5`. With all three present, exactly two bad edges always share
exactly one vertex, and that shared artifact is the one both failures run through:

| Bad edges | Suspect |
| --- | --- |
| `data-schema` + `data-rules` | the **dataset** |
| `data-schema` + `schema-rules` | the **JSON Schema** |
| `data-rules` + `schema-rules` | the **QC rules** |

Anything else names nobody: one bad edge is a disagreeing PAIR with no third opinion to break the tie, three bad
edges mean all three inputs are mutually foreign, and fewer than three edges cannot triangulate at all. `warn`-level
edges deliberately do not accuse anyone — 90% coverage is ordinary partial data, not a file from another project.

**Presentation.** One line in the Preview section's head (`previewModel.ts` owns the copy, `previewSection.ts`
renders it), Tier 2 inside the existing sticker, `role="status"`, badge `OK` / `Warning` / `Mismatch`. **There is no
block modal and no override.** Nothing here gates Run QC, so nothing pretends to: the caution is the whole
intervention. Numbers appear only when something is wrong — the per-panel meta lines already carry the counts —
and when it is, the line names the suspect rather than reciting arithmetic.

---

## F. Performance, worker protocol, progress

**Cost model** (HESP worst case 265 cols × 171 conditionals): ~20–60 µs/row compiled → 1M rows ≈ 20–60 s; 100k ≈ 2–6 s; 10k sub-second. One-time: Ajv compile ≈ 150–500 ms (worker shows "compiling schema"); CastPlan CTAS over 1M×265 ≈ 1–4 s; duplicate GROUP BY ALL ≈ 1–2 s.

**Placement:** DuckDB worker (WorkerBridge) does ingest/CTAS/counts and serves each batch's values (raw text, standard-text transports, corrected cells). **QC worker** owns Ajv compile + the record loop + translation + the dataset-wide checks that need every record (duplicates by JSON-equality fingerprint, `contains` counts, records past `items: false`). Main thread orchestrates (`bridge.query` is main-thread API), re-splits a JSON file's records from its bytes, aggregates flags, drives progress; fetch of batch N+1 overlaps validation of batch N (single-slot pipeline, bounded memory). The QC worker is constructed whenever there is at least one record — even with zero overlap (edge 20), since every record carries every dataset column; only the empty dataset (edge 17) returns a hand-built summary.

```ts
// worker-protocol.ts
type MainToWorker =
  | { type:'init'; files: {uri: string; json: unknown}[]; draft: string;
      columnMeta: SerializedColumnMeta[]; conditionals: ConditionalRule[];
      missingRequired: string[];            // absent required columns: their column flag stands for each record's
      mode: 'text' | 'typed' | 'records';   // §C.0
      columns: PresentedColumn[];           // every dataset column: key, jsonTypes, nullAllowed, transport, plans
      checks: DatasetChecks;                // record / prefix schema ids, contains, uniqueItems (dataset-shape.ts)
      config: { flagCap: number } }
  | { type:'batch'; seq: number; rowStart: number;
      rows?: unknown[][];                   // text / typed: one value per column
      records?: string[];                   // records: each record's text
      fixes?: (string | null)[][] }         // corrected cells (§C.0)
  | { type:'flush' } | { type:'abort' };

type WorkerToMain =
  | { type:'ready'; compileMs: number }
  | { type:'batchDone'; seq: number; flags: QCFlag[]; rowsDone: number; rowsWithErrors: number;
      truncated: boolean; elapsedMs: number }
  | { type:'done'; summary: ValidationSummary; datasetFlags: QCFlag[];
      rejectedColumns: string[];            // extra columns the schema rejected (one error each)
      keysSeen?: string[] }                 // records mode: the keys the records really have
  | { type:'fatal'; message: string };

interface ValidationSummary {
  rowsTotal: number; rowsWithErrors: number;   // records with at least one error-severity finding
  flagsEmitted: number; flagsTruncated: boolean;
  countsByRuleId: Record<string, number>;   // ALWAYS exact, even past the cap → Sheet 4 unaffected
  elapsedMs: number; aborted: boolean;
}
```

Progress events to the duck UI: `{phase:'casting'|'compiling'|'validating'|'aggregating', rowsDone, rowsTotal, flagCount, rowsPerSec, etaMs}`, throttled ≤10 Hz. **Abort:** UI → main stops pumping, posts `{type:'abort'}`; worker checks between rows, replies `done{aborted:true}` with partial summary (kept, labeled "partial run"). **Flag cap (default 100,000 materialized schema flags):** past it the worker stops pushing flag objects but keeps `countsByRuleId` exact; report front matter states "showing first 100,000 findings; totals are complete."

---

## G. Test fixtures & scenarios (full list in `testing-strategy.md`)

Synthetic fixtures under `tests/fixtures/synthetic/`:

1. `mini/` — single-file array-of-objects schema, 4 columns: `id` (`pattern ^R[0-9]{3}$`), `age` (`anyOf`[int 18–100, `$ref #/$defs/refused` (-777), `#/$defs/dont_know` (-888)]), `score` (number 0–1), `consent` (`oneOf` 0 No / 1 Yes / -777), one allOf if/then (`consent=0` → `score` const -777) with `$comment`, all required, `unevaluatedProperties:false`, `uniqueItems`; fragment-only refs. + `mini_valid.csv`, `mini_invalid.csv` (one violation of each kind + `'abc'` in age + empty cell + extra column `notes` + a duplicate row) + `mini_expected_flags.json`.
2. `two-roots/{a.schema.json, b.schema.json, shared.defs.json}` — both roots array-shaped → ambiguity.
3. `cycle/{x.json, y.json}` — mutual refs → zero candidates.
4. `no-ids/{root.json, sub/defs.json}` — no `$id`s; relative refs → `quac-set:` synthetic-URI resolution.
5. `draft7/root.schema.json` — draft-07, simple.
6. `mixed/` — mini schema + HESP-style `manifest.json` (entrypoints naming one present + one absent file) + `notes.txt`.
7. **HESP dual-root (assembled in-memory by tests)** — real HESP dir + a synthetic `core/hesp.core.bundle.schema.json` (copy of core with `$id` set to the manifest's standalone entrypoint) → two unreferenced array-shaped roots → modal + manifest-hint ordering. Mirrors the manifest's documented-but-absent bundle.

Key scenario groups (file names in `testing-strategy.md`): root detection (auto/dual/cycle/`index=` resolution), ref graph (3 styles, no-ids, dup-id, bad fragment), ajv-setup (register HESP, pointer compile, unevaluatedProperties smoke, draft-07 routing), column-meta goldens (`wage_income_annual`, `selfemp_income_annual`, `yes_no`, `split_origin_household_id`, `survey_weight`; 265/171 counts), conditionals digest, translator goldens (every §D.6 row), anyOf collapse suppression, conditional attribution, casting (node-DuckDB execution), row shaping, pertinence thresholds, worker end-to-end (browser: mini fixture equality, progress ordering, abort, cap truncation).

---

## H. Phase mapping & edge-case ledger

Master phases: **P06** = §A (loader, ref graph, root detection, pre-checks, IndexPickerModal, slot UX) · **P07** = §E digests + tooltips + missing-vars + shared pertinence · **P08** = §D translator (pure) + golden messages + FlagStore (`core/flags/`) · **P09** = §B + §C + §F (Ajv engine, casting, row shaping, worker, SQL dataset checks) · **P14** = §E.2 wiring + annotations integration.

Edge-case ledger (implementers: keep these as tests or explicit no-ops):

1. UTF-8 BOM in JSON; `.JSON` extensions. 2. Folder uploads with README/manifest/.DS_Store → ignored; manifest = ordering hint only (may name absent files). 3. Same basename in different dirs (relativePath disambiguates; basename `index=` match warns when non-unique). 4. Duplicate `$id` → fatal, both files named. 5. `$id`-base resolution misses but retrieval-base hits → fallback + warning. 6. URL crawl: retrieval-URL relative only; never `$id`-derived hosts; caps 64/depth 8; CORS copy. 7. All-files cycle → modal (iterative graph pass; digest walkers depth-capped). 8. Boolean-schema files; `{"$ref": …}`-only roots; root without items → `E_ROOT_NOT_TABULAR`. 9. `$anchor` pre-check scan; `$dynamicRef` as `$ref` for the graph. 10. Whole-column NULL (per-cell required flags) vs column absent (one column flag). 11. Dedup'd headers (`age_1`) → unexpected; `AGE` → case-mismatch. 12. NaN/±Inf intercepted (would pass min/max silently). 13. BigInt > 2^53 → precision warning. 14. Text cells follow JSON's number grammar (§C.1): `'1e5'`, `' 42 '`, `'42.0'` are integers; `'42.5'`, `'1,5'`, `'+5'`, `'.5'`, `'007'` are not (a cast finding where text is not allowed); leading-zero ids stay text under `type: string`. 15. Error storms bounded (per-row allErrors ≤ a few hundred; global cap + exact counters). 16. Conditional targeting a missing column → no false conditional errors (HESP then-blocks contain no `required`; `if.required` guard skips rows whose condition value is missing — correct: condition not evaluable). 17. Empty dataset → `schema:dataset:empty` + min-items. 18. Mixed drafts; missing `$schema` → 2020-12. 19. Identical re-upload detected via `setId` (skip re-compile); annotations always re-applied from flags keyed by `__row__`, never persisted via data-table. 20. **Zero overlap** — the schema names none of the dataset's columns. Every record still carries every dataset column (§C.3), so the record loop runs: each absent variable is named once at column scope (its per-record `required` errors folded in), the schema's verdict on the unknown columns stands (rejected → one `unexpected` error each; allowed → `undescribed` info), and `schema:dataset:no-overlap` is the one sentence explaining why so little matched. (Before records carried every column, the worker's column list was empty here and `SELECT FROM …` died on DuckDB's parser.) §E.5 reports this as `Mismatch` on the Load view and still does not gate.
