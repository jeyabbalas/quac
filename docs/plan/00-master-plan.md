# QuaC — Master Implementation Plan

> **Start here.** This is the hub for building QuaC, a fully client-side data-QC web app. One Claude Code (CC) agent
> implements one phase at a time. Requirements source of truth: `docs/BRIEF.md`. This plan was produced 2026-07-23
> from deep research into the repo fixtures, the `@jeyabbalas/data-table` v0.5.1 library, and the 2026 browser
> tooling landscape, with stack decisions confirmed by the product owner (who is also the data-table author).

## What QuaC is (30 seconds)

Users load three things — a tabular **dataset** (CSV/TSV/JSON/Excel/Parquet), **JSON Schema** file(s) (schema
validation rules; possibly a multi-file `$ref` network), and **QC rules file(s)** (`*.quac.csv` — corrections,
semantic checks, dataset integrity, longitudinal checks). QuaC applies corrections, validates everything, shows an
annotated interactive grid (`@jeyabbalas/data-table` on DuckDB-WASM), and exports a multi-sheet Excel **QC report**.
Configurations are shareable via URL hash params so data stewards can validate privately in their own browsers.
Privacy is the headline feature: **data never leaves the browser**. A **Rule Studio** lets users compose/edit rules
with CodeMirror + live preview. Hosted on GitHub Pages at `/quac/`. Playful duck branding, used sparingly.

## Document map

| Doc | Contents |
|---|---|
| `specs/architecture.md` | Stack, module tree, canonical names (`__row__`, `quac_raw/typed/work`, view `data`), QCFlag, pipeline stages, security hardening, **Verified facts** (V1–V21) |
| `specs/data-table-api.md` | data-table v0.5.1 cheat sheet + author-confirmed behaviors + integration rules |
| `specs/ingestion.md` | Input slots UX, format conversions, guardrails, persistence policy |
| `specs/json-schema-subsystem.md` | Schema-set loading, root detection + `index=` contract, Ajv config, casting, translator + keyword table + golden messages, digests/tooltips, worker protocol, edge ledger |
| `specs/qc-rules-format.md` | The `.quac.csv` format spec: columns, (type,scope) semantics, assertion DSL, `__value__`, JS signature, 3 complete example files |
| `specs/qc-rules-engine.md` | Execution pipeline pseudocode, CTAS lifecycle, caps, broken-rule policy, lint stages, sandbox budgets, Studio hooks |
| `specs/qc-report-spec.md` | FlagStore, flag→annotation/tooltip mapping, report view panels, exact Excel workbook spec |
| `specs/url-params.md` | Hash-fragment grammar, `config=` manifest, ShareModal, CORS host table |
| `specs/ui-design.md` | Tokens/palette, wireframes, component inventory, duck copy deck, a11y checklist |
| `specs/testing-strategy.md` | Test tiers, golden journeys, fixtures strategy, named test files, CI, budgets |

## Working protocol for CC agents (binding)

1. Read, in order: this file → your `phases/phase-NN-*.md` → **only** the specs it links. Do not read other phase files.
2. Verify the repo is green before starting: `npm ci && npm run verify` (typecheck+lint+unit); run browser/E2E tiers if your phase touches them. Work on a branch; keep `main` green.
3. **Never expand scope.** Tempting improvements go in your phase file's "Deferred notes" section and the progress log below.
4. If reality contradicts a spec (especially ⏳ items in `architecture.md → Verified facts`): spend ≤30 min confirming, then implement the documented fallback, and record the deviation in **Verified facts** AND the progress log. Later agents trust Verified facts over any other statement.
5. On completion: all named verifications pass; tick your phase in the checklist below (`[x]`, date, commit/PR); append a 3–5-line progress-log entry (what shipped, deviations, notes for successors).
6. Fixtures are append-only for other phases' expectations. Changing `scripts/generate-fixtures.mjs` output requires re-running `fixtures:check` and a progress-log note.
7. Commit style: conventional-ish, imperative subject; do not bump versions or tag except in P20.

## Phase index & status

