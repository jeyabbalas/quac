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

> Append-only. Newest entries at the top. Format: `YYYY-MM-DD · PNN · <3–5 lines>`

2026-07-26 · UIX-6 · **Only the dataset is mandatory; either check source alone runs** (contract for P20's README).
The engine always worked this way — what shipped is the surface: `app/runReadiness.ts` is now the ONE gate the Run
button and `startRun` both consume (a Warning dataset runs; a failed re-ingest with a stale `store.dataset` refuses;
an index-pending schema blocks only when no rules can carry the run, else it rides as a non-blocking "won't be
checked this run" note), the Load cards carry Required/Optional tags under a one-line rubric, and partial runs stop
misleading: Summary dashes the three rules cards off `RunArtifacts.inputs` (+ scope notes), Missing-vars splits its
no-schema/no-dataset empties, the Offenders hint renders only when a row is actually filterable, and Excel Sheet 2
gains a "comparison was not performed" note row. Golden journey 8 (`partialRun.spec`) drives both modes; rules-only
stays all-VARCHAR by design (docs-only caveat — see V23: the binder refuses implicit VARCHAR casts, so lint stage 4
excludes such rules pre-run). Deferred niggle: a file whose every ROW is lint-errored still counts as an executable
file (empty rule list) — the run gate says ready with nothing to run; inherited from `executableFiles()`, now noted.
Unit 676 → 695, e2e 74 → 76, entry JS 43.0 → 44.4 KB gz.

2026-07-25 · UIX-5 · **Pertinence is a line in the Preview head, not a strip with a modal.** The check compared
Dataset↔Schema and Dataset↔Rules and never Schema↔Rules, so it could say some numbers disagreed but structurally
could not say WHICH of the three files was from another project — one bad edge names a disagreeing PAIR with no
third opinion to break the tie — and it returned early on a null dataset, so a mismatched schema/rules pair already
on screen got nothing at all. `crossCheckInputs` (`core/pertinence.ts`) now runs the unchanged `computePertinence`
over all three pairs and triangulates: an edge is bad at `score < 0.5`, exactly two bad edges always share exactly
one vertex, and that vertex is the suspect. 0, 1 or 3 bad edges name nobody, and `warn` edges never accuse anyone —
90% coverage is partial data, not a stranger. Full rules in `json-schema-subsystem.md §E.5`.

The strip, the block modal, `blockCopy`, the `overrideKey` signal and the `prompted` set are **all deleted**.
Nothing was ever blocked, so nothing pretends to be: one Tier 2 line inside the existing Preview sticker
(`role="status"`, badge `OK`/`Warning`/`Mismatch`), rendered from `mountPreviewSection`'s existing availability
effect rather than a second one — the write to `tabs.active` stays last, per the hazard note that cost a real bug in
UIX-4. `Pertinence: 265/265 schema variables present · 0 missing · 1 extra` becomes `Inputs look consistent — the
dataset, JSON Schema, and QC rules all describe the same variables`, and a mismatch reads `The dataset doesn't look
like it belongs with the other two inputs — only 0 of 265 schema variables match.` Numbers appear only when
something is wrong; a test asserts the consistent line contains no digit.

Two things the copy deck did not settle, decided in the code: the missing-examples ellipsis is conditional (`…` only
when the list is truly capped at three, or it promises names that are not there — and the near-miss clause is
appended to the same sentence and needs a terminator), and the suspect phrase carries its own verb, since one shared
template yields `The QC rules doesn't look like it belongs` for a slot that holds a list of files. Tints use
`--q-warning-ink`/`--q-error-ink`; the strip painted `--q-gray-800` on both fills, 4.7:1 on the error tint, which is
what `tokens.css:20` warns about — and a new axe scan covers both tinted tones, since the populated Load scan only
ever saw the untinted OK. Unit 660 → 676, e2e 69 → 74 (three suspect cases, the no-dataset edge, the near-miss),
entry JS 42.9 → 43.0 KB gz. Manually verified against all five cases in the browser.

2026-07-25 · UIX-4d · **The QC rules tab has content.** `rulesPreview.ts` was a 41-line stub: you could load three
`.quac.csv` files, see `3 files · 22 rules` and read per-file lint on the slot card, and still not read a single rule
anywhere on the Load tab — the Studio's grid is the only place they were tabulated, and at ~510–710px wide it
deliberately omits both `condition` and `update_expression`. The panel is now the SAME component as the data
dictionary over a different payload: one native `<details class="q-rp-file" open>` per file in **load order** (the
cross-file correction-order contract), a `Search rules` box, a derived `Collapse all` / `Expand all`, a debounced
`role="status"` count, and one `<table>` per file. Everything identical between the two panels — head, search,
toggle, count, scroll region, disclosure, table base, chip, muted mono sub-line — is now declared ONCE in
`preview.css` under grouped `.q-dd-*, .q-rp-*` selectors; only the payload cells and the measured percentages differ.

**Six curated columns, not the raw ten**: `Rule` (id, with `type · scope` folded under it and `off`/`external` as
badges), `Targets`, `Condition`, `Update expression`, `Severity`, `Comment`. **Syntax-highlighted** by the same
`@lezer/highlight` `classHighlighter` and the same PostgreSQL/JS parsers the Studio editors use, so the two surfaces
agree by construction; the `tok-*` colours moved from `studioView.css`'s `.q-studio` to `primitives.css` under a
`.q-syntax` marker (scoped, or an unscoped `.tok-*` would restyle `@jeyabbalas/data-table`'s own bundled CodeMirror).
The bundle gate drove the module split: `exprTokens.ts` is reachable only through the dynamic `import()` in
`exprHighlight.ts`, since `lang-sql → language → view` and the Load view is eager. Entry JS **41.4 → 42.9 KB gz**,
all of it QuaC's own code; the codemirror marker chunk reads 116.3 → 109.7 KB gz but that is a re-split, not a
saving — total JS 909.8 → 912.3 KB gz over 47 → 50 chunks. Cold, the first cells paint plain mono and upgrade in
place behind a stamp+`isConnected` guard; warm, every cell highlights synchronously off a 256-entry LRU.

**Column widths measured, not guessed.** Unwrapped content need per column over all 22 rules (p50/p90/max px):
Rule 125/154/190 · Targets 125/176/233 · Condition **348**/658/917 · Update expression **24**/176/363 ·
Severity 53/72/72 · Comment 722/870/1024. Condition's MEDIAN need is 348px against the 333 it got at the starting
25%, so it takes the largest share; Update expression is the Format pathology again — 15 of the 22 rules are
`validate` or `external` and carry none, so its median content is an em-dash — and went 21 → 13% on the numbers,
then back to **16%** on the eye, 13% being above its p90 but breaking `LAG(reference_education)` mid-identifier.
Final **12 · 14 · 28 · 16 · 7 · 23** = 160/186/372/213/93/306 at 1440; `.q-rp-scroll` scrollWidth/clientWidth
1514/1514 · 1354/1354 · 1280/1280 · 1194/1194 · 1112/938 · 1112/698 at 1600/1440/1366/1280/1024/768, page-level
overflow **0** throughout. Expressions cap at 6 lines behind the dictionary's `+N more` (HESP Q021's 11-line
condition → `+5 more`); the cap is exact because `highlightCode` emits every break as its own run and never emits a
text run spanning one, verified through strings, block comments and template literals.

**Three things found by driving it.** (1) The panel rebuilt on every `rulesState` publish, and every load ends with a
second publish — the re-lint once the dataset lands — which threw away the `<details>` the user had just collapsed
and the query they had just typed; guarded by reference-comparing `state.files`, which the store replaces on every
real change and reuses when only lint moves. (2) axe caught a genuine serious violation the eye did not: a disabled
rule's muted row painted its target chips `--q-gray-500` on `--q-gray-100`, **4.35:1** — `tokens.css:23` already said
gray-500 is text on WHITE or gray-50. (3) After a Studio edit the serializer writes CRLF and PapaParse keeps `\r\n`
inside quoted fields, so `renderExpr` normalises line endings the way CodeMirror does to its own documents.
Deviation from plan: `TokenRun`/`ExprLang`/`splitLines` live in the DOM-free `rulesPreviewModel.ts` and
`exprTokens.ts` imports the types, not the reverse, so the node-tested model never reaches CodeMirror — which also
swapped the plan's commits 2 and 3. 640 unit green (**+41**: the model, and the real Lezer output on real HESP
expressions, both in the fast `node` project); loadPreview 13 → 20 e2e; two new axe scans (rules populated, rules
collapsed).

2026-07-25 · UIX-4c · **The data dictionary's categories collapse.** All twelve opened at once, so the panel could
tell you about any one variable and nothing about what it contained: measured on HESP at 1440×900, `.q-dd-scroll`
was **51,354px of content in a 628px box** (`min(70vh, 720px)`) — 82 screens, with `Identification` and
`Derived measures` ~200 rows apart. Each category is now a native `<details class="q-dd-cat" open>` whose
`<summary>` is the whole header row (chevron · `<h4>` title · count), plus one `Collapse all` / `Expand all` beside
the search box. Collapsed, the same panel is **492px** — twelve lines, each still carrying its count, no scrolling
at all, and no horizontal overflow at 1024/768 either (938/938, 698/698: the `min-width: 1070px` tables are out of
flow while closed). Native `<details>` is why it is cheap: `aria-expanded`, Enter and Space are the UA's, and both
the button and the filter reduce to writing `.open`. **Search wins over a collapsed category** — typing force-opens
every category still holding a match, clearing restores exactly what you had open, snapshotted on the *transition*
into filtering because `toggle` fires from a queued task and cannot tell a click from a programmatic write.
Default stays expanded: axe skips unrendered subtrees, so collapsing by default would take twelve tables out of the
gate. Deviation from plan: `.q-dd-cathead` needed no `color: inherit`; the blanket `.q-dd-scroll summary` rule was
narrowed to `details:not(.q-dd-cat) > summary` instead, so titles stay `--q-ink` (17,17,17) and `+N more` stays
`--q-gray-600` (82,82,82). 599 unit green unchanged (DOM only) + 3 new e2e and a fourth axe scan of the collapsed
state; entry bundle 41.2 → **41.4 KB gz**, no new dependency.

2026-07-25 · UIX-4b · Follow-up on the Preview panel, on review of the shipped one. **The schema tab is now named for
the input, not the rendering**: `Dataset · JSON Schema · QC rules`, the three slot-card names verbatim, so the strip
under the cards names the same three things the cards do — `Data dictionary` left the schema card the only slot with
no tab bearing its name. The dictionary framing moves inside as a `.q-preview-panelcaption` under the panel head,
`JSON Schema formatted as a data dictionary`, present in every state (the empty note shortens to `…to see it here.`,
matching the rules panel, since the caption above it now says what you would see). **Format folded into Type**,
superseding this entry's `Format 8→7%` below: at 7% it was ~95px of em-dash on 260 of HESP's 265 rows, and the 5 rows
that do carry one get a 40-character `Matches pattern ^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$` that wrapped to five lines
inside it. Folded in it renders as a muted mono line under the type (`.q-dd-format`, the `.q-dd-when` treatment) —
which is also what `format` IS in JSON Schema, a qualifier of `type`, not a peer. Re-measured at 1440: the six columns
are **186/266/160/279/239/200** against the old seven's 176/257/135/95/271/230/190 — every remaining column wider AND
the table 110px narrower (`min-width` 1180 → 1070, `.q-dd-scroll` 1192 → **1082** at 1024/768, page overflow still 0
at all six widths). Type took the largest share (+25px) because it was the column against its ceiling: widest content
130px against 10% of a 1354px table. 260 of the table's 347 em-dashes are gone. 599 unit green unchanged (the model
still carries `format`; only the DOM changed) + 1 new e2e pinning the six headers, the folded cell and the count of 5;
59 e2e green.

