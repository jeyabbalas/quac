# Spec: Testing Strategy, Fixtures, CI, Budgets

> Audience: every phase (each phase file names its tests from here). P01 sets up the harnesses; P02 builds the fixtures.

## 1. The three tiers

| Tier | Runner | What runs here |
|---|---|---|
| **Unit (node)** | Vitest 4, node env | Everything pure + everything SQL-paritied: `share/urlConfig`, `flags/*` (store, messages), `report/reportModel` **and exceljs write→re-read assertions (exceljs runs in node)**, `rules/{parse,serialize,lint(1–3),assertions,sql}`, `schema/{schema-set,ref-graph,root-detection,column-meta,value-spec,conditionals,translator,casting-derivation,pertinence}`, Ajv setup (Ajv runs in node); **SQL parity**: engine + rule + correction + casting SQL executed against **`@duckdb/node-api`** through the `SQLRunner` interface with fixtures, results asserted vs expected-flag manifests |
| **Browser (Vitest browser mode, `@vitest/browser-playwright`, real Chromium)** | anything needing real WASM/workers/DOM APIs | `core/bridge` against real duckdb-wasm (**P03 spike assertions live on as regression tests**: DDL via bridge, clearQueryCache-after-DML, COPY→buffer, `enable_external_access`/`lock_configuration` semantics, `__rowid__ == __row__` after loadData), SheetJS conversion, validation worker end-to-end, QuickJS sandbox limits, lazy-chunk loading, CodeMirror smoke |
| **E2E (Playwright)** | `vite preview` with `base:'/quac/'` + a local CORS-enabled static fixture server | the seven golden journeys (§2), download-content assertions (parse the .xlsx bytes in the test), a11y (axe), reduced-motion, network-isolation |

Rule of thumb: if it can be tested in node, it is. Browser mode is only for WASM/worker/DOM truth. Playwright is only for user journeys.

## 2. Golden journeys (Playwright)

1. **Full run:** upload dirty CSV + HESP schema files + rules CSVs → Run QC → annotated grid + counts match the seeded manifest → download .xlsx → parse bytes → assert `age__review`-style contents, severity fills, sheets 2–5.
2. **URL pre-config:** open `#/load?schema=…&rules=…&index=…` (fixture server) → slots auto-load → upload data → run.
3. **Excel input:** multi-sheet .xlsx → SheetPickerModal (Sheet 1 preselected) → pick sheet 2 → correct ingest.
4. **Ambiguous root:** dual-root fixture → IndexPickerModal → pick → Share link contains `index=`.
5. **Studio:** compose a rule → Test shows match count → Add → Download rules CSV → re-import → identical lint state.
6. **CORS failure:** URL from a non-CORS fixture endpoint → typed failure message → manual upload fallback succeeds.
7. **Zero-flag happy path:** valid dataset → run → "no findings" state, report still downloadable.

## 3. Fixtures

### 3.1 Generated HESP mock data (`scripts/generate-fixtures.mjs`, P02)

- Deterministic: mulberry32 PRNG, seed `20260723`; **derives the 265-column layout by parsing `tests/fixtures/hesp/json_schema/` itself** (schema stays the single source of truth).
- Emits to `tests/fixtures/hesp/data/`:
  - `hesp_valid_100.csv` — 100 schema-clean household-wave rows (multi-wave households included).
  - `hesp_dirty_100.{csv,tsv,json,xlsx,parquet}` — same base + **seeded violations** (xlsx via exceljs, parquet via `@duckdb/node-api`; both devDeps).
  - `seeded-violations.json` — ground truth: every injected violation (row, column, kind, expected rule ids — schema ruleIds AND Q/H rule ids). P07–P14 refine this into full expected-`QCFlag` manifests.
