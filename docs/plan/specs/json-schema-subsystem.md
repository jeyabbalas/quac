# Spec: JSON-Schema Validation Subsystem

> Audience: P06 (loading & root detection), P07 (digests & pertinence), P08 (FlagStore & translator), P09 (validation engine), P14 (integration).
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

1. **Collect.** Uploads: accept `.json` (case-insensitive); everything else → `ignored: unsupported-extension` (drops README.md, .DS_Store silently). Strip the single common leading directory from `webkitRelativePath`. URLs: fetch (`Accept: application/schema+json, application/json`), record post-redirect URL as `retrievalUri`.
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
3. `arrayOfObjects(f)` = root has `type:"array"` (or no `type` but `items`) AND `items` is an object/$ref (not tuple/boolean). Matches `core.schema.json`.
4. Decide:
   - `|C| = 1` → `auto` (HESP today).
   - `|C| > 1`: `A = {c ∈ C : arrayOfObjects(c)}`; `|A| = 1` → `auto-preferred` + dismissible notice ("Using core.schema.json as the index; X is also unreferenced"). Else → `ambiguous` → **IndexPickerModal** over `C`, ordered: manifest hints, then array-shaped, then by path; rows show `relativePath`, `title`, shape badge, "why ambiguous" note.
   - `|C| = 0`, schemas non-empty (cycle) → `none` → modal over **all** schemas ("These files reference each other in a cycle; choose the entry point.").
   - No schemas → `E_NO_SCHEMAS` (fatal).
5. Post-selection: chosen root must be `arrayOfObjects`; if not, warn but allow; if it lacks `items` entirely → fatal `E_ROOT_NOT_TABULAR`.

### A.4 `indexFileId` (share-URL contract — consumed by `url-params.md`)

`indexFileId` = first available of **(1)** `declaredId` (stable across upload vs URL delivery — it lives inside the file), **(2)** absolute URL, **(3)** `relativePath`. Share URL param: `index=<encodeURIComponent(indexFileId)>`.

On load with `index=`: resolve by exact `declaredId` → exact `retrievalUri`/URL → exact `relativePath` → unique basename (warning) → no match: show modal anyway + warning "the shared index reference didn't match any loaded file." A matched `index` **always suppresses the modal**, even in `ambiguous`/`none` states. When the user resolves the modal manually, compute `indexFileId` immediately so Share embeds it.

### A.5 Pre-checks & user-facing copy

Run all; report all at once (never stop at first). Fatal set-level errors block validation, not schema browsing.

| Code | Check | Severity | Copy template |
|---|---|---|---|
| `E_PARSE` | JSON.parse fails | fatal (file) | "`{path}` is not valid JSON: {reason} (near position {n})." |
| `E_DUP_ID` | two files share `$id` | fatal (set) | "Two files declare the same `$id` `{id}`: `{a}` and `{b}`. Each schema file needs a unique `$id`." |
| `E_UNRESOLVED_REF` | ref matches no file post-crawl | fatal (set) | "`{path}` references `{ref}` (at {pointer}), but no loaded file matches. Upload the folder containing `{expectedName}`, or check the reference." |
| `E_BAD_FRAGMENT` | pointer/anchor missing in target | fatal (set) | "`{path}` references `{ref}`, but `{fragment}` does not exist in `{target}`." |
| `E_NO_SCHEMAS` | zero schema files | fatal | "None of the loaded files look like JSON Schemas. QuaC looked for keys like `$schema`, `type`, or `properties`." |
| `E_META` | Ajv `validateSchema` fails | fatal (file) | "`{path}` is not a valid {draft} schema: {first Ajv message} at `{instancePath}`." |
| `E_MIXED_DRAFT` | mixed `$schema` drafts | warning | "Files use different JSON Schema drafts ({list}); QuaC validates using the index file's draft ({draft})." |
| `E_ROOT_NOT_TABULAR` | root lacks `items` | fatal | "The index schema `{path}` does not describe a table (expected `type: \"array\"` with `items`)." |
| `E_FETCH` | URL fetch fails | fatal (file) | CORS-aware copy per `url-params.md §CORS` |

---

## B. Ajv integration