Sizing: one focused CC session each (~0.5–2 human-days); the repo ends every phase green and deployable.
Critical path: **P01 → P03 → P05 → P09/P11 → P14 → P15**. P02, P04, P06, P08, P10 can interleave after P01
(P02 after P01; P06–P09 after P04; the listed `Depends` is binding, the ordering otherwise advisory).

| Status | Phase | Title | Depends on |
|---|---|---|---|
| [x] 2026-07-23 · dcec6c1 | P01 | Scaffold, CI, deployed shell | — |
| [x] 2026-07-23 · d6476ef | P02 | Fixtures & deterministic generator | P01 |
| [x] 2026-07-23 · 20f361b | P03 | Bridge module & round-trip verification (CRITICAL PATH) | P01 |
| [x] 2026-07-23 · f037f2a | P04 | App shell, router, signals, design tokens | P01 |
| [x] 2026-07-23 · b9763bc | P05 | Dataset ingestion & display | P02, P03, P04 |
| [x] 2026-07-23 · ff9551c | P06 | Schema loading & root detection | P02, P04 |
| [x] 2026-07-23 · 95993f0 | P07 | Column digests & pertinence | P06 |
| [x] 2026-07-23 · fb7d11b | P08 | FlagStore & schema translator | P07 |
| [x] 2026-07-23 · 445b63b | P09 | Schema validation engine | P05, P08 |
| [x] 2026-07-23 · 83bed21 | P10 | Rules model, CSV parse/serialize, static lint, assertion DSL | P02 (P01 for harness) |
| [x] 2026-07-23 · 5ce8a79 | P11 | Rules engine: validations | P08, P10 (node-only; P03 for browser wiring) |
| [x] 2026-07-23 · 43e0c31 | P12 | Rules corrections (SQL), integrated lint, hardening, rules slot | P05, P11 |
| [x] 2026-07-23 · 3cf097e | P13 | QuickJS sandbox & JS corrections | P12 |
| [x] 2026-07-23 · 0e817b9 | P14 | Run orchestration & in-app report | P09, P12 (P13 integrates if done) |
| [x] 2026-07-24 · 46b3b3a | P15 | Excel QC report export | P14 |
| [x] 2026-07-24 · bbd3a25 | P16 | URL configuration & sharing | P05, P06, P12 (P14 for full journey) |
| [ ] | P17 | Rule Studio: workspace & editor | P12, P05 |
| [ ] | P18 | Rule Studio: preview, gate, export | P17 |
| [ ] | P19 | Branding polish & accessibility | P14, P16, P18 |
| [ ] | P20 | Hardening, perf, docs, release | all |

## Progress log

> Append-only. Newest entries at the top. Format: `YYYY-MM-DD · PNN · <3–5 lines>`

2026-07-24 · UIX · Interstitial UI/UX overhaul (10 commits, post-P16, before P17) — one design language on the loved chrome:
tokens (type/space/radius/border/elevation/z/motion tiers + yellow-tint/sky-deep) → button system (.q-btn secondary base,
--primary yellow opt-in, ghost/small) → tiered "sticker" surfaces (T1 ink-stroke cards / T2 hairlines / T3 quiet data) → slot-card
consolidation (shared SlotCard+DropZone+UrlField; schemaSlotCard is a detail-renderer; folder drop via onDropTransfer) → modal
footers (.q-modal-actions) + createSeverityLabel + in-panel empty doctrine → DuckProgress v2 (clamped duck, CSS-glide asymptote,
runProgressModel.ts monotonic stage segments, one surface at a time, WAAPI reveal/collapse) → Load hero + sticky run bar →
report severity-stat hero, short one-line panel tabs, offenders rule/source split, sticky panel column → ShareModal wide +
link-first + grouped schema row → CSS co-location (styles/ = tokens/base/primitives only; shell/slotCard/duckProgress/
sheetPickerModal/loadView/reportView css beside owners; dist rule-multiset verified identical minus purged
.q-slotcard-placeholder + --q-gray-900). Spec churn: ui-design.md §2 tokens/tiers, §4 wireframes + ShareModal structure, §5
conventions (slot primitives API, modal sizes, CSS map, For-P17 contract), §6 DuckProgress v2 + PROGRESS_LABELS. Lockstep
selector/copy edits confined to schemaLoad/runQc/pertinence/loadExample/download/preconfig/shareLink/nav/smoke specs
(badge → slotcard-header, panel tab renames, exact:true). 490 unit + 44 browser + 39 e2e green; bundle gate unchanged.

