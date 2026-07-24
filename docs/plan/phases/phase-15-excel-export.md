# P15 — Excel QC report export

## Goal
The downloadable five-sheet styled `.xlsx` per the exact workbook spec: annotated Data sheet with `<col>__review` sister columns, Missing Variables, Dataset Findings, Repeat Offenders, Run Info.

## Depends on
P14.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-report-spec.md` (§5–§6 — the contract, follow verbatim) · `docs/plan/specs/testing-strategy.md` (report test rows).

## Tasks
1. `src/core/report/reportModel.ts` (pure): build the full workbook model from FlagStore + ColumnMeta + RunInfo + a row source (`quac_work` streamed 10k rows/chunk) — review-column placement (only flagged columns) with deterministic collision escalation (`age__review_2`), `__row_review` as column A, per-cell merged text (pipeline order, `"; "`-joined, 8-flag cap `(+N more)`, 32,767-char guard), corrected-cell suffixes, fills by max severity (+corrected-only green), truncation notes, sheets 2–5 content per spec.
2. `excelWriter.ts`: lazy `import('exceljs')`; render the model 1:1 (frozen row 1, autofilter, header styling, column widths 10–40, fills with the spec's ARGB pairs); stream rows; produce a Blob + download with filename `quac-report_<dataset-stem>_<YYYYMMDD-HHmm>.xlsx`.
3. Wire the Summary panel's Download button (progress via DuckProgress; export is cancel-safe).
4. Extend `check-bundle-size.mjs` allowlist for the exceljs lazy chunk; assert it is not in the entry bundle.

## Deliverables
Byte-assertable Excel report downloadable from the Report view.

## Out of scope
Anything not in the workbook spec; PDF/CSV report variants.

## Verification
- **Unit (node):** `tests/unit/report/reportModel.test.ts` — collision `age__review` (source column exists) → `age__review_2`; merge order + 8-flag cap; `__row_review` placement; no review column for clean columns; truncation row logic. `tests/unit/report/excelRoundtrip.test.ts` — write with exceljs, re-read with exceljs: sheet names/order, review text incl. `(corrected: 999 → -999)`, severity fills on the right cells, frozen pane, widths clamped.
- **UI/UX:** Playwright `tests/e2e/download.spec.ts` — full run on the dirty fixture → click Download → capture the download event → parse bytes in-test → assert a known seeded violation's review text and fill, and Sheets 2–5 exist with expected header rows.

## Deferred notes

**Shipped as planned.** Pure model (`reportModel.ts`) + lazy exceljs writer (`excelWriter.ts`) + lazy orchestrator
(`reportExport.ts`); Download button live; bundle gate extended. Unit 461 (16 model + 5 round-trip new) · browser 44 ·
e2e 36 (download.spec new) green. Entry 29.7 KB gz; exceljs lazy chunk 249.9 KB gz, asserted out of the entry graph.

Spec-silent resolutions / deviations (successors trust these):
- **V21 — no browser streaming write.** exceljs's `stream.xlsx.WorkbookWriter` is Node-`fs`-only, so the spec's
  "streamed in 10k-row chunks" is honoured on the READ side (paged `reportRowsSQL`, cache cleared per chunk) while
  the workbook is assembled in memory and emitted via `writeBuffer()` → `Blob`. Fine at v1 scale; if a
  >~500k-row export is ever needed, revisit (there is no in-browser streaming xlsx writer in this library).
- **exceljs UMD interop.** API is reachable only under the ESM-interop `default` (`import('exceljs')` →
  `{ default: ExcelJS }`); `mod.Workbook` is undefined. exceljs moved devDep→dep (a `src/` module imports it);
  `optimizeDeps.include` gains it so Vite pre-bundles it once (avoids the late-discovery reload flake).
- **`__row__` inclusion.** `reportRowsSQL` keeps `__row__` (unlike `DISPLAY_EXPORT_SQL`) — it keys the model's
  per-row decoration lookup and is simply never emitted as a workbook column. Report data row = `__row__ + 2`.
- **No `__row_review` on real HESP runs.** Row-scope *validate* rules emit one **cell** flag per target column
  (engine `runRowBool`), and schema conditionals attribute to target columns (cell scope) — so a normal run
  produces no `scope:'row'` QCFlags and the model omits `__row_review` entirely. Q003 (row rule) therefore
  merges into `record_id__review` alongside the schema pattern flag. `__row_review` placement + escalation is
  still exercised by a synthetic row flag in `reportModel.test.ts`.
- **Cell-truncation marker.** The 32,767-char guard appends `"… (truncated)"` (spec says "guard", not the exact
  marker). The 8-flag cap uses `" (+N more)"` (leading space, joined after `"; "`).
- **Sheet 3 affected count** uses the exact per-rule counter (`violationCount` ∪ schema `countsByRuleId`) with a
  fallback to the FlagStore dedupe count — never a truncated list. **Sheet 5 (Run Info)** is the creative-freedom
  sheet: version (build-time `__QUAC_VERSION__`), timestamp, dataset dims, schema/rules file lists + resolved
  root/index, stage durations, corrections, caps in effect, and truncation/cancel/cap notes.
- **Column-header tint** for column-scope flags uses the severity fill's bg + fg (bold) so tinted headers stay
  readable (a white-on-light-yellow header would not); review headers are italic gray on the dark header fill.
- **App-version source.** `src/app/version.ts` reads a Vite `define` from `package.json` rather than importing the
  JSON, so P20's version bump flows through with no code change and no JSON import in the bundle.

Not done (out of scope, as planned): PDF/CSV report variants; any streaming-write path; changes to the in-app panels'
rendered content (only the shared helpers moved to `reportModel.ts`).
