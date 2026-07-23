# P05 — Dataset ingestion & display

## Goal
The Dataset slot works end-to-end: any of the five formats loads into `quac_raw` (with `__row__`), shows a preview and a full data-table grid in the Report view via the display round-trip.

## Depends on
P02 (fixtures), P03 (bridge + Verified facts), P04 (shell/slots host).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/ingestion.md` (all) · `docs/plan/specs/architecture.md` (§3, §4, §9 + **Verified facts**) · `docs/plan/specs/data-table-api.md` (§2, §7) · `docs/plan/specs/ui-design.md` (Load wireframe, SheetPickerModal).

## Tasks
1. `src/core/ingest/sniff.ts` (extension + magic-bytes content sniff) and per-format loaders: `csv.ts`/`tsv.ts` (`read_csv` on registered buffer, `all_varchar=true`, TSV `delim='\t'`), `json.ts` (array-of-objects prefix check → `read_json`), `parquet.ts` (`read_parquet`), `excel.ts` (lazy `import('xlsx')` SheetJS from the CDN tarball dep; `{cellDates:true}`; >1 sheet → SheetPickerModal, Sheet 1 preselected → `sheet_to_csv` → CSV path).
2. `src/core/ingest/ingest.ts`: orchestrate bytes → `quac_raw` with `__row__ = row_number() OVER () - 1`; reserved-name check (`__`-prefixed columns rejected/renamed with warning); keep source Blob for the session; `quac_typed` = plain copy for now (schema-driven casting arrives in P09 — build `quac_typed` behind a function P09 will replace); `clearQueryCache()` after each step.
3. `src/core/ingest/guardrails.ts`: 100 MB warn / 500 MB stop / >1,048,575-row Excel-truncation notice.
4. UI: Dataset `SlotCard` (drop zone, browse, URL field via a minimal `fetchArtifact` — typed CORS errors polished in P16; status badge; details "N rows × M cols"), `PlainPreviewTable` (first 50 rows via `bridge.query`), and the Report view hosting `createDataTable({container, source: <display bytes>, bridge, tableName:'quac_display'})` fed by `copyToParquetBytes()` (or the P03-recorded fallback).
5. Progress: bind DuckProgress to ingest stages + data-table `loadProgress`.

## Deliverables
Working Dataset slot + preview + Report grid for CSV/TSV/JSON/XLSX/Parquet fixtures.

## Out of scope
Schema/rules slots (P06/P12), pertinence strip (P07), Run QC (P14).

## Verification
- **Unit (node):** `tests/unit/ingest/sniff.test.ts` (each format + spoofed extensions), `guardrails.test.ts`.
- **Browser:** `tests/browser/ingest.browser.test.ts` — each `hesp_dirty_100.*` fixture lands with 100 rows × 265 cols (+`__row__`); leading-zero preservation check on a tiny CSV (`'007'` stays text in `quac_raw`); excel conversion path.
- **UI/UX:** Playwright `tests/e2e/ingest.spec.ts` — drag-drop CSV shows Valid badge + preview; xlsx flow opens SheetPickerModal (Sheet 1 preselected), picking sheet 2 ingests it; TSV/JSON/Parquet via browse; Report tab shows the grid; oversized-file message (fixture served with fake size header or a generated big file, implementer's choice).

## Deferred notes
*(agent fills in)*