2026-07-24 · P16 · URL config & sharing shipped on main: core/share/{urlConfig (fragment grammar decode/encode/assemble,
unknown-param + repeated-key order preserving),configManifest (shape validation + applyPrecedence — config= first, inline
overrides each key WHOLESALE + override toast),shareModel (pure provenance→link),corsHosts} + fetchArtifact finalized (30 s
AbortController timeout so a fetch never hangs, retry hook default-off). Boot: app/bootConfig.ts applyBootConfig parses the
fragment → expands config= → loads schema (with index=)/rules/dataset (via the card loader registered on Load-view mount, with a
pending-url flush) → never auto-runs; a preconfigured session syncs index= back into the address bar once the URL-loaded root
resolves (never a bare index=). `index=` was nearly FREE — buildSchemaSet already accepted indexParam (P06 built §A.4 ahead);
loadSchemaUrls just threads it, and effects are synchronous so a matched index suppresses the modal with no flash. Provenance is
co-located in the slot states (DatasetSession.sourceUrl, SchemaSlotState.sourceUrls = crawl bases, RulesSlotState.sources aligned
with files) — the reserved `shareables` signal is SUPERSEDED by on-demand buildShareModel (kept unused; remove in P20). ShareModal
(ui/components/shareModal): ✓/✗ provenance list (uploads excluded + "host it by URL" copy), assembled link + char count + Copy,
index-included callout, >2000 chars → config= manifest download; Share enabled once any slot is non-empty (empty keeps the nav
keyboard-skip contract). FETCH_CORS UX: corsHelp host-table popover + Retry on the Dataset card (onCorsError hook), appended to
schema/rules cross-origin fetch errors. tests/e2e/support/cors-server.mjs (:4199, ACAO:* except /no-cors/) as a 2nd Playwright
webServer → journeys 2/4/6 exercise REAL cross-origin + the 14-file HESP schema crawl over HTTP from a single schema= URL
(verified in-browser: "14 files · root: core/core.schema.json"). Deviation: new unit tests placed under tests/unit/core/share/
(beside the existing fetchArtifact test) not the phase's tests/unit/share/. No new V-fact. Entry 33.2 KB gz. Unit 483 + browser 44
+ e2e 39 green. P17/P19 unblocked.

2026-07-24 · P15 · Excel QC report export shipped on main: core/report/reportModel.ts (pure five-sheet layout — `<col>__review`
sisters + deterministic collision escalation `age__review_2`, `__row_review` col A when row flags exist, per-cell merge in
pipeline order with 8-flag cap + 32,767-char guard, severity/corrected fills, column-header tints, EXCEL_MAX_ROWS truncation;
moved RULE_STATUS_LABELS/schemaRuleTargets/exact-count ranking out of reportPanels so panel + workbook share one source) +
core/report/excelWriter.ts (lazy exceljs; frozen row 1, autofilter, spec ARGB, 10–40 width clamp, bigint-safe coercion, chunked
cancellable row source → Blob) + ui/views/report/reportExport.ts (RunInfo assembly, 10k-row paged reads clearing the SELECT
cache, download) + version.ts/vite define. **V21**: exceljs has no browser streaming writer (WorkbookWriter is Node-fs only) →
chunked READ + in-memory workbook + writeBuffer(); UMD API only under `.default`. HESP emits NO row-scope QCFlags (row-scope
validate rules emit cell flags per target), so `__row_review` is absent on real runs — Q003 merges into record_id__review.
exceljs promoted devDep→dep; 249.9 KB gz lazy chunk, entry 29.7 KB gz (bundle gate asserts no leak). Unit 461 + browser 44 +
e2e 36 green. P16 unblocked.

