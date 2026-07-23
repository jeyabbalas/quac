# P17 — Rule Studio: workspace & editor

## Goal
The Studio view exists: rule-file rail, rule grid, the full editor form with live validity-matrix enforcement, and CodeMirror SQL/JS editors with schema-aware completion and debounced lint.

## Depends on
P12 (rules engine + lint), P05 (dataset for completions/preview data). P13 helpful for js lint (else js lint stays compile-stub).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-engine.md` (§7–§8) · `docs/plan/specs/qc-rules-format.md` (§2–§4) · `docs/plan/specs/ui-design.md` (Studio wireframe, components).

## Tasks
1. Studio view scaffold per the wireframe: left rail = loaded rule files (group, count, lint badge, pertinence badge) + "New file"; file's rule grid (id, type, scope, targets, severity, enabled toggle, lint status — a simple component, NOT data-table); row click → editor drawer; duplicate / delete / move up-down (tooltip: "Row order = correction order").
2. `RuleForm`: fields ↔ CSV columns 1:1; dropdowns enforce the (type,scope) validity matrix live; `target_variables` = searchable multi-select fed from `PRAGMA table_info('quac_work')`; comment textarea with rendered annotation preview (`"{ruleId}: {comment}"`); severity/enabled controls.
3. `CodeEditor` (CM6 wrapper): `@codemirror/lang-sql` with PostgreSQL dialect; `schema: { data: [columns…] }`; custom completion source merging DuckDB functions (`SELECT DISTINCT function_name FROM duckdb_functions()` once per session), `__row__`, `__value__` (correct rules only), assertion-vocabulary snippets (scope=column); `@codemirror/lint` debounced 400 ms against the engine's EXPLAIN wrappers (reuse lint stage 4); js mode → `lang-javascript` + QuickJS compileCheck when available.
4. In-session rule mutations flow through the P10 model (parse/serialize untouched); edits mark the file dirty (export in P18).
5. Empty state when no dataset is loaded ("Load a dataset to compose rules against it — completions and previews need your columns") with a link to Load.

## Deliverables
Fully editable rules workspace with intelligent editors; no preview/export yet.

## Out of scope
Live preview, test-before-save gate, export/import (all P18).

## Verification
- **Unit (node):** `tests/unit/studio/completionSource.test.ts` — completion feed composition (columns + functions + tokens + assertion snippets by scope/type); validity-matrix enforcement logic.
- **UI/UX:** Playwright `tests/e2e/studio-edit.spec.ts` — open Studio with fixtures loaded; create a rule; type a condition referencing a typo'd column → inline lint diagnostic appears with the DuckDB message; switch scope to column → assertion snippets appear in completions; matrix blocks `correct` + `dataset`. Manual: keyboard-only pass through the form + editor (note in log).

## Deferred notes
*(agent fills in)*
