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

## Post-P14 demo review (2026-07-23, user-requested pass over the shipped UI)

**Fixed (all four are bugs, not polish):**

- **`.q-report-grid` must carry a definite height.** data-table's `.dt-root` is `height: 100%` and its
  `VirtualScroller.calculateVisibleRange` reads `.dt-body-scroll.clientHeight`. Under the old
  `min-height: 480px` (auto height) that percentage resolved to `auto`, the scroller measured the full
  content height and rendered **every** row: 101 × 266 = 26,866 cells / 51k DOM nodes locked the tab for
  minutes, and a real-size dataset would have killed it. Now `clamp(420px, calc(100dvh - 210px), 1200px)`
  → 12–15 rows rendered. **Do not turn this back into a min-height.**
- Repeat-offenders table: `table-layout: auto` sized columns from max-content, so one URL-bearing
  `schema:advisory:<fileId>` id stretched the table to ~3× the panel and only the Rule column was on
  screen. Now `table-layout: fixed` + explicit column proportions + `overflow-wrap`, and the Targets cell
  shows 3 names with the full list in `title`.
- Dataset-findings rows: the flex text child had no `min-width: 0`, so long ruleIds spilled past the panel
  edge and squeezed the severity pill to a sliver. Also **sorted errors → warnings → info**: emission order
  put the per-file `$comment` advisories (info) first and buried the real findings.
- Repeat offenders are now ranked on the **exact** count that is displayed. `FlagStore.summary().perRule`
  sorts by *flag* count; a rule with ten target columns emits ten flags per violation, so the visible
  Count column looked unsorted (spec §4 says sorted desc).

**Also here:** `.q-main--wide` (report route only, 1600px) — 266 columns plus the panel column do not fit
the 1280px reading width; `.dt-col-tooltip__chip` height override (data-table sizes `string[]` tooltip
items as 1.4em pills; QuaC's QC-rule lines are sentences and overflowed their neighbours — the override
needs two classes because data-table's stylesheet ships in the lazy grid chunk, i.e. after ours); slot-card
disclosure label `details` → `Details` to match the schema card.

**Measured, left alone:** a window resize with the 266-column grid mounted blocks the main thread for
~4.5 s. It is **not** the `100dvh` height (a fixed-px grid height reproduces it identically) and not the
route switch (report↔load is <400 ms; first grid render is two long tasks of 67/105 ms) — it is
data-table's own per-column work, most likely the 266 header visualizations each re-rendering off their
own ResizeObserver. Worth raising with the library rather than patching here.

**Deferred (not attempted):** `schema:advisory:<fileId>` uses the absolute URL for URL-loaded schema sets,
so those findings/offender rows are dominated by a ~90-char prefix that the message then repeats as
`Schema note (<relativePath>)`. `relativePath` would read far better, but §D.5 pins the id on `fileId`, so
changing it is a spec deviation for P19/P20 to weigh. Report-panel tabs wrap to two rows below ~520px.
