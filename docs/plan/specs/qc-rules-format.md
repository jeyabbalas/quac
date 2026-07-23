# Spec: QC Rules File Format (`*.quac.csv`)

> Audience: P02 (fixtures), P10 (parser/lint), P11–P13 (engine), P17–P18 (Studio), P20 (README user guide derives from this).
> Depends on: `architecture.md` (QCFlag, `__row__`, view `data`). Engine semantics in `qc-rules-engine.md`.
> This spec doubles as the source for end-user documentation of the format.

## 1. Naming (decided)

- UI/docs label: **"QC rules file"** (generic on purpose — the files can technically hold any rule; the README encourages JSON Schema for schema-shaped validation).
- Filename convention: **`<group>.quac.csv`** (e.g. `corrections.quac.csv` → group "corrections"). The double suffix is format-unique (unambiguous drag-drop detection, greppable) yet still plain `.csv` (Excel/Numbers open by double-click).
- The app **accepts any `*.csv`** designated as a rules file; `.quac.csv` is a convention, not a gate. Group = basename minus `.quac.csv`/`.csv`. Multiple files = user-meaningful groupings; all loaded files merge into one run.

## 2. Column spec (canonical header order)

| Column | Required | Type / allowed values | Default | Notes |
|---|---|---|---|---|
| `rule_id` | yes | `[A-Za-z][A-Za-z0-9_-]*`, unique across ALL loaded files | — | Provenance in annotations/report (rendered `{ruleId}: {message}`) |
| `rule_type` | yes | `validate` \| `correct` \| `external` (case-insensitive) | — | Broad processing category ONLY: flag / mutate / not-executable. Exhaustive — see §3 |
| `rule_scope` | yes | `row` \| `column` \| `dataset` \| `longitudinal` | — | Drives how `condition` is interpreted (§4). `longitudinal` executes identically to `row` (uniform SELECT-wrapping makes window functions legal); it is documentation + lint hint |
| `target_variables` | yes for `row`/`column`/`longitudinal`; optional for `dataset` | **Pipe-separated** column names: `adult_count|child_count|household_size` (whitespace trimmed) | empty | Determines which `<col>__review` sister columns receive the comment, pertinence, and header-tooltip aggregation. Pipe never collides with comma/semicolon CSV delimiters (German-locale Excel saves `;`-delimited) |
| `condition` | yes — write `TRUE` for always-apply corrections | SQL boolean expr / assertion DSL / SELECT — by scope (§4) | — | Blank is a lint **error**, never "match everything" (an accidentally empty cell must not rewrite the table) |
| `update_language` | no | `sql` \| `js` | `sql` | Only meaningful on `correct` rules |
| `update_expression` | required iff `rule_type=correct`; must be blank for `validate` | SQL expression or JS arrow function (§5, §6) | — | Both mismatches are lint errors with "did you mean…" hints |
| `severity` | no | `error` \| `warning` \| `info` | `error` (validate), `info` (correct) | Hard breaks vs review-flags (Q013) vs change records |
| `comment` | yes (lint warning if blank; fallback text generated) | free text | — | Becomes the annotation / `__review` text; renderer appends provenance per `architecture.md §5` |
| `enabled` | no | `true/false/yes/no/1/0`, blank = true | `true` | Keep rules in the file but skippable (e.g. release-only topcoding) |

Parsing rules:

- **Header row required**; columns matched **by trimmed, case-insensitive name**, not position (Excel users reorder).
- **Unknown extra columns are preserved** verbatim (`extras` map) and re-emitted on export — users keep bookkeeping columns (notes, owner, source row). Lint reports them at `info`.
- Cell whitespace trimmed (leading space = formula-guard escape, §7).
- Dataset column names starting with `__` are reserved for the engine (`__row__`, `__value__`); ingestion rejects/renames them.

## 3. `rule_type` — the exhaustive taxonomy

| Value | Meaning | Executed? |
|---|---|---|
| `validate` | Flag rows/columns/dataset findings; never touches data | yes |
| `correct` | Mutate target values (SQL expression or sandboxed JS); every changed cell is also flagged (severity default `info`, with before → after) | yes |
| `external` | Rule requires external reference data (admin linkage, sample frame, paradata). Loaded, listed, **never executed**: status "requires external reference data — not executable in QuaC" (run summary + report Sheet 3 as "not evaluated"). `condition` may be free text; SQL/JS lint skipped | no |

