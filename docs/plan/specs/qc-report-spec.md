# Spec: QC Report — FlagStore, In-App Display, Excel Workbook

> Audience: P08 (FlagStore), P14 (report view + annotations + tooltips), P15 (Excel export); 1.2.0 (§7, the findings without data).
> Depends on: `architecture.md` (QCFlag, `__row__`, rendering rule), `data-table-api.md` (annotations, tooltips).

## 1. FlagStore (`src/core/flags/flagStore.ts`)

- Stores canonical `QCFlag`s verbatim. Dedupe key = `source|ruleId|scope|row|column|hash(message)` (identical duplicates counted, not duplicated).
- Indexes: `byCell(row, column)`, `byColumn`, `byRule`, `datasetScope[]`. Aggregates: per-rule counts + % of rows, per-column counts, severity totals, corrections count.
- Ordering inside a cell = pipeline order (corrections → schema → rules), then ruleId. Deterministic iteration everywhere.
- Accepts incremental batches (`onFlags` callbacks from both engines); exposes summary signals for the UI.
- Global cap policy: see engines (`json-schema-subsystem.md §F` cap 100k schema flags; `qc-rules-engine.md §5` cap 200k global). Exact per-rule counts are ALWAYS kept (`countsByRuleId`, `RuleRunStat.violationCount`) — Sheet 4 and the Summary panel never lie.

Rendering (in `core/flags/messages.ts`): TWO renderers over the same parts. `renderFlag(flag)` → **`"{ruleId}: {message}"`**; `renderFlagMessage(flag)` → **`"{message}"`**. Both append **`" (corrected: {before} → {after})"`** when the flag carries a correction, from one shared helper. A nested correction that changed a few parts names them instead — `(corrected: country: 'us' → 'US')`, `(corrected: [1]: 'e11.9' → 'E11.9')` — and a nested value printed whole is cut at 80 characters. Which one a surface calls is decided by whether it has somewhere ELSE to put the id: `<col>__review` / `__row_review` cells do NOT — one cell, one string — and call `renderFlag`; the grid's annotation popover (data-table prints `code · source` under every entry, §2) and the Findings panel (its own muted id line, §4) DO, and call `renderFlagMessage`, so the id is never printed twice (UX-09 — `schema:advisory:<fileId>` is the retrieval URL for URL-loaded sets, 106 chars in the bundled example, and used to open the row before the sentence). No other module formats flag text.

## 2. Mapping flags → data-table annotations (P14)

- One annotation per flag: `scope` maps 1:1 (`cell`/`row`/`column`; `dataset` flags are NOT annotations — they go to panels/Sheet 3), severities map 1:1, `rowId = flag.row` (valid because `__rowid__ === __row__`, see `architecture.md §3`), `code = ruleId`, `source = flag.source`, `metadata = { scope, correction }`, `message` = `renderFlagMessage(flag)` — id-free, because `code` already carries the ruleId and the popover renders `code · source` beneath every entry (UX-09).
- Use one `annotations.addMany(all)` — data-table 0.10 validates the whole batch before storing any of it and fires one change event per call; re-apply after every `loadData()` (annotations do not survive a reload).
- **No paint cap (since data-table 0.10).** Every cell, row and column flag the FlagStore materialized is painted, in one `addMany` — the store's own cap (`FLAG_CAP_DEFAULT`, 200,000) is the only bound, and data-table 0.10 holds a million annotations. Through 0.9 the grid scanned every annotation per lookup and repainted every visible cell per change, so v1.0–1.1 painted at most `ANNOTATION_CAP = 20,000` cells (errors first, then warnings, then info) under a "Painting 20,000 of {N} flags" banner; both are gone. Severity-filter toggles call `annotations.setSeverityFilter(...)`, and data-table's `F8` / `Shift+F8` step between the annotations the filter shows.

## 3. Column-header tooltips (P14)

