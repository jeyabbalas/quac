# QuaC — Master Implementation Plan

> **Start here.** This is the hub for building QuaC, a fully client-side data-QC web app. One Claude Code (CC) agent
> implements one phase at a time. Requirements source of truth: `docs/BRIEF.md`. This plan was produced 2026-07-23
> from deep research into the repo fixtures, the `@jeyabbalas/data-table` v0.5.1 library, and the 2026 browser
> tooling landscape, with stack decisions confirmed by the product owner (who is also the data-table author).

## What QuaC is (30 seconds)

Users load a tabular **dataset** (CSV/TSV/JSON/Excel/Parquet) plus at least one source of checks — **JSON Schema**
file(s) (schema validation rules; possibly a multi-file `$ref` network) and/or **QC rules file(s)** (`*.quac.csv` —
corrections, semantic checks, dataset integrity, longitudinal checks). Only the dataset is mandatory; every surface
degrades gracefully when one check source is absent (UIX-6). QuaC applies corrections, validates everything, shows an
annotated interactive grid (`@jeyabbalas/data-table` on DuckDB-WASM), and exports a multi-sheet Excel **QC report**.
Configurations are shareable via URL hash params so data stewards can validate privately in their own browsers.
Privacy is the headline feature: **data never leaves the browser**. A **Rule Studio** lets users compose/edit rules
with CodeMirror + live preview. Hosted on GitHub Pages at `/quac/`. Playful duck branding, used sparingly.

## Document map

| Doc | Contents |
|---|---|
| `specs/architecture.md` | Stack, module tree, canonical names (`__row__`, `quac_raw/typed/work`, view `data`), QCFlag, pipeline stages, security hardening, **Verified facts** (V1–V23) |
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
| [x] 2026-07-24 · 47179c2 | P17 | Rule Studio: workspace & editor | P12, P05 |
| [x] 2026-07-24 · ce4e15b | P18 | Rule Studio: preview, gate, export | P17 |
| [x] 2026-07-25 · a89baa0 | P19 | Branding polish & accessibility | P14, P16, P18 |
| [ ] | P20 | Hardening, perf, docs, release | all |

## Progress log

> Append-only. Newest entries at the top. Format: `YYYY-MM-DD · PNN · <5–10 lines>` — what shipped and where
> it lives (module paths), spec deviations and V-fact changes, notes and warnings for successors, then a closing
> counts line (unit/browser/e2e, entry KB gz). Repro narratives, measurement dumps, rejected alternatives and
> verification walkthroughs belong in the phase file or the spec they amend — not here.

2026-07-30 · UIX-19 · **A reload restores the session on whatever tab it lands — no Load-tab visit needed** (reverses
P19b's "deliberate quirk" note). Mount order, not persistence: both dataset loaders (`registerDatasetUrlLoader` P16,
`registerDatasetRestoreLoader` P19b) register on Load-VIEW mount and views mounted lazily, so any boot landing off
`#/load` parked that leg — schema/rules are store-level, hence the half-restored Studio. Fix: `shell.ts` mounts Load
eagerly and hidden before `applyBootConfig` on EVERY route (Report/Studio stay lazy), so `data=` also survives a
`#/report` reload. Only free while the Load subtree stays CodeMirror-free with heavy imports behind data-arrival
effects. Studio: `takePendingStudioRestore` now waits for every named file or for the slot to settle, and the gate
effect re-lints an open draft when `getLintContext()` changes identity. Amends `url-params.md` §2, `ingestion.md` §6.
Unit 803 unchanged, browser 73 unchanged, e2e 111 → 112, entry JS 50.2 → 50.3 KB gz.