Rationale for `external` staying in the format: real QC programs (see `tests/fixtures/hesp/qc_rules/HESP_qc_rule_catalog.xlsx`) keep linkage/paradata rules in the same living catalog; stewards want ONE shareable file listing the whole program. Cost is a skip branch. A future "upload reference table" feature could activate them (out of scope).

## 4. What `condition` means — the (type, scope) matrix

**One mental model: `condition` selects the rows the rule ACTS ON** — violating rows for `validate`, rows-to-fix for `correct`. Plain SQL `WHERE` truthiness; **NULL ⇒ not selected**. (Rejected alternative — applicability + assertion in two columns — would force the app to negate user SQL, and `NOT (expr)` under three-valued logic silently drops NULL rows: an ambiguity trap. One column also makes Studio preview trivial: matching rows ARE the violations; `matchCount` IS the violation count.) Applicability guards are simply ANDed in (`monthly_rent > 0 AND …`) — the house style for sentinel-heavy data, shown throughout §8.

All rule SQL is written against the view **`data`** (never physical table names). The injected `__row__` column (BIGINT, 0-based file order) is queryable. DuckDB dialect, full function catalog (`regexp_full_match`, `TRY_CAST`, `quantile_cont`, window functions, …).

| | `row` | `longitudinal` | `column` | `dataset` |
|---|---|---|---|---|
| **`validate`** | Boolean expr; matching rows → one **cell** flag per (row × target) | Same as `row`; window functions expected (`LAG(x) OVER (PARTITION BY household_id ORDER BY wave)`) | **Assertion DSL** (§4.1) expanded per target | **Full `SELECT`**; each returned row → one **dataset** flag (Sheet 3), message = comment + rendered `col=val` pairs |
| **`correct`** | Boolean expr; matching rows get `update_expression` per target | Same; window functions legal in condition AND update (carry-forward) | invalid — lint: "use scope=row with `__value__`" | invalid (lint error) |
| **`external`** | free text — never executed | same | same | same |

NULL semantics are documented loudly in user docs and Studio help: sentinel guards like `wage_income_annual >= 0` both scope the rule and protect it. Window functions are illegal in SQL `WHERE`/`UPDATE`, so the engine ALWAYS evaluates conditions in a SELECT-list wrapper (`qc-rules-engine.md §3`) — the single code path that makes `longitudinal` pure documentation and lets corrections use `LAG`.

### 4.1 Column-assertion vocabulary (complete v1 set; exact expansions)

`{c}` = quoted target column; applied to **each** target (so `no_nulls` over 4 key columns is one rule). Grammar: `name` or `name(arg, …)`; args = numbers, single-quoted strings, or `key=value`; case-insensitive; whitespace-tolerant; ONE assertion per rule (clean provenance). The Studio always displays the expanded SQL.

| Shorthand | Expansion (violation condition) | Flag scope |
|---|---|---|
| `unique` | `({c} IS NOT NULL AND COUNT(*) OVER (PARTITION BY {c}) > 1)` | cell (every duplicate row) |
| `no_nulls` | `({c} IS NULL)` | cell |
| `not_blank` | `({c} IS NULL OR TRIM(CAST({c} AS VARCHAR)) = '')` | cell |
| `in_range(lo, hi)` | `({c} IS NOT NULL AND ({c} < lo OR {c} > hi))` | cell |
| `in_enum(v1, …, vn)` | `({c} IS NOT NULL AND {c} NOT IN (v1, …, vn))` | cell |
| `match_regex('re')` | `({c} IS NOT NULL AND NOT regexp_full_match(CAST({c} AS VARCHAR), 're'))` (full-match) | cell |
| `monotonic(dir[, order_by=col][, partition_by=col])` | dir ∈ `increasing\|strict_increasing\|decreasing\|strict_decreasing`; default `order_by=__row__`; e.g. increasing: `({c} IS NOT NULL AND LAG({c}) OVER ([PARTITION BY {p}] ORDER BY {o}) IS NOT NULL AND {c} < LAG({c}) OVER ([PARTITION BY {p}] ORDER BY {o}))` (strict: `<=`) | cell |
| `count_distinct_in_range(lo, hi)` | aggregate `SELECT COUNT(DISTINCT {c}) FROM data`; violation iff `n < lo OR n > hi` | column (single flag) |

