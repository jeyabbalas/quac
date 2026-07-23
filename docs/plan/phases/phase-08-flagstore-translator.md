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

Spec-silent resolutions and golden-vs-prose conflicts settled in P08 (all unit-pinned; goldens + P02 fixture
manifests were treated as ground truth over §D prose; revisit only with a spec change):

- **Golden #2 replaced per V15** (`selfemp_income_annual = -555` is schema-valid): the pinned
  collapse-with-exclusions golden is `selfemp_income_annual = -6000000` → "below the minimum" lead + the
  "(sentinel codes are not valid substantive values)" clause + full sentinel labels + BOTH `[Unit:]`/`[Universe:]`
  trailers (the spec's golden was abbreviated with `…`).
- **Golden #8 title drift**: the committed HESP schema titles `net_worth` "Household net worth", not the spec's
  "Net worth". Template golden kept; title read from the schema (same drift class as V15, no new V-fact).
- **Trailer scope**: §D.4 says trailers on "all cell templates", but goldens #3/#4/#7 (conditional/required on
  columns that DO carry x-unit/x-universe) show none → trailers attach only to `schema:prop:<col>:value` messages.
- **Conditional template includes the column name** (`when …, move_reason must be -666 …`) although §D.1 says
  messages exclude it — goldens #3/#4 and `mini_expected_flags.json` both include it. The `Found {v}.` clause is
  omitted for `not-const` targets (golden #4: the found value IS the prohibited one — zero information).
- **String-pattern collapse rendering** (golden #6) contradicts §D.4's `text matching {pattern}`: the translator
  renders `a/an {patternTitle} ({humanized regex})` via a narrow humanizer (literal runs + `[0-9]{n}`/`\d{n}`
  classes only, number words 1–20, joined " followed by "); any unparsable pattern falls back to §D.4.
  `renderExpectation` (tooltips, P07-pinned) is untouched.
- **Standalone-pattern gloss** = `patternDescription` only, trailing period stripped (golden #5 uses the def's
  description; mini's inline-titled `id` renders no gloss — matches `mini_expected_flags.json`).
- **Collapse lead selection** (spec-silent): numeric spec + numeric value below min / above max → "is below the
  minimum {fmt}" / "exceeds the maximum {fmt}"; codes spec → "is not an allowed value"; everything else →
  "is not valid". oneOf multi-match appends " (matches more than one exclusive option)" before the period.
- **Unattributable root-level errors** (§D.3.4's "row-scope flag, generic template") get ruleId
  `schema:row:<keyword>` — §D.5 defines no format for them.
- **FlagStore cap mechanics** ("errors-first", spec-silent): severity-tiered admission with eviction — at cap an
  incoming higher-severity flag evicts the newest materialized flag of the lowest tier below it; all counters
  (countsByRuleId, severity totals, per-column, corrections) stay exact past the cap. Default cap 200,000
  (qc-rules-engine §5), constructor-injectable. Evicted-then-re-added flags re-materialize with a fresh count.
- **Correction-suffix value formatting** (spec shows bare `999 → -999`): strings single-quoted, null/undefined →
  `null`, objects JSON-stringified, other primitives via `String()`.
- **Recorded-error fixtures**: `scripts/record-ajv-errors.mjs` is standalone (NOT wired into
  `generate-fixtures.mjs`/`fixtures:check`); re-run manually when schemas change. No fixture row is a split-off
  household, so golden #6's recording mutates `panel_membership_status := 3` (nothing else keys on or targets it).
- **P09 hooks**: `castNonNumericMessage`/`castNonIntegralMessage`/`missingColumnMessage`/`unexpectedColumnMessage`/
  `duplicateRecordsMessage`/`minItemsMessage` + `rule-ids.ts` are exported for validation-run.ts; the optional-
  declared missing-column info-flag message (§E.3) is left to P09. P07's "bare-enum conditional target" nicety
  (generic text) remains deferred — the translator renders whatever `ConditionalTarget.text` provides.
