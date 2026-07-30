# Spec: Headless Node Runtime & CLI

> Audience: P20 (Node runtime), P21 (CLI & packaging), P22 (release docs/publish).
> Depends on: `architecture.md` (§4 tables, §5 QCFlag, §6 pipeline, §8 hardening, Verified facts), `json-schema-subsystem.md` (§A.4 `index=`, §C casting, §F worker protocol), `ingestion.md` (§2 formats, §5 guardrails), `qc-rules-engine.md` (§3 pipeline, §7 lint), `testing-strategy.md`.
> Provenance: the full contract below was proven end-to-end by a throwaway spike (2026-07-30, planning session, scratchpad-only): the complete pipeline ran under plain Node v22 on the committed fixtures with **exact flag parity** — all 23 `seeded-violations.json` injections at their cells, `synthetic/mini` flags deep-equal to the browser-pinned `mini_expected_flags.json`, identical double-run digests, and identical digests across all four ingest routes (csv/xlsx/json/parquet). Full HESP run ≈ 1.3 s. Facts marked **[spike]** were observed there and should be re-pinned as Verified facts by the implementing phases.

## 1. Scope & privacy posture

Pipeline users run the QC Report generation headlessly: **ingest → schema validation → rules + corrections → Excel report**, via a `quac` CLI and a programmatic `runQuac()` API, on Node ≥ 24 (engines floor; ≥ 20 runs in practice — hard-refuse < 20, warn < 24). The Rule Studio, all UI surfaces, URL-hash sharing, and session persistence are out of scope. The browser app is **byte-unaffected**: no headless module may enter the web entry graph (the bundle gate proves it — entry KB gz unchanged).

Privacy has two legs now, one promise: data stays on the machine that ran it.
- **Browser**: after load, zero non-origin requests (DevTools-verifiable, `network-isolation` Playwright test — browser-scoped by design).
- **Headless**: an ordinary local Node process. It reads the files named on the command line, talks to an embedded native DuckDB, writes the report next to your data. The only network activity it can ever perform is fetching schema/rules **URLs the user passes** (same rule as the browser app). No telemetry, no uploads, no server side.

## 2. Node runtime adapter — `src/headless/nodeBridge.ts`

`createNodeBridge(): Promise<{ bridge: WorkerBridge; close(): Promise<void> }>` — a facade over `@duckdb/node-api` (in-memory instance + one connection), cast `as unknown as WorkerBridge` (nominal class, private fields; the same house cast as `tests/unit/pipeline/pipeline.test.ts:20`). The pipeline path touches exactly five members; nothing else needs implementing:

| Member | Contract |
|---|---|
| `query(sql, signal?)` | `runAndReadAll` → `getRowObjectsJS()` → **recursive bigint→Number normalization** (getRowObjectsJS still returns JS `bigint` for BIGINT **[spike]**; recursion covers LIST/STRUCT). Parity target: data-table's worker `convertBigInts`. Abort: pre-check `signal.aborted` + `conn.interrupt()` on the abort event (best-effort; the rules engine deliberately passes no signal — post-abort cleanup must run). |
| `loadData(source, {format, tableName}, onProgress?)` | Temp-file route (node-api has no buffer registration): write bytes to a private `mkdtemp` dir, then `json` → `CREATE OR REPLACE TABLE t AS SELECT CAST(row_number() OVER () - 1 AS BIGINT) AS "__rowid__", * FROM read_json('file')` (handles both NDJSON and the wrapped-JSON top-level array); `parquet` → `read_parquet('file', file_row_number=true)` with `file_row_number` cast to `__rowid__`. Single-file scan + `preserve_insertion_order` (default true) ⇒ `__rowid__` is file order **[spike]** — the `data-table-api.md` §3 contract ingest depends on. Returns `{tableName, rowCount, columns}` with `__rowid__` **included** in `columns` (ingest filters it out itself); `schema: []` is fine (unused). Delete the temp file in `finally`. |
| `exportToBuffer()` | Rejects. Unreachable: the headless pipeline stubs the `exportDisplay` executor (§4). |
| `clearQueryCache()` | No-op — node-api has no cross-statement SELECT cache (house precedent `tests/unit/schema/duckdb.ts:36`). |
| `dropTable(name)` | `DROP TABLE IF EXISTS` (quoted). |

