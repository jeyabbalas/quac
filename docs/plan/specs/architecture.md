# Spec: Architecture

> Audience: every phase. Read this before any other spec. Canonical names defined here override anything else.

## 1. Stack (locked, user-confirmed)

- **Vanilla TypeScript + Vite**, no UI framework. Core engine (`src/core/**`) is framework-free and DOM-free (node-testable); the UI layer is direct DOM construction + a tiny signals module. If templating ever hurts, the sanctioned fallback is a tagged-template `html()` helper — never a framework.
- **Plain CSS + design tokens** (`--quac-*`), mirroring data-table's `--dt-*` idiom. See `ui-design.md`.
- **One DuckDB** for everything, via `@jeyabbalas/data-table`'s `WorkerBridge` (see `data-table-api.md`). WASM **self-hosted** at build time.
- Libraries (verified July 2026): Ajv 8 (`Ajv2020`), SheetJS CE (read xlsx), exceljs (write xlsx, lazy), PapaParse, CodeMirror 6 (`@codemirror/lang-sql` PostgreSQL dialect + `@codemirror/lint`), `quickjs-emscripten` (JS rule sandbox, lazy), Vitest 4 (node + browser via `@vitest/browser-playwright`), `@duckdb/node-api` (test-only SQL parity), Playwright.
- Deploy: GitHub Pages, `base: '/quac/'`, target `https://jeyabbalas.github.io/quac/`.

## 2. Source tree

```
src/
  main.ts                     # boot: parse hash config → mount shell → route
  app/                        # thin UI-app layer (DOM allowed)
    shell.ts                  # header banner, nav tabs, layout regions, footer
    router.ts                 # hash router: #/load | #/report | #/studio (+ config params, see url-params.md)
    signals.ts                # signal<T>() / computed() / effect()  (~60 LOC, zero deps)
    store.ts                  # AppState: slots, pipeline, run summary, shareables
    errors.ts                 # QuacError{code,userMessage,hint,cause} + reportError()
    toast.ts  modal.ts        # shared primitives (focus trap, ARIA)
  core/                       # framework-free; no document/window except bridge/ + lazy loaders
    bridge/
      bridge.ts               # getBridge(): lazy singleton WorkerBridge; terminate on unload
      harden.ts               # SET enable_external_access=false + lock_configuration sequencing
      tables.ts               # table-name registry + lifecycle helpers (CTAS swap, COPY, clearQueryCache)
    ingest/                   # see ingestion.md
      sniff.ts csv.ts tsv.ts excel.ts json.ts parquet.ts ingest.ts guardrails.ts
    schema/                   # see json-schema-subsystem.md
      types.ts schema-set.ts ref-graph.ts root-detection.ts ajv-engine.ts column-meta.ts
      value-spec.ts conditionals.ts casting.ts row-shaping.ts translator.ts tooltips.ts
      validation-run.ts validation.worker.ts worker-protocol.ts
    rules/                    # see qc-rules-format.md + qc-rules-engine.md
      types.ts parse.ts serialize.ts lint.ts assertions.ts sql.ts engine.ts sandbox.ts
    flags/
      flag.ts                 # canonical QCFlag type (§5)
      flagStore.ts            # dedupe, indexes, aggregates, caps
      messages.ts             # rendering: "{ruleId}: {message}" (+ correction suffix)
    pertinence.ts             # shared data↔schema/rules coverage check (thresholds in json-schema-subsystem.md §E.5)
    pipeline.ts               # run orchestration: stages, progress, cancel token
    report/
      reportModel.ts          # pure model: sheets, __review layout, collisions
      excelWriter.ts          # lazy exceljs — model → .xlsx bytes
    share/
      urlConfig.ts configManifest.ts fetchArtifact.ts   # see url-params.md
  ui/
    views/load/  views/report/  views/studio/
    components/               # SlotCard, DropZone, UrlField, DuckProgress, Badge, Modal variants, ...
  styles/
    tokens.css base.css components.css
public/
  favicon.svg favicon-32.png apple-touch-icon.png
  logo/quac-logo.svg logo/github-logo.svg
scripts/
  generate-fixtures.mjs  copy-duckdb-assets.mjs  check-bundle-size.mjs
```

Import rule: nothing under `src/core/` imports from `src/app/` or `src/ui/`.

## 3. Row identity (canonical)

- **`__row__`** — BIGINT, 0-based original file order, injected at ingest (`row_number() OVER () - 1` at `quac_raw` creation). It is:
  - the key in every `QCFlag.row`;
  - queryable from rule SQL (default ordering for `monotonic`, keyset pagination);
  - the Excel mapping: report data row = `__row__ + 2` (header is row 1).
- Display mapping: display bytes are exported `ORDER BY __row__` with `__row__` **excluded**, so data-table's own `__rowid__` (assigned in insertion order, stable within a load — ✅ author-confirmed) **equals `__row__`**. Annotations use `rowId = flag.row` directly.
- Ingestion **rejects or renames dataset columns starting with `__`** (reserved: `__row__`, `__value__`, `<col>__review` report columns get collision handling in `qc-report-spec.md`).
- Corrections never insert or delete rows in v1 (dedup rules flag only) — keeps `__row__` alignment trivial.

