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
| `specs/architecture.md` | Stack, module tree, canonical names (`__row__`, `quac_raw/typed/work`, view `data`), QCFlag, pipeline stages, security hardening, **Verified facts** (V1–V15) |
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
| [ ] | P05 | Dataset ingestion & display | P02, P03, P04 |
| [x] 2026-07-23 · ff9551c | P06 | Schema loading & root detection | P02, P04 |
| [ ] | P07 | Column digests & pertinence | P06 |
| [ ] | P08 | FlagStore & schema translator | P07 |
| [ ] | P09 | Schema validation engine | P05, P08 |
| [ ] | P10 | Rules model, CSV parse/serialize, static lint, assertion DSL | P02 (P01 for harness) |
| [ ] | P11 | Rules engine: validations | P08, P10 (node-only; P03 for browser wiring) |
| [ ] | P12 | Rules corrections (SQL), integrated lint, hardening, rules slot | P05, P11 |
| [ ] | P13 | QuickJS sandbox & JS corrections | P12 |
| [ ] | P14 | Run orchestration & in-app report | P09, P12 (P13 integrates if done) |
| [ ] | P15 | Excel QC report export | P14 |
| [ ] | P16 | URL configuration & sharing | P05, P06, P12 (P14 for full journey) |
| [ ] | P17 | Rule Studio: workspace & editor | P12, P05 |
| [ ] | P18 | Rule Studio: preview, gate, export | P17 |
| [ ] | P19 | Branding polish & accessibility | P14, P16, P18 |
| [ ] | P20 | Hardening, perf, docs, release | all |

## Progress log

> Append-only. Newest entries at the top. Format: `YYYY-MM-DD · PNN · <3–5 lines>`

2026-07-23 · P06 · Schema subsystem §A shipped on branch p06-schema: core/schema/{types,messages,schema-set,ref-graph,root-detection,
meta-validate,fetch-json,schema-store}.ts + schema SlotCard/IndexPickerModal (scoped q-schemaslot/q-idxpick classes; generic SlotCard names
left for P05 — consolidate post-merge). E_META wired NOW via ajv ^8.20 (dynamic import, lazy chunks; entry 12.8 KB gz): one instance per set
by root draft; other-known-draft files skipped (E_MIXED_DRAFT covers). AppStore slots.schema NOT bridged (views get no store ctx —
`bindSlotSignal` ships for P14's one-liner). Unit 113 + browser 13 + e2e 17 green; nav.spec Load marker now the schema-card heading.

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
