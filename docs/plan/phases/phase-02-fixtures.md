# P02 — Fixtures & deterministic generator

## Goal
Commit the test-data backbone: deterministic mock HESP datasets (valid + dirty with a ground-truth violation log) in all five input formats, the three example QC-rules files, tiny synthetic fixtures, and the schema fixtures for root-detection tests.

## Depends on
P01 (harness).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/testing-strategy.md` (§3 — the authoritative fixture list) · `docs/plan/specs/qc-rules-format.md` (§8 — the three files to commit verbatim; §2 for the format) · `docs/plan/specs/json-schema-subsystem.md` (§G synthetic fixtures) · `tests/fixtures/hesp/json_schema/README.md`.

## Tasks
1. `scripts/generate-fixtures.mjs` (node, devDeps `@duckdb/node-api` + `exceljs`): seeded mulberry32 (`20260723`); parse `tests/fixtures/hesp/json_schema/` to derive the 265 columns + their value domains (walk root allOf → category properties → resolve `../../common/defs.json#/$defs/*` refs manually — no Ajv needed for generation); generate 100 valid household-wave rows (≥6 multi-wave households, correct record_id composition, sentinel usage, if/then-consistent skip logic).
2. Inject the seeded violations listed in `testing-strategy.md §3.1` into a dirty copy; write `seeded-violations.json` (row, column, kind, expected rule ids — schema ruleIds like `schema:prop:wage_income_annual:value` AND `Q*/H*` ids).
3. Emit `tests/fixtures/hesp/data/`: `hesp_valid_100.csv`, `hesp_dirty_100.csv/.tsv/.json/.xlsx/.parquet` (xlsx via exceljs; parquet via `@duckdb/node-api` COPY).
4. Commit `tests/fixtures/hesp/rules/{hesp_keys_and_structure,hesp_consistency,hesp_corrections}.quac.csv` — **verbatim from `qc-rules-format.md §8`** (they pin the format contract).
5. `tests/fixtures/tiny/` (people.csv 12×5, people.schema.json single-file, people_rules.quac.csv 6 rules) and `tests/fixtures/synthetic/` (`mini/`, `two-roots/`, `cycle/`, `no-ids/`, `draft7/`, `mixed/`) per `json-schema-subsystem.md §G` including `mini_expected_flags.json`.
6. Wire `npm run fixtures` (regenerate) + `fixtures:check` (regenerate then `git diff --exit-code`) into CI.
7. `tests/unit/fixtures/generator.test.ts`: two runs byte-identical; violation log count matches injections; generated column list == schema property list (265); valid file has zero seeded violations.

## Deliverables
All fixture files committed; generator + determinism gate in CI.

## Out of scope
Any `src/` app code; asserting that the app finds these violations (later phases refine `seeded-violations.json` into full QCFlag manifests).

## Verification
- **Unit:** `generator.test.ts` green; `fixtures:check` CI job green.
- **UI/UX:** n/a (no UI). Sanity: open `hesp_dirty_100.xlsx` locally once — sheets/values look right (note in log).

## Deferred notes

- **`qc_fixture` seed SQL is NOT here**: it appears under `testing-strategy.md §3` fixtures, but `phase-11-rules-validations.md` task 6 owns it ("Seed helper that materializes the qc_fixture table"). Deferred to P11 deliberately.
- **`mini_expected_flags.json` message strings are best-effort renderings** of the `json-schema-subsystem.md §D` templates; structural fields (ruleId/scope/row/column/severity/value) are ground truth. P08/P09 may refine the message text when the real translator lands (the file's `$comment` says so too).
- **§D.7 golden #2 contradicts the committed schema** (see Verified fact V15; recorded as V11 pre-merge, renumbered — P03 claimed V11–V14): `-555` is valid in `selfemp_income_annual`. The dirty fixture's sentinel-in-numeric-branch injection uses `wage_income_annual = -555` (branch min 0 → genuinely invalid, Q021-guarded). P08 must choose a schema-consistent golden for the "collapse with exclusions" template.
- **XLSX determinism recipe** (for anyone touching the generator): keep `workbook.xlsx.writeBuffer()` (jszip/pako, platform-independent) — never the streaming `WorkbookWriter` (archiver/node-zlib, node-version-dependent bytes) — plus pinned workbook metadata and the post-hoc zip DOS-timestamp normalization (`normalizeZipTimestamps`). The double-run unit test enforces this.
- **Parquet is the one format that is NOT byte-portable** (found post-merge on the first Linux CI run; Verified fact V16): DuckDB's native writer emits different bytes per platform build for identical data. The generator therefore keeps the committed file when `parquetFilesEqual` (DuckDB read-back: DESCRIBE + row_number-paired EXCEPT ALL) reports no content change, and the unit test compares parquet by content, not bytes. If you intentionally change parquet content, the file rewrites and `fixtures:check` dirties as designed — commit the new bytes from whatever platform you're on.
- **Repair-loop insight for future schema edits**: conditionals can rewrite *drivers* (e.g. `public_housing=1` forces `tenure=3` via allOf[44/45]), so archetype initialization must stay consistent with such implications or the constraint repair will reshape distributions (harmless but unrealistic). The generator hard-errors on any unrecognized schema shape rather than guessing.
- **Manual xlsx eyeball**: this session ran headless; `hesp_dirty_100.xlsx` was verified programmatically (sheet `hesp_dirty_100`, 102×266 incl. header, injected values in place, exceljs re-read). Owner: open it once locally if a human glance is still wanted.
- **Multi-sheet .xlsx ingest fixture** (golden journey 3 / SheetPickerModal) is P05's to create — the dirty workbook here is deliberately single-sheet.
- **Reminder (master-plan rule 6)**: any change to generator output requires re-running `fixtures:check` and a progress-log note; fixtures are append-only for other phases' expectations.