2026-07-25 · UIX-4 · Interstitial Load-view pass on main (post-P19, before P20): **the Load tab now previews all three
inputs, not one.** It took a dataset, a schema set and rules files and showed you a bare 50-row table — you could load
the bundled 14-file, 265-variable HESP schema and never see a single variable it defines. One Tier 1 sticker now holds
a `createPanelTabs` tablist over **Dataset · Data dictionary · QC rules**. Extraction is
`json-schema-data-dictionary@0.1.0` (MIT, zero runtime deps, pinned exact) behind `core/schema/data-dictionary.ts`;
QuaC renders its own table. **Measured on HESP: 265 rows / 12 categories / 0 warnings in 17.6 ms** on the main thread
(so no worker, no chunking, no idle callback), per-category counts `[16,28,24,32,26,24,24,26,17,23,10,15]` pinned.
Search filters in **0.1 ms median (p90 0.3)** per keystroke over 265 precomputed haystacks — but it is a per-row
`hidden` toggle rather than a rebuild because a rebuild would allocate ~8,500 nodes per keystroke, destroy every
`<details>` the user just opened and reset the scroll position mid-typing. Entry JS **37.5 → 41.2 KB gz**, all of it
QuaC's own new UI: the package sits in a lazy chunk (16.4 KB gz) with a `check-bundle-size.mjs` marker guard beside
`EXCELJS_MARKER`/`CODEMIRROR_MARKER`; a static import would have grown eagerly-loaded JS ~45% to serve a tab most
users never open. Dictionary column widths measured, not guessed (Format's median content is **12px — an em-dash**,
since only 5 of 265 HESP variables carry a `format` and the package falls back to describing `pattern`; Type's p90 is
130px and wrapped at 8%), so Format 8→7%, Additional info 15→14%, Type 8→10%; `.q-dd-scroll` scrollWidth/clientWidth
1514/1514 · 1354/1354 · 1280/1280 · 1194/1194 · 1192/938 · 1192/698 at 1600/1440/1366/1280/1024/768 with page-level
overflow 0 throughout. **Four deviations, all deliberate.** (1) `typedRevision` — `typedSync.ts`'s own doc comment
promised the 50-row preview sees what the run will see, but a rebuild re-points the `data` view WITHOUT bumping
`dataset.generation`, which was invisible while the preview showed only values and becomes a visible lie with a type
row: measured **250 BIGINT · 9 DOUBLE · 7 VARCHAR** after the cast against 266 VARCHAR before. (2) The panel-tab
primitives moved to `primitives.css` and `components/panelTabs.ts`, discharging `phase-17-studio-editor.md:41`'s
standing instruction; `ruleForm.ts` needed no change, which was the point. (3) All three tabs are permanently present
(the option preview said disabled/absent-until-filled) — the rules tab had no content yet (UIX-4d gave it some) and
would have hidden forever, and both roving-tabindex hazards vanish. (4) The dictionary renders where `columnDigest` refuses to: §A.5
says fatal set-level errors block validation, not schema browsing. The **agreement test** is the highest-value artifact
— row count and variable-name set asserted equal across HESP, tiny and every synthetic set — and it caught a real
divergence on the first run: `synthetic/no-ids` gives 0 from the digest and 2 from the package, because §E.1 walks
`items.allOf` and that fixture hides the row object behind a `$ref` ON `items`. Widening §E.1 would newly subject
those columns to casting/translation/Ajv attribution, so it is **pinned with its exact numbers** as a known
divergence, not skipped. One bug found by driving it: the visibility effect read the signal it wrote, so
`active.set()` re-entered it while `pinned` was still false and bounced the user's *first* click on any other tab.
Also stripped a literal NUL byte from `json-schema-subsystem.md` (offset 17636) that made grep/rg treat the whole spec
as binary. 51 new unit tests (548 → 599) + 9 new e2e (`loadPreview.spec.ts`, incl. the `typedRevision` regression);
`a11y.spec.ts` now ACTIVATES each Preview tab before scanning, since axe skips `[hidden]`; 58 e2e green.

