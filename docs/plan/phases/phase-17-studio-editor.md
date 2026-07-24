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

- **Column feed via `DESCRIBE quac_work`**, not the task's `PRAGMA table_info('quac_work')` — `describeColumns` (casting.ts) is the codebase idiom and returns the identical name/type pairs; reused instead of adding a second query shape.
- **Graceful no-dataset behavior (user-approved interpretation of task 5):** the framed view-level empty shows only when NOTHING is loaded (no dataset AND no rule files). Rules-without-dataset renders the full workspace plus an info banner ("SQL checks are pending until then" + Go to Load); per-rule lint badges read `pending`. The literal reading (empty state whenever no dataset) would contradict P18's "Save untested" flow.
- **Completion catalog only with a live lint context:** `getLintContext()` (new rules-store export) gates both `DESCRIBE` and the session-cached `SELECT DISTINCT function_name FROM duckdb_functions()` — Studio never calls `getBridge()`, so composing rules before any dataset never boots the 35 MB wasm. Without a catalog the editors still complete `__row__`/`__value__` and the assertion snippets.
- **data-table's `CodeMirrorExpressionEditor` + `DUCKDB_FUNCTIONS` deliberately unused:** the filter-bar editor is single-line/filter-oriented; the studio needs multiline SQL/JS modes, push diagnostics, and the schema-aware `lang-sql` config. Sharing would couple the studio to data-table's private editor contract.
- **Push-model diagnostics:** ONE 400 ms debounce for the whole draft (`runDraftLint` wraps the rule in a synthetic one-rule ParsedRuleFile → `lintRuleFilesWithDataset` stages 2–6 verbatim) and results are pushed via `setDiagnostics`, mirrored to a stable `ul.q-editor-diags` per editor. Per-editor `linter()` pulls would double the EXPLAIN traffic and split one draft into two lint schedules. Diagnostics span the whole doc — DuckDB reports no offsets.
- **Draft lint pauses while the pipeline runs** (`isRunningStage`) — a mid-run EXPLAIN could hit a swapped `quac_work` — and resumes on settle. Same guard skips catalog refreshes during runs.
- **Save is gated only on rule_id validity/uniqueness** (P18's test-before-save gate lands on this button); draft-lint errors never block saving — partial acceptance, matching file loads. Async `byField.rule_id` issues are not mirrored under the field: the synchronous gate owns that surface.
- **Delete has no undo** (P18's export/import is the recovery story today).
- **Empty-file asymmetry (sanctioned):** `createRuleFile` hand-builds a pristine ParsedRuleFile (0 rules, all canonical headers, no issues) so a fresh file doesn't open branded with the upload-oriented `empty-file` error; deleting a file's last rule goes through the serialize→parse round-trip and re-acquires it.
- **Mutation round-trips normalize:** every mutator re-parses `serialize(mutatedFile)`, so rowNumbers renumber (UI selection keys on `(fileName, index)`), enum text canonicalizes, and a file missing optional/required headers gains the full canonical header on first edit (missing-header errors resolve). The form cannot represent invalid enum cells — loading such a rule falls back to format defaults and saving normalizes the row.
- **`.q-paneltab` is now dual-consumer** (report panel tabs + the update_language switch) while its rules still live in reportView.css (eagerly bundled via the shell import). Promote to primitives.css in P19/P20.
- **Manual keyboard-only pass (2026-07-24, Chrome via browser tools, preview build):** rail → New file → file buttons (Enter selects; focus stays on the selection — a drop-to-body found in this pass was fixed, 47179c2) → Add rule → grid rows (Enter opens) → drawer focuses rule_id → Tab walks the form INTO and OUT of both CodeMirror editors (no Tab binding = no trap) → Esc on a dirty draft raises the Discard confirm (focus-trapped) → discard closes and restores focus to the opening row. Note: chip × buttons sit in the tab order (Space removes a target) — standard button semantics, kept. DuckDB-wasm would not boot in the extension-driven background tab (30 s worker-init timeout — tab throttling, not an app issue), so the pass ran on the rules-without-dataset path; the with-dataset flow is covered end-to-end by `studio-edit.spec.ts`.
- **Pre-existing e2e flake observed (NOT P17):** under parallel load, `download.spec.ts` intermittently sees a run with most rules excluded ("Rules run: 9" of 22; 25/0/5 counts). Mechanism: the rules slot installs the dataset lint context as soon as the dataset lands, so rules EXPLAIN against the still-all-VARCHAR `quac_work`; arithmetic rules transiently publish `sql-error` results (exactly the hazard typedSync's header documents), and a Run clicked inside that window excludes them via `executableRuleFile`. Reproduced on the pre-P17 base (4/6 with `--repeat-each=6 --workers=6`) — CI retries absorb it today. Follow-up candidate (P18/P20): sequence context installs behind the typed rebuild, or re-derive exclusions at run start.
