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

Spec-silent resolutions made in P07 (all unit-pinned; revisit only with a spec change):

- **Bare-`enum` conditional targets** (13 in HESP, e.g. allOf blocks constraining a code subset) render the
  generic `schema`-kind text "must satisfy the conditional constraint (see schema)" per §D.2's fallback. A
  nicer "must be one of …" rendering would need a new target kind — deferred (P08 may want it for messages).
- **Sentinel-vs-code split rule** (§E.1 is silent): within a `codes` fold, consts reached via a branch-level
  `$ref` (shared sentinel defs) are `sentinels`, inline consts are `codes`; provenance resets at every
  anyOf/oneOf branch boundary. In `numeric`/`string-pattern` folds ALL const branches are sentinels (matches
  the §D.7 goldens for wage/selfemp/split_origin).
- **`if.anyOf` disjunction** (allOf[175]): conditions flattened, `conditionText` clauses joined `" or "`
  (plain multi-property ifs join `" and "`). The `conditions[]` array does not record the and/or shape —
  fine for cross-indexing; P08's translator matches by allOf index, not by re-evaluating conditions.
- **`then.allOf` blocks** (156, 157, 160, 174): `properties` sub-blocks flatten to per-column targets;
  `anyOf` sub-blocks (cross-column "at least one") emit one deduped `schema`-kind target per mentioned
  column so `ColumnMeta.conditionals.asTarget` stays complete.
- **Generic schemas**: `buildColumnMeta` also digests `items`-level `properties` and inline (non-`$ref`,
  non-`if`) `items.allOf` entries — mini/tiny schemas would otherwise produce zero columns and skip
  pertinence entirely.
- **`computePertinence` returns `null`** for zero-property schemas (skip); the `schema:dataset:pertinence`
  info flag lands with FlagStore in P08+. Score numerator counts matches within the denominator universe
  (required, else all declared) so it stays ≤ 1.
- **`ValueSpec`'s `'mixed' | 'opaque'`** member is split into two structurally identical members in
  types (TS cannot narrow a two-literal discriminant member); semantics unchanged.
- **`DatasetSession.columns`** added (shared surface, isolated commit 6821edc): ingest already computed the
  sanitized names; pertinence and P12 rules-target pertinence consume them without re-querying DuckDB.
- Block modal opens once per `(setId, dataset.generation)` key; after dismissal the Blocked strip carries an
  inline "Continue anyway" so the §E.5 downgrade path stays reachable without re-loading files.
- Tooltip `ColumnHeaderTooltipContent` is a local structural copy of the data-table v0.5.1 type (keeps the
  digest layer free of runtime library imports); P14 passes it to `setColumnHeaderTooltip` unchanged.
