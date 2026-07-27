# Spec: QC Report — FlagStore, In-App Display, Excel Workbook

> Audience: P08 (FlagStore), P14 (report view + annotations + tooltips), P15 (Excel export).
> Depends on: `architecture.md` (QCFlag, `__row__`, rendering rule), `data-table-api.md` (annotations, tooltips).

## 1. FlagStore (`src/core/flags/flagStore.ts`)

- Stores canonical `QCFlag`s verbatim. Dedupe key = `source|ruleId|scope|row|column|hash(message)` (identical duplicates counted, not duplicated).
- Indexes: `byCell(row, column)`, `byColumn`, `byRule`, `datasetScope[]`. Aggregates: per-rule counts + % of rows, per-column counts, severity totals, corrections count.
- Ordering inside a cell = pipeline order (corrections → schema → rules), then ruleId. Deterministic iteration everywhere.
- Accepts incremental batches (`onFlags` callbacks from both engines); exposes summary signals for the UI.
- Global cap policy: see engines (`json-schema-subsystem.md §F` cap 100k schema flags; `qc-rules-engine.md §5` cap 200k global). Exact per-rule counts are ALWAYS kept (`countsByRuleId`, `RuleRunStat.violationCount`) — Sheet 4 and the Summary panel never lie.

Rendering (in `core/flags/messages.ts`): TWO renderers over the same parts. `renderFlag(flag)` → **`"{ruleId}: {message}"`**; `renderFlagMessage(flag)` → **`"{message}"`**. Both append **`" (corrected: {before} → {after})"`** when the flag carries a correction, from one shared helper. Which one a surface calls is decided by whether it has somewhere ELSE to put the id: `<col>__review` / `__row_review` cells do NOT — one cell, one string — and call `renderFlag`; the grid's annotation popover (data-table prints `code · source` under every entry, §2) and the Findings panel (its own muted id line, §4) DO, and call `renderFlagMessage`, so the id is never printed twice (UX-09 — `schema:advisory:<fileId>` is the retrieval URL for URL-loaded sets, 106 chars in the bundled example, and used to open the row before the sentence). No other module formats flag text.

## 2. Mapping flags → data-table annotations (P14)

- One annotation per flag: `scope` maps 1:1 (`cell`/`row`/`column`; `dataset` flags are NOT annotations — they go to panels/Sheet 3), severities map 1:1, `rowId = flag.row` (valid because `__rowid__ === __row__`, see `architecture.md §3`), `code = ruleId`, `source = flag.source`, `metadata = { scope, correction }`, `message` = `renderFlagMessage(flag)` — id-free, because `code` already carries the ruleId and the popover renders `code · source` beneath every entry (UX-09).
- Use `annotations.addMany(batch)` in chunks; re-apply after every `loadData()` (annotations do not survive a reload).
- **Cap:** paint at most `ANNOTATION_CAP = 20,000` cell annotations, filled errors-first, then warnings, then info; row/column-scope always applied (cheap). When capped, the Report view shows a persistent banner: "Painting 20,000 of {N} flags — full detail in the Excel report and the panels." Severity-filter toggles call `annotations.setSeverityFilter(...)`.

## 3. Column-header tooltips (P14)

Per column: `setColumnHeaderTooltip(col, {title, description, items})` where `items` = schema-derived entries (`json-schema-subsystem.md §E.2`: Type / Allowed / Missing-value codes / Unit / Universe / Role / Group / Conditional rules / Note / Required) **plus** one `QC rules` entry listing every loaded rules-file rule that targets the column, as `"{ruleId} — {first ~80 chars of comment}"` (cap 6 + "+n more"). Recomputed when schema, rules, or dataset change; columns without any metadata get no tooltip override.

## 4. In-app Report view (replaces Excel sheets 2–4 for interactive use)

Layout (wireframe in `ui-design.md`): left ~65% = data-table grid (annotated, filterable, export dialog enabled); right panel tabs:

- **Summary** — stat cards: rows / columns / errors / warnings / info / corrections applied / rules run / rules skipped; severity filter toggles (drive the annotation severity filter); primary button "Download QC Report (.xlsx)".
- **Missing variables** (= Sheet 2 content): schema variables absent from the data, with titles/descriptions/groups.
- **Dataset findings** (= Sheet 3): dataset- and column-scope flags + broken/skipped/external rules with statuses. Each row is severity pill · message · a muted second line carrying the rule id in mono (plus `×N` when the entry deduped) — the same split Sheet 3 makes with its `Rule ID` and `Message` columns, and the same shape data-table gives its own annotation entries. The id is NOT prefixed onto the message (UX-09). Non-ok rule rows take their wording from `ruleStatusMessage()` (`core/report/reportModel.ts`), shared with Sheet 3 so the two can never disagree.
- **Repeat offenders** (= Sheet 4): table rule → severity, targets, exact count, % of rows; sorted desc. Row click: when the rule is SQL row-scope, apply `addRawSQLFilter(condition)` to focus matching rows (best effort, window-free only; otherwise focus the rule's entry) — nice-to-have, not a gate. The "Click a row-level SQL rule…" hint + `Clear focus` render only when ≥1 listed rule is actually filterable (a schema-only run has none).
  - **A focus that would empty the grid is a FAILED best effort (UX-03).** `validateSQLFilter` returns `{valid, matchCount}` and BOTH halves are read: a condition that cannot run here (`!valid`) and a condition that runs and matches **zero** grid rows are treated alike — no filter is applied, any previous rule's filter is removed (it would label the grid with a rule the user did not click), and the grid is left as it was. The two cases carry different toasts, because the second one otherwise reads as the panel's count being wrong: `unfilterable` → "This rule cannot filter the grid (window functions or unavailable columns)."; `no-match` → "`{ruleId}` matches no rows in the grid, so it was left unfiltered." with the hint "The grid shows the data as it stands after the run — this rule's flagged cells are still annotated." The counts can legitimately disagree: rules run against the `data` view, while data-table's own loaded copy of the display export may type a column differently (observed on H004 — `interview_date` is VARCHAR in `data` and DATE in the grid, so the one unparseable calendar date is already null there).
  - The Studio's twin affordance (`previewPane`'s **Filter preview to matches**) applies the same guard: it is not offered when the condition matches none of the sample grid's rows.

**Partial-run scope (UIX-6).** The panels read `RunArtifacts.inputs = { schemaProvided, ruleFileCount }` — the echo of what THIS run was handed, assigned at artifacts assembly. Run-time truth, never live-store reads (the stores can change post-run), and never `rules`-null-ness (a schema-only run still returns a non-null rules result with empty `perRule`; a crashed rules stage returns null with files loaded). Surfaces:

- `ruleFileCount === 0` → the `Corrections applied` / `Rules run` / `Rules skipped` cards show `—` with title "No QC rules were loaded for this run.", plus a muted `q-scope-note` line above the hero row: "No QC rules were loaded for this run — the rules stage was skipped."
- `schemaProvided === false` → scope note "No JSON Schema was loaded for this run — schema validation was skipped."
- Missing variables keeps two DISTINCT empties (live-store panel, works pre-run): no digest → "No JSON Schema loaded — nothing to compare. Load one to see schema variables missing from the dataset."; digest but no dataset → "Load a dataset to compare against the schema's variables." The tab stays visible in both.

During a run the grid area shows DuckProgress (stage label + cancel). After data re-upload, stale flags/annotations are cleared and the view returns to its empty "run QC" state.

## 5. The Excel workbook (P15) — exact spec

Single `.xlsx`, filename **`quac-report_<dataset-stem>_<YYYYMMDD-HHmm>.xlsx`**, built lazily (dynamic `import('exceljs')`) from FlagStore + `quac_work`, streamed in 10k-row chunks to keep memory flat.

### Sheet 1 — `Data`

- Contains **post-correction** values (the dataset the user should keep); pre-correction values live in the review text via the `(corrected: before → after)` suffix.
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