2026-07-23 · P14-ui · One shell rail for all three routes (user request): `#app{--q-shell-max:1600px}` unconditionally;
`.q-main--wide` and its `#app:has()` rule are gone, as is the class toggle in shell.ts. Load/Studio previously sat at 1280px
while QC Report jumped to 1600px — the report width won because it buys work surface. Header and main share the variable, so
the banner rail widened with them. No layout regressions at 1600px (Load cards/preview/pertinence checked in-browser on the
HESP example). Unit 440 + browser 44 + e2e 35 green; entry 26.2 KB gz unchanged.

2026-07-23 · P14-review · Demo-readiness pass over the shipped UI (browser-driven, no scope added). CRITICAL: `.q-report-grid`
had no definite height, so data-table's `.dt-root{height:100%}` resolved to auto, its VirtualScroller measured the full content
height and rendered EVERY row (101×266 = 27k cells / 51k nodes froze the tab; a real dataset would kill it) — now a `clamp()`
on `100dvh`; treat that height as load-bearing. Also: offenders table `table-layout:fixed` (URL-bearing schema ruleIds blew it
to 3× the panel), findings list `min-width:0` + errors-first ordering, offenders ranked on the exact count shown, `.q-main--wide`
on the report route, tooltip-chip height override. Measured & left alone: window resize ≈4.5 s main-thread block from
data-table's 266 per-column visualizations (reproduces with a fixed-px grid height — not ours). Unit 440 + browser 44 + e2e 35
green; entry 26.4 KB gz. Details → phase-14 "Post-P14 demo review".

2026-07-23 · P14 · Run orchestration + in-app report shipped on main: core/pipeline.ts (ONE runQC call, schema in the NEW
EngineOptions.betweenPhases hook = §3's reserved slot, sourceTable='data', castPlan seam; signal cancel = return-partial; annotate
always presents via the reportView presenter port), report view (annotated grid + 4 panels + DuckProgress/cancel + 20k cap banner +
pre-run tooltips), Load run bar, app/typedSync.ts (quac_typed recast on schema load — arch §4's "(+ after schema load)" was
unimplemented; CSV+schema arithmetic rules linted broken otherwise), lint executableRuleFile (§7 exclusion was unimplemented),
store gains runArtifacts/applyCorrections; devHooks deleted. User-approved demo: public/examples bundle + "Load example files".
V20: wrapped-JSON CSV ingest OOMs ~2k×266 (cancel e2e uses JSON path). Unit 440 + browser 44 + e2e 35 green; entry 26.2 KB gz. P15/P16 unblocked.

2026-07-23 · P13 · QuickJS sandbox shipped on main: core/rules/{sandbox,sandbox-loader}.ts (quickjs-emscripten-core+wasmfile variant
0.32.0 exact, optimizeDeps.exclude'd; wasm = same-origin Vite asset), engine runJsCorrection (keyset __qc_hit__ fetch → per-chunk fresh
context → staged __qc_updates_<i> → pre-merge CAST-aware capture → ONE all-targets V14 merge), lint stage 5 real compileCheck (dataset-
independent, pending fallback), store/devHooks threading. Deviations: §3's per-pair merge deferred to one CTAS (broken-rule invariant
beats pseudocode); JSSandbox result gains error?; OOM catchable in-guest → driver rethrows InternalError (spike-pinned). H006 in parity
manifest (Q003 row-13 interplay pinned both engines). Unit 414 + browser 44 + e2e 32 green; entry 22.1 KB gz (quickjs lazy). P14 unblocked.

2026-07-23 · P12 · Corrections + integrated lint + rules slot shipped on main: engine runQC (shared-sink corrections→validations,
correctedCells), lint stages 4–6 (EXPLAIN dry-run of exact wrappers, pertinence, pending-data), rules-store + QC Rules SlotCard +
strip rules line, devHooks.runRules hardening wiring. MAJOR deviation: swap = single CREATE-OR-REPLACE CTAS per V14 (phase file's
quac_work_next dance superseded — destructive DROP→RENAME window); via-view variant pinned on wasm in rulesExec.browser. Node⇄browser
parity manifest green (tests/shared/qcFixtureSql.ts); "lock_configuration holds" wording predates V6 — tests assert V6 invariants.
Spec-silent calls → phase Deferred notes. Unit 377 + browser 38 + e2e 32 green; entry 22.0 KB gz. P13/P14/P16/P17 unblocked.