**Result-shape conformance** (V13): DDL/DML through `query` must behave as the engine expects; the adapter conformance test pins DDL → `[]`-ish, DML count shapes, and the bigint normalization.

**Harden parity — `src/headless/harden.ts`**: `nodeHarden(bridge)` replaces `core/bridge/harden.ts` via the `PipelineExecutors.harden` seam. json/parquet/icu/core_functions are **statically linked and loaded** in `@duckdb/node-api` 1.5.5 **[spike]** — no `LOAD`s. Instead, lock down against untrusted rule SQL (`architecture.md` §8 threat model; native DuckDB, unlike the prelude-hardened wasm worker, could otherwise reach fs/network):
`SET autoinstall_known_extensions = false` → `SET autoload_known_extensions = false` → `SET enable_external_access = false` (try/catch — one-way per instance). Safe because every `loadData` temp-file read happens **before** prepare; everything after is table-only SQL (corrections CTAS, JS staging, validation SELECTs, report paging) **[spike]**. A future corrected-data file export would need to run before harden or relax this deliberately.

## 3. In-process schema validation

The Ajv leg reuses the **real worker logic** via a one-file extraction (single source of truth — no reimplementation):

- `src/core/schema/validation-core.ts` (NEW, core-legal: pure, DOM-free): move the whole engine body of `validation.worker.ts` (state, `handleInit`/`handleBatch`/`finish`, the dispatcher `switch`) into `createValidationEngine(post: (msg: WorkerToMain) => void): { handle(msg: MainToWorker): void }`. Module-scope `state` becomes per-engine state.
- `src/core/schema/validation.worker.ts` shrinks to a ~6-line shell: `const engine = createValidationEngine((m) => scope.postMessage(m)); scope.onmessage = (e) => engine.handle(e.data)`. The browser tier (`validation-worker.browser.test.ts`) keeps guarding the shell; its mini deep-equal is unchanged.
- `src/headless/validationWorker.ts`: `createInProcessValidationWorker(): Worker` — a duck-typed object (`onmessage/onerror/onmessageerror/postMessage/terminate`, the exact surface `createChannel` at `validation-run.ts:107-143` touches; precedent: the fake in `tests/unit/schema/validation-no-overlap.test.ts`). `postMessage` feeds `engine.handle`; engine `post`s are delivered to `onmessage` via `queueMicrotask` (preserves the real worker's async ordering). Each factory call builds a fresh engine — concurrent runs are isolated (unlike the spike's `globalThis.self` import trick, which is why that trick does not graduate).

Injection: `runPipeline` calls `executors.runSchemaValidation(deps)` **without** `createWorker` (`pipeline.ts:234-252`), so the headless runner supplies an executor wrapper:
`runSchemaValidation: (deps) => runSchemaValidation({ ...deps, createWorker: createInProcessValidationWorker })`.
Batching, the sticky flag cap, abort-at-batch-boundary, and `ValidationSummary` semantics are the §F contract, unchanged.

## 4. Programmatic API — `runQuac()`

`src/headless/run.ts` exports the assembly; `src/headless/index.ts` is the public library entry (P21).

```ts
runQuac(options: RunQuacOptions): Promise<RunQuacResult>
// options: { dataset: string; schema?: string[]; rules?: string[]; index?: string;
//            sheet?: string; out?: string; applyCorrections?: boolean;   // default true
//            signal?: AbortSignal; onProgress?: (p: RunProgress) => void;
//            quiet?: boolean }   // paths or URLs per §8
// result:  { outPath: string; artifacts: RunArtifacts; model: ReportModel;
//            summary: SummaryJson /* §7, minus exitCode */ }
```

