# P08 — FlagStore & schema translator

## Goal
The canonical flag layer (`QCFlag`, FlagStore, the single rendering function) plus the pure Ajv-error→flag translator with its full keyword coverage and golden human-readable messages.

## Depends on
P07 (digests).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/architecture.md` (§5 QCFlag + rendering rule) · `docs/plan/specs/json-schema-subsystem.md` (§D complete — the heart of this phase) · `docs/plan/specs/qc-report-spec.md` (§1 FlagStore).

## Tasks
1. `src/core/flags/flag.ts` (canonical QCFlag — verbatim from `architecture.md §5`), `flagStore.ts` (dedupe key, indexes byCell/byColumn/byRule/datasetScope, aggregates, deterministic ordering, incremental batches, cap accounting with exact counters), `messages.ts` (`renderFlag(flag)` → `"{ruleId}: {message}"` + correction suffix — the ONLY formatter).
2. `src/core/schema/translator.ts`: `translateRowErrors(errors, row, ctx)` per §D.3 — wrapper dropping, column bucketing, priority resolution (castFailures → missingColumns → required → conditional attribution via the `^#\/allOf\/(\d+)\/(then|else)\//` schemaPath regex → anyOf/oneOf collapse with sub-error suppression → per-keyword fallback), unevaluatedProperties dedupe, generic-keyword fallback template. Pure; deterministic sort `(row, columnOrdinal, ruleId)`; `Intl.NumberFormat('en-US')`.
3. ruleId scheme per §D.5 (constants + builder helpers, exported for P09's dataset checks and P02's manifests).
4. Golden messages: implement so the ten §D.7 examples render CHARACTER-EXACT; store goldens as string literals in tests (they become documentation).
5. Record real Jv error arrays for the collapse/attribution tests: small script or inline — run Ajv (node) on `synthetic/mini` + targeted HESP rows, snapshot the raw error arrays as fixtures so translator tests don't depend on Ajv at test time.

## Deliverables
`core/flags/*`, `core/schema/translator.ts`, golden-message test suite.

## Out of scope
Running validation at scale (P09 owns Ajv setup/worker); annotations/report rendering (P14/P15).

## Verification
- **Unit (node):** `tests/unit/flags/flagStore.test.ts` (dedupe, indexes, aggregate math, cap ordering errors-first, exact counters past cap). `translator.test.ts` — ≥1 golden per §D.6 keyword row incl. the generic fallback. `anyof-collapse.test.ts` — recorded error arrays → exactly ONE flag per bad cell; suppression verified; oneOf multi-match. `conditional-attribution.test.ts` — then-target attribution, per-(index,column) dedupe, `if`-error dropping, coexistence with a base value flag on the same cell. Determinism property test (shuffled error input → identical output).
- **UI/UX:** n/a (pure phase). Paste two golden messages into the progress log as a readability spot-check.

## Deferred notes
*(agent fills in)*