## 5. Correction semantics (SQL)

- Per selected row, each target `T` becomes `CASE WHEN (condition) THEN (update_expression) ELSE T END` in a full-table CTAS rebuild (`qc-rules-engine.md §4`).
- **`__value__` substitution:** wherever the identifier `__value__` appears in `condition` or `update_expression` of a `correct` rule, the engine substitutes the quoted target column name — one (condition, expression) pair **per target**. Q047 ("recode legacy 777/888/999 across many money columns") is one row. If `__value__` is absent, the condition evaluates once per row and every target receives the same expression value (right for skip-recodes to `-666`); lint notes at `info`.
- **No-op suppression:** a corrected cell is flagged/counted only when `after IS DISTINCT FROM before` — re-running well-formed corrections emits zero flags.
- Type changes: CTAS infers the common type; incompatible → DuckDB error → rule marked broken, table untouched (CTAS atomic).
- **Corrections never insert or delete rows in v1** (dedup rules flag; users fix + re-upload) — keeps `__row__` ↔ report-row alignment trivial.

## 6. Correction semantics (JavaScript)

- `update_expression` holds an arrow function **`(value, row) => newValue`**: `value` = current cell for the target (per-target invocation, mirroring `__value__`); `row` = frozen plain object of the full pre-correction row (incl. `__row__`). Return the new value; `null` writes SQL NULL; **`undefined` leaves the cell unchanged** (escape hatch when the SQL condition over-selects).
- Execution: condition selects rows in SQL; matches stream to QuickJS in 5,000-row chunks (keyset pagination on `__row__`); results staged into a temp table and merged via one CTAS LEFT JOIN with `CAST(u.val AS <declared column type>)`. Before/after captured host-side.
- Sandbox budget: fresh QuickJS context per rule; ~128 MB memory; interrupt ~2 s/chunk, 30 s/rule; **no host functions injected — `fetch`/DOM do not exist in the engine**.

## 7. CSV encoding (Excel round-trip rules)

- **Multi-line SQL/JS:** quoted fields containing newlines are legal RFC 4180; PapaParse parses/unparses them; Excel round-trips (Alt+Enter). Used deliberately in §8.
- **Writer (Studio export):** UTF-8 **with BOM**; **CRLF**; RFC 4180 minimal quoting (quote iff field contains `"` `,` `\r` `\n`; internal `"` doubled); canonical column order then preserved extras; defaults written explicitly (`true`, `sql`, `error`) — no blank-magic on export.
- **Formula/CSV-injection guard:** cells that would start with `=`, `@`, or `+`/`-` followed by a non-digit (e.g. `-__value__`) get a leading space on write; parser trims it. (`-666` is a safe numeric literal — not guarded.)
- **Reader tolerance:** BOM strip; PapaParse delimiter auto-detect (`;` from German-locale Excel, tabs); CR/LF/CRLF; skip fully-empty rows/trailing empty columns; `TRUE`/`True` accepted; smart quotes (`’ “ ”`) inside SQL cells → targeted lint hint "did you paste from a word processor?".

## 8. The complete example files (fixtures — P02 commits these verbatim to `tests/fixtures/hesp/rules/`)

Real HESP columns and sentinel guards; Q-ids preserve catalog provenance; H-ids are house rules for coverage.

**`hesp_keys_and_structure.quac.csv`**