2026-07-23 · merge · P09+P11 merged to main (df1c01d, 47494fe). Conflicts: master-plan progress-log union only (phase-table ticks
auto-merged; entries stacked P11-over-P09). No V-number collision — P11 claimed none; V19 stands, doc-map V-range → V1–V19, stale
collide-caveat stripped from V19. No cross-branch code fixes needed; twin @duckdb/node-api test helpers (tests/unit/schema/duckdb.ts
vs tests/unit/rules/support.ts) are intentional per P09's header — consolidation deferred. Integrated tree green: verify (352 unit)
+ fixtures:check byte-clean + browser 34 + e2e 29 + build/size (entry 19.9 KB gz). P12 unblocked (P14 awaits P12); worktrees/branches removed.

2026-07-23 · P11 · Validations engine shipped (branch p11-rules-validations, sibling worktree — P09 in flight): core/rules/engine.ts
(runValidations + private FlagSink + createBridgeRunner) + sql.ts datasetFetchSQL/datasetCountSQL + support.ts openDuckDb refactor
(openQcFixture delegates; P10 pins unchanged). All 7 named tests + 15-rule fixture manifest green (unit 324; Q021 exercises
skipped-inapplicable on qc_fixture, H004=2 incl. whitespace date). Spec-silent contracts (violationCount per path, onProgress
0-based/before-rule, summaries bypass global cap, broken rules discard buffers, external-over-disabled) → phase Deferred notes.
Engine unimported by app code — entry 19.1 KB gz unchanged. P12 unblocked.

2026-07-23 · P09 · Schema engine shipped (branch p09-schema-engine, sibling worktree — P11 in flight): core/schema/{ajv-engine,casting,
row-shaping,worker-protocol,validation.worker,validation-run}.ts + app/devHooks console hook (P14 deletes) + ajv-formats dep. MAJOR
deviation **V19**: DuckDB TRY_CAST ROUNDS decimal strings to BIGINT ('42.5'→43) — §C.1 ladder replaced with an integrality-gated CASE,
pinned on node-api AND wasm. Abort = batch boundaries (arch §6; §F "between rows" → notes); extras keep native types; case-mismatch
excluded from unexpected. Mini browser deep-equal green vs the immutable 9-flag fixture; HESP dirty 101×266 end-to-end: every seeded
schema:* id at its row (cond:12/14 indices align). Perf: 100k×4 mini 268 ms wall / 107 ms worker (~935k rows/s); HESP-width pipeline
509 ms. Unit 335 + browser 34 + e2e 29 green; entry 19.9 KB gz; fixtures untouched. P09 side of P14 unblocked.

2026-07-23 · P08 · Flag layer + translator shipped on main: core/flags/{flagStore,messages}.ts + core/schema/{rule-ids,translator}.ts
+ recorded-Ajv fixtures (scripts/record-ajv-errors.mjs → synthetic/ajv-errors/, standalone, NOT in fixtures:check). §D.7 goldens pinned
character-exact with golden #2 → selfemp -6000000 (V15) and #8 title from schema ("Household net worth"); goldens beat §D prose on
trailer scope / conditional column naming / string-pattern collapse — all in phase Deferred notes. Readability spot-check: "schema:cond:12:move_reason:
when baseline_record = 1, move_reason must be -666 (Not applicable / structural skip). Found 3. [Schema note: Skip pattern: baseline records
have no prior-wave move comparison.]" · "schema:prop:record_id:value: 'HH1234_W01' does not match the expected format (pattern
^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$ — Household identifier followed by '_W' and a two-digit wave number)." Unit 307 + browser 27 + e2e 29
green; entry 19.1 KB gz unchanged. P09/P11 unblocked.