## 4. DuckDB tables (canonical registry — `core/bridge/tables.ts`)

| Table | Owner | Created | Purpose |
|---|---|---|---|
| `quac_raw` | engine | ingest | as-read data; delimited files via `read_csv(..., all_varchar=true)`; `__row__` injected here. May be dropped after the cast-failure scan to save memory (source bytes are kept as a Blob for re-ingest) |
| `quac_typed` | engine | ingest (+ after schema load) | schema-driven `TRY_CAST` ladder (`json-schema-subsystem.md §C`); copy of raw when no schema. Durable per (dataset, schema) pair; never mutated |
| `quac_work` | engine | each run | `CREATE OR REPLACE TABLE quac_work AS SELECT * FROM quac_typed`; corrections CTAS-swap it (atomic) |
| view **`data`** | engine | each run + after every swap | `CREATE OR REPLACE VIEW data AS SELECT * FROM quac_work`. **All rule SQL targets `data`** |
| `quac_display` | data-table | `loadData(bytes)` | Report-view grid (library-owned; never touched via DML) |
| `quac_studio_display` | data-table | `loadData(sample)` | Studio live preview (sampled) |

Every helper in `tables.ts` that mutates state ends with `bridge.clearQueryCache()` (✅ author-confirmed necessity).

## 5. Canonical QCFlag (shared by both engines — defined once in `core/flags/flag.ts`)

```ts
interface QCFlag {
  source: 'schema' | 'rules';
  ruleId: string;                       // e.g. 'schema:prop:age:value' | 'Q003'
  scope: 'cell' | 'row' | 'column' | 'dataset';
  row?: number;                         // __row__ (cell/row scope)
  column?: string;                      // (cell/column scope)
  severity: 'error' | 'warning' | 'info';
  message: string;                      // self-contained sentence; EXCLUDES column name and ruleId
  value?: unknown;                      // offending value snapshot (cell scope)
  correction?: { before: unknown; after: unknown };
  meta?: { keyword?: string; schemaPath?: string; conditionalIndex?: number };
}
```

Rendering rule (annotations, `<col>__review` cells, dataset-findings lists): **`"{ruleId}: {message}"`**; when `correction` is present append **`" (corrected: {before} → {after})"`**. Implemented once in `core/flags/messages.ts`; no other module formats flag text.

## 6. QC run pipeline (`core/pipeline.ts`)

Stages, in order (see `qc-rules-engine.md §pipeline` for full pseudocode):

```
prepare      CTAS quac_work from quac_typed; CREATE OR REPLACE VIEW data; harden bridge (§8)
corrections  rules engine, type=correct, file order (skipped when "Apply corrections" toggle is off)
schema       Ajv row-chunk validation of the CORRECTED data (validation worker; cancellable between chunks)
rules        validation rules (SQL/JS), file order; cancellable between rules
annotate     COPY display bytes → loadData → re-apply annotations + tooltips + panels
```

- Cancel = cooperative token checked at chunk/rule boundaries (DuckDB statement interrupt not assumed; `bridge.cancel()` behavior is a P03 note).
- Re-run semantics: artifacts persist; new data upload invalidates flags + `quac_*` tables; every run starts from a fresh CTAS so corrections are idempotent per run. Determinism: a run is a pure function of (source bytes, schema set, rule files); `SELECT setseed(0.42)` before each correction.
- Progress: `core/pipeline.ts` owns an emitter (`onStage`, `onTick`); UI binds DuckProgress. Per-rule failures are never fatal (broken-rule policy in `qc-rules-engine.md`).

## 7. State management & errors

- `app/signals.ts`: `signal(v) → {get,set,subscribe}`, `computed(fn)`, `effect(fn)`. No external deps.
- `app/store.ts` AppState:
  ```ts
  slots: { data: SlotState; schema: SlotState; rules: SlotState }   // status: empty|loading|valid|warning|error (+detail)
  pipeline: { stage: 'idle'|'prepare'|'corrections'|'schema'|'rules'|'annotate'|'done'|'cancelled'|'failed';
              progress: {done:number; total:number}; cancel: CancelToken }
  run: { flagsSummary; lastRunAt; datasetName } | null
  shareables: ArtifactProvenance[]        // per artifact: 'upload' | {url}
  ```
- data-table's own signals drive grid internals; QuaC subscribes to its events (`ready`, `loadProgress`, `loadComplete`) and never duplicates grid state.
- `QuacError` codes (closed set): `INGEST_UNSUPPORTED`, `INGEST_TOO_LARGE`, `FETCH_CORS`, `FETCH_HTTP`, `SCHEMA_INVALID`, `SCHEMA_AMBIGUOUS_ROOT`, `RULES_PARSE`, `RULE_SQL_ERROR`, `RULE_JS_ERROR`, `PIPELINE_CANCELLED`, `EXPORT_FAILED`, `BRIDGE_FAILED`. Every async UI action wraps in `reportError()` → toast (transient) + slot/panel state (persistent).