Per column: `setColumnHeaderTooltip(col, {title, description, items})` where `items` = schema-derived entries (`json-schema-subsystem.md §E.2`: Type / Allowed / Missing-value codes / Unit / Universe / Role / Group / Conditional rules / Note / Required) **plus** one `QC rules` entry listing every loaded rules-file rule that targets the column, as `"{ruleId} — {first ~80 chars of comment}"` (cap 6 + "+n more"). Recomputed when schema, rules, or dataset change; columns without any metadata get no tooltip override.

## 4. In-app Report view (replaces Excel sheets 2–4 for interactive use)

Layout (wireframe in `ui-design.md`): left ~65% = data-table grid (annotated, filterable, export dialog enabled); right panel tabs:

- **Summary** — stat cards: rows / columns / errors / warnings / info / corrections applied / rules run / rules skipped; severity filter toggles (drive the annotation severity filter); primary button "Download QC Report (.xlsx)".
- **Missing variables** (= Sheet 2 content): schema variables absent from the data, with titles/descriptions/groups.
- **Dataset findings** (= Sheet 3): dataset- and column-scope flags + broken/skipped/external rules with statuses. Each row is severity pill · message · a muted second line carrying the rule id in mono (plus `×N` when the entry deduped) — the same split Sheet 3 makes with its `Rule ID` and `Message` columns, and the same shape data-table gives its own annotation entries. The id is NOT prefixed onto the message (UX-09). Non-ok rule rows take their wording from `ruleStatusMessage()` (`core/report/reportModel.ts`), shared with Sheet 3 so the two can never disagree.
- **Repeat offenders** (= Sheet 4): table rule → severity, targets, exact count, % of rows; sorted desc. Click a rule to focus the grid on the rows it flagged. The "Click a rule to focus the rows it flagged." hint + `Clear focus` render whenever ≥1 listed rule is focusable, and the focused rule's row is marked (`.is-focused`, `aria-pressed`) — the data-table filter chip is a column away, over the grid, so the panel says which rule it is showing.
  - **Focus is by ROW IDENTITY, not by re-running the rule.** Every flag carries `flag.row` (`__row__`) and `FlagStore.rowsOf(ruleId)` returns that rule's distinct rows — exact past the flag cap, because the row sets are recorded for every flag, materialized or merely counted. The display export makes data-table's own `__rowid__` equal to `__row__` (`SELECT * EXCLUDE (__row__) FROM data ORDER BY __row__`, V7 — the identity the annotation layer already keys on), so the focus is one `addRawSQLFilter` over `__rowid__` (`core/report/rowFocus.ts`, consecutive ids collapsed to `BETWEEN` so a dense rule is one term rather than a 60 KB literal list). The chip's label is the ruleId, not the id list.
  - **Focusable = `rowsAffected > 0`**, whatever the rule's source or scope. A schema rule, a column-scope assertion, a correction and a window-function rule all qualify. What stays out is the finding that names no row — a schema `$comment` advisory, a duplicate-records dataset check — and those rows say so in a `title` ("Not tied to individual rows — nothing to focus.") rather than being a click that silently does nothing.
  - **This replaced a predicate re-run, and with it two whole failure classes (UX-03).** Focus used to apply `addRawSQLFilter(rule.condition)`, which meant it was offered only for `validate` rules of scope `row`/`longitudinal` found in the live rules store — and then refused most of those: a window function is illegal in a `WHERE` clause (Q002, Q008), and a condition can run against the grid's copy and match **zero** of the rows the run flagged, because rules run against the `data` view while data-table types the same column differently (observed on H004 — `interview_date` is VARCHAR in `data` and DATE in the grid, so the one unparseable calendar date is already null there). On the example session that left **3 of 28** offender rows able to do the thing the panel invited. Row ids cannot miss: they ARE what the run flagged, so `no-match` is gone rather than merely explained, and the surviving outcomes are `applied` / `no-rows` / `unfilterable` (the last now meaning a grid without `__rowid__`, i.e. a defect, reported through `reportError`).
  - **The one partial that remains** is the engine's `rowCapPerRule` (10k): a rule whose flag emission was truncated focuses only the rows it managed to flag, and the run stat's `truncated` drives an info toast saying so, rather than letting the grid's count quietly contradict the panel's `Count`.
  - The Studio's twin affordance (`previewPane`'s **Filter preview to matches**) is a different feature — it previews a *draft* rule's condition against the sample grid, where there is no run and so no flagged rows — and keeps its own zero-match guard.

