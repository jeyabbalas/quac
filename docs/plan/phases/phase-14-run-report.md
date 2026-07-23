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
*(agent fills in)*