2026-07-30 · P19b · **IndexedDB session persistence & app-wide Reset** — owner-directed amendment of the "no storage"
rule (`architecture.md` §8.5, `ingestion.md` §6, the footer line): ONE device-local DB `quac-session`, INPUTS only,
never the report, and restore never auto-runs (consent to compute stands). Stance: persist original inputs, replay the
existing loaders — per-slot replay and write-through timings in `ingestion.md` §6; schema replays with
`preserveIntakePaths` and the root on `indexParam`, so no IndexPicker; an all-empty state EMPTIES the DB rather than
deleting it, since `deleteDatabase` can block on an open connection. New `app/session{Snapshot,Persistence,Backend}.ts`
+ `app/studioSession.ts`; boot is arbitrated by `decideBoot`'s four-row table (`url-params.md` §1), whose row 3
EXCLUDES `index=` from the equality key against the plan's letter (reasoned in its doc comment). Header `Reset` is the
always-confirming clear-all plus a purge. Two fidelity losses documented in §6; P20 still owns the README rewording.
Unit 762 → 803, browser 60 → 73, e2e 101 → 111, entry JS 46.9 → 50.2 KB gz.

2026-07-27 · UIX-18 · **A schema parse error names a file you can paste, and says it once — UX-10.**
`stripCommonRoot` is a `webkitRelativePath` helper (§A.2.1: uploads only) that `intakeFiles` handed every origin, and
a URL's first `/` segment is its scheme, so it ate `http:` off EVERY URL entry; `relativizeUrlPaths` repairs
`relativePath` off `fileId` only afterwards, while messages freeze at intake — so gating the strip on upload origin
also fixes `E_DUP_ID` and the four `ref-graph` messages. Second half, one token: `E_PARSE` names the file by
`fileId`, not `relativePath` — the same string the card's *Ignored files* line prints, so one file can never be named
two ways (now a unit invariant). V8's position-free tail is cut only when present, so a message merely containing a
comma survives whole (fail-closed). Spec: `json-schema-subsystem.md` §A.1 + §A.3's `E_PARSE` row,
`testing-strategy.md` §16. `stripCommonRoot` itself was mis-aimed, not wrong: its contract and tests stand.
Unit 755 → 762, e2e 100 → 101, browser 60 unchanged, entry JS 46.8 → 46.9 KB gz.

2026-07-27 · UIX-17 · **The Findings list leads with its message, not a 106-character machine id — UX-09.** Display
composition only: `schema:advisory:<fileId>` is untouched, so `seeded-violations.json`/`mini_expected_flags.json` never
move and P14's Deferred note (`phase-14-run-report.md:117-119`, still unstruck) is answered without spending the §D.5
`fileId` deviation. `renderFlag` keeps its name, signature and output, and is now composed of a new `renderFlagMessage`
over a shared `correctionSuffix`, so Excel's `<col>__review` cells are unchanged BY CONSTRUCTION. Two extras: the
panel's private broken-rule string became a shared `ruleStatusMessage()` (`reportModel.ts`); and the URL-id overflow
guard `li > span:not(.q-pill)` lost the span the markup change removed, so it was RE-EXPRESSED on the `.q-finding-*`
leaves rather than dropped. Spec: `qc-report-spec.md` §1/§2/§4, `architecture.md` §5, `testing-strategy.md` §15.
Unit 750 → 755, e2e 99 → 100, browser 60 unchanged, entry JS 46.8 KB gz unchanged.

2026-07-27 · UIX-16 · **A rule disabled by an untyped column says so in plain language — UX-08.**
One branch in lint stage 4's `dryRun` (`core/rules/lint.ts`): `RuleLintIssue` already splits `message` (text) from
`detail` (`title`), so one rewritten string fixed the slot card AND both Studio surfaces (`ruleForm`, `codeEditor`).
`qc-rules-engine.md` §7 stage 4 said binder errors are surfaced **verbatim**, forbidding this; verbatim is now
`detail`'s job and the fail-closed gate is pinned there, V23 gaining the live numbers. The `DESCRIBE` probe is
memoized + wrapped: `relint` (`rules-store.ts:67`) has no try/catch, and an escaping rejection strands the card at
`phase: 'loading'`. Untouched by design: `sql-error` stays one code, `recordBrokenRule` (`engine.ts:382`) stays raw.
Unit 739 → 750, e2e 98 → 99, browser 60 unchanged, entry JS 46.8 KB gz unchanged.