**Partial-run scope (UIX-6).** The panels read `RunArtifacts.inputs = { schemaProvided, ruleFileCount }` — the echo of what THIS run was handed, assigned at artifacts assembly. Run-time truth, never live-store reads (the stores can change post-run), and never `rules`-null-ness (a schema-only run still returns a non-null rules result with empty `perRule`; a crashed rules stage returns null with files loaded). Surfaces:

- `ruleFileCount === 0` → the `Corrections applied` / `Rules run` / `Rules skipped` cards show `—` with title "No QC rules were loaded for this run.", plus a muted `q-scope-note` line above the hero row: "No QC rules were loaded for this run — the rules stage was skipped."
- `schemaProvided === false` → scope note "No JSON Schema was loaded for this run — schema validation was skipped."
- Missing variables keeps two DISTINCT empties (live-store panel, works pre-run): no digest → "No JSON Schema loaded — nothing to compare. Load one to see schema variables missing from the dataset."; digest but no dataset → "Load a dataset to compare against the schema's variables." The tab stays visible in both.

During a run the grid area shows DuckProgress (stage label + cancel). After data re-upload, stale flags/annotations are cleared and the view returns to its empty "run QC" state.

## 5. The Excel workbook (P15) — exact spec

Single `.xlsx`, filename **`quac-report_<dataset-stem>_<YYYYMMDD-HHmm>.xlsx`**, built lazily (dynamic `import('exceljs')`) from FlagStore + `quac_work`, streamed in 10k-row chunks to keep memory flat.

### Sheet 1 — `Data`

- Contains **post-correction** values (the dataset the user should keep); pre-correction values live in the review text via the `(corrected: before → after)` suffix.
- A nested or JSON column's cell is the value's exact JSON text (`[{"date":"2024-05-29",…}]`, `core/nested-json.ts`). Any cell longer than Excel's 32,767-character limit — a long list's JSON, a long text — is cut with `… [cut: N characters in all]` (`EXCEL_CELL_CHARS`); written whole, Excel calls the workbook corrupt.
- **Sister review columns:** `<col>__review` inserted immediately RIGHT of each column that has ≥1 cell-scope flag; only flagged cells get text; others blank. Text = that cell's flags merged in pipeline order, `"; "`-joined, each rendered `"{ruleId}: {message}"` (`renderFlag` — the one surface with nowhere else to put the id); truncate at 8 flags with `"(+N more)"`; guard Excel's 32,767-char cell limit.
- Row-scope flags land in a **`__row_review`** column inserted as column A (blank when none).
- Column-scope flags do NOT create review columns — they tint the header cell and appear on Sheet 3.
- No flags on a column ⇒ no `<col>__review` column (per brief).
- **Collision policy:** if `<col>__review` already exists as a source column (or is taken), escalate `<col>__review_2`, `_3`, … deterministically. Same policy for `__row_review`. Unit-tested.
- Styling: frozen row 1 (`views:[{state:'frozen', ySplit:1}]`); autofilter across the used range; header row bold, white text on `#111111`; review-column headers italic gray; flagged data cells filled by max severity — error fill `FFC7CE` / font `9C0006`, warning `FFEB9C` / `9C6500`, info `DDEBF7` / `1F4E79`, corrected-only `C6EFCE` / `276749`; column widths clamped 10–40 chars (content-based).
- Truncation: > 1,048,575 data rows → truncate with a final note row + a banner note on Sheet 5.

### Sheet 2 — `Missing Variables`

Columns: variable, title, description, variable group (`x-variable-group`), required?. Required first, then optional, schema declaration order.

