# Spec: Ingestion — Inputs, Conversion, Guardrails, Slots

> Audience: P05 (dataset ingestion & display), P06 (schema slot), P12 (rules slot), P16 (URL loading).
> Depends on: `architecture.md` (tables, `__row__`, bridge), `data-table-api.md` (accepted formats).

## 1. The three input slots (Load view)

Three `SlotCard`s — **Dataset**, **JSON Schema**, **QC Rules** — each with:

- drag-drop zone (keyboard-activatable button semantics), "browse" file input
  - Dataset: single file
  - Schema: multiple files AND folder upload (`webkitdirectory`; `webkitRelativePath` preserved for ref resolution)
  - Rules: multiple `.csv` files
- URL field + "Fetch" button (see `url-params.md` for CORS UX; slot works identically whether the artifact came from param, URL field, or upload)
- status `Badge`: Empty / Loading / Valid / Warning / Error
- expandable detail area — Dataset: "hesp_dirty.csv · 100 rows × 265 cols"; Schema: "14 files · root: core.schema.json"; Rules: "2 files · 60 rules · 2 lint warnings"
- persistent one-line hint on the view: "Uploads live only in this tab. Reload = re-upload. URLs reload themselves."
  — and that promise now holds for **replacements** too (UIX-10): every successful load by URL writes itself into the
  address bar, so fetching a second dataset over a URL-loaded one leaves a fragment that reloads the *second* file,
  not the one the link arrived with. Loading over a URL-loaded slot with an *upload* drops that param instead, because
  an upload has nothing to re-fetch.

**Every slot is clearable (UIX-7).** Each card's Clear (and the run bar's `Clear all inputs`) removes that input from the session outright, and the contract is the same on every path: an explicit clear **invalidates the run** (`app/runInvalidation.ts` bumps `store.runEpoch`, cancels an in-flight run, empties the pill/panels — unlike a *replacement* or a Studio edit, which keep the report for consultation), re-syncs the address bar from the REMAINING live sources (a reload cannot resurrect a cleared input; Back cannot un-clear; `config=` always drops with the remainder materialized inline), and announces with one polite toast. Since UIX-10 that rewrite is not clear-specific: the clears call the same single writer every *load* goes through (`app/hashSync.ts`, `history.replaceState`, `url-params.md §1/§2`), and keep calling it explicitly so a clear during the boot window — before the store effect is armed — is still covered. A dataset clear additionally drops `quac_raw/typed/work` + the `data` view best-effort through `peekBridge()` (never boots WASM) while holding the card's busy latch, and disposes the report grid; a check-source-only clear strips run paint (annotations, offender filter, cap banner, header tooltips) but keeps the data grid. Confirmation only when unsaved Rule Studio work would be lost; clear-all always confirms. Schema/rules Clear stays enabled during `loading` and doubles as the cancel for a hung fetch (the stores' load tokens discard the late completion); only the dataset Clear disables while busy (ingest is uninterruptible mid-CTAS, and `runIngest` would overwrite the cleared slot on settle). Pinned dialog/toast copy in `ui-design.md §5`.

The **input-consistency line** sits in the Preview section's head, not in a container of its own, and appears as soon as ANY TWO of the three inputs are loaded — including Schema + Rules with no dataset at all (`core/pertinence.ts`; the three edges, the suspect rule and the copy in `json-schema-subsystem.md §E.5`). It is a caution, never a gate: **Run QC** enables when the Dataset (Valid **or** Warning — a rename-warned dataset is runnable) is joined by at least one *usable* check source, regardless of what the line says, and it **never auto-runs**, even for fully URL-preconfigured links (user consent to compute). "Usable" means the REAL run predicates, not slot badges: a schema counts only when its column digest resolves (an index-pending or fatally-broken set does not); rules count when at least one file survives `executableRuleFile`. Button and `startRun` share the one assessment in `app/runReadiness.ts`, so they cannot disagree — and a failed re-ingest (slot Error with a stale `store.dataset`) refuses to run the old data.

## 2. Dataset formats → engine tables

Everything lands in `quac_raw` with `__row__ = row_number() OVER () - 1` injected (original file order). Delimited text is read **all-VARCHAR** to preserve raw fidelity (leading zeros, big ids); typing happens later via the schema-driven `CastPlan` into `quac_typed` (`json-schema-subsystem.md §C`), or a plain copy when no schema is loaded.

