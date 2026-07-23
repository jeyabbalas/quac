# Spec: QC Rules Engine — Execution Pipeline, Lint, Sandbox

> Audience: P10–P13 (rules subsystem), P14 (orchestration), P17–P18 (Studio preview reuses the same wrappers).
> Depends on: `qc-rules-format.md` (format + semantics), `architecture.md` (tables, `__row__`, QCFlag, hardening).

## 1. Core interfaces (`src/core/rules/`)

```ts
// types.ts
export type RuleType = 'validate' | 'correct' | 'external';
export type RuleScope = 'row' | 'column' | 'dataset' | 'longitudinal';
export type Severity = 'error' | 'warning' | 'info';

export interface QCRule {
  ruleId: string;
  ruleType: RuleType;
  ruleScope: RuleScope;
  targetVariables: string[];          // parsed pipe list; [] only for dataset/external
  condition: string;
  updateLanguage: 'sql' | 'js';       // default 'sql'
  updateExpression: string;           // '' unless correct
  severity: Severity;
  comment: string;
  enabled: boolean;
  sourceFile: string;                 // group (basename)
  rowNumber: number;                  // 1-based CSV data row, for lint/error surfacing
  extras: Record<string, string>;     // unknown columns, preserved for lossless round-trip
}

export interface RuleFile {
  name: string; group: string;
  rules: QCRule[];
  extraColumns: string[];             // original order, for lossless export
}

// engine.ts
export interface SQLRunner {          // WorkerBridge adapter in browser; @duckdb/node-api in node tests
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

export interface EngineOptions {
  workTable?: string;                 // default 'quac_work'; view 'data' points at it
  rowCapPerRule?: number;             // default 10_000 violating rows
  datasetRowCap?: number;             // default 200 rows per dataset rule
  globalFlagCap?: number;             // default 200_000
  applyCorrections?: boolean;         // false = assess-only mode
  jsSandbox?: JSSandbox | null;       // null ⇒ js rules marked broken, run continues
  onProgress?: (p: { ruleId: string; index: number; total: number; phase: 'correct'|'validate' }) => void;
  onFlags?: (batch: QCFlag[]) => void;   // incremental delivery to the FlagStore
}

export type RuleRunStatus = 'ok' | 'broken' | 'skipped-disabled' | 'skipped-external' | 'skipped-inapplicable';
export interface RuleRunStat {
  ruleId: string; status: RuleRunStatus;
  violationCount: number;             // EXACT, from COUNT(*), never truncated
  flagsEmitted: number; truncated: boolean;
  changedCells?: number;              // correct rules
  durationMs: number; error?: string;
}
export interface RunResult { flags: QCFlag[]; perRule: RuleRunStat[]; correctedCells: number; }

// sandbox.ts
export interface JSSandbox {
  compileCheck(fnSource: string): Promise<{ ok: boolean; error?: string }>;
  runCorrection(
    fnSource: string,
    batch: Array<{ row: number; value: unknown; rowData: Record<string, unknown> }>,
    budget: { timeoutMs: number },
  ): Promise<Array<{ row: number; value: unknown; changed: boolean }>>;
}
```

The `SQLRunner` browser implementation wraps `bridge.query` and calls `bridge.clearQueryCache()` after every mutating statement (Verified fact V2 in `architecture.md`).

## 2. Ordering policy (decided)

**corrections (file load order, then row order) → schema validation → validation rules.** The real HESP catalog is explicit that schema validates *post-clean* (Q047 "legacy codes harmonized before schema validation"). Validation-rule order cannot affect results (read-only); it runs in file order for stable output. No per-rule ordering column: correction order = row order in the spreadsheet (the medium users already understand); cross-file order = load order (share-URL param order for shared configs). Override: a single run-panel toggle "Apply corrections" (off = assess-only; schema + validations run on the untouched work table).

Determinism: a run is a pure function of (source bytes, schema set, rule files). `quac_work` is rebuilt from the never-mutated `quac_typed` at the start of every run; `SELECT setseed(0.42)` before each correction (a rule sneaking in `random()` is at least reproducible; hotdeck-style rules must use deterministic donor selection — documented guidance).

## 3. Pipeline (authoritative pseudocode)

