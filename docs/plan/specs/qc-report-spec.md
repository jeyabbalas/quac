# Spec: QC Report — FlagStore, In-App Display, Excel Workbook

> Audience: P08 (FlagStore), P14 (report view + annotations + tooltips), P15 (Excel export).
> Depends on: `architecture.md` (QCFlag, `__row__`, rendering rule), `data-table-api.md` (annotations, tooltips).

## 1. FlagStore (`src/core/flags/flagStore.ts`)

- Stores canonical `QCFlag`s verbatim. Dedupe key = `source|ruleId|scope|row|column|hash(message)` (identical duplicates counted, not duplicated).
- Indexes: `byCell(row, column)`, `byColumn`, `byRule`, `datasetScope[]`. Aggregates: per-rule counts + % of rows, per-column counts, severity totals, corrections count.
- Ordering inside a cell = pipeline order (corrections → schema → rules), then ruleId. Deterministic iteration everywhere.
- Accepts incremental batches (`onFlags` callbacks from both engines); exposes summary signals for the UI.
- Global cap policy: see engines (`json-schema-subsystem.md §F` cap 100k schema flags; `qc-rules-engine.md §5` cap 200k global). Exact per-rule counts are ALWAYS kept (`countsByRuleId`, `RuleRunStat.violationCount`) — Sheet 4 and the Summary panel never lie.

Rendering (in `core/flags/messages.ts`, used by annotations + `__review` cells + findings lists): **`"{ruleId}: {message}"`**, corrections append **`" (corrected: {before} → {after})"`**. No other module formats flag text.

## 2. Mapping flags → data-table annotations (P14)

- One annotation per flag: `scope` maps 1:1 (`cell`/`row`/`column`; `dataset` flags are NOT annotations — they go to panels/Sheet 3), severities map 1:1, `rowId = flag.row` (valid because `__rowid__ === __row__`, see `architecture.md §3`), `code = ruleId`, `source = flag.source`, `metadata = { scope, correction }`, `message` = rendered text.
- Use `annotations.addMany(batch)` in chunks; re-apply after every `loadData()` (annotations do not survive a reload).
- **Cap:** paint at most `ANNOTATION_CAP = 20,000` cell annotations, filled errors-first, then warnings, then info; row/column-scope always applied (cheap). When capped, the Report view shows a persistent banner: "Painting 20,000 of {N} flags — full detail in the Excel report and the panels." Severity-filter toggles call `annotations.setSeverityFilter(...)`.

## 3. Column-header tooltips (P14)

Per column: `setColumnHeaderTooltip(col, {title, description, items})` where `items` = schema-derived entries (`json-schema-subsystem.md §E.2`: Type / Allowed / Missing-value codes / Unit / Universe / Role / Group / Conditional rules / Note / Required) **plus** one `QC rules` entry listing every loaded rules-file rule that targets the column, as `"{ruleId} — {first ~80 chars of comment}"` (cap 6 + "+n more"). Recomputed when schema, rules, or dataset change; columns without any metadata get no tooltip override.

## 4. In-app Report view (replaces Excel sheets 2–4 for interactive use)

Layout (wireframe in `ui-design.md`): left ~65% = data-table grid (annotated, filterable, export dialog enabled); right panel tabs:

- **Summary** — stat cards: rows / columns / errors / warnings / info / corrections applied / rules run / rules skipped; severity filter toggles (drive the annotation severity filter); primary button "Download QC Report (.xlsx)".
- **Missing variables** (= Sheet 2 content): schema variables absent from the data, with titles/descriptions/groups.
- **Dataset findings** (= Sheet 3): dataset- and column-scope flags + broken/skipped/external rules with statuses.
- **Repeat offenders** (= Sheet 4): table rule → severity, targets, exact count, % of rows; sorted desc. Row click: when the rule is SQL row-scope, apply `addRawSQLFilter(condition)` to focus matching rows (best effort, window-free only; otherwise focus the rule's entry) — nice-to-have, not a gate.

During a run the grid area shows DuckProgress (stage label + cancel). After data re-upload, stale flags/annotations are cleared and the view returns to its empty "run QC" state.

## 5. The Excel workbook (P15) — exact spec

Single `.xlsx`, filename **`quac-report_<dataset-stem>_<YYYYMMDD-HHmm>.xlsx`**, built lazily (dynamic `import('exceljs')`) from FlagStore + `quac_work`, streamed in 10k-row chunks to keep memory flat.

### Sheet 1 — `Data`

- Contains **post-correction** values (the dataset the user should keep); pre-correction values live in the review text via the `(corrected: before → after)` suffix.
- **Sister review columns:** `<col>__review` inserted immediately RIGHT of each column that has ≥1 cell-scope flag; only flagged cells get text; others blank. Text = that cell's flags merged in pipeline order, `"; "`-joined, each rendered `"{ruleId}: {message}"`; truncate at 8 flags with `"(+N more)"`; guard Excel's 32,767-char cell limit.
- Row-scope flags land in a **`__row_review`** column inserted as column A (blank when none).
- Column-scope flags do NOT create review columns — they tint the header cell and appear on Sheet 3.
- No flags on a column ⇒ no `<col>__review` column (per brief).
- **Collision policy:** if `<col>__review` already exists as a source column (or is taken), escalate `<col>__review_2`, `_3`, … deterministically. Same policy for `__row_review`. Unit-tested.
- Styling: frozen row 1 (`views:[{state:'frozen', ySplit:1}]`); autofilter across the used range; header row bold, white text on `#111111`; review-column headers italic gray; flagged data cells filled by max severity — error fill `FFC7CE` / font `9C0006`, warning `FFEB9C` / `9C6500`, info `DDEBF7` / `1F4E79`, corrected-only `C6EFCE` / `276749`; column widths clamped 10–40 chars (content-based).
- Truncation: > 1,048,575 data rows → truncate with a final note row + a banner note on Sheet 5.

### Sheet 2 — `Missing Variables`

Columns: variable, title, description, variable group (`x-variable-group`), required?. Required first, then optional, schema declaration order.

### Sheet 3 — `Dataset Findings`

Columns: ruleId, source (schema/rules), severity, scope (dataset/column), column (if any), message (rendered), affected count. Includes: dataset-scope flags (duplicates, min-items, dataset SELECT results), column-scope flags (missing/unexpected/case-mismatch, count_distinct violations), broken rules ("Rule failed to execute: …"), skipped-inapplicable rules, and `external` rules as "not evaluated — requires external reference data".

### Sheet 4 — `Repeat Offenders`

Columns: ruleId, source, severity, target variables, flag count (EXACT, from counters — never truncated lists), % of rows affected, comment/message template. Sorted by count desc.

### Sheet 5 — `Run Info`

App version, run timestamp, dataset filename + row/col counts, schema files (names/URLs + resolved root/index id), rules files (+ per-file rule counts), pipeline stage durations, applied-corrections count, truncation notes, caps in effect. (Creative-freedom addition; sheets 1–4 match the brief exactly.)

## 6. Report model (`reportModel.ts`) — pure & testable

`buildReportModel(flagStore, columnMeta, runInfo, rowSource)` → a plain object describing every sheet (headers, column layout incl. review-column placement + collision-resolved names, cell texts, fills) that `excelWriter.ts` renders 1:1. All layout decisions (sister-column insertion, merge order, truncation, collisions) happen in the model so node tests can assert them without exceljs; a second node test round-trips through exceljs (write → re-read) to pin styling.