```csv
rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled
Q001,validate,column,record_id,unique,,,error,Duplicate record_id: household-wave record identifiers must be unique across the file.,true
Q002,validate,row,household_id|wave,"COUNT(*) OVER (PARTITION BY household_id, wave) > 1",,,error,"Duplicate household_id + wave combination: each household may appear at most once per wave. Split-offs receive new household_id values, so duplicates indicate a bad extract.",true
Q003,validate,row,record_id|household_id|wave,"record_id IS NOT NULL AND household_id IS NOT NULL AND wave BETWEEN 1 AND 20 AND record_id <> household_id || '_W' || lpad(CAST(wave AS VARCHAR), 2, '0')",,,error,"record_id does not decompose into household_id + '_W' + zero-padded wave; internal key components disagree.",true
Q007,validate,row,panel_entry_wave|wave|baseline_record,"panel_entry_wave BETWEEN 1 AND 20 AND wave BETWEEN 1 AND 20 AND baseline_record IN (0, 1) AND (panel_entry_wave > wave OR (baseline_record = 1) <> (wave = panel_entry_wave))",,,error,"Panel entry logic inconsistent: panel_entry_wave must be <= wave and baseline_record = 1 exactly when wave = panel_entry_wave.",true
H001,validate,column,household_id,match_regex('^HH[0-9]{8}$'),,,error,Household identifier must be HH followed by eight digits.,true
H002,validate,column,record_id|household_id|wave|interview_date,no_nulls,,,error,Core identifier fields must never be missing in any wave.,true
H003,validate,column,wave,"count_distinct_in_range(1, 20)",,,warning,"Distinct wave count outside 1-20 suggests a truncated or wrongly merged extract.",true
H004,validate,row,interview_date,"interview_date IS NOT NULL AND TRY_CAST(interview_date AS DATE) IS NULL",,,error,"interview_date is not a real calendar date (e.g. Feb 30). The JSON Schema regex cannot check calendar validity; this rule does.",true
H005,validate,dataset,household_id|wave,"SELECT wave,
       COUNT(*) AS n_rows,
       COUNT(DISTINCT household_id) AS n_households,
       COUNT(*) - COUNT(DISTINCT household_id) AS n_duplicate_household_rows
FROM data
GROUP BY wave
HAVING COUNT(*) - COUNT(DISTINCT household_id) > 0
ORDER BY wave",,,error,"Wave contains more rows than distinct households; per-wave duplicate household extractions listed.",true
Q044,external,row,linkage_consent,Administrative income or benefit records are attached to this household and must be covered by consent scope and date range.,,,warning,"Linkage-consent reconciliation requires linkage audit metadata that is not part of this dataset. Not executable in QuaC.",true
```

**`hesp_consistency.quac.csv`**

```csv
rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled
Q011,validate,row,household_size|adult_count|child_count,"household_size >= 1 AND adult_count >= 0 AND child_count >= 0 AND adult_count + child_count <> household_size",,,error,"Roster arithmetic: adult_count + child_count must equal household_size (guards exclude sentinel-coded counts).",true
Q021,validate,row,total_household_income_annual|wage_income_annual|selfemp_income_annual|interest_dividend_annual|retirement_income_annual|rental_income_annual|child_support_annual|alimony_annual|private_transfer_annual|other_income_annual,"total_household_income_annual >= 0
AND wage_income_annual >= 0 AND selfemp_income_annual >= 0
AND interest_dividend_annual >= 0 AND retirement_income_annual >= 0
AND rental_income_annual >= 0 AND child_support_annual >= 0
AND alimony_annual >= 0 AND private_transfer_annual >= 0
AND other_income_annual >= 0
AND ABS((wage_income_annual + selfemp_income_annual + interest_dividend_annual
       + retirement_income_annual + rental_income_annual + child_support_annual
       + alimony_annual + private_transfer_annual + other_income_annual)
      - total_household_income_annual)
    > GREATEST(50, 0.01 * total_household_income_annual)",,,warning,"Income components do not sum to total_household_income_annual within tolerance (larger of $50 or 1%). Rows with any sentinel-coded component are excluded by the guards.",true
Q013,validate,row,partner_present|marital_status,"partner_present = 1 AND marital_status IN (3, 4, 5, 6)",,,warning,"Partner present but marital status is separated/divorced/widowed/never married. May be genuine (unmarried partner) — review, not an automatic error.",true
Q008,validate,longitudinal,reference_age|household_id|wave,"reference_age >= 0
AND LAG(reference_age) OVER (PARTITION BY household_id ORDER BY wave) >= 0
AND wave - LAG(wave) OVER (PARTITION BY household_id ORDER BY wave) = 1
AND reference_age - LAG(reference_age) OVER (PARTITION BY household_id ORDER BY wave) NOT BETWEEN 0 AND 2",,,warning,"Reference person age change between adjacent waves outside 0-2 years is implausible given interview timing.",true
Q038,validate,row,monthly_rent,"monthly_rent > 0 AND monthly_rent > quantile_cont(CASE WHEN monthly_rent > 0 THEN monthly_rent END, 0.995) OVER (PARTITION BY wave)",,,warning,"Monthly rent above the 99.5th percentile of substantive rents in the same wave — extreme outlier; check units and data entry.",true
```