```
runQC(runner, ruleFiles, opts):
  # hardening — once per run, after ingest/typing, BEFORE any rule SQL (architecture.md §8)
  runner.query("SET enable_external_access=false")
  runner.query("SET lock_configuration=true")            # rules cannot re-enable

  runner.query("CREATE OR REPLACE TABLE quac_work AS SELECT * FROM quac_typed")
  runner.query("CREATE OR REPLACE VIEW data AS SELECT * FROM quac_work")
  clearQueryCache()

  stats = []; flags = FlagSink(opts.globalFlagCap, opts.onFlags)

  # ---- phase 1: corrections (skipped in assess-only mode) ----
  if opts.applyCorrections:
    for rule in enabledInFileOrder(ruleFiles, type='correct'):
      if targetsMissing(rule): stats += skippedInapplicable(rule); continue
      try:
        runner.query("SELECT setseed(0.42)")
        pairs = expandValueToken(rule)                   # [(cond_i, expr_i, target_i)] via __value__
        if rule.updateLanguage == 'sql':
          for (cond, expr, t) in pairs:                  # capture before/after (window-safe:
            n    = count("SELECT COUNT(*) FROM (SELECT ({expr}) AS after, {t} AS before,   # everything
                          ({cond}) AS hit FROM data) WHERE hit AND after IS DISTINCT FROM before")
            rows = query("SELECT __row__, before, after FROM (SELECT __row__, {t} AS before,
                          ({expr}) AS after, ({cond}) AS hit FROM data)
                          WHERE hit AND after IS DISTINCT FROM before ORDER BY __row__ LIMIT {rowCap}")
            flags.emitCorrections(rule, t, rows); noteTruncation(rule, n, rows)
          # atomic rebuild — ONE CTAS covering all targets of this rule
          runner.query("DROP TABLE IF EXISTS quac_work_next")
          runner.query("CREATE TABLE quac_work_next AS SELECT * REPLACE (
                          CASE WHEN ({cond_1}) THEN ({expr_1}) ELSE {t1} END AS {t1},
                          ... one per target ...
                        ) FROM data")
          runner.query("DROP TABLE quac_work"); runner.query("ALTER TABLE quac_work_next RENAME TO quac_work")
          runner.query("CREATE OR REPLACE VIEW data AS SELECT * FROM quac_work")
          clearQueryCache()
        else:  # js — keyset-paginated fetch, QuickJS chunks, staged merge
          for (…, t) in pairs:
            changed = []
            loop chunks of 5000: "SELECT __row__, {t} AS value, * FROM (SELECT *, ({cond}) AS hit FROM data)
                                  WHERE hit AND __row__ > {last} ORDER BY __row__ LIMIT 5000"
              changed += sandbox.runCorrection(rule.updateExpression, chunk, budget)
            stage temp table __qc_updates(__row__ BIGINT, val VARCHAR)
            CTAS LEFT JOIN merge with CAST(u.val AS <declared type of t>); swap; refresh view; clearQueryCache()
            flags.emitCorrections(rule, t, changed.filter(c => c.changed))
      except SQLError | SandboxError as e:
        runner.query("DROP TABLE IF EXISTS quac_work_next")   # table unchanged (CTAS atomic)
        stats += broken(rule, e); flags.emitBrokenRule(rule, e)   # dataset-scope error flag; run continues

  # ---- phase 2: schema validation (other subsystem) runs here, on the corrected `data` ----

  # ---- phase 3: validations ----
  for rule in enabledInFileOrder(ruleFiles, type='validate'):
    if targetsMissing(rule): stats += skippedInapplicable(rule); continue
    try:
      switch interpretation(rule.ruleType, rule.ruleScope):
        case rowBool:            # row + longitudinal + per-row column-assert expansions
          cond = (scope=='column') ? expandAssertion(rule, target) : rule.condition   # per target for asserts
          n    = count("SELECT COUNT(*) FROM (SELECT ({cond}) AS viol FROM data) WHERE viol")
          rows = query("SELECT __row__, {targets} FROM (SELECT *, ({cond}) AS viol FROM data)
                        WHERE viol ORDER BY __row__ LIMIT {rowCap}")
          flags.emitCellsPerTarget(rule, rows); noteTruncation(rule, n, rows)
        case columnAggregate:    # count_distinct_in_range
          n = scalar("SELECT COUNT(DISTINCT {c}) FROM data"); if outOfRange: flags.emitColumn(rule, c)
        case datasetSelect:
          rows = query(stripTrailingSemicolon(rule.condition) + " LIMIT {datasetRowCap + 1}")
          flags.emitDatasetRows(rule, rows)   # one flag/row; +summary flag if truncated
    except SQLError as e: stats += broken(rule, e); flags.emitBrokenRule(rule, e)

  for rule in rules(type='external'): stats += skippedExternal(rule)
  return { flags: flags.all(), perRule: stats, correctedCells: sum(...) }
```

