# P18 — Rule Studio: preview, gate, export

## Goal
Rules can be tested live against the loaded dataset (counts + samples + before→after), gated behind test-before-save, and exported/re-imported losslessly.

## Depends on
P17.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-engine.md` (§8 — the contract for previews) · `docs/plan/specs/qc-rules-format.md` (§7 writer rules) · `docs/plan/specs/data-table-api.md` (§6 raw-SQL filters).

## Tasks
1. Studio preview pane hosting a data-table instance (`quac_studio_display`, sampled ≤10,000 rows exported from `data`) + `RuleTestPanel`:
   - validate row/longitudinal: exact violation count + first-20 violating rows via the engine's wrapped `bridge.query` (window-safe); when window-free, also `validateSQLFilter(condition)` and offer "Filter preview to matches" via `addRawSQLFilter` (cleared on panel close).
   - column asserts: show expanded SQL read-only + per-target count/sample.
   - corrections: `__row__ | before | after` capture query LIMIT 20 + exact change count; js corrections run sandboxed on the 20 sample rows only.
   - dataset: run the SELECT LIMIT 20, render a small result grid.
2. **Test-before-save gate:** Save/Add disabled until lint has zero errors AND a preview executed successfully since the last edit ("Tested ✓" indicator). No dataset → explicit "Save untested" (`pending-data`).
3. Export: "Download rules CSV" per the §7 writer (BOM, CRLF, minimal quoting, canonical order + extras, explicit defaults, formula-guard); filename `<group>.quac.csv`. Round-trip guarantee: import → edit one rule → export leaves all other rows byte-comparable after parsing (extras + row order preserved; edited rules replaced in place; new appended).
4. Import-back path: re-import runs full lint; broken rows open the editor with the issue pinned above the offending field.
5. Preview sampling note in UI ("previewing on a 10,000-row sample") when the dataset is larger.

## Deliverables
Golden journey 5 works end-to-end.

## Out of scope
New rule semantics; report integration.

## Verification
- **Unit (node):** `tests/unit/studio/ruleSerialize.test.ts` — import→edit-one→export byte-comparability (after parse) incl. extras and order; formula-guard and BOM present in output; filename derivation.
- **UI/UX:** Playwright `tests/e2e/studio.spec.ts` — compose Q011 against the dirty fixture → Test shows the seeded violation count → "Filter preview to matches" narrows the grid → Add (gate satisfied) → Download → re-import the downloaded file → identical lint state and rule list. Corrections preview: author Q052-style rule, before→after table shows the seeded −2500 → 2500.

## Deferred notes

- **Fixture-reality deviation (protocol #4):** the Verification line's "before→after shows the seeded −2500 → 2500" is
  impossible against the example dataset the e2e loads — the dirty HESP fixture's seeded negative-debt cell is
  `credit_card_balance = −1200` at row 15 (`seeded-violations.json`); −2500 exists only in the node-tier `qc_fixture` seed
  (`tests/shared/qcFixtureSql.ts` row 9). Resolution: `studio.spec.ts` asserts **−1200 → 1200** (fixture truth); the new
  node-tier `ruleTest.test.ts` runs the same Q052-style rule on `qc_fixture` and **pins −2500 → 2500 there**.
- **Gate policy (spec-silent calls, all implemented):**
  - Gate = `rule_id valid+unique ∧ last completed draft lint has zero errors ∧ tested-since-last-edit`, where testability
    mirrors the engine's `applicableTargets` (exact, case-sensitive names). This supersedes P17's "draft-lint errors never
    block saving" — the form tracks `lastLintOk` (nulled by ANY edit, set by each completed lint).
  - ANY field edit, drawer open/close, or file switch resets the test state (token bump) and clears the test panel +
    any applied preview filter.
  - A test "passes" iff the preview executed without error — **0 matches / 0 rows is a pass** ("Tested ✓").
  - js sampling: the exact match count comes from SQL (`violCountSQL` per pair); the user function runs sandboxed on the
    ≤20 sampled rows only. **Partial sample errors pass** with the count surfaced in the result line and the errored rows
    listed in the capture table; **all sampled rows erroring fails** the test.
  - lint-only mode (no lint context / external / any distinct target missing from the dataset): test affordances hidden;
    data-shaped skips save via the explicit **"Save untested"** label; **external keeps the normal label** — it never
    executes, so an "untested" brand would be noise.
  - Tests are **suspended, not queued**, while the pipeline runs (`isRunningStage`) — the user re-clicks after settle.
  - Edit-opens seed the form instantly from the stored file lint (`bucketStoredIssues`, row-scoped issues only) so broken
    re-imported rows show their issues before the 400 ms draft lint refreshes; clean rules satisfy the lint leg immediately.
- **Download placement + dirty semantics:** "Download rules CSV" sits in the grid-card header beside "Add rule" (the
  wireframe drew it in the drawer footer row — the header is reachable without an open drawer). Download does **not**
  clear the dirty `*`; a same-name re-import does (rules-store contract), which golden journey 5 exercises.
- **`RuleTestResult` addition beyond the plan sketch:** the correction variant carries `sampledRows` (0 for sql) so the js
  result line reports the true sample size instead of a hardcoded "20".
- **Preview mutation safety:** counts run against the FULL `data` view (exact); only the browsing grid is the 10k sample
  (`STUDIO_SAMPLE_SQL`, `__rowid__ === __row__` per V7). "Filter preview to matches" is offered only when
  `validateSQLFilter(condition)` passes on the sample table — window functions or `__row__` references simply fail
  validation (same contract as reportGrid's `tryFilterByCondition`); the filter dies with clear/new-test/instance rebuild.
- **Manual UI/UX pass (2026-07-24):** headed-Playwright screenshot walkthrough on the preview build (the Chrome-extension
  browser tools could not reach local servers in this environment — error page on every localhost/LAN attempt). Verified
  visually: 3-column ≥1280px layout, sample grid + "101 rows" meta, gate states (disabled Add → Tested ✓), validate result
  + sample table, filter narrowing the sample to the seeded row (grid shows its SQL filter chip), correction capture
  −1200 → 1200, dirty-marker/download header, and the <1280px stacked layout.
- **Pre-existing `download.spec` flake (P17 notes):** untouched and not observed in this phase's runs; the VARCHAR-window
  lint race remains a P20 follow-up candidate.