## 8. Privacy & security hardening

Threat model: **shared rule URLs make rule SQL/JS untrusted code** running against the user's private data. Channels closed:

1. **DuckDB network exfiltration** (httpfs URL reads): after ingest and BEFORE the first rule statement of every run, `core/bridge/harden.ts` executes, in order: all app-level `SET`s (e.g. memory limit) → `SET enable_external_access=false` → `SET lock_configuration=true` (rules cannot re-enable). P03 verifies interactions with registered file buffers and records the working sequencing.
2. **Rule SQL is single-statement**: lint rejects top-level `;` (string/comment-aware scan) so a cell cannot smuggle a second statement into the engine's wrappers. Rule text is never `eval`ed and never interpolated anywhere except the documented SQL wrappers and QuickJS.
3. **JS rules run only in QuickJS-WASM** (lazy chunk): no fetch/DOM by construction; ~128 MB memory cap; interrupt budget ~2 s/chunk, 30 s/rule. Values cross as JSON.
4. **WASM + fonts self-hosted** — after page load QuaC makes **zero third-party requests** (README claim, asserted by a Playwright network test in P20). Only user-initiated fetches of user-provided URLs (schema/rules/data) leave the origin, and schema-ref auto-crawl fetches schemas only, never data.
5. **No persistence of data**: no localStorage/sessionStorage/IndexedDB for dataset, schema, or rule content. The hash fragment is the only configuration persistence (never sent to servers). `localStorage` allowed solely for trivial UI prefs. Uploaded artifacts die with the tab — the Load screen says so.
6. Residual risk (documented in README): malicious SQL can still DoS the tab (cross-join explosion). Mitigations: warning banner when rules come from URLs, cooperative cancellation, and the caps in `qc-rules-engine.md`.

## 9. Corrected-data display round trip

Primary path (per `data-table-api.md §7`):

```
mutate quac_work (bridge SQL) → clearQueryCache()
COPY (SELECT * EXCLUDE (__row__) FROM data ORDER BY __row__) TO 'corrected.parquet' (FORMAT PARQUET)
retrieve bytes → table.loadData(bytes) → loadComplete → re-apply annotations (rowId = flag.row) + tooltips
```

P03 verifies the byte-retrieval step (`bridge.export()` vs alternatives) and records it below. Documented fallback if no path exists: chunked `SELECT` → JSON text → `loadData(jsonString)`, 250k-row cap + UI notice.

## 10. Verified facts (append-only; updated by phases, trusted over everything else)

| # | Fact | Status | Source |
|---|---|---|---|
| V1 | `bridge.query()` executes DDL/DML (CREATE/INSERT/UPDATE/DELETE/DROP/COPY); no-result statements → `[]` | ✅ confirmed | library author, v0.5.1 source, 2026-07-23 |
| V2 | SELECT cache is NOT invalidated by mutations → `bridge.clearQueryCache()` required after every DDL/DML | ✅ confirmed | author, 2026-07-23 |
| V3 | `createDataTable({bridge, tableName})` without `source` does not attach to an existing table | ✅ confirmed (not supported) | author, 2026-07-23 |
| V4 | `__rowid__` stable within a load (materialized `row_number() OVER () - 1`; sort tie-breaker); reassigned per `loadData()` | ✅ confirmed | author, 2026-07-23 |
| V5 | Byte-retrieval path for `COPY ... TO 'file.parquet'` output through the bridge (`bridge.export()`?) | ⏳ P03 | — |
| V6 | `SET enable_external_access=false` + `lock_configuration=true` via `bridge.query()`: effective, and registered-buffer reads/`loadData` still work afterward | ⏳ P03 | — |
| V7 | `loadData(parquet bytes ordered by __row__)` yields `__rowid__ === __row__` | ⏳ P03 | — |
| V8 | Exact self-hosted duckdb-wasm dist filenames + `bridgeOptions` wiring under `/quac/` base | ⏳ P03 | — |
| V9 | Vitest 4 node env reports `import.meta.env.BASE_URL` as `'/'` regardless of vite `base` (vitest-dev/vitest#8895, open) → unit tests assert base-join invariants, never the literal `/quac/`; e2e owns the deployed-base truth | ✅ confirmed | P01, 2026-07-23 |
| V10 | GH Pages deploy actions current majors: `configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5` (Node-24 runtime-only bumps over the v5/v4 named in `testing-strategy.md §4`) | ✅ confirmed | P01, 2026-07-23 |
| V11 | `-555` is schema-VALID in `selfemp_income_annual` (branch min −5,000,000; `not.enum` excludes only the four sentinel codes), so `json-schema-subsystem.md §D.7` golden #2's expected flag contradicts the committed HESP schema. P02's sentinel-in-numeric-branch injection targets `wage_income_annual` (branch min 0, genuinely invalid) instead; P08 must pick a schema-consistent golden for the collapse-with-exclusions template | ✅ confirmed | P02, schema inspection, 2026-07-23 |

Phases append rows here (with date + evidence) whenever reality is tested against a spec claim.