Key properties: conditions are ALWAYS evaluated in a SELECT-list wrapper (never a bare WHERE) — the one code path that makes window functions legal everywhere (longitudinal checks AND corrections like Q055 carry-forward). Window expressions read the **pre-rule** state (single CTAS per rule): a carry-forward fills from the previous wave's original value — documented + tested (T-CORRECT-WINDOW).

## 4. Working-table lifecycle & memory

- Physical `quac_work` + view `data` (recreated after every swap; explicit `CREATE OR REPLACE VIEW` after rename is cheap insurance), `clearQueryCache()` after every swap.
- Each SQL correction = ONE CTAS covering all its targets → peak memory 2× working table during swap regardless of correction count. `quac_typed` is the durable baseline (never mutated); source bytes kept as Blob for schema changes/re-ingest.
- CTAS instead of UPDATE everywhere: uniform code path, atomic failure, and the only way window-function corrections can execute at all.

## 5. Flag emission, caps, truncation

- Per rule: exact `COUNT(*)` first, then row fetch `ORDER BY __row__ LIMIT rowCap` (default **10,000** violating rows). If count > cap: emit cap×targets cell flags + one column-scope summary flag per target ("…and 15,000 more rows flagged by this rule") + `truncated:true`. Sheet 4 tallies use exact counts from `RuleRunStat`, never truncated lists.
- Global sink cap **200,000** flags: past it, rules still run but emit count-only summary flags (protects JS heap + annotation store).
- Dataset rules: **200** returned rows, then one "…and N more result rows" flag.
- Corrections → cell flags (default `info`) with `correction:{before,after}`; validate rules → cell flags per (row × target); `count_distinct_in_range` → single column flag; dataset SELECT → dataset flags with `col=val` rendering of each returned row.
- Broken rules NEVER abort the run: any DuckDB/sandbox error → stat `broken` + one dataset-scope `error` flag `Rule failed to execute: <message>`; working table untouched; run proceeds. JS row-level exceptions: per-rule counter; individual "JS error on row N" flags up to 50; rule aborted (broken) past 1% of chunk failures.

## 6. Security (engine-specific; general model in `architecture.md §8`)

- Hardening `SET`s issued before any rule SQL (order matters: app SETs → `enable_external_access=false` → `lock_configuration=true`).
- Rule SQL must be single-statement: lint rejects top-level `;` via a string/comment-aware scan (dataset-scope SELECTs may end with one trailing `;`, stripped).
- `__value__`/identifier substitution uses `quoteIdentifier`; rule text never reaches `eval`/`new Function`; JS only inside QuickJS.
- Residual risk documented: SQL DoS (cross-join explosion) — mitigations: untrusted-URL warning banner, cooperative cancel, caps.

## 7. Lint (`lint.ts`) — stages & result shape

Runs on file load; re-runs when the dataset changes (rules may load before data: SQL checks report `pending-data` info, upgraded automatically).