2026-07-25 · P19 · **Favicon re-cut from the artwork** (post-merge, on review of the shipped icon). P19 hand-drew the
duck because the phase file said the artwork was a raster that wouldn't downscale — but `a44d234` had already replaced
`assets/logo/*.svg` with clean vector paths, so the tab carried a *different* duck than the header. `generate-favicons.mjs`
now generates `public/favicon.svg` as well: it samples the artwork's outline, solves its minimal enclosing circle
(r 481.2 at (573.4, 533.0) artwork units — a bbox centre sits left of true, the bill juts right), drops it concentric
with the sky disk leaving 1.2 units of sky inside the ink ring, and bakes the coordinates into the 32-unit icon space
so no `transform` survives for a dumb rasteriser to mangle. One deliberate non-token: the bill keeps the artwork's
`#f95d1d` — `--q-orange` on `--q-yellow` measures **1.42:1** and dissolves at 16px, the artwork orange holds **2.19:1**.
Touch icon gained an 8% inset off the iOS mask curve. Output is byte-identical across runs; checked by eye at
16/20/24/32/48/64/128 on paper and on dark chrome. 548 unit · 49 e2e green; `typecheck`/`lint` clean (the script is
JSDoc-typed — `tsconfig` includes `scripts`).

2026-07-25 · P19 · Branding polish + a hard accessibility pass. Shipped: a hand-drawn flat duck favicon (checked by eye
at 16/24/32/64/128) with `favicon-32.png`/`apple-touch-icon.png` from a committed **Playwright** script — not `sharp`
as the phase file sketched, since Playwright is already a devDep and renders through the engine that paints the tab;
`tests/e2e/a11y.spec.ts` (axe over 3 views + 4 report panels + 3 modals, gated on serious/critical — CI already runs
`test:e2e`, so that IS axe in CI); `reducedMotion.spec.ts`; and `copyDeck.test.ts` (pun containment by scanning string
literals, allowlist + staleness check; verified by injecting a pun into `toast.ts`). **Four real defects, all
measured**: (1) `--q-error` on `--q-error-fill` = **3.38** and `--q-success` on `--q-success-fill` = **3.97**, i.e. the
Error/Valid badges, the stat-card hero, and — via `--dt-annotation-*-fg` — the text in every annotated grid cell, all
sub-AA; new `--q-*-ink` tokens take the Excel workbook's font colours (`qc-report-spec.md §5`) so workbook/grid/chrome
share one palette, measuring 5.92 / 5.33 / 7.14 / 4.56 on fill, fills untouched so the P05 `#ffc7ce` e2e stays green.
(2) `createDataTable` never pinned `colorScheme`, so the library default `'auto'` turned the whole grid dark under a
dark OS — pinned `'light'` in both calls, proved with `emulateMedia({colorScheme:'dark'})`: `data-dt-color-scheme=light`,
grid `rgb(255,255,255)`. (3) `--q-orange` measures **1.08:1 on `--q-sky`**, so the focus ring was invisible exactly
where the header puts Share/GitHub/the nav tabs — `--q-focus-edge` adds an ink companion (18.9/13.0/10.0). (4) the
placeholder favicon. Axe then found seven more, all fixed: the offenders `<tr role="button">` inside a `<tbody>`
(`aria-required-children`, the only **critical**), three unfocusable scroll containers, an unnamed `progressbar`,
`role="tablist"` without the APG keys, a bare pertinence strip, and four more contrast failures on *tinted*
backgrounds (`--q-gray-500` passes on white at 4.74 but fails at 4.49 on `--q-yellow-tint`). **The keyboard walk found
what axe could not**: data-table is a WCAG 2.1.2 keyboard trap — focus `.dt-root` and neither Tab nor Shift+Tab moves
again, with ~1600 focusables inside — so the report's Download/Re-run were unreachable. Mitigated with a `.q-skiplink`
(a `<button>`, never an `<a href="#…">` — QuaC routes on the hash) and Escape-to-leave on both grid hosts; logged as
upstream in `ui-design.md §9` along with the rest of data-table's debt (`.cm-editor` is clean). Deviations: Playwright
over `sharp`; `--dt-primary`/`--dt-accent` deliberately NOT remapped (96 usages, several white-on-primary — brand hues
would *create* failures); one `runQc.spec` locator scoped to `.q-duckprogress-meta` because the new stage live region
repeats that string (copy unchanged). Responsive re-measured at 1023/768/640 — page overflow 0 everywhere; the Studio
rule table's 32px scroller overflow at 640 fixed below a 720px ceiling so no UIX-3 band can see it. 548 unit (+3) · 44
browser · 49 e2e (+4) green; entry 37.5 KB gz (was 37.1, budget 300) and axe stayed devDep-only. **For P20**: the
data-table keyboard trap is the one thing a release audit will flag that QuaC cannot fix in-repo — it wants an upstream
issue, and `ui-design.md §9` should be re-checked on any data-table bump.