2026-07-27 · UIX-15 · **An over-length share link keeps its link and its Copy button — UX-07.**
Root cause: the early `return section;` at `shareModal.ts:209` made the link row unreachable past the threshold. The
link row, char count and callout now render unconditionally with the advice + manifest button appended below, and the
threshold moved out of the view into `buildShareLink` (`shareModel.ts`) to be node-testable (boundary `>`, not `>=`).
`url-params.md` §4 and `ui-design.md`'s ShareModal line, which had licensed the *replace*, now pin the offer as
additive. Also: `public/examples/index.json` (`scripts/example-manifest.mjs`) lists the schema ROOT only as a crawl
base (all 14 still staged), fitting the example under the limit at the DEPLOYED origin; fixture paths untouched.
Browser 56 → 60 (13 files), e2e 97 → 98, unit 734 → 739, entry JS 46.7 → 46.8 KB gz.

2026-07-26 · UIX-14 · **A cleared slot forgets the URL it was fetched from — UX-06.**
Root cause: `createUrlField.clear()` had ONE call site in `src/` — `datasetCard.ts:131` — while
`clearSchema`/`clearRules` (`clearInputs.ts:203,213`) are store-only, so neither check-source card had a hook. Both
now register one on mount, driven from `clearInputs.ts` via `clearSchemaSlot()` / `clearRulesSlot()`, bound to the
EXPLICIT clears and not to `status === 'empty'` (a THROWN schema load lands there too — `schema-store.ts:57,110`).
The rules card's `cancelRun()` moved into that hook, closing a latent clear-all-mid-fetch defect, and
`IngestUi.onUrlAbandoned` fires on SheetPicker Cancel, URL leg only. Pinned: `ingestion.md` §1, `ui-design.md` §5.
Browser 52 → 56 (12 files), e2e 95 → 97, unit 734 unchanged, entry JS 46.6 → 46.7 KB gz.

2026-07-26 · UIX-13 · **An emptied slot advertises no detail it does not have — UX-05.**
Root cause: `createSlotCard.update()` derives the actions row AND `<details>` visibility from live DOM
(`detailHost.childElementCount`), and the rules effect called `update()` before `renderDetails()`, counting the last
load's blocks. The swap is the fix; `renderDetails` wipes its host before its early return. Also: the effect
collapses the disclosure when the slot empties — safe, since `summarizeSlot` reads `'empty'` only with no files AND
no fetch errors. Invariant + collapse pinned in `ui-design.md` §5. Known issue: `schemaSlotCard.ts:204`'s
`setDetailsOpen(true)` on a fatal error has no paired `false`, so the SCHEMA card stays expanded after a clear.
Browser 49 → 52 (11 files), e2e 94 → 95, unit 734 unchanged, entry JS 46.6 KB gz unchanged.

2026-07-26 · UIX-12 · **A slow fetch is visible, and the way out is on screen — UX-04.**
Three defects: both check-source projections tested emptiness before phase (`schema-store.ts:50/75` publishes
`loading` with a null `set`, so the branch was dead), `addRuleUrls` published no phase until bytes landed, and the
rules Clear cancelled the store, not the card's `.finally()` latch. Fix, now `ingestion.md` §1: phase is tested
FIRST, `addRuleUrls` enters `loading` before the loop, `run()` is generation-counted behind `cancelRun()`, the schema
card gains `Fetching…`. Knock-on, intended: the slots now report `loading` honestly, so `loadView`'s `anyFilled`
turns true as a fetch starts — hero recedes and `Clear all inputs` shows meanwhile; `runReadiness` untouched.
Discharges UIX-7's deferred niggle. Unit 727 → 734, e2e 92 → 94, browser 49 unchanged, entry JS 46.5 → 46.6 KB gz.