1. **Parse**: PapaParse (`header:true`, delimiter auto-detect, BOM strip, skip empty lines). Errors: missing required headers (trimmed case-insensitive), zero data rows.
2. **Row structural checks**: `rule_id` present/pattern/**unique across all loaded files** (later file gets the error); enum canonicalization (`rule_type`, `rule_scope`, `severity`, `update_language`, `enabled`); condition non-empty; (type, scope) matrix validity; `update_expression` present iff `correct` (hints: "did you mean rule_type=correct?"); `__value__` only in correct rules; multi-target correct without `__value__` → info.
3. **Assertion parse** (scope=column): grammar, known name, arity, arg types; row-scope condition starting with `SELECT` → error "use rule_scope=dataset for queries".
4. **SQL dry-run** (needs dataset): per rule, `EXPLAIN` of the EXACT wrapped query the engine will run (row: viol-select wrapper; correct: the rebuild SELECT; dataset: the statement after the single-statement check). DuckDB binder errors surfaced verbatim with file + ruleId + rowNumber + CSV column; smart-quote detection adds the word-processor hint.
5. **JS compile check**: QuickJS `compileCheck` (lazy-loaded only if any `js` rules exist).
6. **Pertinence** (via shared `core/pertinence.ts`): distinct targets ∩ dataset columns; rules with any missing target → status `inapplicable` (skipped at run, `warning`); file-level banner < 50% targets present.

```ts
export type LintCode =
  | 'missing-header' | 'empty-file' | 'bad-enum' | 'missing-field' | 'duplicate-id'
  | 'bad-id' | 'update-on-validate' | 'missing-update' | 'bad-scope-combo'
  | 'bad-assertion' | 'select-in-row-scope' | 'semicolon' | 'value-token-misuse'
  | 'sql-error' | 'js-error' | 'smart-quotes' | 'unknown-target' | 'pertinence'
  | 'pending-data' | 'extra-columns' | 'empty-comment';

export interface RuleLintIssue {
  severity: 'error' | 'warning' | 'info';
  code: LintCode;
  file: string; ruleId?: string; rowNumber?: number;   // 1-based CSV data row
  csvColumn?: string;
  message: string; detail?: string;                    // detail = raw DuckDB/QuickJS message
}

export interface RuleFileLintResult {
  file: string; ok: boolean;                           // ok = no error-severity issues
  ruleCount: number; executable: number;               // enabled ∧ lint-clean ∧ applicable
  issues: RuleLintIssue[];
  pertinence?: { targetsFound: number; targetsTotal: number; missing: string[] };
}
```

Policy: **partial acceptance** — rules with errors are marked broken and excluded from runs; the file still loads and the rest run. Loader panel lists issues grouped file → rule.

## 8. Studio hooks (consumed by P17–P18; UI spec in `ui-design.md`)

- Preview reuses the engine's EXACT wrappers: validate row/longitudinal → violation count + first-20 rows via wrapped `bridge.query` (window-safe); when the condition is window-free, additionally `validateSQLFilter(condition)` → offer "Filter main table to matches" via `addRawSQLFilter` (cleared on close). Column asserts → show the expanded SQL read-only + per-target count/sample. Corrections → `__row__ | before | after` capture query `LIMIT 20` + exact change count; JS corrections execute sandboxed on the 20 sample rows only. Dataset → run the SELECT `LIMIT 20`, render grid.
- CodeMirror completion feeds: column list from `PRAGMA table_info('quac_work')`; DuckDB functions from `SELECT DISTINCT function_name FROM duckdb_functions()` (queried once per session); `__row__`; `__value__` (correct rules only); assertion vocabulary with signature snippets (scope=column). Debounced (400 ms) `@codemirror/lint` against the same EXPLAIN wrappers; JS mode → `lang-javascript` + QuickJS compileCheck.
- **Test-before-save gate**: Save disabled until lint has zero errors AND a preview executed successfully since the last edit. No dataset loaded → Save becomes explicit "Save untested" (`pending-data`).
- Export/import: writer rules in `qc-rules-format.md §7`; round-trip guarantee: import → edit one rule → export leaves all other rows byte-comparable after parsing (extras + row order preserved; edited rules replaced in place; new rules appended). Row order = correction order (surfaced with exactly that tooltip on the reorder buttons).

## 9. Named test scenarios (details in `testing-strategy.md`; node tier uses `@duckdb/node-api` via `SQLRunner`)

`qc_fixture` table (~14 rows; columns incl. record_id, household_id, wave, panel_entry_wave, baseline_record, interview_date, reference_age, reference_education, household_size, adult_count, child_count, tenure, monthly_rent, wage_income_annual, selfemp_income_annual, total_household_income_annual, credit_card_balance, partner_present, marital_status) seeded with: HH00000001 waves 1–3 (age 41→42→47 → LAG violation), duplicated (HH00000002, wave 1), `record_id` mismatch (Q003), `interview_date='2023-02-30'` (H004), `monthly_rent=150000` cents (Q050), `wage_income_annual=999` (Q047), `credit_card_balance=-2500` (Q052), tenure=2 w/ rent (Q048), `reference_education=-999` at wave 2 / 4 at wave 1 (Q055), roster arithmetic break (Q011), `household_id='hh-42'` (H006).

- T-ASSERT-EXPANSION · T-KEY-UNIQUE · T-PARSE-KEY (NULL-guard three-valued-logic regression) · T-LAG-AGE · T-TOLERANCE · T-PCTL · T-CORRECT-SENTINEL-IDEMPOTENT (second run: zero flags, byte-identical table) · T-CORRECT-ORDER (Q047→Q050 correct; reversed = wrong — documents file order as contract) · T-CORRECT-WINDOW (single-pass semantics) · T-JS-SANDBOX (fetch undefined; `while(true)` killed; allocation bomb → broken rule, run continues) · T-BROKEN-RULE · T-CSV-ROUNDTRIP (BOM/CRLF/semicolon-delimited/uppercase TRUE/smart quotes/multiline/formula-guard) · T-CAPS (25k violations, cap 10k → exact count 25000) · T-LINT (one test per LintCode incl. pending-data → resolved transition).