<details><summary>P19 contrast table — every §7 pairing recomputed after the token edits (AA 4.5; focus indicator 3.0)</summary>

| Surface | Pairing | Ratio | AA | Was |
|---|---|---|---|---|
| Slot / rule badges | `--q-error-ink` on `--q-error-fill` | **5.92** | ✓ | 3.38 ✗ |
| Slot / rule badges | `--q-success-ink` on `--q-success-fill` | **5.33** | ✓ | 3.97 ✗ |
| Slot / rule badges | `--q-info-ink` on `--q-info-fill` | **7.14** | ✓ | 4.89 |
| Slot / rule badges | `--q-warning-ink` on `--q-warning-fill` | **4.56** | ✓ | unchanged |
| Grid annotated cell | `--dt-annotation-error-fg` on `-bg`, **as rendered** | **9.12** | ✓ | 3.38 ✗ |
| Report stat cards | `--q-error-ink` / `--q-success-ink` on their fills | **5.92 / 5.33** | ✓ | 3.38 / 3.97 ✗ |
| Cap + partial banners | `--q-warning-ink` on `--q-warning-fill` | **4.56** | ✓ | unchanged |
| Preconfig hint · studio banner · share callout | `--q-info-ink` on `--q-info-fill` | **7.14** | ✓ | 4.89 |
| Nav count pill | `--q-paper` on `--q-error` / `--q-warning` / `--q-info` | **4.96 / 5.02 / 5.93** | ✓ | unchanged |
| Severity text on paper | `--q-error` on `--q-paper` | **4.96** | ✓ | unchanged |
| Editor diagnostics | `--q-error` on `--q-gray-50` | **4.75** | ✓ | unchanged |
| Header | `--q-ink` on `--q-sky` | **9.96** | ✓ | unchanged |
| Primary button | `--q-ink` on `--q-yellow` | **13.03** | ✓ | unchanged |
| Body | `--q-ink` on `--q-paper` | **18.88** | ✓ | unchanged |
| Studio rail sub-line | `--q-gray-600` on `--q-yellow-tint` | **7.40** | ✓ | 4.49 ✗ |
| Combobox type hint | `--q-gray-600` on `--q-gray-100` (hover row) | **7.17** | ✓ | 4.35 ✗ |
| Preview NULL dash | `--q-gray-500` on `--q-paper` | **4.74** | ✓ | 2.52 ✗ |
| Share excluded ✗ | `--q-gray-600` on `--q-paper` | **7.81** | ✓ | 2.52 ✗ |
| Focus ring edge | `--q-ink` on paper / sky / yellow | **18.88 / 9.96 / 13.03** | ✓ | orange alone 2.05 / 1.08 / 1.42 ✗ |