### B.1 Construction (decided config)

```ts
import Ajv2020 from 'ajv/dist/2020';
import Ajv2019 from 'ajv/dist/2019';
import AjvDraft7 from 'ajv';
import addFormats from 'ajv-formats';

function buildAjv(draft: SchemaFile['draft']) {
  const Ctor = draft === 'draft-07' ? AjvDraft7 : draft === '2019-09' ? Ajv2019 : Ajv2020;
  const ajv = new Ctor({
    allErrors: true,      // QC needs every failure
    verbose: true,        // errors carry schema/parentSchema/data → translator needs titles
    strict: false,        // user schemas carry x-universe/x-unit/x-role/… — strict mode would throw
                          //   "unknown keyword"; meta-schema validation still runs (validateSchema: true)
    validateSchema: true,
    coerceTypes: false,   // casting is DuckDB's job (§C); coercion would mask cast findings
    $data: false,
    code: { optimize: 1 },
  });
  addFormats(ajv);        // HESP uses no `format`; generic user schemas commonly do
  return ajv;
}
```

- **Draft routing:** ONE instance per set, class chosen by the **root file's** draft; files missing `$schema` assumed 2020-12; mixed drafts → `E_MIXED_DRAFT` warning (no cross-draft `addMetaSchema` — Ajv documents meta-schemas don't work across drafts).
- **CSP note:** Ajv codegen needs `unsafe-eval`; QuaC ships no blocking CSP, and Ajv lives in the validation worker anyway.

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

Array-level keywords (`uniqueItems`, `minItems`) are **NOT** validated through Ajv — at 1M rows Ajv's deep-equality `uniqueItems` is prohibitive; DuckDB does both as SQL (§D.6 table, `validation-run.ts`).

### B.4 Execution model — chunked per-row in a dedicated Web Worker (decided)

