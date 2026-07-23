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
*(agent fills in)*
