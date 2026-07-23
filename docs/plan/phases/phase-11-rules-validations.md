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

Shipped 2026-07-23 on branch `p11-rules-validations` (engine.ts header documents the same contracts).
Spec-silent decisions made here:

- **violationCount semantics**: row/longitudinal = violating ROWS (exact `COUNT(*)`); column asserts = SUM of
  per-target counts (violating cells); `count_distinct_in_range` = number of violating targets; dataset =
  returned-row count (exact — `datasetCountSQL` runs only when the cap+1 fetch overflows); broken/skips = 0.
- **onProgress contract**: fires BEFORE each enabled validate rule (inapplicable skips included — they are loop
  work; disabled/external excluded), `index` 0-based, `total` = enabled validate count, `phase` always
  `'validate'`. Pinned in engine.test.ts — P14 renders `(index+1)/total`.
- **flagsEmitted** counts everything the rule delivered (cells + truncation/cap summaries + the broken flag);
  `truncated` = any detail flags withheld (row-cap, dataset-cap, or global-cap suppression).
- **Global cap**: summary + broken flags BYPASS the cap (§5 — they ARE the past-cap mechanism; bounded by
  O(rules×targets)); count-only summary wording: `…and {N} more flags from this rule suppressed (global flag
  cap reached)`.
- **Broken rules are all-or-nothing**: the rule's buffered flags are discarded (cap slots refunded) and only the
  dataset-scope `Rule failed to execute: …` error flag is emitted; mid-rule failures (e.g. target 2 of a
  multi-target assert) therefore never leave partial flags.
- **Stats ordering**: ONE file-order pass with validate+external interleaved (deviation from §3 pseudocode's
  externals-appended-last; same stat set, deterministic file order for the report). `external` →
  `skipped-external` even when disabled (§3 has no enabled filter). `correct` rules get NO stat from
  `runValidations` — P12's corrections phase owns them (avoids double-stat when runQC composes both).
- **Message wordings pinned in tests**: `${comment} Found {n} distinct values.` (count_distinct violation);
  dataset rows `${comment} — col=val; col=val` in SELECT column order (values render like
  formatCorrectionValue: strings quoted, null → `null`, numbers bare); blank-comment fallback
  `Rule condition matched.`; thousands separators via `toLocaleString('en-US')`.
- **Known edge**: a dataset rule carrying its own top-level `LIMIT` parser-errors under the appended cap →
  broken rule; P12's lint SQL dry-run (stage 4) EXPLAINs the same wrapped statement and surfaces it pre-run.
- **For P12**: the browser bridge may deliver bigint values — the engine already coerces counts/`__row__` via
  `Number()` engine-side, so `createBridgeRunner` stays a pure passthrough; runQC must call its `clearCache()`
  after every work-table swap. `EngineOptions.workTable/applyCorrections/jsSandbox` are accepted but unused
  here (validations only read view `data`).
- **DATE caution** (P10 helper knock-on): `@duckdb/node-api` `getRowObjects()` returns DuckDBDateValue objects
  for real DATE columns; `qc_fixture` keeps `interview_date` VARCHAR so the shared adapter only normalizes
  bigint. If P12+ tests add DATE columns, extend `openDuckDb`'s normalization.