2026-07-23 · P07 · Digest layer shipped on main: core/schema/{deref,value-spec,conditionals,column-meta,tooltips}.ts +
shared core/pertinence.ts + PertinenceStrip/block-modal under the Load slot cards. HESP goldens pinned: 265 cols /
171 conditionals; sentinel-vs-code split, if.anyOf " or " join, then.allOf flattening → phase Deferred notes.
Shared-surface: DatasetSession gains `columns` (isolated commit 6821edc); buildColumnMeta also digests items-level
properties (generic schemas). Unit 258 + browser 27 + e2e 29 green; entry 19.1 KB gz. P08 unblocked.

2026-07-23 · merge · P05+P06+P10 merged to main (09bff1c, 12e641b, d754b28). Conflicts: master-plan table/log unions; package.json
dep union (lock regenerated, zero drift at P10); loadView.ts hand-merged — P05's three-slot grid + ctx signature kept, P06's
`mountSchemaSlotCard` replaces the schema placeholder; nav.spec asserts BOTH card headings. One cross-branch e2e fix: two "Fetch"
buttons post-merge → ingest.spec URL-fetch locator scoped to the dataset card. Doc-map V-range → V1–V18. Integrated tree green:
verify (225 unit) + fixtures:check byte-clean + browser 27 + e2e 26 + build/size (entry 14.8 KB gz). P07/P08→P09/P11 now unblocked;
slot-card consolidation (P06 note) stays deferred. Phase worktrees/branches removed.

