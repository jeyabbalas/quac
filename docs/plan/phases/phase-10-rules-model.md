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
*(agent fills in)*
