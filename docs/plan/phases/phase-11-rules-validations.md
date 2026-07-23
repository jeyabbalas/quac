# P11 — Rules engine: validations

## Goal
Execute `validate` rules end-to-end over the `SQLRunner` abstraction: row/longitudinal conditions, column-assert expansions, dataset SELECTs — with exact counts, caps, per-target cell flags, and the broken-rule policy.

## Depends on
P08 (FlagStore), P10 (parse/assertions/sql builders). Node-only phase (browser wiring through the real bridge lands in P12).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-engine.md` (§1–§3 validations paths, §5, §9) · `docs/plan/specs/qc-rules-format.md` (§4, §9).

## Tasks
1. `src/core/rules/engine.ts`: `runValidations(runner, ruleFiles, opts)` implementing the phase-3 pseudocode — enabled/file-order iteration, `targetsMissing` skip (via `core/pertinence.ts` inputs), the three interpretation paths:
   - rowBool (row + longitudinal + per-target assertion expansions): exact `COUNT(*)` wrapper → capped `__row__`-ordered fetch → `emitCellsPerTarget`.
   - columnAggregate (`count_distinct_in_range`) → single column flag.
   - datasetSelect → `LIMIT datasetRowCap+1`, one dataset flag per row with `col=val` rendering, truncation summary flag.
2. Caps + truncation summary flags per §5 (10k/rule, 200/dataset rule, 200k global sink with count-only summaries past it); `RuleRunStat` bookkeeping with EXACT `violationCount`.
3. Broken-rule policy: SQL error → `broken` stat + dataset-scope error flag "Rule failed to execute: …"; run continues; `external` → `skipped-external`; disabled → `skipped-disabled`.
4. Progress + incremental `onFlags` callbacks.
5. `SQLRunner` node implementation over `@duckdb/node-api` for tests (thin adapter; the browser adapter over `bridge.query` + `clearQueryCache` is trivial and lands here too, exercised in P12).
6. Seed helper that materializes the `qc_fixture` table (per `qc-rules-engine.md §9`) — shared by this phase's and P12's tests.

## Deliverables
`engine.ts` validations paths, node SQLRunner + fixture seeding, full test battery green.

## Out of scope
Corrections (P12), JS rules (P13), UI.

## Verification
- **Unit (node + @duckdb/node-api):** `tests/unit/rules/engine.test.ts` — **T-KEY-UNIQUE** (both duplicate members flagged, cell scope, right `__row__`s), **T-PARSE-KEY** (only mismatched row; NULL-guarded rows unflagged — three-valued-logic regression), **T-LAG-AGE** (exactly the wave-3 row; wave-gap guard suppresses non-adjacent), **T-TOLERANCE** ($200-on-$10k flagged, $60 not, sentinel row excluded), **T-PCTL** (window quantile within wave partition), **T-BROKEN-RULE** (lint-clean but runtime-failing rule → broken + others still run + table untouched), **T-CAPS** (25k violations, cap 10k → 10k×targets flags + summary + exact 25000).
- **UI/UX:** n/a (engine phase).

## Deferred notes
*(agent fills in)*
