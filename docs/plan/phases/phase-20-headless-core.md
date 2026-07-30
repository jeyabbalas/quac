# P20 — Headless core: the QC pipeline under Node

## Goal
`runPipeline` executes end-to-end under plain Node (no browser, no WASM worker, no DOM): a WorkerBridge-shaped adapter over `@duckdb/node-api`, an in-process replacement for the Ajv validation worker (extracted, not reimplemented), node-side hardening parity, the typed-sync cast mirror, and a full-pipeline node test proving exact fixture counts. The web app is byte-unaffected. (The whole design was proven by the 2026-07-30 planning spike — see `headless.md`'s provenance note; this phase productionizes it.)

## Depends on
P14 (pipeline), P15 (report model). Both complete.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/headless.md` (§1–§4, §8, §10 — the contract; module/symbol names there are final) · `docs/plan/specs/architecture.md` (§4 tables, §6 pipeline, §8 threat model, Verified facts V13/V17–V19/V23) · `docs/plan/specs/json-schema-subsystem.md` (§C casting, §F worker protocol) · `docs/plan/specs/testing-strategy.md` (§1, §3).

## Tasks
1. `src/headless/nodeBridge.ts` — `createNodeBridge()` per `headless.md §2`: `query` via `runAndReadAll().getRowObjectsJS()` + recursive bigint→Number; temp-file `loadData` (json `read_json` + `row_number()−1` as `__rowid__`; parquet `read_parquet(file_row_number=true)`); `clearQueryCache` no-op; `dropTable`; rejecting `exportToBuffer`; abort via pre-check + `conn.interrupt()`. **Import rule (extends architecture.md §2):** `src/headless/**` imports `src/core/**` and npm packages only; nothing under `src/app/` or `src/ui/` may import `src/headless/**`, and no headless module may reach the web entry graph.
2. `src/core/schema/validation-core.ts` — extract the engine body of `validation.worker.ts` into `createValidationEngine(post)` per `headless.md §3` (verbatim move; module-scope `state` becomes per-engine). Shrink `validation.worker.ts` to the `self` shell. The browser tier must stay green untouched — it is the proof the shell still works.
3. `src/headless/validationWorker.ts` — `createInProcessValidationWorker(): Worker` (duck-typed; `queueMicrotask` delivery; fresh engine per call so concurrent runs are isolated).
4. `src/headless/harden.ts` — `nodeHarden` per `headless.md §2`: autoinstall/autoload off + `enable_external_access=false` in try/catch; no LOADs (extensions statically linked in node-api 1.5.5).
5. `src/headless/run.ts` — `runQuac(options)` per `headless.md §4` steps 1–7, including the **typed-sync mirror** (§4.3 — cast plan → `swapWorkTable` → `refreshDataView` BEFORE rules lint; without it 12 HESP rules lint-fail on all-VARCHAR and are excluded), the unfiltered-vs-filtered rule-file lists, the conditional `loadJSSandbox`, the executor overrides (`harden`, stubbed `exportDisplay`, `runSchemaValidation` wrapper injecting `createWorker`), no-op `present`, and the `reportExport.ts`-parity report assembly + 10k-page row source + `Blob`→`fs.writeFile`. CLI-only concerns (arg parsing, summary JSON, exit codes, `index.ts` public export) belong to P21 — `run.ts` throws the typed errors P21 will map.
6. Tests per `headless.md §10`: `tests/unit/headless/nodeBridge.test.ts`, `tests/unit/headless/validationNode.test.ts`, and the phase gate `tests/unit/headless/nodePipeline.test.ts` (mini deep-equal via the browser test's canonical-sort recipe; HESP seeded-ids/dims/corrections/QuickJS/zero-lint-exclusions/determinism; tiny partial modes incl. rules-only V23 exclusions).
7. Append Verified facts (`architecture.md §10`) for what this phase pins with tests: node-api `getRowObjectsJS` bigint behavior + normalization parity; `read_json`/`read_parquet` single-file insertion order for `__rowid__`; `enable_external_access=false` binds on node-api with the post-prepare pipeline table-only. Update `architecture.md` §1's `@duckdb/node-api` note ("test-only" → node tests + headless runtime) and §2's source tree with `src/headless/` if the plan-surgery commit has not already.

## Deliverables
The full pipeline runs under `npm test` on node with exact-count proof against both ground-truth manifests; the web bundle, browser tier, and e2e suite are unchanged.

## Out of scope
CLI surface, arg parsing, summary JSON, packaging/bin/exports, docs (P21/P22); any behavior change in the browser app; Rule Studio.

## Verification
- **Unit (node):** `nodePipeline.test.ts` green with all three passes (exact counts, not thresholds, wherever the manifests pin them); `nodeBridge.test.ts` + `validationNode.test.ts` green; full `npm run verify` green; `npm run test:browser` green (the worker-shell refactor is guarded by `validation-worker.browser.test.ts`).
- **UI/UX:** n/a (no UI surface). `npm run build && npm run size` — entry KB gz unchanged, proving the node layer never entered the web graph.

## Deferred notes

**Two narrowings of `headless.md` §4, both handed to P21 (owner-approved before implementation).**

1. **Intake is local paths and directories only.** `readSchemaEntries` walks a directory exactly as the
   browser folder drop does (every file, no extension filter, dotfiles skipped, POSIX `relativePath`
   relative to the dir, then sorted) so `stripCommonRoot` behaves identically and the `setId` matches;
   a plain file becomes a one-entry set. A `http(s)://` argument is refused **by name**
   (`QuacCliError('usage')`) rather than half-handled. P21 task 2 already owns the full §8 intake —
   URL fetching via the existing `FetchJson`/`fetchArtifact` ports, the multi-sheet `--sheet` refusal,
   and the exit-3 candidate listing — and that is where the CLI tier's `node:http` fixture server can
   test them. Consequence to know: **`runQuac` does not gate multi-sheet workbooks yet**; `sheet`
   passes straight through to `ingestDataset`, which defaults to the first sheet, as the browser does
   when no picker runs. `two_sheets.xlsx` is journey 19's, not this phase's.
2. **`RunQuacResult` carries `inputs`, not `summary`.** §7 assembly is P21 task 4 (`src/cli/summary.ts`),
   so building it here would have been dead code with no consumer and no test. `inputs` holds the
   resolved dataset info, the schema `{set, digest}`, the **unfiltered** `RuleFileLintResult[]` in
   argument order, and `applyCorrections` — every §7 field maps off that plus `artifacts`, with nothing
   re-derived. P21 adds `summary` on top. `RunQuacOptions.quiet` likewise lands with the CLI, since it
   only means anything once something prints. **Two field-name mismatches P21 must translate rather
   than look up**: §7's `flagsTruncated` is `FlagStoreSummary.truncated`, and its top-level
   `rowsAffected` does not exist on `FlagStoreSummary` at all — `rowsAffected` is per-rule
   (`RuleAggregate.rowsAffected`), so the summary's single number has to be derived or the field
   dropped when §7 is implemented.

**Report assembly is duplicated from `reportExport.ts`, as §4 step 7 instructs** ("replicate field for
field"). Nothing tests that the two stay in step, and a Run Info change made in one place will not
show up in the other. A shared pure `core/report/runInfo.ts` taking explicit values (the browser
version reads three module stores; the headless one cannot) is the obvious fix and a good P22
candidate — it was not taken here because it edits a shipped browser path for a phase whose deliverable
is "the web bundle is byte-unaffected".

**The in-process worker passes messages by reference, not structured clone.** A real `Worker` copies;
this one does not. Safe as the engine stands — `handleBatch` builds a fresh `out` array per batch and
never mutates the rows it is handed — but an engine change that started mutating its input would
behave differently in the two tiers, and the browser tier would not catch it. Pinned in the module
doc so the next person to touch `validation-core.ts` sees it.

**`RuleFileLintResult.executable` is not the exclusion count.** It is `enabled ∧ no error issue ∧
applicable`, so the HESP fixtures' one disabled rule makes it 21 of 22 on a perfectly clean lint. The
gate asserts the honest pin instead: zero error-severity issues, and one `perRule` stat per loaded
rule (disabled and inapplicable rules still get one). Worth knowing before P21 prints a "N of M
executable" line.

**Not measured here:** the four-ingest-route digest equality the spike observed (csv/xlsx/json/parquet
all identical on HESP). The gate runs the csv route only, since §10 (b) names it; the other three are
one `runQuac` call each if a future phase wants the assertion. Same for the `Date`-vs-epoch cosmetic
divergence §10 documents — nothing in this tier surfaces report cell values.