2026-07-23 · P10 · Rules front-end shipped (branch p10-rules-model, sibling worktree — P05/P06 in flight): core/rules/{types,parse,
serialize,lint,assertions,sql}.ts + canonical core/flags/flag.ts (created ahead of P08, verbatim §5) + tests/unit/rules/* incl. the
engine-§9 qc_fixture seed helper (created ahead of P11; 2 documented extra rows). 66 new unit tests (113 total): round-trip fixpoint
+ byte idempotence, 16 static lint codes (HESP fixtures + tiny lint to ZERO issues), all 8 assertion expansions executed on
@duckdb/node-api. papaparse added as runtime dep ('|' excluded from delimiter guessing). Spec-silent resolutions → phase Deferred notes.

2026-07-23 · P06 · Schema subsystem §A shipped on branch p06-schema: core/schema/{types,messages,schema-set,ref-graph,root-detection,
meta-validate,fetch-json,schema-store}.ts + schema SlotCard/IndexPickerModal (scoped q-schemaslot/q-idxpick classes; generic SlotCard names
left for P05 — consolidate post-merge). E_META wired NOW via ajv ^8.20 (dynamic import, lazy chunks; entry 12.8 KB gz): one instance per set
by root draft; other-known-draft files skipped (E_MIXED_DRAFT covers). AppStore slots.schema NOT bridged (views get no store ctx —
`bindSlotSignal` ships for P14's one-liner). Unit 113 + browser 13 + e2e 17 green; nav.spec Load marker now the schema-card heading.

2026-07-23 · P05 · Dataset slot end-to-end on branch p05-ingestion: all 5 formats → `quac_raw`(__row__)→typed→work→`data`, Load-view
Dataset SlotCard + SheetPicker + 50-row preview, Report grid via the V5/V7 byte round-trip. MAJOR deviation (V17/V18): no
`registerFileBuffer` on the bridge and `loadData` whitelists its RPC options → delimited text goes PapaParse → wrapped-JSON
(`{"j":…}`, defeats read_json date-detection AND 266-col MAP inference) → `json_extract_string` CTAS; ingestion.md §2 rewritten.
New deps: papaparse, xlsx@SheetJS-CDN-tarball 0.20.3 (npm stale; CI fetches cdn.sheetjs.com, lockfile-pinned), CodeMirror peers
(build needs them resolvable for data-table's lazy editor chunk). Appended `tiny/two_sheets.xlsx` to the generator (default runs
only; fixtures:check green). Shared-surface edits isolated in one commit (ba40ef7: view mounters get ctx; store gains `dataset`
signal). Entry 6.8 KB gz. Unit 93 + browser 27 + e2e 20 green. P04's `--dt-annotation-*` body-mapping CONFIRMED on a mounted
grid (e2e asserts `--dt-annotation-error-bg` computes to `#ffc7ce` inside the Report grid).

2026-07-23 · P02 · Post-merge CI hotfix (first Linux run of the generator): DuckDB-native parquet bytes are platform-dependent →
`hesp_dirty_100.parquet` failed CI byte-equality vs the macOS-committed fixture. Contract scoped per **V16**: parquet byte-stable
per platform, content-stable across platforms — generator now keeps the committed file when `parquetFilesEqual` (DuckDB DESCRIBE
+ ordered EXCEPT ALL read-back) matches; unit test compares parquet by content, remaining 4 formats stay byte-gated. Committed
parquet bytes unchanged.

2026-07-23 · merge · P02+P03+P04 merged to main (1e1b629, 41231fd, 1939c7c). Conflicts: master-plan table/log unions; P02's
Verified fact V11 renumbered to **V15** (P03 claimed V11–V14) with cross-refs updated in phase-02-fixtures.md; package-lock
regenerated from the union package.json. Full suite green on the integrated tree: verify (47 unit) + fixtures:check (byte-clean)
+ browser 13 + e2e 11 + build/size (3.7 KB gz). P05–P10 dependencies now all satisfied; phase worktrees/branches removed.

2026-07-23 · P04 · Navigable shell shipped (branch p04-shell, own worktree — main checkout held P03-in-flight): signals/router/
store/errors + Modal/Toast/Badge/SeverityPill/EmptyState/DuckProgress, three placeholder views, footer privacy line.
Tokens finalized: `--dt-annotation-*` mapped on `body` (data-table.css ships `:root` defaults; inheritance proximity beats
import order — P05 confirm on a mounted grid). @fontsource Inter/JBMono self-hosted (latin subsets; entry 3.7 KB gz).
Router preserves raw fragment queries byte-for-byte (reads `href`, never `location.hash`). smoke.spec logo locator
tightened to `header img.q-logo` (header gained the GitHub icon). Unit 38 + e2e 11 green. Details → phase Deferred notes.

2026-07-23 · P03 · Bridge layer shipped on branch `p03-bridge`: core/bridge/{bridge,harden,tables}.ts, copy-duckdb-assets.mjs (predev/prebuild/pretest:browser), 4 browser spike regressions + unit URL test, all green; `vite preview` serves every `/quac/duckdb/*` asset 200 (verified). MAJOR deviations recorded in Verified facts V5–V8 + new V11–V14: no `bridge.export()` → `exportToBuffer`; every SQL hardening gate unusable in duckdb-wasm → hardening moved to a generated worker prelude (same-origin exact-file allowlist) + vendored parquet/icu/json extensions (NOT statically linked — they silently fetch from extensions.duckdb.org otherwise!) + `custom_extension_repository`; specs §2/§6/§8/§9 updated to match. Successors: bundle URLs must be absolute (blob worker), vite has `optimizeDeps.include:['@jeyabbalas/data-table']`, V-fact numbering may collide with parallel P02/P04 branches at merge.

2026-07-23 · P02 · Fixtures shipped: deterministic generator (mulberry32 seed 20260723) parses the HESP schema itself → 265 cols + 171
conditionals (incl. the if.anyOf disjunction at allOf[175] and 4 then.allOf blocks); 100 valid rows clean under schema AND all enabled
example rules (Q038 requires tied top rents per wave); dirty copy carries 23 seeded injections with machine-cross-checked expected ids
(`seeded-violations.json`); 5 output formats byte-deterministic (xlsx zip-mtime normalization post-writeBuffer; parquet threads=1). Rules
files verbatim from `qc-rules-format.md §8` (LF/no-BOM); tiny/ + synthetic/ committed; exceljs 4.4.0 devDep; deviation → Verified fact V15 (recorded as V11 pre-merge; renumbered — P03 claimed V11–V14).

2026-07-23 · P01 · Scaffold shipped: Vite 8.1.5 + TS ~6.0.3 (typescript-eslint caps TS <6.1.0; TS 7 native port unsupported),
ESLint 10 flat (explicit `@eslint/js` devDep — eslint 10 dropped it), Vitest 4 projects (unit node + browser Chromium via
`@vitest/browser-playwright`), Playwright smoke, bundle gate (entry 0.7 KB gz / 300 KB budget), CI verify+deploy green,
live at https://jeyabbalas.github.io/quac/ (favicon + logos 200, zero 404s). Deviations → Verified facts V9 (vitest#8895:
BASE_URL is '/' in node env) and V10 (Pages actions at v6/v5/v5, not spec's v5/v4). data-table 0.5.1 + duckdb-wasm 1.33.1-dev57.0 pinned exact.

## BRIEF → plan traceability

| BRIEF requirement | Where |
|---|---|
| Client-side TS app, GitHub Pages, no data leaves browser | `architecture.md` §1/§8; P01, P20 (network-isolation test) |
| Inputs: dataset JSON/CSV/TSV/Excel(sheet choice, default 1)/Parquet | `ingestion.md` §2; P05 (SheetPickerModal) |
| JSON Schema single file or multi-file network; auto-detect main file; modal on ambiguity | `json-schema-subsystem.md` §A; P06 |
| Selected index file id included in share URL | `json-schema-subsystem.md` §A.4 + `url-params.md` §2; P06, P16 |
| QC rules as user-handcraftable CSV; generic name; documented rule_type taxonomy | `qc-rules-format.md` (name: "QC rules file", `*.quac.csv`); P10 |
| Rule scopes incl. dataset/row/column/longitudinal; column assertions (unique, no_nulls, monotonic, match_regex, in_enum, count_distinct_in_range) | `qc-rules-format.md` §4/§4.1; P10–P11 |
| Conditions in SQL (DuckDB); corrections in SQL or JS with language column; no THEN on flag-only rules | `qc-rules-format.md` §2/§5/§6; P11–P13 |
| Safe in-browser execution of rules (privacy) | `architecture.md` §8 (worker-prelude network allowlist + vendored extensions per V6/V11; QuickJS); P03, P12, P13 |
| Basic validity checks of rules files + broad data-pertinence check | `qc-rules-engine.md` §7 + `json-schema-subsystem.md` §E.5; P07, P08, P12 |
| Inputs via upload AND dereferenceable URLs; partial pre-config; shareable | `url-params.md`; P16 |
| Excel QC report: Sheet 1 annotated data w/ `<col>__review` sisters (comment text, multi-rule append, rule-ID provenance), Sheet 2 missing vars + descriptions, Sheet 3 non-annotatable/dataset flags, Sheet 4 repeat offenders | `qc-report-spec.md` §5; P15 |
| Elegant schema-rule → comment text for ALL JSON Schema structures | `json-schema-subsystem.md` §D (keyword table + fallback); P08 |
| In-app display via data-table annotations + creative UI for other sheets | `qc-report-spec.md` §2–4; P14 |
| Column tooltips aggregating all rules per column | `qc-report-spec.md` §3; P07, P14 |
| data-table can't mutate data → correction data flow | `architecture.md` §9 (work-table CTAS + loadData round trip); P03, P12, P14 |
| Users fix data externally & re-upload (no in-app editing beyond corrections) | `architecture.md` §6 re-run semantics; P14 |
| Compose/edit/serialize rules with live effects (data-table) + CodeMirror completion/intelligence + check-before-save | `qc-rules-engine.md` §8 + `ui-design.md` studio; P17–P18 |
| Early phase creates example inputs: mock HESP data (valid+invalid) + rules CSVs | `testing-strategy.md` §3; P02 |
| Duck branding, sparing puns, duck loading bar, white main area, logo palette | `ui-design.md`; P04, P19 |
| README encourages JSON Schema for schema validation rules | P20 README task |
| Unit tests + UI/UX checks per phase | every phase file §Verification; `testing-strategy.md` |
| Out of scope for v1 (documented): external-source/linkage rules execution (loaded & listed, not run), case auto-mapping, dark mode, in-app row add/delete corrections | `qc-rules-format.md` §3, `json-schema-subsystem.md` §E.5, `ui-design.md` §2 |