- Seeded violation kinds must cover: pattern break (record_id), range break, sentinel-in-numeric-branch (−555), if/then skip-logic breaks (both const and not-const directions), non-integral + non-numeric strings (cast findings), empty cells, an extra column, a duplicate full row, duplicate (household_id, wave), record_id decomposition mismatch, age regression across waves, roster arithmetic break, income-sum tolerance break, legacy sentinels 777/888/999, cents-scaled rent, negative debt, malformed household_id (`hh-42`), invalid calendar date.
- Rules fixtures: `tests/fixtures/hesp/rules/{hesp_keys_and_structure,hesp_consistency,hesp_corrections}.quac.csv` — authored VERBATIM from `qc-rules-format.md §8`.
- `tests/fixtures/tiny/`: `people.csv` (5 columns, 12 rows), `people.schema.json` (single file), `people_rules.quac.csv` (6 rules) — for fast unit tests.
- Synthetic schema fixtures (`tests/fixtures/synthetic/`): `mini/`, `two-roots/`, `cycle/`, `no-ids/`, `draft7/`, `mixed/` per `json-schema-subsystem.md §G` (+ the in-memory HESP dual-root assembly).
- `qc_fixture` seed SQL for rules-engine node tests per `qc-rules-engine.md §9`.
- Committed outputs + CI job **`fixtures:check`**: re-run the generator and `git diff --exit-code` (determinism gate). Fixtures are append-only for other phases' expectations; changing generator output requires re-running `fixtures:check` and a progress-log note.

### 3.2 Named test files (created by their phases)