> **P05 reality (Verified facts V17/V18):** the original design here assumed `registerFileBuffer` +
> `read_csv(all_varchar=true)`. The v0.5.1 `WorkerBridge` exposes NO buffer registration (its worker
> registers-then-drops files internally) and the `loadData` RPC whitelists `{data, format, tableName}`,
> so no reader option is reachable. The table below is the implemented routing (`core/ingest/ingest.ts`).

| Input | Path |
|---|---|
| CSV | main-thread **PapaParse** (strings only) → column hygiene → **wrapped JSON** (`wrappedJson.ts`: top-level array of `{"j": "<row json>"}` records, positional keys `c0..cN`) → `bridge.loadData(format:'json')` → `CREATE OR REPLACE TABLE quac_raw AS SELECT __rowid__ AS __row__, json_extract_string(j, '$.cN') AS "<name>", … ORDER BY __rowid__` — extraction always yields VARCHAR (raw fidelity: `'007'` stays text) |
| TSV | same with `delimiter='\t'` (no text rewriting) |
| JSON array | streamed prefix sanity check (top-level `[` of objects) → `loadData(format:'json')`; typed values kept → rename-aware CTAS from `__rowid__` |
| Excel .xlsx | lazy **SheetJS** chunk → `XLSX.read(arrayBuffer, {cellDates:true})` → if >1 sheet, **SheetPickerModal** (Sheet 1 preselected per brief) → `sheet_to_csv` → CSV path. Document the serial-date caveat (dates may arrive as strings/serials; schema casting + rules handle) |
| Parquet | `loadData(format:'parquet')`; native types kept → rename-aware CTAS from `__rowid__` |

Notes:
- Why wrapped: plain per-column JSON loses fidelity twice — `read_json_auto` date-detects ISO-looking strings (`'2020-01-01'` → DATE) and collapses ≥ ~200 uniformly-typed fields into one `MAP(VARCHAR, VARCHAR)` (HESP has 266); both knobs are unreachable through the RPC whitelist. One VARCHAR field (`j`) can never trip either heuristic (V18 evidence tests in `ingest.browser.test.ts`).
- Both engine loaders inject a physical `__rowid__` (0-based insertion order) — it becomes `__row__` in the CTAS; header-only delimited files skip the loader entirely (`read_json` cannot infer from `[]`).
- Unknown extension: content-sniff (`sniff.ts`): leading `PAR1` → parquet; `PK\x03\x04` → xlsx; leading `[`/`{` → JSON; tab count heuristic → TSV; else CSV. Binary magics override spoofed text extensions.
- Column-name hygiene at `quac_raw` creation: reject/rename columns starting with `__` (reserved) and deduplicate case-identical duplicates with a warning flag.
- Keep the original source bytes (Blob) in memory for the session: reruns re-CTAS from `quac_typed`; a schema change re-runs typing from `quac_raw` (or re-ingests from bytes if raw was dropped).
- After every table creation: `bridge.clearQueryCache()`.

**Display feed** (Report view): always engine-exported bytes → `table.loadData()` (single source of truth = engine tables; ordering contract in `architecture.md §3`).

**Display feed on a dataset REPLACEMENT (UX-01).** A replacement keeps the report for consultation but the grid must be rebuilt, and every rebuild takes a **fresh table name** from `nextDisplayTableName()` (`core/bridge/tables.ts`) — never the bare `quac_display` / `quac_studio_display` constant. data-table derives its duckdb-wasm virtual file from the table name (`registerFileBuffer('<tableName>.parquet', …)` … `finally { dropFile(…) }`), and DuckDB keeps per-path state across that cycle: reusing one path meant the second build of a differently shaped export read the new bytes against the old file's extent and died (`No magic bytes found at end of file`) — unrecoverably, since `Re-run QC` repeated the same call. The same-generation refresh path (`loadData(bytes)` with no options) is safe as it stands *because* data-table generates a unique name for it; do not pass a stable `tableName` there.