Never calls `process.exit`; throws typed errors (`QuacCliError` with a `kind` mapping onto §6 codes) that `main()` translates. The assembly (all seams existing):

1. **Ingest**: read bytes → `sniffFormat` → `assessFileSize` guardrails (§8) → `ingestDataset(bridge, {name, bytes, format, sheetName?})` — unchanged over the adapter (Buffer→ArrayBuffer slice).
2. **Schema**: intake per §8 → `buildSchemaSet(entries, {origin, fetchJson?, indexParam})` → `columnDigest`.
3. **Typed-sync parity (load-bearing — [spike] found it)**: with a digest present, BEFORE the rules lint: `describeColumns` → `buildCastPlan(digest.meta, columns, rawTypes)` → `applyCastPlan` → `swapWorkTable('SELECT * FROM quac_typed')` → `refreshDataView` — the headless mirror of `src/app/typedSync.ts`. Without it the lint dry-runs see the all-VARCHAR copy and every arithmetic rule lint-fails and is excluded (12 exclusions on the HESP fixtures; with it, 0).
4. **Rules**: read files/URLs in arg order → `parseRuleFile` → `lintRuleFilesWithDataset(parsed, {runner, datasetColumns}, {loadSandbox: loadJSSandbox})` → `executableRuleFile` filter. Keep BOTH lists: filtered → pipeline; unfiltered `.file`s → `ReportModelInput.ruleFiles` + `ruleFileSummaries` (reportExport parity).
5. **Sandbox**: `loadJSSandbox()` only when corrections apply AND an enabled js `correct` rule exists (mirrors `runController.resolveSandbox`); QuickJS works under plain Node **[spike]**.
6. **Pipeline**: `runPipeline({..., present: async () => {}, executors: { harden: nodeHarden, exportDisplay: async () => new Uint8Array(0), runSchemaValidation: wrapper }})`. The annotate stage still builds its pure plans cheaply; only `present` consumed the display bytes, and ours ignores them.
7. **Report**: replicate `reportExport.ts:39-122` field-for-field — `buildReportModel` input incl. `RunInfoInput` (appVersion=`APP_VERSION`, runAt, dataset name/format, `schemaFiles`/`schemaRoot`/`schemaIndexId` from the set, `ruleFileSummaries` from unfiltered files, durations in STAGE_ORDER, correctionsApplied, the two caps rows, stageErrors); row source = 10k pages of `reportRowsSQL(offset, limit)` with `clearQueryCache()` per page mapping `{row: Number(r.__row__), values: r}`; `writeReportWorkbook` → `Blob` → `fs.writeFile(out, Buffer.from(await blob.arrayBuffer()))`. Default `out`: `reportFilename(datasetName, new Date())` in cwd; if `out` is an existing directory, join the default name into it.

## 5. CLI grammar — `src/cli/`

```
quac <dataset> [--schema <file|dir|url>]... [--rules <file|url>]...
     [--index <id>] [--sheet <name>] [--out <path>] [--no-corrections]
     [--summary <path|->] [--fail-on <error|warning|none>] [--quiet]
quac --version | quac --help
```

`node:util` parseArgs (zero new runtime deps; repeatables via `multiple: true`; positional dataset via `allowPositionals`). No subcommands in v1.