2026-07-26 · UIX-11 · **A focus filter that matches nothing is a failed best effort, not an empty grid — UX-03.**
Offender focus on `H004` emptied the grid to `0 / 101 rows`: `validateSQLFilter` returns `{valid, matchCount}` and only
`valid` was read. `tryFilterByCondition` now returns `OffenderFocusOutcome` (`applied`|`unfilterable`|`no-match`); both
failures also drop the previous rule's chip. Both toasts + the VARCHAR-vs-DATE divergence behind H004:
`qc-report-spec.md` §4. Studio twin `previewPane.offerPreviewFilter` took the same guard — "Filter preview to matches"
is not offered when it would empty the preview (phase-18 pins only `!valid`). Rejected: `__rowid__ IN (…)` off the
run's flags — `OffenderRow` has no row list and flags are 20k-capped.
Browser 46 → 49 (10 files), e2e 91 → 92, unit 727 unchanged, entry JS 46.4 → 46.5 KB gz.

2026-07-26 · UIX-10 · **The address bar tracks the live inputs, not just the link you arrived on — UX-02.**
The fragment was write-only on clears: replacing a URL-loaded artifact left the bar, and any reload, on the old one.
New `src/app/hashSync.ts` is the single writer both ways — `buildSyncedConfig` is UIX-7's `buildClearedConfig` but
DERIVES `index=` from `set.root.indexFileId`, retiring `bootConfig`'s `installIndexSync` (the only history-pushing
writer). Arming (`url-params.md` §2): the effect installs LAST, after all three boot legs settle (`datasetCard.run()`
now returns its chain) — never gate it behind a flag-guarded early return instead, `signals.ts` re-tracks deps per run
and unlinks unread branches, so it would go deaf for good. Deviation, same §: the writer owns the QUERY, not the path
(canonicalizing breaks router.ts's read-only unknown-route contract).
Unit 723 → 727, e2e 87 → 91, entry JS 46.3 → 46.4 KB gz.

2026-07-26 · UIX-9 · **A schema that describes none of the dataset's columns is a finding, not a parser error.**
The zero-overlap bug UIX-8 filed: when a closed schema names none of the dataset's columns the QC worker's column list
`selected` is empty, and interpolating it into `SELECT ${selectList} FROM …` made DuckDB answer `Parser Error: SELECT
clause without selection list` — the run died on a raw-engine toast with no report. `validation-run.ts` now skips the
row loop entirely (no worker constructed) and emits one dataset-scope flag `schema:dataset:no-overlap` (`rule-ids.ts`)
saying why nothing was validated; the dataset-level SQL checks were hoisted OUT of the worker's `try/finally` so they
still run. Rule, copy and rationale now in `json-schema-subsystem.md` §H edge 20 (flag table §D.5, placement §F);
§E.5 reports it `Mismatch` and does not gate.
Unit 721 → 723, e2e 85 → 87, entry JS 46.3 KB gz (unchanged).

2026-07-26 · UIX-8 · **A display grid never reuses another build's parquet path — UX-01 from the manual review.**
A reshaping dataset replacement + re-run left the grid empty behind two toasts of `No magic bytes found at end of file
'quac_display.parquet'`. Cause: data-table's fixed `<tableName>.parquet` virtual file, whose DuckDB per-path state
survives register/drop. Fix: `nextDisplayTableName()` (`core/bridge/tables.ts`) at both `createDataTable` call sites
(not on the same-generation refresh); the Studio sample grid had the same bug. Both pinned in `architecture.md` §4 +
`ingestion.md` §2. Secondary: a failed build resets `tableGeneration`, swaps in a `.q-panel-note` and rethrows a typed
`QuacError` so no engine text toasts; `renderedGeneration` + an `announcedFailureGeneration` latch kill a redundant
rebuild and a duplicate toast.
Unit 718 → 721, browser 45 → 46, e2e 83 → 85, entry JS 46.3 KB gz (unchanged).

2026-07-26 · merge · UIX-6+UIX-7 merged to main (e5474d4, 0103daf). Zero conflicts — the two branches were a linear
chain (uix7 branched off uix6's tip), so both `--no-ff` merges replayed clean and the integrated tree is
byte-identical to uix7's; no cross-branch fixes needed. Integrated tree green: typecheck + lint clean, unit 718 +
fixtures:check byte-clean + browser 45 + e2e 83 + build/size (entry 46.3 KB gz) — every count matches what the two
entries below claim. Manual pass covered both partial-run modes and all five clear paths. Branches removed.

2026-07-26 · UIX-7 · **Every input is clearable; an explicit clear invalidates the run, the hash, and the tables.**
Every slot card gains a `Clear` (rules a per-file ✕ too; schema is whole-slot — a set compiles as one unit), the run
bar a left-pinned `Clear all inputs`. New `app/clearInputs.ts` + `app/runInvalidation.ts` (`store.runEpoch`) +
`app/rulesDraftProbe.ts` + `peekBridge()` (WASM-free table drop) + reportGrid `disposeGrid`/`clearRunPresentation`;
contract `ingestion.md` §1/§4 + `architecture.md` §6/§7, copy `ui-design.md` §5. Two live bugs fixed en route: the
mid-run-replace `onProgress` wedge, and non-monotonic ingest generations (`ingestController.ts`) that let reportGrid's
memo serve the previous dataset's grid. Deferred: back-stack entries still carry pre-clear URLs (replaceState fixes
only the current one); a cancelled run racing a dataset clear may log swallowed worker-side stage errors. (The third —
no Loading badge on a first rules fetch — was discharged by UIX-12.)
Unit 695 → 718, e2e 76 → 83, entry JS 44.4 → 46.3 KB gz.

2026-07-26 · UIX-6 · **Only the dataset is mandatory; either check source alone runs** (contract for P20's README).
The engine always worked this way — what shipped is the surface: `app/runReadiness.ts` is now the ONE gate Run and
`startRun` share (Warning dataset runs; stale-`store.dataset` re-ingest failure refuses; index-pending schema blocks
only when no rules can carry the run — `ingestion.md` §1), the Load cards carry Required/Optional tags, and partial
runs stop misleading — dashed rules cards + scope notes off `RunArtifacts.inputs`, split Missing-vars empties, a
conditional Offenders hint, an Excel Sheet 2 "comparison was not performed" row (`qc-report-spec.md` §4/§5). Golden
journey 8 (`partialRun.spec`) drives both modes; rules-only stays all-VARCHAR by design (V23). Deferred niggle: a file
whose every ROW is lint-errored still counts as executable (empty rule list), so the gate says ready with nothing to
run — inherited from `executableFiles()`.
Unit 676 → 695, e2e 74 → 76, entry JS 43.0 → 44.4 KB gz.

2026-07-25 · UIX-5 · **Pertinence is a line in the Preview head, not a strip with a modal.** The old check compared
only Dataset↔Schema and Dataset↔Rules, so it could say numbers disagreed but structurally could not name WHICH input
was foreign, and it returned early on a null dataset. `crossCheckInputs` (`core/pertinence.ts`) now runs the unchanged
`computePertinence` over all three pairs and triangulates: an edge is bad at `score < 0.5`, exactly two bad edges share
exactly one vertex, and that vertex is the suspect; 0/1/3 bad edges name nobody and `warn` edges never accuse. Full
rules → `json-schema-subsystem.md` §E.5. The strip, block modal, `blockCopy`, `overrideKey` and the `prompted` set are
all DELETED — nothing was ever blocked, so nothing pretends to be: one Tier 2 `role="status"` line inside the existing
Preview sticker, rendered from `mountPreviewSection`'s existing availability effect with its write to `tabs.active`
staying last, per the UIX-4 hazard. Numbers appear only when something is wrong (a test asserts the consistent line
contains no digit); tints use `--q-warning-ink`/`--q-error-ink` and a new axe scan covers both tinted tones.
Unit 660 → 676, e2e 69 → 74, entry JS 42.9 → 43.0 KB gz.

2026-07-25 · UIX-4d · **The QC rules tab has content.** `rulesPreview.ts` was a 41-line stub — you could load three
`.quac.csv` files and never read a rule on the Load tab. The panel is now the SAME component as the data dictionary
over a different payload (layout in `ui-design.md` §5): one `<details class="q-rp-file" open>` per file in **load
order** — the cross-file correction-order contract — with a search box, Collapse/Expand all and six curated columns
rather than the raw ten. Syntax highlighting reuses the Studio's `@lezer/highlight` + PostgreSQL/JS parsers so the two
surfaces agree by construction; the `tok-*` colours moved to `primitives.css` under a **`.q-syntax` marker — unscoped
`.tok-*` would restyle data-table's own bundled CodeMirror**. The bundle gate drove the split: `exprTokens.ts` is
reachable only via the dynamic `import()` in `exprHighlight.ts` (`lang-sql → language → view`, Load being eager).
One guard worth keeping: the panel rebuilt on every `rulesState` publish — and every load ends with a second, re-lint
publish — throwing away user-collapsed `<details>` and typed queries, so it reference-compares `state.files`.
Deviation: `TokenRun`/`ExprLang`/`splitLines` live in the DOM-free `rulesPreviewModel.ts` and `exprTokens.ts` imports
the types, not the reverse, so the node-tested model never reaches CodeMirror (this swapped the plan's commits 2/3).
Unit 599 → 640, loadPreview 13 → 20 e2e, two new axe scans; entry JS 41.4 → 42.9 KB gz (all QuaC's own code).

2026-07-25 · UIX-4c · **The data dictionary's categories collapse.** All twelve opened at once made the panel 82
screens tall on HESP. Each category is now a native `<details class="q-dd-cat" open>` whose `<summary>` is the whole
header row, plus one Collapse all / Expand all beside the search box — native `<details>` is why it is cheap
(`aria-expanded`, Enter and Space are the UA's; both the button and the filter reduce to writing `.open`). **Search
wins over a collapsed category**: typing force-opens every category still holding a match and clearing restores what
you had open, snapshotted on the *transition* into filtering because `toggle` fires from a queued task and cannot
tell a click from a programmatic write. Default stays expanded — axe skips unrendered subtrees, so collapsing by
default would take twelve tables out of the gate. Deviation: the blanket `.q-dd-scroll summary` rule was narrowed to
`details:not(.q-dd-cat) > summary` rather than adding `color: inherit`. 599 unit unchanged (DOM only) + 3 e2e and a
fourth axe scan; entry 41.2 → 41.4 KB gz, no new dependency.

2026-07-25 · UIX-4b · Follow-up on the Preview panel, on review of the shipped one. **The tabs are now named for the
inputs, not the rendering**: `Dataset · JSON Schema · QC rules`, the three slot-card names verbatim; the dictionary
framing moves inside as a `.q-preview-panelcaption` (`JSON Schema formatted as a data dictionary`), present in every
state. **Format folded into Type** — at 7% it was ~95px of em-dash on 260 of HESP's 265 rows, and it renders as a
muted mono line under the type (`.q-dd-format`), which is what `format` IS in JSON Schema: a qualifier of `type`, not
a peer. Six columns instead of seven, every one wider and the table 110px narrower (`min-width` 1180 → 1070). 599
unit unchanged (the model still carries `format`; only the DOM changed) + 1 e2e pinning the six headers; 59 e2e green.

2026-07-25 · UIX-4 · Interstitial Load-view pass on main (post-P19, before P20): **the Load tab previews all three
inputs, not one** — one Tier 1 sticker holding a `createPanelTabs` tablist over Dataset · Data dictionary · QC rules
(renamed in UIX-4b; the rules tab stayed empty until UIX-4d), spec'd in `ingestion.md` §2. Extraction is
`json-schema-data-dictionary@0.1.0` (MIT, pinned exact) behind `core/schema/data-dictionary.ts`, in a lazy 16.4 KB gz
chunk under its own `check-bundle-size.mjs` marker — statically imported it would have grown eager JS ~45% for a tab
most users never open. **Three deviations.** (1) The preview key gained `typedRevision`, since a schema-load recast
re-points the `data` view WITHOUT bumping `dataset.generation` — causal chain in `ingestion.md` §2's ⚠️ note.
(2) Panel-tab primitives moved to `primitives.css` + `components/panelTabs.ts`, discharging
`phase-17-studio-editor.md:41`'s standing instruction. (3) The dictionary renders where `columnDigest` refuses to:
§A.5 blocks validation on fatal set-level errors, not schema browsing. The **agreement test** caught a real divergence
— digest 0 vs package 2 on `synthetic/no-ids`, a §E.1 scope limit — pinned as `KNOWN_DIVERGENT` in
`tests/unit/schema/data-dictionary.test.ts`, NOT in any spec. Hazard UIX-5 later leans on: the visibility effect read
the signal it wrote, so `active.set()` re-entered it and bounced the user's first click on any other tab.
Unit 548 → 599, +9 e2e (`loadPreview.spec.ts`); `a11y.spec.ts` ACTIVATES each Preview tab before scanning, since axe
skips `[hidden]`. Entry JS 37.5 → 41.2 KB gz.

2026-07-25 · P19 · **Favicon re-cut from the artwork** (post-merge review): P19 hand-drew a duck believing the artwork
was a raster, but `a44d234` had already vectorised `assets/logo/*.svg`, so the tab carried a different duck than the
header. `scripts/generate-favicons.mjs` now emits `public/favicon.svg` too, placing the artwork by measured minimal
enclosing circle with the coordinates baked into the 32-unit icon space (no `transform` for a dumb rasteriser to
mangle). One deliberate non-token: the bill keeps the artwork's `#f95d1d` — `--q-orange` on `--q-yellow` is 1.42:1 and
the bill dissolves at 16px. Constants and rationale → `ui-design.md` §6; deviation #4 in `phase-19-polish-a11y.md`.
Output is byte-identical across runs. 548 unit · 49 e2e green; `typecheck`/`lint` clean.

2026-07-25 · P19 · Branding polish + a hard accessibility pass. Shipped: favicons from a committed **Playwright**
script (not `sharp`), `tests/e2e/a11y.spec.ts` (axe over 3 views + 4 report panels + 3 modals, gated on
serious/critical — CI already runs `test:e2e`, so that IS axe in CI), `reducedMotion.spec.ts`, and
`tests/unit/ui/copyDeck.test.ts` (pun containment). Four measured defects: sub-AA severity mid-tones on their own fills
(new `--q-*-ink` tokens take the workbook's font colours per `qc-report-spec.md` §5, fills frozen so P05's `#ffc7ce`
e2e stays green), an unpinned `colorScheme` turning the grid dark under a dark OS (`'light'` now pinned at both
`createDataTable` calls), an invisible focus ring on `--q-sky`, and the placeholder favicon; axe then found seven
more, the sole **critical** being `<tr role="button">` inside a `<tbody>`. All 19 recomputed §7 pairings live in
`ui-design.md` §2/§7 — only the annotated cell's RENDERED 9.12 is log-only, since data-table alpha-blends the tint
and so beats the raw token pair's 5.92. **The keyboard walk found what axe could not (V22)**: data-table is a WCAG 2.1.2
keyboard trap, mitigated by a `.q-skiplink` (a `<button>` — never an `<a href="#…">`, QuaC routes on the hash) plus
Escape-to-leave on both grid hosts. Deviations → `phase-19-polish-a11y.md`. **For P20**: that trap is the one thing a
release audit will flag that QuaC cannot fix in-repo — it wants an upstream issue, and `ui-design.md` §9 should be
re-checked on any data-table bump.
548 unit (+3) · 44 browser · 49 e2e (+4) green; entry 37.5 KB gz (was 37.1, budget 300); axe stayed devDep-only.

2026-07-24 · UIX-3 · Interstitial Rule Studio pass on main (post-P18, before P19): the rail collapses and deleting a
rule asks first. Collapse is one `--q-studio-rail` flip plus a pinned 600px work track at ≥1280; a user-reported height
bug (a fixed clamp starved the sample grid) is fixed by filling the screen at ≥1280 — full contract and measurements
now in `ui-design.md` §5. Rail state is a plain `let` + `quac.studio.railCollapsed`, the app's FIRST localStorage key
(`architecture.md` §5's trivial-UI-prefs carve-out). `confirmDeleteRule` mirrors `confirmDiscard` and subsumes the
dirty-draft guard. **Correction to a P14-review inference** (`phase-14-run-report.md` still reads the old way): the
~4.5 s HESP block is a data-table *creation* cost, not a resize cost — `TableContainer`'s ResizeObserver has zero
subscribers and headers are fixed-px, so a width change fires none of the 266 visualization observers. 545 unit + 44
browser + 42 e2e green; entry 37.1 KB gz unchanged (all in the lazy studio chunk).

2026-07-24 · UIX-2 · Interstitial Rule Studio UI/UX pass on main (9 commits, post-P18, before P19) — four Tier-1
stickers on one screen, the form split from its test result. Now ONE card with three hairline zones (rail · work ·
preview): the editor REPLACES the rule table in the work column (`syncWorkView()`), a `← Rules` ghost routes back
through the existing discard guard, and the preview reads result-first over a definite-height sample grid. Sizing is
MEASURED (600px work-track floor, 130px in-band targets cap → 0px overflow at 1600–768; ≤1023 the rail becomes a
horizontal file strip); the whole layout contract is now `ui-design.md` §5. **P19 task 3's Studio empty state is
already done** (duck mark + copy, mirroring reportView) — do not redo it. Deviations from the approved sketch, all to
hold its own "no horizontal scroll down to 1280": rail 240px not 260, preview floor 360px not 380, work track gained a
floor. 545 unit + 44 browser + 41 e2e green; entry 37.1 KB gz unchanged.

2026-07-24 · P18 · Rule Studio preview/gate/export shipped on main (6 commits): rules become live-testable, saving is
gated, files round-trip. `ruleTest.ts` is pure dispatch mirroring the engine's interpret + `applicableTargets` over the
EXACT `sql.ts` wrappers (`PREVIEW_ROW_CAP` 20, counts still exact on the full `data` view); `previewPane.ts` docks a
second data-table (`quac_studio_display`, 10k sample, `__rowid__ == __row__` per V7) beside the grid, plus
`RuleTestPanel`. Gate: submit iff `rule_id` valid ∧ last completed lint clean (`lastLintOk`) ∧ tested-since-last-edit
— this SUPERSEDES P17's lint-never-blocks; the policy, the "Save untested" carve-out and the fixture-reality deviation
(the e2e asserts the example dataset's seeded −1200, not the phase file's −2500) are all in
`phase-18-studio-preview.md`. Export is "Download rules CSV" in the grid header (deviation from the wireframe's drawer
row); golden journey 5 is `studio.spec.ts`. Unit 545 + browser 44 + e2e 41 green; entry 37.1 KB gz (all new UI in the
lazy studio chunk). P19 unblocked.

2026-07-24 · P17 · Rule Studio workspace & editor shipped on main (7 commits): `lint.ts` now exports the (type,scope)
matrix (`typeScopeComboError`/`isValidTypeScope`) and rules-store grows `getLintContext()` + `dirtyFiles` + in-session
mutators that all round-trip serialize→parse. `views/studio/`: `studioView.ts` is an eager shim route-gating the lazy
`studioWorkspace` chunk (the bundle gate gains a `@codemirror/view` `cm-announced` entry-leak marker beside ExcelJS);
workspace = rail + rule grid + full-width bottom editor drawer (user-approved; P18 docks the preview beside the grid).
`codeEditor.ts` is the ONLY `@codemirror/*` importer (`completionSource.ts` pure + node-tested); draft lint is ONE
400 ms debounce → `runDraftLint` pushed via `setDiagnostics`, paused while the pipeline runs; the catalog reads
`DESCRIBE quac_work` (idiom deviation from the phase file's `PRAGMA table_info`) + session-cached `duckdb_functions()`,
so the studio never boots the wasm. Deferred: the PRE-EXISTING `download.spec` flake (VARCHAR-window lint race,
reproduced on the pre-P17 base 4/6) stays open as a P20 follow-up — mechanism in `phase-17-studio-editor.md`. Unit 525
+ browser 44 + e2e 40 green; entry 37.3 KB gz. P18 unblocked.

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
