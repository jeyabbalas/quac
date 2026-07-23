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
*(agent fills in)*