- **Input contract = the app's** (`runReadiness`): dataset mandatory; at least one usable check source. Zero check sources → exit 1, copy echoing the `'no-checks'` sentence ("Provide a JSON Schema (--schema) or a QC rules file (--rules) — either is enough."). All-broken-rules with no schema mirrors `'rules-blocked'`.
- **stdout is data, stderr is human.** stdout carries ONLY the summary JSON when `--summary -`; stage/progress lines, lint findings, warnings, and the final `quac: report written → <path>` + counts line go to stderr. In-place progress updates only when `process.stderr.isTTY`; one line per stage transition otherwise; no spinners ever. `--quiet` suppresses progress/stage lines, never warnings or errors.
- **Warning surfaces (non-fatal, app parity)**: per-file lint summary line + one `warning:` line per excluded rule (the UIX-16 plain-language diagnosis, never a raw binder error); post-run broken rules (`RuleRunStat.status === 'broken'`); missing-variables count; pertinence verdict when `crossCheckInputs` names a suspect; `W_INDEX_BASENAME` when `--index` matched by basename.
- `--version` prints the build-injected `__QUAC_VERSION__` (same define as the app → Run Info sheet, `--version`, and summary `quacVersion` move together at P22's bump).

Files: `src/cli/args.ts` (pure grammar + refusals), `src/cli/progress.ts` (stderr/TTY rules), `src/cli/summary.ts` (§7 assembly), `src/cli/quac.ts` (`main()`: args → `runQuac` → writes → exit mapping; the only file allowed to `process.exit`).

## 6. Exit codes & `--fail-on`

Closed set — scripts may depend on it:

| Code | Meaning |
|---|---|
| 0 | Report written (findings do NOT affect exit unless `--fail-on`) |
| 1 | Usage error: bad/unknown flags, no dataset, no check source, mixed local/URL `--schema` (§8), bad `--fail-on` value |
| 2 | Input/ingest error: unreadable/unsupported/oversize dataset (guardrail hard-stop), multi-sheet workbook without `--sheet` or unknown `--sheet` (stderr lists the workbook's sheet names), unreadable rules file, failed URL fetch |
| 3 | Schema-set error: fatal load errors / null digest with no other check source, ambiguous root without a matching `--index` (stderr lists `set.root.candidates` — fileId, declaredId, title — plus the `--index` hint) |
| 4 | Run failure: prepare-stage error, bridge/DuckDB init failure, any uncaught exception (top-level catch maps unknowns here) |
| 5 | Report/summary write failure |
| 6 | `--fail-on` threshold met — the report AND summary were still written first |
| 130 | SIGINT (cooperative cancel through the pipeline's AbortSignal; no report) |

Non-prepare `stageErrors` are **not** fatal (the app presents partials): write the partial report, print the stage errors as `warning:` lines, exit 0 (or 6). `--fail-on error` → exit 6 when `severityTotals.error > 0`; `warning` → when errors+warnings > 0; `none` (default) → never. No count-threshold form in v1 (that is `--summary - | jq` territory).

## 7. Summary JSON (`--summary <path|->`)

`summarySchemaVersion: 1`. Pure assembly — every field maps to an existing type; no new computation:

```jsonc
{
  "summarySchemaVersion": 1,
  "quacVersion": "…",                                   // __QUAC_VERSION__
  "generatedAt": "ISO-8601",
  "exitCode": 0,
  "dataset": { "path", "name", "format", "sheet": null, "rows", "columns" },   // ingest result
  "inputs": {
    "schema": { "files": [], "root", "index": null, "loadWarnings": [] } | null,  // SchemaSet
    "rules": [ { "name", "rules", "lintErrors", "excludedRuleIds": [] } ],        // RuleFileLintResult
    "applyCorrections": true
  },
  "severityTotals": { "error", "warning", "info" },     // FlagStoreSummary (exact)
  "rowsAffected": 0, "flagsTruncated": false,           // FlagStoreSummary
  "correctedCells": 0,                                  // artifacts.rules
  "perRule": [ { "ruleId", "status", "violationCount", "flagsEmitted", "truncated", "durationMs" } ],  // RuleRunStat[] (violationCount EXACT)
  "schema": { "rowsTotal", "rowsWithErrors", "flagsEmitted", "flagsTruncated", "countsByRuleId": {}, "elapsedMs", "aborted" } | null,  // ValidationSummary (countsByRuleId EXACT)
  "missingVariables": [ { "name", "description" } ],    // ReportModel
  "stageErrors": [ { "stage", "message" } ],
  "durations": { "prepare", "corrections", "schema", "rules", "annotate" },     // RunArtifacts.durations (ms)
  "report": { "path", "dataRowsTruncated" }             // abs path; ReportModel.data.truncated
}
```

Serialize the two `ReadonlyMap`s via `Object.fromEntries`. Stability: additive changes only within version 1; field removals/renames bump `summarySchemaVersion`.

## 8. Intake semantics

- **Dataset**: one positional path; format by `sniffFormat` (all five: csv/tsv/json/xlsx/parquet — all four routes produce identical flag digests on the HESP fixtures **[spike]**). Guardrails per `ingestion.md` §5 in Node too: warn ≥ 100 MB (stderr), hard-stop > 500 MB → exit 2 (PapaParse still buffers the whole text). `--sheet <name>` for xlsx: single-sheet proceeds; multi-sheet without `--sheet` → exit 2 listing `workbook.sheetNames` (the CLI's SheetPickerModal — a pipeline must not guess); unknown name → exit 2 with the same list.
- **Schema** (`--schema`, repeatable): a **dir** → recursive walk (skip dotfiles), `relativePath` = POSIX path relative to the dir, `raw` = file text — every file, no extension filter (manifest ordering hints and graceful `not-json` ignores work exactly as the browser folder drop; `stripCommonRoot` then behaves identically, so `setId` matches the browser for the same tree). A **file** → `{relativePath: basename, raw}`. A **URL** → mirror `loadSchemaUrls`: fetch via the existing `FetchJson` port (`browserFetchJson` is plain `fetch` — Node-clean; the `$ref` crawler fetches transitive refs), `relativePath`/`retrievalUri` = final URL. **Same-kind rule**: `BuildOptions.origin` is a single `'upload' | 'url'` — mixing local and URL `--schema` values is exit 1. `--index` → `indexParam` (§A.4 ladder); `needsRootChoice` still true → exit 3 per §6.
- **Rules** (`--rules`, repeatable): files or URLs; **arg order = load order = cross-file correction order** (document in `--help`). Lint per §4 step 4; issues to stderr; exclusions never fatal while another check source survives.
- **URL fetches**: Node's global fetch, no CORS (a browser concept) — note in docs that URL configs which need CORS headers in the browser work headless regardless; 30 s timeout parity with `fetchArtifact`.

## 9. Build, packaging & distribution

- **Build**: `vite build --config vite.cli.config.ts` — SSR entry build, the mechanism the spike proved (51-module graph, no worker-plugin interference; the dead `new Worker(new URL(...))` in `validation-run.ts` is harmless). NOT esbuild — Vite 8 ships rolldown; esbuild is not in the tree. Two entries: `src/cli/quac.ts` → `dist-cli/quac.mjs` (with `#!/usr/bin/env node` banner) and `src/headless/index.ts` → `dist-cli/index.mjs`. `target: 'node22'`, ESM, deps external (SSR default — keeps QuickJS's `import.meta.url` wasm resolution and the native duckdb binding in `node_modules`), `define: { __QUAC_VERSION__: JSON.stringify(pkg.version) }`. `dist-cli/` is gitignored, never committed, disjoint from `dist/` (web build, Pages artifact, and the 300 KB entry gate untouched by construction).
- **Dev loop**: `npm run cli -- <args>` = `npm run build:cli --silent && node dist-cli/quac.mjs` — the build is ~50 ms **[spike]**; no tsx/vite-node dependency needed.
- **package.json (P21)**: `"bin": {"quac": "dist-cli/quac.mjs"}`; `"exports": {".": {"types": "./types/quac.d.ts", "default": "./dist-cli/index.mjs"}}` (inert for the web app — nothing imports the package by name); `"files": ["dist-cli", "types", "README.md", "LICENSE"]`; `"prepack": "npm run build:cli"`; promote `@duckdb/node-api` devDependencies → dependencies (precedent: exceljs in P15). Hand-maintained `types/quac.d.ts` (~40 lines: `RunQuacOptions`, `RunQuacResult`, summary shape) — no dts toolchain in a noEmit repo.
- **Distribution posture**: P21 makes the package *publishable* and proves it (`npm pack` + install-from-tarball smoke — `npm pack` works while `"private": true`); the repo-clone path (`npm ci && npm run build:cli && node dist-cli/quac.mjs`, or `npm link`) works from P21 day one. **P22 executes the publish decision**: check npm name `quac` (fallback `@jeyabbalas/quac` — `bin` keeps the command name either way), flip `private`, audit `npm pack` contents (note: the `xlsx` dependency installs from a sheetjs CDN tarball URL — verify acceptable for installers), publish, verify `npx` on a clean environment. Version bumps remain P22-only (working-protocol rule 7).
- **Node floor**: `main()` refuses `process.versions.node` major < 20 with a friendly line, warns < 24 (declared engines), continues otherwise.

## 10. Parity & test map

**Parity mechanism: shared ground-truth manifests, not cross-tier runtime comparison.** The node tier asserts the SAME manifests the browser tier pins — `synthetic/mini/mini_expected_flags.json` deep-equal (the `validation-worker.browser.test.ts` recipe: canonical sort, `meta`/undefined dropped, key-order-insensitive) and `hesp/data/seeded-violations.json` per-cell ids. Engine skew (duckdb-wasm 1.33.1-dev57 vs native 1.5.5) is therefore caught the moment either side drifts from the manifests. Divergence budget: none. Known cosmetic divergence to document, not fix: json/parquet ingests can surface DATE/TIMESTAMP as Node `Date` objects in report cells where the browser shows epoch values (all-VARCHAR csv/tsv/xlsx routes unaffected — and the schema cast plan normalizes the typed routes: all four routes digest-identical on HESP **[spike]**).

| Test (under `tests/`) | Tier | Covers |
|---|---|---|
| `unit/headless/nodeBridge.test.ts` | node | §2 conformance: result shapes + bigint normalization, `__rowid__` insertion order for json/parquet loads, cache no-op, dropTable, abort, exportToBuffer rejection |
| `unit/headless/validationNode.test.ts` | node | §3 protocol through `createWorker`: ready/batchDone/done order, abort at batch boundary, sticky flag cap; engine isolation across two concurrent factories |
| `unit/headless/nodePipeline.test.ts` | node | **the P20 gate** — three passes on committed fixtures: (a) mini deep-equal vs `mini_expected_flags.json`; (b) HESP csv + 14-file schema dir + 3 rules files → every seeded expectedRuleId present at its row/column (any-of per cell — corrections legitimately replace schema flags), 101×266, correctedCells ≥ 3, H006 ok (QuickJS), ≥ 1 skipped-external, 0 lint exclusions (the §4.3 typed-sync pin), double-run digest identical; (c) tiny/ partial modes (schema-only; rules-only exercising the V23 all-VARCHAR lint exclusions against node-api's binder) |
| `unit/cli/args.test.ts` | node | §5 grammar: every flag, repeatables, refusals (no dataset / no check source / mixed-kind schema / bad `--fail-on`), help/version text |
| `unit/cli/summary.test.ts` | node | §7 field-by-field from a synthetic `RunArtifacts`/`ReportModel` |
| `cli/run.test.ts` | **cli (built)** | golden journey 18 |
| `cli/exitCodes.test.ts` | **cli (built)** | golden journey 19 |

**CLI tier**: a new vitest project `cli` (`tests/cli/**/*.test.ts`, node env) that black-boxes the BUILT `dist-cli/quac.mjs` via `child_process` — exit codes, stderr shapes, exceljs re-read of the workbook, summary JSON parse; URL-intake cases run an in-test `node:http` static server over `tests/fixtures/` (no CORS server — CORS is a browser concept). Scripts: `"test:cli": "vitest run --project cli"`, `"pretest:cli": "npm run build:cli"` (the `pretest:browser` house pattern). CI: `test:cli` runs after `fixtures:check`, before the Playwright steps (fail cheap, no browsers needed).