**`hesp_corrections.quac.csv`** (row order encodes the Q047→Q050 dependency: sentinels before cents conversion)

```csv
rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled
Q047,correct,row,wage_income_annual|selfemp_income_annual|monthly_rent|credit_card_balance,"__value__ IN (777, 888, 999, 999999999)",sql,"CASE __value__ WHEN 777 THEN -777 WHEN 888 THEN -888 ELSE -999 END",info,"Legacy positive sentinel recoded to HESP negative sentinel convention (-777 refused, -888 don't know, -999 not collected).",true
Q048,correct,row,monthly_rent,"tenure IN (1, 2, 4, 5) AND monthly_rent <> -666",sql,-666,info,"Structural skip: household is not a cash renter (tenure 1/2/4/5), so monthly_rent is out of universe and set to -666 (Not applicable).",true
Q050,correct,row,monthly_rent,monthly_rent >= 20000,sql,"CAST(ROUND(monthly_rent / 100.0) AS INTEGER)",info,"Source exported rent in cents; converted to whole dollars (divide by 100, round). Runs after sentinel recode so 999999999 is never treated as cents.",true
Q052,correct,row,credit_card_balance|student_loan_balance|auto_loan_balance|payday_loan_balance,"__value__ < 0 AND __value__ NOT IN (-666, -777, -888, -999)",sql,ABS(__value__),info,"Debt balance arrived as a signed liability; stored as a positive amount per HESP convention. Negative sentinels preserved by the guard.",true
Q055,correct,longitudinal,reference_education,"reference_education IN (-777, -888, -999)
AND LAG(reference_education) OVER (PARTITION BY household_id ORDER BY wave) BETWEEN 1 AND 6",sql,"LAG(reference_education) OVER (PARTITION BY household_id ORDER BY wave)",info,"Missing education carried forward from the household's previous wave (stable characteristic). Set an imputation flag downstream.",true
H006,correct,row,household_id,"household_id IS NOT NULL AND NOT regexp_full_match(household_id, 'HH[0-9]{8}')",js,"(value, row) => {
  const m = /^hh[\s_-]*([0-9]{1,8})$/i.exec(String(value).trim());
  if (!m) return value; // leave unrecognized formats for manual review
  return 'HH' + m[1].padStart(8, '0');
}",info,"Legacy household_id formats (e.g. 'hh-42', 'HH 00000042') normalized to canonical HH######## via regex capture groups.",true
Q057,correct,row,total_household_income_annual,total_household_income_annual > 1500000,sql,1500000,info,"Disclosure top-code: incomes above $1.5M capped for the public-use file. Enable only when producing the public release.",false
```

Coverage: unique key (Q001), composite key (Q002), key-composition parse (Q003), chronology/panel logic (Q007, H004), arithmetic identity with tolerance (Q011, Q021), longitudinal LAG (Q008), distributional percentile (Q038), assertion shorthands (H001–H003), dataset-level multi-line SQL (H005), sentinel recode with `__value__` (Q047), skip recode (Q048), unit convert (Q050), sign normalize (Q052), carry-forward window correction (Q055), JS regex-capture correction (H006), disabled topcode (Q057), external (Q044).

## 9. Flag emission (summary — details in `qc-rules-engine.md §5`)

- `validate` row/longitudinal → one **cell** flag per (violating row × target). Targets are required for these scopes precisely so every rules-engine flag is column-addressable; the rules engine never emits `scope:'row'` (reserved for the schema engine).
- Column asserts → cell flags per row (or one column flag for `count_distinct_in_range`).
- Dataset SELECT → one dataset flag per returned row (cap; Sheet 3), message = comment + `wave=3; n_duplicate_household_rows=2`-style rendering of the returned row.
- Corrections → cell flags, default `info`, `correction:{before,after}`; renderer output: `Q047: <comment> (corrected: 999 → -999)`.
