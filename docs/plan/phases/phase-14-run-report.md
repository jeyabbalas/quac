# P14 — Run orchestration & in-app report

## Goal
The "Run QC" button works: the full pipeline (prepare → corrections → schema → rules → annotate) with duck progress and cancel; the Report view shows the annotated grid (with caps), aggregated header tooltips, and the four summary panels; re-run semantics are correct.

## Depends on
P09 (schema engine), P12 (rules engine). P13 integrates if already merged (pipeline treats the sandbox as optional per `EngineOptions.jsSandbox`).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/architecture.md` (§6, §9, Verified facts) · `docs/plan/specs/qc-report-spec.md` (§1–§4) · `docs/plan/specs/qc-rules-engine.md` (§2–§3) · `docs/plan/specs/json-schema-subsystem.md` (§E.2, §F progress) · `docs/plan/specs/ui-design.md` (Report wireframe).

## Tasks
1. `src/core/pipeline.ts`: stage machine per `architecture.md §6` — CTAS `quac_work` + view + `hardenBridge()`; corrections (respecting the "Apply corrections" toggle); schema validation on corrected `data` (worker, chunked); validation rules; annotate stage (display export → `loadData` → annotations/tooltips/panels). Cooperative CancelToken at chunk/rule boundaries; progress emitter feeding DuckProgress (stage labels + the three rotating pun lines); partial results labeled on cancel.
2. Re-run semantics: artifacts persist; replacing the dataset clears flags/annotations/`quac_*` tables and returns the Report view to its empty state; every run re-CTASes from `quac_typed` (idempotent corrections).
3. Annotations mapping per `qc-report-spec.md §2`: `addMany` in chunks; `ANNOTATION_CAP = 20,000` errors-first; cap banner; severity toggles → `setSeverityFilter`; re-apply after every `loadData`.
4. Tooltips per §3: schema digest items + rules-targeting items per column; set for all matched columns on `ready`/reload.
5. Report view UI per §4: grid left; right panel tabs Summary (stat cards, filters, Download button stub → enabled in P15) / Missing variables / Dataset findings / Repeat offenders (exact counts; best-effort row-click filter for window-free SQL rules); run/cancel states; Report nav-tab severity pill.
6. Run button state machine on Load view (enabled when Dataset + ≥1 rules source valid; disabled + reason otherwise).

## Deliverables
Golden journey 1 minus the Excel download: load fixtures → run → annotated grid + correct counts + panels.

## Out of scope
Excel export (P15), URL params (P16), Studio.

## Verification
- **Unit (node):** `tests/unit/pipeline/pipeline.test.ts` (mocked engine executors) — stage order, corrections-toggle path, cancel token honored between stages, rerun invalidation, error containment (one engine failing → pipeline reports, others ran). Tooltip aggregation unit test (schema + rules items merged per column, caps).
- **UI/UX:** Playwright `tests/e2e/runQc.spec.ts` — HESP dirty CSV + schema + rules → Run → progress stages visible → counts in Summary match `seeded-violations.json`-derived expectations (allow ≥ semantics where later phases refine manifests); annotated cells visible with popover text `"{ruleId}: …"`; severity toggle hides warnings; cancel mid-run leaves a sane partial state; re-upload data → grid/panels reset. Manual: tooltip content spot-check on 3 columns (screenshot in log).

## Deferred notes

**Composition (design-reviewed before implementation):** the pipeline makes ONE `runQC` call for every
shape (schema-only / rules-only / both / assess-only) — `EngineOptions.betweenPhases` realizes engine-spec
§3's reserved "phase 2 runs here" slot, so schema validation executes inside `runQC` between corrections
and validations, reading the corrected `data` (`sourceTable: DATA_VIEW`). `runQC` with zero rule files
still performs the work-table CTAS, so no prepare special case exists. `ValidationRunDeps.castPlan`
(new) lets prepare apply the cast CTAS before corrections while validation-run remains the single writer
of cast flags (a second writer would inflate FlagStore dedupe counts — `add()` counts repeats).
`runSchemaValidation` is called at most once per run (its pertinence/advisory block is unconditional);
a containment fallback runs it after `runQC` if the engine rejected before the hook.

**Cancellation:** `EngineOptions.signal` + `RunResult.aborted` — return-partial, never throw (mirrors
the schema side). Checks at both rule loops, abort-guards before `recordBrokenRule` (an abort-rejected
call is a cancel, not a broken rule), `throwIfAborted()` at the js keyset chunk loop. The signal is NOT
bound into bridge calls: post-abort cleanup (staging DROPs, view refresh) must still run. Annotate always
runs — partial state presents, labeled.

**Spec gaps closed (were unimplemented, discovered here):**
- `quac_typed` "(+ after schema load)" (architecture §4): `app/typedSync.ts` rebuilds the cast on schema
  arrival (and reverts to a plain copy on schema removal), re-points work/data, and re-installs the rules
  lint context. Without it a CSV dataset stayed all-VARCHAR until the first run, every arithmetic rule
  linted as a binder error, and (with the next item) would have been excluded from runs — the exact demo
  path (CSV + schema + HESP rules).
- Lint-error rules "excluded from runs" (engine-spec §7): `lint.ts → executableRuleFile` (file-level
  error ⇒ whole file; error rows dropped; disabled/external kept — the engine owns their skipped stats),
  applied by `app/runController.ts`.

**AppState additions beyond architecture §7:** `store.runArtifacts` (per-run FlagStore + stats — the
panels' source) and `store.applyCorrections` (run toggle, default ON).

**UI interpretations:** Re-run button on the Summary panel (§4 "run/cancel states"); pre-run header
tooltips (spec §3's recompute triggers are not run-gated); grid keeps showing the ingested data pre-run
while the panels hold the empty state; panel empty-state copy de-duplicated from the view-level copy
(Playwright strict mode). Panel counts follow the exact-count rule: offenders = `RuleRunStat.violationCount`
+ `ValidationSummary.countsByRuleId`; "corrections applied" = `correctedCells`; severity cards =
`flagStore.severityTotals` (reflect *emitted* flags — engine caps truncate emission past 10k/rule).

**Demo scope (user-approved):** `scripts/copy-example-assets.mjs` stages the HESP fixtures →
`public/examples/` (gitignored; predev/prebuild) + `index.json`; the Load view's "Load example files"
strip drives the three existing URL loaders same-origin. `mountDatasetCard` returns a `fetchUrl` handle.

**Discovered limits (P20 attention):** the CSV wrapped-JSON ingest CTAS (`json_extract_string` × N cols)
OOMs duckdb-wasm (~3.1 GiB cap) at roughly 2k rows × 266 cols — recorded as Verified fact V20. The cancel
e2e replicates the dirty dataset ×20 through the JSON path instead. Also: annotation popover e2e pins the
`.dt-annotation-popover` portal (role="tooltip"); hover needs a settle after paint on the virtualized grid.

**Not done here:** testing-strategy §1's "local CORS-enabled static fixture server" still does not exist
(e2e uses `page.route()`); becomes load-bearing at P16. Excel download ships as a disabled stub (P15).
