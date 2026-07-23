# P12 — Rules corrections (SQL), integrated lint, hardening, rules slot

## Goal
SQL correction rules mutate `quac_work` atomically with before/after capture; lint gains its dataset-dependent stages (SQL dry-run, pertinence, pending-data); the hardening sequence is enforced and browser-proven; the QC Rules slot card ships.

## Depends on
P05 (ingest/work tables), P11 (engine core).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-engine.md` (§2–§7) · `docs/plan/specs/qc-rules-format.md` (§5) · `docs/plan/specs/architecture.md` (§4, §8, Verified facts V6) · `docs/plan/specs/ingestion.md` (§4).

## Tasks
1. Corrections in `engine.ts` per the pipeline pseudocode: `setseed(0.42)`; `expandValueToken`; per-target capture queries (`before`/`after`/`hit` computed in the inner SELECT list — window-safe) with no-op suppression (`after IS DISTINCT FROM before`); ONE atomic CTAS `SELECT * REPLACE (...)` per rule covering all targets; swap + view refresh + `clearQueryCache()`; failure → drop `quac_work_next`, broken stat, continue. Correction flags carry `correction:{before,after}`, default severity `info`.
2. Assess-only mode (`applyCorrections:false`) skipping phase 1 cleanly.
3. Lint stages 4–6 in `lint.ts`: `EXPLAIN` dry-run of the EXACT engine wrappers per rule (row viol-select / rebuild SELECT / dataset statement), binder errors surfaced with file+ruleId+rowNumber+csvColumn, smart-quote hint; JS `compileCheck` deferred to P13 (emit `pending` for js rules with a TODO note); pertinence integration (extend `core/pertinence.ts` inputs with rules targets); `pending-data` lifecycle (lint re-runs when the dataset changes).
4. Hardening wiring: `hardenBridge()` called at run start before any rule SQL (pipeline `prepare`); browser test proving httpfs reads fail, `lock_configuration` holds, and the correction path still works hardened.
5. UI: Rules `SlotCard` (multi-file, per-file badges, lint detail list grouped file→rule, pertinence line) per `ingestion.md §4`; pertinence strip now includes rules coverage.

## Deliverables
Full SQL-rules execution (validate + correct) against the real bridge; complete lint; Rules slot UI.

## Out of scope
JS corrections (P13), run orchestration UI (P14), Studio.

## Verification
- **Unit (node + @duckdb/node-api):** `tests/unit/rules/corrections.test.ts` — **T-CORRECT-SENTINEL-IDEMPOTENT** (before=999/after=-999 captured; second run: zero flags, byte-identical table; untargeted columns unchanged), **T-CORRECT-ORDER** (Q047→Q050 right; reversed wrong — file order is the contract), **T-CORRECT-WINDOW** (Q055 carry-forward; single-pass semantics: fills from pre-rule values). `lint.test.ts` extension — `sql-error` (with exact location), `pertinence`, `pending-data`→resolved transition.
- **Browser:** `tests/browser/rulesExec.browser.test.ts` — representative fixture rules through the real hardened bridge produce the same flags as the node run; `tests/browser/harden.browser.test.ts` extension — httpfs blocked during rules, corrections still succeed.
- **UI/UX:** Playwright `tests/e2e/rulesLoad.spec.ts` — drop the 3 fixture rule files → warnings badge shows lint counts; a rules file targeting missing columns shows the inapplicable warning; pertinence strip reflects rules coverage.

## Deferred notes
*(agent fills in)*
