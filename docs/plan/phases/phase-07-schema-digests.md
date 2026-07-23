# P07 — Column digests & pertinence

## Goal
Build the static analysis layer every downstream consumer shares: per-column `ColumnMeta`/`ValueSpec`, the `ConditionalRule[]` digest of all if/then blocks, tooltip content, the missing-variables artifact, and the shared data-pertinence check with its UI strip.

## Depends on
P06.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/json-schema-subsystem.md` (§D.2 digests, §E complete) · `docs/plan/specs/qc-report-spec.md` (§3 tooltips) · `docs/plan/specs/ui-design.md` (PertinenceStrip, block modal).

## Tasks
1. `src/core/schema/column-meta.ts` + `value-spec.ts`: `buildColumnMeta(set, rootFileId)` per §E.1 (walk allOf → categories → properties; resolve refs via the registry; fold anyOf/oneOf branches into ValueSpec kinds; capture x-unit/x-universe/x-role/x-variable-group/x-derivation, $comment, required).
2. `conditionals.ts`: extract all root `items.allOf` if/then blocks into `ConditionalRule[]` (§D.2) with conditionText and target kinds (`const` / `not-const` / `not-enum` / `schema`), comments captured; wire `ColumnMeta.conditionals` cross-indexes.
3. `value-spec.ts`: `renderExpectation()` per §D.4 (used by tooltips now, translator in P08 — export it standalone and pure).
4. `tooltips.ts`: `buildTooltip(meta, conditionals)` → data-table `ColumnHeaderTooltipContent` per §E.2 (caps: 12 codes, 5 conditionals).
5. Missing-variables artifact (§E.3) + `summarizeColumnRules` (§E.4).
6. `src/core/pertinence.ts` (SHARED module): `PertinenceResult` per §E.5 — exact-match policy, case-mismatch detection, thresholds (block <0.5 with continue-anyway, warn <1); consumes ColumnMeta now, rules targets later (P12 extends inputs, same module).
7. UI: `PertinenceStrip` under the slot cards + the block modal; wire to store so it re-computes when data or schema changes.

## Deliverables
Digest layer + pertinence module + strip UI. (No flags/validation yet.)

## Out of scope
Translator/FlagStore (P08), casting/validation (P09), tooltip *wiring into the grid* (P14 — but `buildTooltip` ships now and is unit-tested).

## Verification
- **Unit (node):** `tests/unit/schema/column-meta.test.ts` — golden digests for `wage_income_annual` (range + 4 sentinels + unit + universe), `selfemp_income_annual` (signed range + exclusions), a `yes_no` column (codes), `split_origin_household_id` (pattern + string sentinels), `cross_section_weight` (number); counts: 265 columns, all required. `conditionals.test.ts` — 171 rules; `baseline_record` block → 2 `const` targets; `moved_since_last_wave=1` block → `not-const`; comments present. `pertinence.test.ts` — thresholds at score 0 / 0.4 / 0.6 / 1.0; `AGE` vs `age` near-miss; zero-property schema skip.
- **UI/UX:** Playwright (extend `schemaLoad.spec.ts` or new) — load HESP schema + `hesp_dirty_100.csv` → strip shows "265/265 … [OK]"; load `tiny/people.csv` against HESP schema → block modal appears, "continue anyway" downgrades to warning strip.

## Deferred notes
*(agent fills in)*