Rejected: whole-array validation (multi-GB materialization, no progress, O(n²) uniqueItems, error-storm OOM risk) and main-thread chunks (guaranteed jank; the 5,117-line root's compile alone is a visible stall).

```
main thread: validation-run.ts          QC worker: validation.worker.ts
  bridge.query(batch N+1) ──rows──▶       compile once; per batch:
  (single-slot pipeline: fetch of N+1     row-shape → validateRow → translate
   overlaps validation of N)  ◀─flags──   post {flags, counts, timing}
```

Rows cross as `unknown[][]` + one-time `columns: string[]` (arrays structured-clone several × faster than 5,000 objects × 265 keys); the worker zips into row objects (needed anyway for null→absent shaping). Batch default **5,000 rows**; batch SQL uses a **range predicate on `__row__`** (`WHERE __row__ >= a AND __row__ < b`), never `OFFSET`.

---

## C. Typing / casting strategy

**Decision: schema-driven SQL casting into `quac_typed` (primary). Ajv `coerceTypes` stays off.** Rationale: a failed cast is itself a QC finding (with the raw value) — `TRY_CAST` gives exactly that; DuckDB casts 1M values orders of magnitude faster than JS; `quac_typed` is the single typed dataset every consumer shares (rules engine, display, report).

### C.1 Column target-type derivation

For each schema property, compute `jsonTypes ⊆ {integer, number, string, boolean, null}` by walking the resolved property schema (cycle-guarded, depth ≤ 12): union over `anyOf`/`oneOf`; intersection over `allOf`; `type` direct; `const`/`enum` contribute `typeof`; `$ref` follows registry; `if`/`then`/`not` contribute nothing (value constraints, not storage). Then:

| `jsonTypes` (minus `null`) | Storage | Notes |
|---|---|---|
| `{integer}` | `BIGINT` | HESP amounts, codes, sentinels |
| `{number}` or `{integer,number}` | `DOUBLE` | weights, ratios |
| `{string}` | `VARCHAR` | ids, dates — leading zeros preserved |
| `{boolean}` | `BOOLEAN` | |
| mixed string+numeric / empty / opaque | `VARCHAR` + `mixed:true` | see row shaping |
| data column absent from schema | `VARCHAR` passthrough | flagged column-scope `unexpected` |

`DECIMAL` never used (Arrow decimal objects complicate row shaping).

```ts
interface ColumnCast { column: string; storageType: 'BIGINT'|'DOUBLE'|'VARCHAR'|'BOOLEAN'; mixed: boolean; castExpr: string; }
interface CastPlan   { columns: ColumnCast[]; sql: string; }   // CREATE TABLE quac_typed AS ...
```

Cast expressions over `quac_raw` (all VARCHAR for delimited inputs; empty CSV fields already NULL under DuckDB's default `nullstr`):

- Integer: `COALESCE(TRY_CAST(raw AS BIGINT), CASE WHEN TRY_CAST(raw AS DOUBLE) IS NOT NULL AND TRY_CAST(raw AS DOUBLE) = trunc(TRY_CAST(raw AS DOUBLE)) THEN CAST(TRY_CAST(raw AS DOUBLE) AS BIGINT) END)` — accepts `'42'`, `' 42 '`, `'42.0'`, `'4.2e1'`; distinguishes `'42.5'` (non-integral) from `'abc'` (non-numeric).
- Number: `TRY_CAST(raw AS DOUBLE)`. Boolean: `TRY_CAST(raw AS BOOLEAN)`. Varchar: passthrough.

`quac_typed` = `CREATE TABLE quac_typed AS SELECT __row__, <cast exprs> FROM quac_raw`. Parquet/JSON inputs load typed: when the loaded DuckDB type already equals the target, passthrough; else the same TRY_CAST ladder via `CAST(col AS VARCHAR)`.

### C.2 Cast failures become flags

One pass per non-passthrough column (raw+typed join or UNPIVOT — implementer's choice), returning `(row, rawValue)` where `raw IS NOT NULL AND trim(raw) <> '' AND typed IS NULL`:

- Non-numeric text → `ruleId: schema:prop:<col>:cast`, error, message `'twelve hundred' is not a valid integer.`
- Numeric-but-non-integral in integer column → same ruleId, message `42.5 is not a whole number — this variable takes integer values.`

Hits land in `castFailures: Set<string>` (`` `${row} ${col}` ``) consulted by the translator: Ajv errors on those cells are **suppressed** so each bad cell yields exactly one flag.

### C.3 Null / empty / missing mapping (row shaping, in the worker)

| Working-table state | Presented to Ajv | Consequence |
|---|---|---|
| SQL `NULL` (empty field, JSON null, cast failure) | property **absent** (unless column's `jsonTypes` includes `null` → JSON null) | `required` fires → "value is missing" |
| Column entirely absent from dataset | absent + in `missingColumns` | one column-scope flag; per-row `required` errors suppressed |
| Extra column (not in schema property universe) | **excluded from row objects** | one column-scope `unexpected` flag (avoids 1M `unevaluatedProperties` errors). Fallback when the property universe isn't statically enumerable (schema uses `patternProperties`/`additionalProperties` — absent in HESP): include extras, translator dedupes per column |
| `BIGINT` → JS `BigInt` | `Number(v)`; if `|v| > 2^53−1`: flag `schema:prop:<col>:precision` warning once per column, present nearest double | Ajv requires `number` |
| `DOUBLE` NaN/±Infinity (Parquet) | absent + cell flag "not a finite number" | NaN would silently PASS min/max — must intercept |
| `mixed:true` VARCHAR | `/^-?(\d+)(\.\d+)?([eE][+-]?\d+)?$/` → number, else string | documented heuristic |

---

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

Extraction: `then.properties` — `const` → kind `const`; `not.const`/`not.enum` → not-kinds; anything else → `schema` with "must satisfy the conditional constraint (see schema)". `else` absent in HESP; when present generically, digest symmetrically with negated `conditionText`.

### D.3 Translation pipeline (pure, per row)

```ts
function translateRowErrors(errors: AjvErrorLike[], row: number, ctx: TranslateCtx): QCFlag[]
// ctx: columnMeta, conditionals, missingColumns, castFailures
```

1. **Drop wrappers:** `keyword === 'if'` and aggregate `allOf` errors.
2. **Bucket by column:** first segment of `instancePath` (`/wage_income_annual` → that column) or `params.missingProperty` for root `required`. Deeper paths attribute to the top segment + append "(at `{innerPath}`)".
3. **Per-bucket priority:**
   a. `(row, column) ∈ castFailures` → emit nothing (cast flag exists).
   b. column ∈ `missingColumns` and error is `required` → emit nothing (column flag exists).
   c. `required` (cell) → `schema:prop:<col>:required`, "value is missing — this variable is required for every record."
   d. **Conditionals:** errors whose `schemaPath` matches `^#\/allOf\/(\d+)\/(then|else)\//` (reliable ONLY for root-inline conditionals — category-file errors arrive under the category's own base via `$ref`, so no false matches). Group by `(allOfIndex, column)` → one flag `schema:cond:<i>:<col>`: `when {conditionText}, {target.text}. Found {render(value)}.` + `[Schema note: {comment}]`.
   e. **anyOf/oneOf collapse:** bucket contains an `anyOf`/`oneOf` error at exactly the column path → emit ONE flag `schema:prop:<col>:value` from the ValueSpec template (§D.4) and **suppress every other non-conditional error in the bucket** (they are branch sub-error noise).
   f. Remaining single-keyword errors → one flag each via the keyword table (§D.6), ruleId `schema:prop:<col>:value` (keyword kept in `meta.keyword`).
4. Row-level leftovers: `unevaluatedProperties` (fallback path only) → dedupe into column-scope `schema:column:<col>:unexpected` (first occurrence wins). Unattributable errors → row-scope flag, generic template.

Dataset-scope flags (duplicates, minItems, empty, pertinence, missing/extra columns) come from `validation-run.ts` SQL, not this function.

### D.4 ValueSpec rendering (`renderExpectation`)

- `numeric`: `an integer {min}–{max}` (or `a number …`; open ends "at least/at most {x}"), then `, or a missing-value code ({-666 Not applicable, -777 Refused, …})` if sentinels exist; append `(sentinel codes are not valid substantive values)` when the numeric branch carries `not:{enum:[sentinels]}` and the range would otherwise include them.
- `codes`: `one of: {v} {title}; …` (≤8 rendered, then `; … ({n} more — see column tooltip)`), sentinels folded in with labels.
- `string-pattern`: `text matching {pattern}` + `({def title/description})`.
- `string-free`/`boolean`/`opaque`: plain type words; opaque → "a value satisfying the schema at {pointer}".
- Trailer enrichment (all cell templates, fixed order when present): `[Unit: {x-unit}]`, `[Universe: {x-universe}]`, `[Note: {property $comment}]`.

### D.5 Schema ruleId format (grouping key for Sheet 4 tallies)

```
schema:prop:<column>:value        in-cell constraint (collapsed unions, type, range, enum, const, not, pattern, format)
schema:prop:<column>:required     null/absent cell in a required column
schema:prop:<column>:cast         TRY_CAST failure (message differentiates subkinds)
schema:prop:<column>:precision    BigInt beyond 2^53 (warning)
schema:cond:<allOfIndex>:<column> if/then violation attributed to the THEN-side target
schema:column:<column>:missing    required variable absent from dataset
schema:column:<column>:unexpected dataset column not in schema
schema:column:<column>:case-mismatch   near-miss header (warning)
schema:dataset:duplicate-records | schema:dataset:min-items | schema:dataset:empty | schema:dataset:pertinence
schema:advisory:<fileId>          category/root-level $comment soft checks (info, dataset scope)
```

Stable for an unchanged schema set (allOf index is positional — acceptable: ids are within-report provenance, not cross-version keys).

### D.6 Keyword coverage (exactly the HESP inventory + fallback — every row needs a golden test)

| Keyword (≈count in HESP) | Handling | Scope | Template / behavior |
|---|---|---|---|
| `const` (881) | in unions → collapsed; standalone → cell | cell | `must be {v} ({title})` |
| `$ref` (673) | transparent (digests pre-resolve) | — | never surfaces |
| `title` (564) | enrichment | — | display names, code labels |
| `required` (203) | cell vs column split (§C.3) | cell/column | cell: "value is missing…"; column: "Variable '{col}' ({title}) is required by the schema but not present in the dataset." |
| `$comment` (175) | property-level → trailer + tooltip; category/root-level → `schema:advisory:*` info flags | —/dataset | `[Note: …]` / "Schema note ({file}): {text}" |
| `not` (174) | then-blocks → not-kinds; numeric-branch exclusions → ValueSpec | cell | "must not be -666 (Not applicable) — a substantive or item-missing value is required" |
| `if`/`then` (171) | §D.3d | cell (then-target) | "when {cond}, {target text}. Found {v}." |
| `type` (169) | collapsed or standalone | cell | `must be {article} {type}, got {typeof v}` (rare post-casting) |
| `minimum`/`maximum` (~150) | collapsed or standalone | cell | `{v} is below the minimum {min}` / `exceeds the maximum {max}` |
| `anyOf` (125) / `oneOf` (57) | collapse drivers | cell | ValueSpec template; oneOf multi-match (`params.passingSchemas`) → same template + "matches more than one exclusive option" |
| `enum` (37) | collapsed or standalone | cell | `{v} is not an allowed value — expected one of {list}` |
| `pattern` (5) | cell | cell | `'{v}' does not match the expected format (pattern {regex} — {def title/description})` |
| `allOf` (5) | wrapper dropped | — | — |
| `uniqueItems` (1) | **DuckDB** (GROUP BY ALL over typed columns) | dataset | "Rows {a} and {b} are identical records — the schema requires all records to be unique." |
| `minItems` (1) | SQL count | dataset | "The dataset has {n} records; the schema requires at least {min}." |
| `items`/`$defs` (1 each) | structural | — | — |
| `unevaluatedProperties` (1) | dataset-side column diff (§C.3); Ajv fallback deduped | column | "Column '{col}' is not defined in the schema, which does not allow unexpected variables." |
| `description` (33) | tooltips, missing-vars sheet | — | — |
| `x-unit` (108) / `x-universe` (149) | trailers + tooltips | — | `[Unit: …] [Universe: …]` |
| `x-role` (26) / `x-variable-group` (12) / `x-derivation` (7) | tooltips only | — | — |
| **any other keyword** | generic fallback | cell/row | `value fails the '{keyword}' constraint {params-summary} (schema: {schemaPath})` — no error is ever dropped silently |

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

Built by `buildColumnMeta(set, rootFileId)`: walk `items.allOf` → per category ref: take `properties` (provenance = that file), union `required`; per property: resolve refs, fold `anyOf`/`oneOf` branches — `{type:integer|number, min/max}` → numeric core; `{const, title}` (direct or via sentinel-def `$ref`) → sentinel; oneOf-of-consts → codes; `{type:string, pattern}` → string-pattern; unresolvable/deep → opaque. Deterministic merge (schema order). Sentinel titles come from the referenced def, overridable by sibling `title`.

### E.2 Column-header tooltips (`tooltips.ts` → `setColumnHeaderTooltip`)

- `title` = `meta.title ?? name`; `description` = `meta.description`.
- `items` (omit empty): `Type`; `Allowed` = `renderExpectation(valueSpec)` (codes as `values:` chips, cap 12 + "+n more"); `Missing-value codes` = sentinels as `"-666 — Not applicable / structural skip"`; `Unit` / `Universe` / `Role` / `Group`; `Conditional rules` = asTarget one-liners ("when {conditionText}, {target.text}"), cap 5 + "+n more"; `Note` = `meta.comment`; `Required` = "yes". The report view also appends a `QC rules` item per column from rules-file targets (`qc-report-spec.md §tooltips`).

### E.3 Missing-variables artifact (report Sheet 2)

`missingVariables(meta[], datasetColumns)` → `{name, title?, description?, group?, required}[]`, required first then optional, schema declaration order. Also emitted as `schema:column:<c>:missing` flags (required → error; optional-declared → info).

### E.4 Per-column rule summaries

`summarizeColumnRules(meta, conditionals): string[]` — expectation string, "required", each conditional-as-target one-liner, property $comment. Reused verbatim by tooltips, the report appendix, and the Studio's column browser.

### E.5 Data-pertinence check (shared `core/pertinence.ts`; runs when data + schema/rules resolve)

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
- **Thresholds:** denominator = required variables (fallback: all declared). `score < 0.5` → `block` modal ("This dataset doesn't look like it matches the schema — {m} of {n} expected variables found (e.g., missing {first 5}…). Load a different file, or continue anyway." — Continue downgrades to warn). `0.5 ≤ score < 1` → warn banner. `= 1` → ok (extras may still warn). `= 0` → block with stronger copy. Zero-property schema → skip, emit `schema:dataset:pertinence` info.
- Rules-file pertinence (targets ∩ columns) is computed by the same module; rules with missing targets are skipped-with-flag (see `qc-rules-engine.md`).

---

## F. Performance, worker protocol, progress

**Cost model** (HESP worst case 265 cols × 171 conditionals): ~20–60 µs/row compiled → 1M rows ≈ 20–60 s; 100k ≈ 2–6 s; 10k sub-second. One-time: Ajv compile ≈ 150–500 ms (worker shows "compiling schema"); CastPlan CTAS over 1M×265 ≈ 1–4 s; duplicate GROUP BY ALL ≈ 1–2 s.

**Placement:** DuckDB worker (WorkerBridge) does ingest/CTAS/cast-scans/duplicates/counts. **QC worker** owns Ajv compile + row loop + translation. Main thread orchestrates (`bridge.query` is main-thread API), aggregates flags, drives progress; fetch of batch N+1 overlaps validation of batch N (single-slot pipeline, bounded memory).

```ts
// worker-protocol.ts
type MainToWorker =
  | { type:'init'; files: {uri: string; json: unknown}[]; rootBase: string; draft: string;
      columnMeta: SerializedColumnMeta[]; conditionals: ConditionalRule[];
      missingColumns: string[]; castFailures: string[]; config: { flagCap: number } }
  | { type:'batch'; seq: number; rowStart: number; columns?: string[]; rows: unknown[][] }
  | { type:'flush' } | { type:'abort' };

type WorkerToMain =
  | { type:'ready'; compileMs: number }
  | { type:'batchDone'; seq: number; flags: QCFlag[]; rowsDone: number; rowsWithErrors: number;
      truncated: boolean; elapsedMs: number }
  | { type:'done'; summary: ValidationSummary }
  | { type:'fatal'; message: string };

interface ValidationSummary {
  rowsTotal: number; rowsWithErrors: number; flagsEmitted: number; flagsTruncated: boolean;
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

1. UTF-8 BOM in JSON; `.JSON` extensions. 2. Folder uploads with README/manifest/.DS_Store → ignored; manifest = ordering hint only (may name absent files). 3. Same basename in different dirs (relativePath disambiguates; basename `index=` match warns when non-unique). 4. Duplicate `$id` → fatal, both files named. 5. `$id`-base resolution misses but retrieval-base hits → fallback + warning. 6. URL crawl: retrieval-URL relative only; never `$id`-derived hosts; caps 64/depth 8; CORS copy. 7. All-files cycle → modal (iterative graph pass; digest walkers depth-capped). 8. Boolean-schema files; `{"$ref": …}`-only roots; root without items → `E_ROOT_NOT_TABULAR`. 9. `$anchor` pre-check scan; `$dynamicRef` as `$ref` for the graph. 10. Whole-column NULL (per-cell required flags) vs column absent (one column flag). 11. Dedup'd headers (`age_1`) → unexpected; `AGE` → case-mismatch. 12. NaN/±Inf intercepted (would pass min/max silently). 13. BigInt > 2^53 → precision warning. 14. `'1e5'`, `' 42 '`, `'42.0'` accepted for integers; `'42.5'`, `'1,5'` are cast findings; leading-zero ids safe (pattern columns are VARCHAR). 15. Error storms bounded (per-row allErrors ≤ a few hundred; global cap + exact counters). 16. Conditional targeting a missing column → no false conditional errors (HESP then-blocks contain no `required`; `if.required` guard skips rows whose condition value is missing — correct: condition not evaluable). 17. Empty dataset → `schema:dataset:empty` + min-items. 18. Mixed drafts; missing `$schema` → 2020-12. 19. Identical re-upload detected via `setId` (skip re-compile); annotations always re-applied from flags keyed by `__row__`, never persisted via data-table.
