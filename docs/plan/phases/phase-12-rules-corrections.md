# P12 — Rules corrections (SQL), integrated lint, hardening, rules slot

## Goal
SQL correction rules mutate `quac_work` atomically with before/after capture; lint gains its dataset-dependent stages (SQL dry-run, pertinence, pending-data); the hardening sequence is enforced and browser-proven; the QC Rules slot card ships.

## Depends on
P05 (ingest/work tables), P11 (engine core).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-engine.md` (§2–§7) · `docs/plan/specs/qc-rules-format.md` (§5) · `docs/plan/specs/architecture.md` (§4, §8, Verified facts V6) · `docs/plan/specs/ingestion.md` (§4).

## Tasks
1. Corrections in `engine.ts` per the pipeline pseudocode: `setseed(0.42)`; `expandValueToken`; per-target capture queries (`before`/`after`/`hit` computed in the inner SELECT list — window-safe) with no-op suppression (`after IS DISTINCT FROM before`); ONE atomic CTAS `SELECT * REPLACE (...)` per rule covering all targets; swap + view refresh + `clearQueryCache()`; failure → drop `quac_work_next`, broken stat, continue. Correction flags carry `correction:{before,after}`, default severity `info`.
2. Assess-only mode (`applyCorrections:false`) skipping phase 1 cleanly.
3. Lint stages 4–6 in `lint.ts`: `EXPLAIN` dry-run of the EXACT engine wrappers per rule (row viol-select / rebuild SELECT / dataset statement), binder errors surfaced with file+ruleId+rowNumber+csvColumn, smart-quote hint; JS `compileCheck` deferred to P13 (emit `pending` for js rules with a TODO note); pertinence integration (extend `core/pertinence.ts` inputs with rules targets); `pending-data` lifecycle (lint re-runs when the dataset changes).
4. Hardening wiring: `hardenBridge()` called at run start before any rule SQL (pipeline `prepare`); browser test proving httpfs reads fail, `lock_configuration` holds, and the correction path still works hardened.
5. UI: Rules `SlotCard` (multi-file, per-file badges, lint detail list grouped file→rule, pertinence line) per `ingestion.md §4`; pertinence strip now includes rules coverage.

## Deliverables
Full SQL-rules execution (validate + correct) against the real bridge; complete lint; Rules slot UI.

## Out of scope
JS corrections (P13), run orchestration UI (P14), Studio.

## Verification
- **Unit (node + @duckdb/node-api):** `tests/unit/rules/corrections.test.ts` — **T-CORRECT-SENTINEL-IDEMPOTENT** (before=999/after=-999 captured; second run: zero flags, byte-identical table; untargeted columns unchanged), **T-CORRECT-ORDER** (Q047→Q050 right; reversed wrong — file order is the contract), **T-CORRECT-WINDOW** (Q055 carry-forward; single-pass semantics: fills from pre-rule values). `lint.test.ts` extension — `sql-error` (with exact location), `pertinence`, `pending-data`→resolved transition.
- **Browser:** `tests/browser/rulesExec.browser.test.ts` — representative fixture rules through the real hardened bridge produce the same flags as the node run; `tests/browser/harden.browser.test.ts` extension — httpfs blocked during rules, corrections still succeed.
- **UI/UX:** Playwright `tests/e2e/rulesLoad.spec.ts` — drop the 3 fixture rule files → warnings badge shows lint counts; a rules file targeting missing columns shows the inapplicable warning; pertinence strip reflects rules coverage.

## Deferred notes

**Deviation — the swap (task 1 wording superseded by V14).** The corrections swap is ONE
`CREATE OR REPLACE TABLE quac_work AS <rebuild SELECT>` per rule (reading the view `data`), not the
`quac_work_next` → `DROP` → `RENAME` dance this file and the §3 pseudocode prescribe. V14 pinned the dance
unnecessary, and it has a destructive window (a failure between `DROP quac_work` and the rename would leave
`quac_work_next` holding the only copy, with the failure path told to drop it). `CREATE OR REPLACE` fails
atomically — a broken rule leaves the table untouched with nothing to clean up. V14's pin read `FROM
quac_work` directly; the via-VIEW variant is proven on wasm by `rulesExec.browser.test.ts` (post-correction
row content). `ctasRebuildSQL` (byte-pinned, quac_work_next) stays exported but unused by the engine; P13's
`jsMergeCtasSQL` should adopt the same V14 shape. Similarly, task 4's "lock_configuration holds" predates V6
— the browser tests assert the V6-replacement invariants (https dies locally inside the worker; corrections
succeed hardened).

**Engine contracts fixed here (spec-silent):**
- Assess-only (`applyCorrections:false`, default true) emits NO `perRule` entries for correct rules — not
  even `skipped-disabled` (Q057). P15's report will meet this asymmetry.
- Correction stats: `violationCount === changedCells` = changed CELLS (per-target exact counts summed);
  correction flags carry `value: before`; per-target row-cap summaries read "…and N more rows corrected by
  this rule"; the global-cap suppression summary matches P11's wording.
- `perRule` order: corrections stats first (file order over correct rules), then the P11 one-pass
  validate/external order. `flushRule()` fires only after the swap succeeds — a rule whose CTAS fails
  delivers exactly one broken flag and zero cells to `onFlags`.
- `EngineOptions.workTable` remains accepted-but-unused (the SQL builders pin literal names);
  `jsSandbox` is ignored in P12 — js correct rules are ALWAYS broken ("JS corrections require the QuickJS
  sandbox (P13); rule not executed"), even if a sandbox object is passed.
- `setseed(0.42)` makes runs reproducible, but the count, capture, and CTAS each advance the RNG stream —
  a `random()`-using rule gets capture values that differ from what the CTAS writes (spec-inherent; §2's
  deterministic-donor guidance is the answer).
- T-CORRECT-SENTINEL-IDEMPOTENT reads "second run" as run-on-corrected-data: runQC always rebuilds from
  `quac_typed` (determinism), so the test promotes work→typed between runs; a literal re-run is pinned as
  byte-identical determinism instead.

**Lint stages 4–6 resolutions (spec-silent):**
- Per-rule missing targets → `unknown-target` (warning, names the columns + case-mismatch hint); the <50%
  file banner is the `pertinence` code. `executable` = enabled ∧ error-free ∧ applicable.
- `external` rules are exempt from stage 4/6 (never executable — Q044 must not warn) and keep counting in
  `executable` exactly as the P10 static pin does.
- Stage 5 placeholder: js rules emit an info `pending-data` ("JS compile check pending…") that does NOT
  resolve on dataset arrival — only P13 replaces it; their SQL `condition` is still dry-run.
- No dataset → ONE file-level `pending-data` info per SQL-bearing file (external-only files stay silent).
- Disabled-but-applicable rules ARE dry-run (one toggle from running).
- Correct-rule dry-run: `violCountSQL` of the FIRST expanded pair's condition (attribution → `condition`
  csvColumn; `__value__` must be substituted before any SQL is valid), then `rebuildSelectSQL(pairs)`
  (attribution → `update_expression`); a failed condition suppresses the rebuild run (no double report).
- Lint binds against the post-ingest `data` view. Without a schema, delimited ingests are all-VARCHAR
  (V17 raw fidelity), so arithmetic rules bind-error — honest "cannot run on untyped data" signals, which
  is why `rulesLoad.spec.ts` uses the parquet fixture for its clean path. Schema-cast lint context is P14's
  concern (casting runs inside the schema stage).
- EXPLAIN stops at the binder: runtime failures (bad CASTs on data) still surface as broken rules at run
  time (T-BROKEN-RULE embraces this).

**UI resolutions:** slot badge = Error only for structural file failures (missing-header/empty-file) and
URL-fetch failures; row-level lint errors → Warning (partial acceptance — the rest of the file runs).
Summary shape "3 files · 22 rules · 2 lint warnings" (+ "data checks pending" before a dataset exists).
Re-dropping a filename replaces that file IN PLACE (load order = correction order). The pertinence strip's
rules line lives in its own `.q-pertinence-rules` element (`.q-pertinence-text` stays byte-stable for the
P07 e2e pins) and the strip now shows for Dataset+Rules without a schema; the block modal stays
schema-driven; rules-only badge is OK/Warning (never Blocked). The relint effect never boots the bridge on
the no-dataset path. Cross-phase e2e touch: `ingest.spec.ts` oversize-test locator scoped to the dataset
card (the Rules card added a second `.q-dropzone`).

**Test infra:** the qc_fixture seed SQL moved to `tests/shared/qcFixtureSql.ts` (pure extraction;
parameterized table name + the node⇄browser runQC parity manifest); `support.ts` gains `openQcTyped()`
(seeds `quac_typed`, no `data` view — runQC's prepare owns it). `__quacDev.runRules(applyCorrections?)`
is the interim hardening call site (P14 deletes it with the schema hook).