When the run had no schema (`columnMeta === null`), the sheet is headers plus ONE unstyled note row — "No JSON Schema was loaded for this run — schema-vs-dataset comparison was not performed." (`ReportModel.missingVariablesNote`, rendered via `addTableSheet`'s note mechanism, the same one Sheet 1 uses for its truncation row). This keeps "never compared" distinguishable from a genuinely-empty none-missing sheet (UIX-6).

### Sheet 3 — `Dataset Findings`

Columns: ruleId, source (schema/rules), severity, scope (dataset/column), column (if any), message (rendered), affected count. Includes: dataset-scope flags (duplicates, min-items, dataset SELECT results), column-scope flags (missing/unexpected/case-mismatch, count_distinct violations), broken rules ("Rule failed to execute: …"), skipped-inapplicable rules, and `external` rules as "not evaluated — requires external reference data".

### Sheet 4 — `Repeat Offenders`

Columns: ruleId, source, severity, target variables, flag count (EXACT, from counters — never truncated lists), % of rows affected, comment/message template. Sorted by count desc.

### Sheet 5 — `Run Info`

App version, run timestamp, dataset filename + row/col counts, schema files (names/URLs + resolved root/index id), rules files (+ per-file rule counts), pipeline stage durations, applied-corrections count, truncation notes, caps in effect. (Creative-freedom addition; sheets 1–4 match the brief exactly.)

## 6. Report model (`reportModel.ts`) — pure & testable

`buildReportModel(flagStore, columnMeta, runInfo, rowSource)` → a plain object describing every sheet (headers, column layout incl. review-column placement + collision-resolved names, cell texts, fills, the Sheet 2 `missingVariablesNote` on schema-less runs) that `excelWriter.ts` renders 1:1. All layout decisions (sister-column insertion, merge order, truncation, collisions) happen in the model so node tests can assert them without exceljs; a second node test round-trips through exceljs (write → re-read) to pin styling.

## 7. Findings without data (1.2.0)

The QC report holds the data — every sheet but Run Info quotes it — so it cannot be what a user hands a third party who must not see it (the team that sent the data, a coordinating centre, a schema or rules author). The findings without data are that document: every check the dataset failed, where the JSON Schema or the QC rules define it, and how many records failed it. Three formats from one model, in the app (Summary panel → **Findings without data**: `Excel` · `Markdown` · `JSON`) and the CLI (`--findings <path|->`, repeatable; `--no-report`, headless.md §5).

### 7.1 No data, by construction

A QCFlag's `message` and `value` carry the data (`'twelve hundred' is not a valid integer`, a correction's before/after, a dataset rule's result rows, an engine error quoting a cell). So the builder (`core/report/findings.ts`, `buildFindings`) never sees a flag. `FindingsInput` admits only:

- **definitions** — the schema set + digest, every loaded rules file (lint-excluded rules included) with its lint result and source URL;
- **the dataset's shape** — its name, format, column names, record count;
- **counts** — `ValidationSummary.checks` (below), `RuleRunStat`s (`violationCount`, `changedCells`, `byTarget`), and the FlagStore through `Pick<FlagStore, 'rowsOf' | 'summary'>`, whose row ids it only ever counts.

Every sentence is worded from those parts — the schema's by `core/schema/requirement.ts`, which takes a keyword and its schema object (never Ajv's error) and reuses the translator's `predicate()` with params read from the schema. Three things that are not data but could carry it are scrubbed: a broken rule's engine message is reduced to its class (`DuckDB reported a Conversion Error`; QuaC's own fixed sentences pass, minus a JS function's "first error"), a URL loses credentials, query and fragment (a signed link's token), and a schema/rules load or lint message gets the same URL treatment. Rules files' `comment` and `condition` ARE included, as written — they are the definitions being referenced; README says so, since a rule may name a record.

`tests/unit/report/findingsNoData.test.ts` is the proof: a dataset whose every checkable value carries a marker, run through schema messages, a list's items, a rule's value, a dataset query, a correction, a DuckDB error that quotes a cell and a throwing JS correction — the run's flags and the QC report DO hold the markers (so a leak is visible), and the JSON, Markdown and Excel findings hold none, while still reporting every check.

### 7.2 Exact per-check counts

A schema ruleId is too coarse for a third party (`schema:prop:age:value` lumps `type` and `maximum`), so `ValidationSummary.checks: SchemaCheckTally[]` counts each **check — ruleId × keyword × schemaPath —** exactly, past the flag cap like `countsByRuleId`, with distinct records (rows arrive in order, so one last-row per check suffices). The worker tallies its per-record flags before the cap decides which are posted; `validation-run.ts` tallies the column- and dataset-level flags it raises itself (`addRunFlags`), and the summary concatenates them. A tally carries identifying fields only (`check-tally.ts`).

The translator puts `meta.location` (`<retrievalUri>#<pointer to the keyword>`) on every flag it raises, via the probe's `locate(error.parentSchema)`: Ajv's schemaPath cannot name the file past a `$ref` (it is the reference as written — `../../common/defs.json#/$defs/record_id/pattern`), the location can (`common/defs.json#/$defs/record_id/pattern`). `checkSubject` reads the path inside a value from the schemaPath — a path through the schema, so `household[].age`, never `household[2].age` — and gives up where a `$ref` restarts it.

Rules count in their scope's own units: records for row/longitudinal (`violationCount` is a COUNT(*) of rows); per variable for column assertions (`RuleRunStat.byTarget`, new: the per-target COUNT(*), or a `count_distinct_in_range` distinct count) plus distinct records across them from `rowsOf`; result rows for a dataset query; values changed for a correction. `recordsExact: false` marks a figure a cap left short.

### 7.3 The document (`QcFindings`, `findingsSchemaVersion: 1`)

The model IS the JSON: `containsData: false`, `generator`, `generatedAt`, `dataset`, `inputs` (schema root/files relative to `baseUrl` for a URL set, `setId`, `title`, `$id`; rules files with URL source; corrections applied), `overview` (records with an error-level / warning-level failure — the union of `rowsOf` over those severities — checks failed, rule outcome counts, values corrected, missing variables, columns not in the schema), `schemaChecks` (level `dataset` · `variable` · `value`; variable, title, path, requirement, keyword, plain `schemaValue`, location, severity, records, failures, % of records, ruleId — ordered level → severity → records ↓ → failures ↓ → schema order), `rules` (every rule, file order: outcome `failed` · `passed` · `corrected` · `unchanged` · `error` · `not-evaluated` · `disabled` · `skipped` · `excluded` · `not-applied` · `not-run`, with reason, records, result rows, values changed, by variable) and `notes` (cancelled / stage errors / assess-only / caps first; schema load warnings, unchecked root keywords, the JSON-source fallback, precision; the schema files' own `$comment`s last). Additive changes only within version 1. `types/quac.d.ts` declares it in full — it is a public contract, unlike `artifacts`.

The app reads the definitions a run checked against from `RunArtifacts.definitions`, which `runController` snapshots at run start: replacing a check input or editing rules in Studio keeps the report on screen (UIX-7), so the live stores can move on while the counts stay the run's.

### 7.4 Formats

- **Markdown** (`findingsMarkdown.ts`) — for reading and sharing as text and diffing run against run. GitHub-flavoured: a facts table, a summary table, schema checks by level (Defined at = `file#pointer` in code), rules that found problems (table, then each one's file, row, scope, variables and fenced SQL), corrections, rules that did not run, rules that passed, notes, how to read. Deterministic but for the generated-at line. Schema literals sit in code spans; prose is escaped only where Markdown would misread it (an asterisk, an edge underscore — never `household_id`'s —, a tag's `<`, a link's `[`); a pipe in a table cell is `\|`, inside code too.
- **JSON** — `JSON.stringify(findings, null, 2)`.
- **Excel** (`findingsWorkbook.ts`) — Summary · Schema checks · QC rules · Notes, in the report's header style, frozen header, autofilter on the two tables, numbers as numbers (% as an exact ratio under `0.0%`), severity tints on failed checks only.

File names follow the report's: `quac-findings_<dataset-stem>_<YYYYMMDD-HHmm>.<md|json|xlsx>`.
