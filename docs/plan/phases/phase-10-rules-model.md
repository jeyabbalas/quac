# P10 — Rules model, CSV parse/serialize, static lint, assertion DSL

## Goal
The `.quac.csv` format becomes code: parser + lossless serializer with all Excel-round-trip rules, static lint (stages 1–3), the 8-assertion DSL with exact SQL expansions, and the SQL builder utilities (`__value__` substitution, engine wrappers).

## Depends on
P02 (fixture rule files pin the contract). P01 harness. (No bridge/UI needed — this phase is pure node.)

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-format.md` (ALL — the contract) · `docs/plan/specs/qc-rules-engine.md` (§1 interfaces, §7 lint stages 1–3, §9 test names).

## Tasks
1. `src/core/rules/types.ts` verbatim from `qc-rules-engine.md §1` (QCRule, RuleFile, engine/lint types).
2. `parse.ts`: PapaParse wrapper — header-by-name (trimmed, case-insensitive), delimiter auto-detect, BOM strip, empty-row skip, extras preservation, formula-guard trim, enum canonicalization, pipe-list parsing.
3. `serialize.ts`: writer per `qc-rules-format.md §7` — UTF-8 BOM, CRLF, RFC 4180 minimal quoting, canonical column order + extras, explicit defaults, formula-guard injection. Round-trip guarantee: parse→serialize→parse fixpoint.
4. `lint.ts` stages 1–3: structural checks, cross-file `rule_id` uniqueness, (type,scope) matrix, update-expression presence rules, `__value__` misuse, `select-in-row-scope`, top-level `;` rejection, smart-quote hint, `LintCode`/`RuleLintIssue`/`RuleFileLintResult` shapes exactly per spec.
5. `assertions.ts`: grammar parser (`name(args…)`, `key=value`) + the §4.1 expansion table as code returning violation-condition SQL per target (plus the `count_distinct_in_range` aggregate form).
6. `sql.ts`: pure builders — `quoteIdentifier` reuse, `expandValueToken(rule)` → per-target (cond, expr) pairs, wrapper generators (viol-count, viol-fetch, correction capture, CTAS rebuild `SELECT * REPLACE (...)`, JS staged-merge), `stripTrailingSemicolon`.

## Deliverables
The complete rules front-end (no execution): parse/lint/serialize/assertions/sql-builders, all pure.

## Out of scope
Execution (P11+), SQL dry-run lint stage 4 (needs dataset — P12), Studio.

## Verification
- **Unit (node):** `tests/unit/rules/parse.test.ts` (**T-CSV-ROUNDTRIP**) — fixpoint on the 3 fixture files; Excel-mangled variants: BOM, CRLF, semicolon-delimited, uppercase TRUE, smart quotes in comment (accepted) vs in SQL (lint hint), multiline SQL/JS preserved, formula-guard space trimmed. `lint.test.ts` (**T-LINT**, static codes) — one test per static LintCode with exact file/ruleId/rowNumber/csvColumn. `assertions.test.ts` (**T-ASSERT-EXPANSION**) — snapshot all 8 expansions incl. `monotonic(increasing, order_by=wave, partition_by=household_id)`; execute each expansion against the `qc_fixture` table on `@duckdb/node-api` and assert expected violating `__row__`s (incl. `count_distinct_in_range` boundary inclusivity). `sql.ts` builder snapshots incl. `__value__` substitution ×4 targets.
- **UI/UX:** n/a (pure phase).

## Deferred notes

*Shipped 2026-07-23 on branch `p10-rules-model` (sibling worktree; P05/P06 ran in parallel). All spec-silent
points below are also documented at their code sites.*

**Created ahead of other phases (treat as pre-existing):**
- `src/core/flags/flag.ts` — canonical `QCFlag`, verbatim `architecture.md §5` + `export`. P10 needed it because the
  §1 engine types (`EngineOptions.onFlags`, `RunResult.flags`) reference it. **P08**: build flagStore/messages around it.
- `tests/unit/rules/support.ts` — the engine-§9 / testing-strategy-§3.1 `qc_fixture` seed (in-memory `@duckdb/node-api`,
  table + view `data`, `SQLRunner` adapter with bigint→Number). **P11**: reuse it; two rows extend the §9 list —
  `__row__ 14` (interview_date NULL → extra H002 hit) and `__row__ 15` (interview_date `'   '` → extra H004 hit;
  tenure 9 for in_enum coverage, outside every fixture rule's tenure sets). Fold both into expected-flag manifests.

**Documented deviations / spec-silent resolutions:**
- parse.ts uses Papa `header:false` + manual mapping (engine-§7 stage 1 sketches `header:true`) — required for verbatim
  extra-header preservation, physical rowNumbers across skipped empty records, and trailing-padding drops. `'|'` is
  excluded from `delimitersToGuess` (Papa's default list includes it; pipe-heavy `target_variables` would win the vote).
- Severity default for `external` rules = `error` (spec table only gives validate→error, correct→info; uniform
  "error except correct" matches §7's explicit-defaults example).
- Blank `target_variables` on external rules is accepted: engine-§1's `// [] only for dataset/external` wins over the
  format-§2 scope-only requirement (targets exist for flag addressability, which never applies to never-executed rules).
- Required headers = the six §2 Required=yes columns; the four defaultable columns are optional headers (a missing
  update_expression header still surfaces per-rule as `missing-update`).
- Extras keyed by the VERBATIM original header (round-trip-exact even when padded); duplicate extra names last-wins;
  interior empty-named headers ignored (only trailing-empty is spec'd); serializer emits exactly one trailing CRLF.
- Assertion grammar accepts positional bare identifiers (the §4.1 grammar summary omits them, but
  `monotonic(increasing)` requires one); `in_range` accepts quoted-string bounds (date ranges) — Studio help should say so.

**Handed to later phases:**
- Lint stages 4–6 codes (`sql-error`, `js-error`, `unknown-target`, `pertinence`, `pending-data`) ship in the union but
  are never emitted here; `executable` = enabled ∧ error-free until P12 adds the applicability dimension.
  `empty-comment` fallback TEXT generation belongs to the flag renderer (P11/P14).
- **P11**: `stripTrailingSemicolon` guarantees an appendable result (trailing comments removed, unterminated line
  comment closed), but a dataset SELECT that already contains its own `LIMIT` will still break the pseudocode's
  `+ " LIMIT n"` append (DuckDB syntax error → broken rule). If that bites, wrap in a subquery instead.
- **P13**: `jsMergeCtasSQL` is provisional (engine §3 only sketches it); validate the qualified-star
  `SELECT data.* REPLACE (…)` join shape against real DuckDB before relying on it.