The grid row is the *rendered* pair (`rgb(122,11,20)` on `rgb(253,226,229)`) — data-table alpha-blends the tint, so the
delivered contrast beats the raw `#9c0006`/`#ffc7ce` token pair's 5.92.

**Keyboard-only journey** (no mouse, focus visible at every stop): Load 15 stops, all named — dropzones, URL fields,
Fetch, details, preview scroller, Apply corrections, Run QC. Report: skip control → panel column in two keys → Summary
(one tab stop, roving) → 3 severity toggles → Download QC Report → Re-run QC; ←/→ wrap the panel tabs, Home/End jump.
Studio: New file → rail toggle → 3 file buttons → Download/Add → rule rows + per-row actions → form (id, enabled,
type, scope, severity, target chips, CodeMirror, comment) → Test rule → Cancel → Save rule. Escape leaves either grid.
**Dark-OS check**: `data-dt-color-scheme="light"`, `.dt-root` `rgb(255,255,255)`, body `rgb(255,255,255)` — matched.
**Favicon at 16px**: bill and eye both survive; also checked on a dark tab strip.
</details>

2026-07-24 · UIX-3 · Interstitial Rule Studio pass on main (post-P18, before P19): the rail collapses and deleting a
rule asks first. Rail — every band's template now reads `--q-studio-rail` (240→44px on `.q-studio-layout--railclosed`),
but flipping the variable ALONE hands the freed 196px to the `1.1fr:1fr` split (measured live: work +103 / preview +93
at 1600 — caught only because the re-measurement ran), so ≥1280 collapsed also pins the work track to its 600px floor.
Measured preview 623→904 (1600), 547→744 (1440), 474→670 (1366), 388→584 (1280), +196 to both zones at 1024;
`.q-studio-gridbody` overflow 0px in BOTH states at 1600/1440/1366/1280/1024/768. Collapsed dress lives entirely inside
`@media (min-width:1024px)` so ≤1023 keeps its horizontal strip and the toggle hides — a stored collapse is remembered
but not honoured there. Files stay as dots (`.q-filebtn-top::before`, `aria-current` yellow + dirty `*` carried over,
`title`/`aria-label` added in renderRail), so they stay clickable and every pinned `.q-filebtn` locator survives.
`syncRailView()` mirrors `syncWorkView()` and is independent of it; state is a plain `let` + the app's FIRST localStorage
key (`quac.studio.railCollapsed`, both accessors try/caught — architecture.md §5's trivial-UI-prefs carve-out).
**Correction to a P14-review inference**: the ~4.5 s HESP block is a data-table *creation* cost, not a resize cost —
`TableContainer`'s ResizeObserver has zero subscribers and column headers are fixed-px, so a width change fires none of
the 266 visualization observers. One discrete flip measures ~46 ms. The track is still never animated: `minmax(600px,
1.1fr)`→`600px` is `<flex>`→`<length>`, not interpolable, and CodeMirror's DOMObserver watches the work column. Only the
rail contents fade (WAAPI 200 ms, expand only, reduced-motion skips). **Height fix (user-reported, same pass)**: the
sample grid appeared to shrink to a row or two on collapse. The host height was in fact constant — data-table's own
column-visualization header is 273–306px and GROWS with the pane's width, so widening the preview ate the body out of a
fixed clamp: 900-tall gave 165px of body → 132px collapsed; 768-tall gave 33px → **0px**. Meanwhile the card used only
505 of the 710px available. Now ≥1280 `.q-studio-layout` carries `min-height: calc(100dvh - var(--q-studio-chrome))`
(`--q-studio-chrome: 210px`; min-height so a long rule table still grows the card), `.q-studio-preview` is a flex column
and `.q-studio-samplegrid` is `flex: 1 1 0` + a 360px floor instead of a clamp → 625px/350px at 900-tall, 805px/530px at
1080, 493px/218px at 768, and the host height is now IDENTICAL in both rail states (pinned in studio-edit.spec). Visible
rows at 1600×900: 4 → 10 collapsed, 5 → 11 expanded. The stacked bands (≤1279) keep the clamp — the preview sits under
the work column there and cannot take "what is left" — with its floor raised 260→360px so it can never hit 0 body again.
Delete — `confirmDeleteRule` mirrors
`confirmDiscard` (`Delete rule?`, `.q-panel-note` consequence line, `Cancel` focused explicitly since openModal always
lands on the header ×) and SUBSUMES the dirty-draft guard when the deleted row is the open draft (one modal at a time);
`run()`'s shiftDrawerIndex/revert/focus-restore is untouched. Deviation from the approved sketch: none. 545 unit + 44
browser + 42 e2e green (studio-edit.spec gains the rail block + a 260 ms no-ingest persistence test); entry 37.1 KB gz
unchanged — all of it lands in the lazy studio chunk.

2026-07-24 · UIX-2 · Interstitial Rule Studio UI/UX pass on main (9 commits, post-P18, before P19) — the studio worked but
put four Tier-1 stickers on one screen and split the form from its test result. Now ONE card, three hairline zones (rail ·
work · preview): the editor REPLACES the rule table in the work column (`syncWorkView()`; ordering contract — it runs before
every focusGrid/addRuleButton.focus and before form.load, since both the grid header button and CodeMirror are inert inside
`hidden`), a `← Rules` ghost button routes back through the existing discard guard, and the preview column reads result-first
(capped scrollable test panel over a shorter but still DEFINITE-height sample grid). Grid trimmed to 7 columns (Type·Scope
merged) with `.q-rulegrid`-scoped quiet (fill-tinted severity keeping its text label, gray OK badge, gray-700 row glyphs,
disabled = absent); rule form head is 3 tracks and `enabled` became a normal field, retiring the padding-top:22px hack.
Sizing is MEASURED: table min-content 628px vs 475px of work column at 1280 → 6px gutters, 130px in-band targets cap and a
600px work-track floor (240/600-1.1fr/360-1fr) → 0px overflow at 1600/1440/1366/1280/1024/768; ≤1023 the rail becomes a
horizontal file strip. Two override blocks had to move BELOW the rules they override (specificity ties, source order decides).
**P19 task 3's Studio empty state is already done** (duck mark + copy, mirroring reportView) — do not redo it. Deviations
from the approved sketch, all to satisfy its own "no horizontal scroll down to 1280": rail 240px not 260, preview floor 360px
not 380, work track gained a floor. 545 unit + 44 browser + 41 e2e green; entry 37.1 KB gz unchanged.

2026-07-24 · P18 · Rule Studio preview/gate/export shipped on main (6 commits): rules become live-testable, saving is gated,
files round-trip. ruleTest.ts = pure dispatch mirroring engine interpret+applicableTargets over the EXACT sql.ts wrappers with
PREVIEW_ROW_CAP 20 (counts exact on full `data`; sql corrections pure SELECT count/capture — no CTAS; js sandboxed on the ≤20
sample only, exact match count from SQL, all-sampled-errored fails; dataset cap+1 idiom; external/missing targets →
not-testable) — node-tested on qc_fixture incl. the phase file's −2500→2500 capture (fixture-reality deviation: the e2e asserts
the example dataset's own seeded −1200; −2500 never existed there — recorded in phase notes). previewPane.ts docks a second
data-table (quac_studio_display over STUDIO_SAMPLE_SQL, 10k sample, __rowid__==__row__ V7) beside the grid (3-col ≥1280px)
with reportGrid's queue/generation/loadData discipline + RuleTestPanel (per-kind result lines, renderPreviewTable bodies,
assert expansions in details/code, "Filter preview to matches" gated on validateSQLFilter — the window-free detector).
Gate: submit iff rule_id valid ∧ last completed lint zero errors (lastLintOk, superseding P17's lint-never-blocks) ∧
tested-since-last-edit; lint-only (no ctx/external/inapplicable) drops the test leg — data-shaped skips save as "Save
untested"; any edit/drawer/file-switch resets; tests suspended during runs. Export: "Download rules CSV" in the grid header
(deviation from the wireframe's drawer row) via shared triggerDownload + exportFileName; dirty * survives download, clears on
same-name re-import. Import-back seeds bucketStoredIssues on edit-open. Golden journey 5 e2e (studio.spec.ts): compose→Test
"1 row"→filter narrows→gated Add→correction −1200→1200→Download (BOM)→re-import → 4 files · 24 rules, identical lint state.
Manual pass via headed-Playwright screenshots (Chrome ext couldn't reach local servers). Unit 545 + browser 44 + e2e 41 green;
entry 37.1 KB gz (all new UI in the lazy studio chunk). P19 unblocked.

2026-07-24 · P17 · Rule Studio workspace & editor shipped on main (7 commits): lint.ts exports the (type,scope) matrix
(typeScopeComboError/isValidTypeScope — stage 2 refactored onto them, messages byte-identical) and rules-store grows
getLintContext() + dirtyFiles + in-session mutators (createRuleFile pristine; update/insert/remove/move/duplicate all
round-trip serialize→parse so rowNumbers/issues re-derive; same-name re-add clears dirty). views/studio/: studioView.ts stays
an eager shim (view-level empty ONLY when nothing is loaded — user-approved; rules-without-dataset gets the workspace + info
banner) route-gating the lazy studioWorkspace chunk (CM never mounts hidden; bundle gate gains the @codemirror/view
`cm-announced` entry-leak marker beside ExcelJS). Workspace = rail (group/count/lint badge/x-y targets/dirty *) + plain-table
rule grid (enable toggle, duplicate/delete/↑↓ with the pinned "Row order = correction order" tooltip) + full-width bottom
editor drawer (user-approved layout; P18 docks preview beside the grid). ruleForm enforces the matrix live (invalid scope
options disabled with the lint helper's exact text; auto-snap scope→row; type change resets severity default), targetsSelect
= chips+combobox (unknown targets allowed, warning-tinted), codeEditor.ts is the only @codemirror/* importer (sql/js/text
compartments, PostgreSQL dialect + schema:{data} + custom feed: functions/__row__/__value__/boosted assertion snippets —
completionSource.ts pure+node-tested), draft lint = ONE 400 ms debounce → runDraftLint (synthetic one-rule file →
lintRuleFilesWithDataset verbatim, byField buckets, cross-file duplicate-id w/ self-exclusion) pushed via setDiagnostics +
mirrored ul.q-editor-diags; paused while the pipeline runs. Catalog: DESCRIBE quac_work (idiom deviation from PRAGMA
table_info) + session-cached duckdb_functions() via getLintContext() — studio never boots the wasm. Manual keyboard pass done
(found+fixed a rail focus drop, 47179c2); deferred notes record the pre-existing download.spec flake (VARCHAR-window lint
race, reproduced on pre-P17 base 4/6 under --repeat-each=6). Unit 525 + browser 44 + e2e 40 green; entry 37.3 KB gz. P18 unblocked.

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
