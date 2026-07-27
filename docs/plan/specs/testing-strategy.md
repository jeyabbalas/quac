# Spec: Testing Strategy, Fixtures, CI, Budgets

> Audience: every phase (each phase file names its tests from here). P01 sets up the harnesses; P02 builds the fixtures.

## 1. The three tiers

| Tier | Runner | What runs here |
|---|---|---|
| **Unit (node)** | Vitest 4, node env | Everything pure + everything SQL-paritied: `share/urlConfig`, `flags/*` (store, messages), `report/reportModel` **and exceljs write→re-read assertions (exceljs runs in node)**, `rules/{parse,serialize,lint(1–3),assertions,sql}`, `schema/{schema-set,ref-graph,root-detection,column-meta,value-spec,conditionals,translator,casting-derivation,pertinence}`, Ajv setup (Ajv runs in node); **SQL parity**: engine + rule + correction + casting SQL executed against **`@duckdb/node-api`** through the `SQLRunner` interface with fixtures, results asserted vs expected-flag manifests |
| **Browser (Vitest browser mode, `@vitest/browser-playwright`, real Chromium)** | anything needing real WASM/workers/DOM APIs | `core/bridge` against real duckdb-wasm (**P03 spike assertions live on as regression tests**: DDL via bridge, clearQueryCache-after-DML, COPY→buffer, `enable_external_access`/`lock_configuration` semantics, `__rowid__ == __row__` after loadData), SheetJS conversion, validation worker end-to-end, QuickJS sandbox limits, lazy-chunk loading, CodeMirror smoke |
| **E2E (Playwright)** | `vite preview` with `base:'/quac/'` + a local CORS-enabled static fixture server | the twelve golden journeys (§2), download-content assertions (parse the .xlsx bytes in the test), a11y (axe), reduced-motion, network-isolation |

Rule of thumb: if it can be tested in node, it is. Browser mode is only for WASM/worker/DOM truth. Playwright is only for user journeys.

## 2. Golden journeys (Playwright)