| File (under `tests/`) | Tier | Covers |
|---|---|---|
| `unit/app/{signals,router,errors}.test.ts` | node | P04 primitives |
| `unit/ingest/{sniff,guardrails}.test.ts` | node | format sniffing, caps |
| `unit/schema/root-detection.test.ts` | node | auto / dual-root / cycle / `index=` resolution / non-array warning |
| `unit/schema/ref-graph.test.ts` | node | 3 ref styles, `quac-set:` bases, dup-$id, bad fragment, manifest classification |
| `unit/schema/ajv-setup.test.ts` | node | HESP registration, `#/items` pointer compile, unevaluatedProperties smoke, draft-07 routing, E_META collection |
| `unit/schema/column-meta.test.ts` | node | golden digests (wage_income_annual, selfemp_income_annual, yes_no, split_origin_household_id, survey_weight); 265/171 counts |
| `unit/schema/conditionals.test.ts` | node | 171 extracted; const / not-const kinds; comments captured |
| `unit/schema/translator.test.ts` | node | one golden per keyword-table row incl. generic fallback |
| `unit/schema/anyof-collapse.test.ts` | node | recorded Ajv error arrays → exactly one flag; suppression; oneOf multi-match |
| `unit/schema/conditional-attribution.test.ts` | node | then-target attribution, dedupe, `if`-drop, coexistence with value flags |
| `unit/schema/casting.test.ts` | node+duckdb | storage-type table; CastPlan SQL snapshot; `'abc'`→flag, `'42.0'`→42, `'42.5'`→non-integral, `'007'` preserved |
| `unit/schema/row-shaping.test.ts` | node | NULL→absent, null-typed columns, BigInt precision, NaN/Inf, mixed heuristic, extra-column exclusion |
| `unit/schema/pertinence.test.ts` | node | thresholds 0/.4/.6/1.0; case near-miss; zero-property skip |
| `unit/flags/flagStore.test.ts` | node | dedupe, indexes, aggregates, cap ordering |
| `unit/rules/parse.test.ts` (T-CSV-ROUNDTRIP) | node | fixpoint on the 3 example files; BOM/CRLF/semicolon-delimited/TRUE/smart-quotes/multiline/formula-guard |
| `unit/rules/lint.test.ts` (T-LINT) | node | one per LintCode with exact file/ruleId/rowNumber/csvColumn; pending-data transition |
| `unit/rules/assertions.test.ts` (T-ASSERT-EXPANSION) | node+duckdb | 8 expansions snapshot + execution on qc_fixture |
| `unit/rules/engine.test.ts` | node+duckdb | T-KEY-UNIQUE, T-PARSE-KEY, T-LAG-AGE, T-TOLERANCE, T-PCTL, T-BROKEN-RULE, T-CAPS |
| `unit/rules/corrections.test.ts` | node+duckdb | T-CORRECT-SENTINEL-IDEMPOTENT, T-CORRECT-ORDER, T-CORRECT-WINDOW |
| `unit/rules/sandbox.test.ts` (T-JS-SANDBOX) | node (quickjs runs in node) | H006 normalization; fetch undefined; loop interrupt; allocation bomb |
| `unit/report/reportModel.test.ts` | node | collision `age__review_2`, merge order, 8-flag cap, truncation, row-review column |
| `unit/report/excelRoundtrip.test.ts` | node | write → re-read: sheet names, review text incl. corrected suffix, fills, frozen pane, widths |
| `unit/share/{urlConfig,configManifest}.test.ts` | node | round-trip, repeated keys, precedence, >2000 detection |
| `unit/studio/{ruleSerialize,ruleTest,draftLint,completionSource}.test.ts` | node (+duckdb for ruleTest/draftLint) | lossless round-trip; live-test dispatch on qc_fixture (−2500→2500 pinned here); draft-lint bucketing; completion feeds |
| `unit/pipeline/pipeline.test.ts` | node (mocked executors) | stage order, cancel token, rerun idempotence, invalidation |
| `browser/bridge.browser.test.ts` | browser | V1/V2 regressions: DDL, cache invalidation |
| `browser/roundtrip.browser.test.ts` | browser | V5/V7: COPY→bytes→loadData→`__rowid__==__row__` |
| `browser/harden.browser.test.ts` | browser | V6: external access blocked (httpfs read fails), lock_configuration holds, buffers still readable |
| `browser/ingest.browser.test.ts` | browser | each fixture format lands with right row/col counts; excel conversion |
| `browser/validation-worker.browser.test.ts` | browser | mini fixture end-to-end flag equality, progress ordering, abort, cap truncation |
| `browser/rulesExec.browser.test.ts` | browser | representative rules through the real bridge, hardened |
| `browser/jsSandbox.browser.test.ts` | browser | sandbox in-browser smoke + lazy-chunk-only-when-needed |
| `e2e/*.spec.ts` | Playwright | `smoke`, `nav`, `ingest`, `schemaLoad`, `rulesLoad`, `runQc`, `download`, `preconfig`, `shareLink`, `corsFallback`, `studio-edit`, `studio`, `a11y`, `reducedMotion`, `perf.smoke`, `network-isolation` |

## 4. Lint / typecheck / CI

- ESLint flat config + `typescript-eslint` strict-type-checked + Prettier. `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- `npm run verify` = typecheck + lint + unit (the pre-work gate every CC agent runs).
- `.github/workflows/ci.yml`:
  - **PR:** `npm ci` → typecheck → lint → unit (node) → browser tests → build → `check-bundle-size` → Playwright E2E (cached browsers) → upload artifact; plus `fixtures:check`.
  - **main:** same + deploy via `actions/configure-pages@v5` + `actions/upload-pages-artifact` + `actions/deploy-pages@v4` (`permissions: {pages: write, id-token: write}`, `pages` concurrency group).
- **Bundle budget** (`scripts/check-bundle-size.mjs`, CI-enforced): entry JS ≤ 300 KB gz (excludes WASM + lazy chunks). Lazy chunks (loaded on demand only): SheetJS, exceljs, QuickJS, CodeMirror/studio route. Self-hosted duckdb WASM (~35 MB) exempt, long-cached.

## 5. Perf gates (P20)

`perf.smoke.spec.ts`: 100k×20 synthetic dataset completes a full run without crash, annotation cap engages cleanly, and total run time is recorded (soft threshold; assert < 60 s in CI hardware terms). `network-isolation` assertion: after app load, zero non-origin requests (backs the README privacy claim).