**Load-view Preview** (UIX-4): one Tier 1 sticker with a `createPanelTabs` tablist over all three inputs — **Dataset** · **JSON Schema** · **QC rules**, the three slot-card names verbatim. The section hides until at least one slot fills; all three tabs are always present once it shows, each empty panel carrying a `.q-panel-note`. The JSON Schema panel renders the schema as a data dictionary (`core/schema/data-dictionary.ts`) and says so in a caption under its head, since that is the one panel showing something other than the bytes you loaded. Its categories are **collapsible** — each is a native `<details class="q-dd-cat">`, **open by default**, with one `Collapse all` / `Expand all` control beside the search box. Collapsed state is in-memory only (never persisted: a different schema brings different categories). **Search wins over a collapsed category**: typing force-opens every category that still holds a match, and clearing the query restores exactly what the user had open.

The dataset panel is a plain HTML table (`components/plainPreviewTable.ts`), **not** a data-table instance, fed by `PREVIEW_SQL` / `PREVIEW_ROW_CAP` in `core/bridge/tables.ts` (`SELECT * EXCLUDE (__row__) FROM data ORDER BY __row__ LIMIT 50` — one constant, so the cap cannot drift between the query, the `first 50 of 101 rows · 266 columns` meta line, and the accessible name). A second header row gives each column's storage type from `describeColumns(bridge, DATA_VIEW)` — `DESCRIBE "data"`, deliberately not the `quac_raw` default, which is all-VARCHAR by construction for CSV/TSV/XLSX. Those cells are `<td>` inside `<thead>`, so a type never joins a body cell's header chain. Numeric columns right-align whole, decided per column from the DuckDB type.

⚠️ The preview keys on `` `${dataset.generation}|${typedRevision}` ``. `installTypedSync` re-points the `data` view at cast columns *without* bumping `generation`, so a generation-only key leaves the type row reading VARCHAR for ever after a schema loads (`app/typedSync.ts`).

## 3. Schema slot intake

Accepts: one `.json`, many `.json`, a folder, or URL(s). Hands entries to `core/schema/schema-set.ts` (see `json-schema-subsystem.md §A`): classification (schema / non-schema / invalid), `$id` + ref-graph, root detection, `E_*` pre-check errors rendered in the slot detail area, IndexPickerModal on ambiguity. Non-JSON files in a folder (README.md, .DS_Store) are silently ignored (listed under details).

The schema slot clears **whole-slot only** (UIX-7): a set compiles as one unit — removing one file would invalidate the ref-graph, root detection, and the content-hash `setId` the whole pipeline keys on, so there is no per-file removal here. A cleared slot also forgets `promptedSetId`, so an identical re-upload re-opens the IndexPicker. The cast revert (typed columns back to the plain copy) rides `installTypedSync`'s existing schema-removed path.

## 4. Rules slot intake

Accepts any `*.csv` (convention `<group>.quac.csv`; group = basename minus suffix). Hands to `core/rules/parse.ts` + `lint.ts` (`qc-rules-format.md`, `qc-rules-engine.md §lint`). Lint issues render grouped by file → rule in the detail area; files with row-level errors still load (broken rules excluded from runs). Before a dataset is loaded, SQL lint reports `pending-data` info entries; they upgrade automatically when data arrives.

Rules files are individually removable (UIX-7): the per-file ✕ in the detail area calls `removeRuleFile(name)` — `files`/`sources` splice together (index-aligned contract), the file's dirty flag drops with it, and survivors relint **under the kept dataset context** (the context belongs to the dataset, not the files; `rulesSlotCard` only re-installs it on a generation change — no `data checks pending` regression). Removing the last file empties the slot outright, fetchErrors included. `clearRuleFiles()` (the card's Clear) empties the slot the same way but keeps the context; `resetRulesSlot()` additionally drops it. Both loaders (`addRuleFiles`/`addRuleUrls`) carry a `loadToken` twin of `lintToken`: a clear/remove landing while a load is parked on an await wins, and the stale completion is discarded.

## 5. Guardrails (`core/ingest/guardrails.ts`)

- Warn at ≥ 100 MB dataset file ("this may be slow; consider Parquet"); hard-stop > 500 MB with explanation (`INGEST_TOO_LARGE`).
- Row-count notice > 1,048,575 rows: Excel Sheet 1 will truncate (report still generated; truncation banner + note row — `qc-report-spec.md §truncation`).
- Every long operation shows DuckProgress and is chunked; the UI never blocks.

## 6. Persistence policy (decided)

**None for data or artifact content.** The hash fragment is the only configuration persistence (survives reload natively, shareable). `localStorage` only for trivial UI prefs (dismissed tips, severity filter default). This backs the README's one-liner: *QuaC stores nothing.*