1. **Full run:** upload dirty CSV + HESP schema files + rules CSVs → Run QC → annotated grid + counts match the seeded manifest → download .xlsx → parse bytes → assert `age__review`-style contents, severity fills, sheets 2–5.
2. **URL pre-config:** open `#/load?schema=…&rules=…&index=…` (fixture server) → slots auto-load → upload data → run.
3. **Excel input:** multi-sheet .xlsx → SheetPickerModal (Sheet 1 preselected) → pick sheet 2 → correct ingest.
4. **Ambiguous root:** dual-root fixture → IndexPickerModal → pick → Share link contains `index=`.
5. **Studio:** compose a rule → Test shows match count → Add → Download rules CSV → re-import → identical lint state.
6. **CORS failure:** URL from a non-CORS fixture endpoint → typed failure message → manual upload fallback succeeds.
7. **Zero-flag happy path:** valid dataset → run → "no findings" state, report still downloadable.
8. **Partial inputs (UIX-6):** tiny/ fixtures, both single-check-source modes run to completion. Schema-only: em-dash rules cards + "No QC rules were loaded" scope note, none-missing Missing vars, offenders present with the focus hint ABSENT, annotated cells. Rules-only: R003/R005 lint-excluded pre-run (observed: DuckDB's binder refuses VARCHAR↔INTEGER comparison/arithmetic on the schema-less all-VARCHAR table — Warning badge, 4 of 6 executable) and, since UX-08, saying why: this is the ONLY tier that runs the diagnosis against duckdb-wasm's own binder strings, so it asserts R003 reads `age is stored as text in this dataset` with the concrete `TRY_CAST(age AS DOUBLE)` while two-column R005 reads `score, age` with the placeholder cast, and that neither carries `Binder Error` on its face; corrections applied, "No JSON Schema was loaded" scope note, the no-schema Missing-vars empty, focus hint absent (nothing filterable survives; the visible case rides journey 1). Excel workbook shape in partial modes is unit-tier (reportModel + roundtrip).
9. **Clearable inputs (UIX-7, `clearInputs.spec`):** tiny/ fixtures, eight passes. Rules clear after a run strips annotations/pill/findings but keeps the data grid, and the run bar asks for a check source; dataset clear → SAME-FILE re-upload builds a fresh grid (the monotonic-generation regression) and a re-run repaints; per-file ✕ removes one of two files with the lint context kept (no `data checks pending` regression); emptying the rules slot takes its `Details` disclosure with it (UX-05) — expanded, then `✕` on the LAST file hides it, a re-load brings it back populated but COLLAPSED, and the whole-slot `Clear` hides it again; a cleared slot forgets the URL it was fetched from (UX-06) — both check sources fetched by URL, cleared one at a time so per-slot isolation is asserted too, then a routed-abort fetch whose `Error` badge must NOT cost the typed URL; clearing the SCHEMA explains what it disabled (UX-08) — the filed repro on tiny/, which pins the whole causal chain (`clearSchema` → typedSync's revert of `quac_typed` to the all-VARCHAR raw copy → `setLintContext` → relint): 6 of 6 executable with the schema, then one click lands `1 file · 6 rules · 2 lint errors` whose two entries name `age` and `score, age` in plain language instead of a binder error; a saved Studio edit gates the rules clear behind `Clear the QC rules?` (Cancel preserves the slot AND the field, confirm empties both); `Clear all inputs` always confirms and restores first-run (hero, hidden preview, disabled Share, hidden button, no card left holding a disclosure onto nothing, and — with all three loaded by URL — three empty URL fields); a cleared share link stays cleared across reload — `schema=` drops while `rules=` survives, then a bare `#/load` reloads to the hero. Plus an a11y.spec axe scan of the open clear-all confirm dialog.
10. **The address bar tracks the live inputs (UIX-10, `hashSync.spec`):** HESP fixtures over the CORS host, three passes. A URL-loaded `.csv` REPLACED by fetching the `.parquet` swaps `data=` in the bar (the `.csv` gone entirely) and the reload restores the Parquet, not the link we arrived on; the mirror — `Clear all inputs` → bare `#/load` → fetch a dataset URL → `data=` is back and survives a reload; an upload over a URL-loaded slot drops `data=` (uploads have no source URL). `loadExample.spec` carries the fourth case: the one hero click also fills `schema=`/`rules=`/`data=`, and a reload restores all three slots instead of first-run.
11. **Offender focus is best effort, and says so (UX-03, `offenderFocus.spec`):** the full HESP set over the CORS host → Run QC → Offenders. `Q003` (Count 4) focuses to `4 / 101 rows` behind one `SQL Q003` chip, with no toast. `H004` (Count 1) is the divergence — its condition parses against the grid's own copy and matches zero of its rows — so nothing is filtered: the `no-match` toast (plus its hint) appears, `Q003`'s now-misleading chip is gone, and the grid is back to `101 rows`. Then focus and `Clear focus` once more, to prove the panel still works after a refusal.
12. **A hung fetch is visible and cancellable (UX-04, `hungFetch.spec`):** a `page.route` that never fulfills stands in for a host that never answers, one pass per check-source slot. While the request hangs the card reads `Loading…` with its own summary line, the URL button reads `Fetching…`, and `Clear JSON Schema` / `Clear QC rules` are **visible and enabled**; pressing Clear returns the badge to `Empty`, hides itself, and leaves the URL field typeable **and empty** (UX-06 — the cancel and the wipe are one action) — the rules pass then starts a second fetch, proving the card's busy latch was released and not merely bypassed.
13. **A cleared slot names nothing (UX-06, `slotClearUrlField.browser.test` + `clearInputs.spec` pass 5 + `ingest.spec`):** the browser tier drives the production clear entry points against both check-source cards; `ingest.spec` covers the SheetPicker's Cancel on the URL leg (slot keeps the previous dataset, field drops the workbook URL) with the file leg as the guard that a typed-but-unfetched URL survives it.
14. **An over-length link keeps its link (UX-07, `shareLink.spec` pass 2 + `shareModal.browser.test` + `exampleLink.test`):** a query-padded dataset URL from the CORS host pushes the assembled link past 2,000 chars — the modal still shows `.q-share-link-input` and `.q-share-copy` with a matching `N characters`, and the manifest is offered **alongside** under `.q-share-overlimit`, not instead of it; pass 1 pins the mirror, that under the limit neither the advice nor the manifest button exists. The browser tier drives `openShareModal` at the limit ±1 (and exactly on it — the boundary is `>`, not `>=`). `exampleLink.test` is the origin pin: the bundled example's own link must fit **at `https://jeyabbalas.github.io/quac/`**, which is where it did not, and `loadExample.spec` holds the mechanism by asserting exactly one `schema=` beside an unchanged `14 files · root: core/core.schema.json`.

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
| `unit/schema/pertinence.test.ts` | node | thresholds 0/.4/.6/1.0; case near-miss; zero-property skip; `crossCheckInputs` edge presence, worst-verdict, weakest-with-tie-break, and every triangulation branch (each of the three suspects, plus the 0/1/3-bad and fewer-than-three-edges cases that name nobody) |
| `unit/flags/flagStore.test.ts` | node | dedupe, indexes, aggregates, cap ordering |
| `unit/rules/parse.test.ts` (T-CSV-ROUNDTRIP) | node | fixpoint on the 3 example files; BOM/CRLF/semicolon-delimited/TRUE/smart-quotes/multiline/formula-guard |
| `unit/rules/lint.test.ts` (T-LINT) | node | one per LintCode with exact file/ruleId/rowNumber/csvColumn; pending-data transition; plus UX-08's untyped-column diagnosis on its OWN all-VARCHAR scratch (the shared one stays fully typed, which is the pin that a schema'd dataset is untouched): the arithmetic and comparison classes, the hint that carries a column-scope assertion and the scan that carries a dataset-scope rule, the "and N more" cap — and four guards that it fails CLOSED, since three of them (a typo, a VARCHAR-free binder error, a VARCHAR token with no implicated column, a throwing `DESCRIBE`) must still show the engine's own words |
| `unit/rules/assertions.test.ts` (T-ASSERT-EXPANSION) | node+duckdb | 8 expansions snapshot + execution on qc_fixture |
| `unit/rules/engine.test.ts` | node+duckdb | T-KEY-UNIQUE, T-PARSE-KEY, T-LAG-AGE, T-TOLERANCE, T-PCTL, T-BROKEN-RULE, T-CAPS |
| `unit/rules/corrections.test.ts` | node+duckdb | T-CORRECT-SENTINEL-IDEMPOTENT, T-CORRECT-ORDER, T-CORRECT-WINDOW |
| `unit/rules/sandbox.test.ts` (T-JS-SANDBOX) | node (quickjs runs in node) | H006 normalization; fetch undefined; loop interrupt; allocation bomb |
| `unit/report/reportModel.test.ts` | node | collision `age__review_2`, merge order, 8-flag cap, truncation, row-review column |
| `unit/report/excelRoundtrip.test.ts` | node | write → re-read: sheet names, review text incl. corrected suffix, fills, frozen pane, widths |
| `unit/share/{urlConfig,configManifest}.test.ts` | node | round-trip, repeated keys, precedence, >2000 detection |
| `unit/core/share/shareModel.test.ts` | node | provenance model, plus UX-07 `buildShareLink` — measures the assembled link and flags only what is strictly OVER `MAX_URL_CHARS` |
| `unit/core/share/exampleLink.test.ts` | node | UX-07 origin pin: the bundled example's link, built through the generator's own `buildExampleIndex`, fits the limit **at the deployed origin**; one `schema=` crawl base with all 14 files still staged |
| `unit/studio/{ruleSerialize,ruleTest,draftLint,completionSource}.test.ts` | node (+duckdb for ruleTest/draftLint) | lossless round-trip; live-test dispatch on qc_fixture (−2500→2500 pinned here); draft-lint bucketing; completion feeds |
| `unit/pipeline/pipeline.test.ts` | node (mocked executors) | stage order, cancel token, rerun idempotence, invalidation, `inputs` echo (schema-only ⇒ non-null rules with empty perRule) |
| `unit/app/runReadiness.test.ts` | node | the ONE run gate (UIX-6): per-code blocked states incl. dataset-error-with-stale-store and fatal-vs-index-pending, either-leg-ready with exact run inputs, non-blocking notes, unconditional signal reads under an early-return blocker |
| `unit/app/runInvalidation.test.ts` | node | UIX-7 invalidateRun: epoch bump, in-flight token cancelled, run+artifacts nulled, idle behind a PRE-CANCELLED token, repeat-stable |
| `unit/app/hashSync.test.ts` | node | UIX-10 buildSyncedConfig, both directions. Clear: config= drops with the remainder inline, passthrough verbatim, index= dies with the last schema=, uploads contribute nothing. Load: a replaced `data=` takes over, a bare fragment gains one, index= is derived from the live root, and a stale index= dies with the schema it belonged to |
| `unit/schema/schemaStore.test.ts` | node | UIX-7 loadToken: reset mid-load wins (entries + URL paths), newer load supersedes older, chooseRoot no-op after reset |
| `browser/bridge.browser.test.ts` | browser | V1/V2 regressions: DDL, cache invalidation |
| `browser/roundtrip.browser.test.ts` | browser | V5/V7: COPY→bytes→loadData→`__rowid__==__row__` |
| `browser/harden.browser.test.ts` | browser | V6: external access blocked (httpfs read fails), lock_configuration holds, buffers still readable |
| `browser/ingest.browser.test.ts` | browser | each fixture format lands with right row/col counts; excel conversion |
| `browser/validation-worker.browser.test.ts` | browser | mini fixture end-to-end flag equality, progress ordering, abort, cap truncation |
| `browser/rulesExec.browser.test.ts` | browser | representative rules through the real bridge, hardened |
| `browser/jsSandbox.browser.test.ts` | browser | sandbox in-browser smoke + lazy-chunk-only-when-needed |
| `browser/offenderFocus.browser.test.ts` | browser | UX-03 `tryFilterByCondition`'s three outcomes through the real grid: a matching condition applies exactly one raw-SQL filter (and re-focusing replaces rather than stacks); a parseable zero-match condition returns `no-match`, applies none, and REMOVES the previously applied one; an unbindable condition returns `unfilterable` and does the same |
| `browser/rulesSlotDetails.browser.test.ts` | browser | UX-05 slot-card ordering: the real rules card over the real store — a cold card has no `Details`, loading N files reveals one block each, and every path into an empty slot (`clearRuleFiles`, `✕` on the last file) leaves the disclosure hidden, childless and collapsed |
| `browser/shareModal.browser.test.ts` | browser | UX-07 `renderLinkSection` over the real store: the link input, Copy and char count render at the limit −1, exactly on it, and +1; only past it do `.q-share-overlimit` and the manifest button appear, and the link stays the first control in the modal body in both states |
| `browser/slotClearUrlField.browser.test.ts` | browser | UX-06 the typed URL against the real schema + rules cards: `clearRules` / `clearSchema` / the `✕` that empties the slot each wipe their own field (and only their own), the `✕` on a non-last file does not — plus the inverse pin, that a bare `clearRuleFiles()` / `resetSchemaSlot()` leaves both fields standing, which keeps the fix out of the render effects |
| `e2e/*.spec.ts` | Playwright | `smoke`, `nav`, `ingest`, `schemaLoad`, `rulesLoad`, `runQc`, `partialRun`, `offenderFocus`, `clearInputs`, `hungFetch`, `hashSync`, `download`, `preconfig`, `shareLink`, `corsFallback`, `studio-edit`, `studio`, `a11y`, `reducedMotion`, `perf.smoke`, `network-isolation` |

## 4. Lint / typecheck / CI

- ESLint flat config + `typescript-eslint` strict-type-checked + Prettier. `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`.
- `npm run verify` = typecheck + lint + unit (the pre-work gate every CC agent runs).
- `.github/workflows/ci.yml`:
  - **PR:** `npm ci` → typecheck → lint → unit (node) → browser tests → build → `check-bundle-size` → Playwright E2E (cached browsers) → upload artifact; plus `fixtures:check`.
  - **main:** same + deploy via `actions/configure-pages@v5` + `actions/upload-pages-artifact` + `actions/deploy-pages@v4` (`permissions: {pages: write, id-token: write}`, `pages` concurrency group).
- **Bundle budget** (`scripts/check-bundle-size.mjs`, CI-enforced): entry JS ≤ 300 KB gz (excludes WASM + lazy chunks). Lazy chunks (loaded on demand only): SheetJS, exceljs, QuickJS, CodeMirror/studio route. Self-hosted duckdb WASM (~35 MB) exempt, long-cached.

## 5. Perf gates (P20)

`perf.smoke.spec.ts`: 100k×20 synthetic dataset completes a full run without crash, annotation cap engages cleanly, and total run time is recorded (soft threshold; assert < 60 s in CI hardware terms). `network-isolation` assertion: after app load, zero non-origin requests (backs the README privacy claim).
