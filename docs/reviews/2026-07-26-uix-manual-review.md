# QuaC — manual UI/UX review, 2026-07-26

**Verdict: 10 findings — 6 bugs, 4 friction, 0 polish.**

The app is in good shape. Every number I checked against the plan's ground truth matched exactly, the
copy is mostly excellent, the partial-run and clearing stories are genuinely well designed, and QuaC
logged **nothing** to the console across five passes. The findings cluster in three places: the report
grid's re-mount path after the dataset changes (UX-01), the address bar's one-directional sync
(UX-02), and states that only appear when something is slow or slightly too big — a hung fetch (UX-04)
and an over-length share link (UX-07) — which local fixtures and a fast machine hide.

## Environment

| | |
|---|---|
| Commit | `7c13dbf` (main, clean tree at start) |
| Build | `npm run build` — `prebuild` regenerated `public/duckdb/` and `public/examples/` |
| App | `vite preview` → `http://localhost:4173/quac/` (port confirmed free before the build) |
| Fixture host | `node tests/e2e/support/cors-server.mjs` → `http://localhost:4199` |
| Browser | Google Chrome 150.0.7871.184 (macOS / Darwin 25.5.0), driven via the Claude-in-Chrome extension |
| Viewports | 1440×900 primary; sweep at 1600 · 1440 · 1280 · 1024 · 768, plus 960 and 720 as zoom equivalents |

**By hand vs by script.** Everything was driven through the live UI — real clicks, typing and form
submits. Four mechanical exceptions, each noted where it matters:

1. The mid-run **Cancel** was fired from a 120 ms timer, because the HESP run finishes in ~1 s and a
   hand-timed click could not land inside it.
2. The exported `.xlsx` and the rules CSV were captured from the page's own download `Blob` and POSTed
   to a throwaway scratchpad server, because this automated Chrome profile writes downloads somewhere
   unreadable. The real Download buttons were clicked; only the capture was scripted.
3. The hung-fetch test in UX-04 needed a host that never answers — a throwaway node script on `:4201`.
4. Later in long sequences I clicked buttons via `element.click()` rather than by coordinate, because
   the Load view reflows as slots fill and coordinate clicks silently miss. Every *finding* below was
   first observed through ordinary pointer interaction.

**Not reached.** Multi-file browse and the schema card's `webkitdirectory` **folder browse** open native
OS dialogs that browser automation cannot drive; I did not script around them either, so those two
intake paths are untested here. (Single-file upload *was* exercised, via the file input directly.)

**Console-noise caveat.** The Chrome extension driving this session logs its own `orchestration:` /
`[voice-trace]` DEBUG lines into every tab. Every console reading below was checked against the source
URL: all such messages originate from `chrome-extension://ljflmlehinmoeknoonhibbjpldiijjmm/…`.
**QuaC itself logged nothing at any point in this review** — including during the failure in UX-01,
which surfaced only as toasts. The standing zero bar is met.

## Coverage

### Pass A — Load view: first run, inputs, previews — **exercised, 4 findings** (UX-02, UX-05, UX-06, UX-10)

Cold first run; `Load example files`, matching ground truth exactly (`hesp_dirty_100.csv · 101 rows ×
266 cols`, schema `14 files · root: core/core.schema.json`, rules `3 files · 22 rules`, consistency
badge **OK**); all three Preview tabs — the dictionary's `12 categories · 265 variables` with
per-category counts `[16,28,24,32,26,24,24,26,17,23,…]`, search (`36 of 265 variables`), Collapse/Expand
all, `+N more`; the QC-rules panel's 22 rows, syntax highlighting and `off` / `external` badges;
`Clear all inputs` and both per-slot clears; the same three inputs re-loaded by URL from `:4199` (schema
auto-crawl: one URL → 14 files); format swap through `.tsv` / `.json` / `.parquet` / `.xlsx` — the
`.xlsx` path, which has no e2e, loaded cleanly at 101×266 and CSV/TSV/XLSX correctly read all-`VARCHAR`
against JSON/Parquet's native `DATE`/`BIGINT`; SheetPicker via `tiny/two_sheets.xlsx` with **Cancel**
verified leaving the slot untouched; IndexPicker via a two-`schema=` link, both **picked** and
**dismissed** (→ `Warning`, `3 files · choose the index schema`, a new `Choose index…` button); and bad
inputs (`notes.txt` into the schema slot and into the rules slot).

Console: **clean**.

### Pass B — Running QC, the report, and the Excel export — **exercised, 3 findings** (UX-01, UX-03, UX-09)

Full run matching ground truth exactly (**39 errors · 13 warnings · 10 info · 6 corrections**, nav pill
62, `101 rows · 266 columns · 20 rules run · 2 skipped`); mid-run **Cancel** at `Preparing tables` and
re-run; annotated cells, the cell popover, and column-header tooltips (`household_id` correctly
aggregates the schema entries **plus** a `QC rules` list of 6 rules and `+1 more`, exactly per
`qc-report-spec.md` §3); severity toggles; all four panels; Offenders row-click focus and `Clear focus`;
the `.xlsx` downloaded and read sheet by sheet; **assess-only**; and the **clean path**
(`hesp_valid_100.csv`, golden journey 7).

The cap banner was **not** exercised — 62 flags is far below `ANNOTATION_CAP = 20,000` and this fixture
set cannot reach it.

Console: **clean** — notably, the failure in UX-01 logged nothing at all.

### Pass C — Partial runs, clearing, and re-entry — **exercised, 2 findings** (UX-04, UX-08)

Schema-only run (em-dash `Corrections applied` / `Rules run` / `Rules skipped` + "No QC rules were
loaded for this run — the rules stage was skipped."); rules-only run ("No JSON Schema was loaded for
this run — schema validation was skipped.", with `reference_year` correctly reverting from `integer` to
`string` as the cast is undone); all four run-bar readiness states; per-slot `Clear`, per-file `✕`
(22 → **17 rules**, toast `Removed hesp_consistency.quac.csv.`, focus landing on the next row's `✕`),
and `Clear all inputs`; the race paths — clear **during** a fetch, clear a check source **mid-run**,
clear the dataset and re-load the same file, and reload after a clear; and a failed re-ingest.

Verified against ground truth: `tiny/people_rules.quac.csv` on the schema-less `tiny/people.csv` gives
**Warning · 6 rules · 4 executable**, R003 and R005 excluded — exactly V23's recorded numbers.

Console: **clean**.

### Pass D — Rule Studio, sharing, and preconfigured links — **exercised, 1 finding** (UX-07)

Studio cold and populated; `New file` → `Add rule` → the whole compose loop (id, the targets combobox
with `BIGINT` type hints, CodeMirror, a deliberate typo → live lint naming the exact column,
`Test rule` → "Test result: 1 row matches" → `Filter preview to matches` → save); the save gate in both
blocked states; row actions (enable toggle, duplicate → `R900_copy`, reorder arrows carrying the pinned
`Row order = correction order` tooltip, delete confirm); **all five dirty guards** (`← Rules`, `Cancel`,
`Escape`, switching files, clearing the rules slot); rail collapse at 1440; the download → re-import
round-trip; the Share modal in **five** states (all-✓ URL artifacts, the grouped 14-file schema row, an
uploaded ✗ row, the `index=` callout, and the **>2000-character** path); preconfigured boot via
`#/load?schema=…&rules=…` **and** via a hosted `config=<url>` manifest; and the CORS failure.

Console: **clean**.

### Pass E — Responsive, keyboard, and cross-cutting — **exercised, 0 findings**

**Responsive:** zero horizontal page overflow on **all three views at all seven widths** (1600, 1440,
1280, 1024, 960, 768, 720), and zero `.q-studio-gridbody` overflow throughout — matching the numbers
UIX-2/3/4 recorded. Rail collapse at 1440 moved the preview **547 → 744 px**, the exact figure in the
UIX-3 log. No overlap or clipping at 768; the sticky run bar keeps all its controls.

**Keyboard:** 28 focus stops on the populated Load view, **every one with an accessible name**. Both
untested mitigations for data-table's documented keyboard trap work: `Skip the data grid` is a real
`<button>`, becomes visible on focus, and lands focus on the panel column outside `.dt-root`; and
**Escape** from inside the grid moves focus out, announced by the `.q-sr-only` line *"The data grid
captures Tab. Press Escape to leave it."*

**Tablists:** the Report strip is one roving tab stop over 4 tabs, with ←/→ (wrapping), Home and End all
correct. **Modals:** `role="dialog"`, `aria-modal="true"`, labelled, focus opens inside, `Esc` closes,
and focus is **restored to the opener**.

**Cross-cutting:** tab title `QuaC`; all three favicons linked (`favicon.svg`, `favicon-32.png`,
`apple-touch-icon.png`). The grid carries `data-dt-color-scheme="light"` with a white
`rgb(255,255,255)` background, which is the pin that stops a dark OS flipping it. **Network
spot-check: 54 requests during a full example load + QC run, every one to the app's own origin**
(plus one `data:` URI) — zero non-origin traffic, which is exactly what the privacy claim needs.

Two E.5 items were **not** verifiable through this harness: `prefers-reduced-motion` and a true dark-OS
render, since the extension exposes no `emulateMedia` and the host OS is light with motion enabled. I
verified the structural pin for dark mode (above) but did not see either media query take effect; both
are already covered by `reducedMotion.spec.ts` and P19's `emulateMedia` check. Browser zoom is likewise
not drivable, so 150% and 200% were approximated by their CSS-pixel equivalents (960 and 720), both
overflow-free.

Console: **clean**.

## Findings

### UX-01 — After a run, swapping in a dataset with different columns breaks the report grid

- **Status:** **Fixed** (2026-07-26, UIX-8 — see the master-plan progress log). Root cause was one layer below the
  memo this finding points at: data-table's parquet handle is `<tableName>.parquet`, so the fixed `quac_display`
  name made every rebuild reuse one duckdb-wasm path. Guarded by `displayGridReshape.browser.test.ts` and
  `reshapeRerun.spec.ts`. The people.csv variant's third toast (`SELECT clause without selection list`) turned out
  to be an unrelated bug — it reproduces cold, with no reshape — filed separately and fixed in UIX-9: a schema
  sharing no column with the dataset now reports `schema:dataset:no-overlap` instead of running an empty `SELECT`
  (`validation-no-overlap.test.ts`, `zeroOverlapSchema.spec.ts`).
- **Severity:** Bug
- **Where:** QC Report · report grid display feed · `src/ui/views/report/` (`reportGrid`), engine export
  to `quac_display.parquet`
- **Repro:**
  1. Cold load `http://localhost:4173/quac/`.
  2. Click **Load example files**; wait for all three cards to fill.
  3. Click **Run QC**. The report is correct: 39 / 13 / 10 / 6, grid populated.
  4. Go to **Load**, and in **Dataset URL** fetch
     `http://localhost:4199/hesp/data/hesp_valid_100.csv` (100 rows × **265** cols — one column fewer).
  5. Click **Run QC**.
- **Observed:** The Summary panel is correct (`0 / 0 / 4 / 0`, `100 rows · 265 columns · 20 rules run`),
  but the grid shows its **pre-run empty state**, "Load data to see the table", and two red toasts
  appear with raw engine text: `Invalid Input Error: No magic bytes found at end of file
  'quac_display.parquet' LINE 1: DESCRIBE SELECT * FROM read_parquet('quac_display.parquet') ^`.
  With `http://localhost:4199/tiny/people.csv` (12 × 5) at step 4 it is worse — **three** toasts,
  including `Parser Error: SELECT clause without selection list`. **`Re-run QC` does not recover it**
  (verified: the toasts had already auto-dismissed and the grid was still empty); only a page reload
  does, which throws the session away.
- **Isolation:** It is the *column set changing*, not the replacement. Repeating step 4 with
  `hesp_dirty_100.tsv` (same 266 columns) re-runs perfectly. And the clean dataset itself is fine — a
  **cold** boot straight into `hesp_valid_100.csv` via a preconfigured link renders 100 rows and 0
  findings correctly ([`assets/ux-01-cold-clean-run-ok.jpg`](assets/ux-01-cold-clean-run-ok.jpg)), so
  golden journey 7 passes on its own and only fails after a prior run of a different shape.
- **Why it matters:** "Run QC → fix the data → load the fixed file → Run QC again" is the core loop of
  the product, and column counts routinely change between passes (a dropped column, a renamed export).
  The user is left with a report whose numbers are right and whose grid is empty, told only that some
  parquet file has no magic bytes, with no in-app way back.
- **Spec check:** **Not addressed.** `ingestion.md` §48 pins the display feed as "always engine-exported
  bytes → `table.loadData()`", and §19 covers the *clear* path's grid disposal (`disposeGrid` /
  `clearRunPresentation`) — but a *replacement* is explicitly the case that "keeps the report for
  consultation", and nothing specifies re-creating the grid when the replacement's schema differs. The
  UIX-7 log already records one bug in this exact area ("reportGrid's memo served the PREVIOUS dataset's
  grid"), so the memo/generation path around a reshape is where to look.
- **Suggested fix:** On run start, dispose and re-create the grid whenever the new dataset's column set
  differs from the mounted one, rather than reusing the memoized table; and route engine errors reaching
  the toast layer through a typed message instead of raw DuckDB text.
- **Evidence:** [`assets/ux-01-grid-breaks-on-reshape.jpg`](assets/ux-01-grid-breaks-on-reshape.jpg)

### UX-02 — Replacing a URL-loaded input never updates the address bar, so a reload silently restores the old one

- **Status:** **Fixed** (2026-07-26, UIX-10 — see the master-plan progress log). Implemented as suggested: the new
  `src/app/hashSync.ts` is the single writer both directions go through, driven by an effect over the three
  provenance signals, so every load/replace/upload-over/clear rebuilds the fragment from the live stores. Two
  refinements beyond the suggestion — `index=` is now *derived* from the live resolved root (which retires
  `bootConfig`'s `installIndexSync`, the only writer that pushed a history entry), and the effect is armed only once
  `applyBootConfig` has awaited all three boot legs, since an effect armed at t0 would drop still-in-flight params
  from the very link being opened. Guarded by `hashSync.spec.ts` (3 cases), the extended `loadExample.spec.ts`, and
  the load-direction half of `hashSync.test.ts`.
- **Severity:** Bug
- **Where:** Load view · hash sync · `src/app/clearInputs.ts` (only writer) / `src/app/bootConfig.ts`
- **Repro:**
  1. Open a shared link: `http://localhost:4173/quac/#/load?data=http%3A%2F%2Flocalhost%3A4199%2Fhesp%2Fdata%2Fhesp_dirty_100.csv`
     and wait for the dataset to land (`hesp_dirty_100.csv · 101 rows × 266 cols`).
  2. In **Dataset URL**, fetch `http://localhost:4199/hesp/data/hesp_dirty_100.parquet`.
     The card updates to `hesp_dirty_100.parquet`; the preview's type row changes from all-`VARCHAR` to
     `DATE`/`BIGINT`, so the swap plainly took effect.
  3. Read the address bar. Reload the page.
- **Observed:** After step 2 the address bar still reads `…?data=…hesp_dirty_100.csv`. After the reload
  the app re-fetches the **CSV** — the Parquet is gone with no notice. The mirror case is just as
  reachable: `Clear all inputs` (which *does* rewrite the hash, to a bare `#/load`) followed by loading a
  dataset by URL leaves the hash at `#/load`, so a reload now **loses** an input that was loaded by URL.
  The Share modal is unaffected — it rebuilds from provenance and correctly offered the `.parquet` link —
  so the two surfaces disagree with each other.
- **Why it matters:** It breaks the promise printed at the top of every Load page ("…or load by URL and
  let QuaC re-fetch for you") in the direction that costs most: you keep working, and a reload or a
  bookmark quietly hands you a *different dataset* than the one on screen. Anyone who copies the address
  bar rather than opening Share shares the wrong file.
- **Spec check:** **Partly addressed, one-directionally.** `url-params.md` §1 makes the fragment "the
  app's only persistence" and says it "survives reloads"; `ingestion.md` §17 pins the hint as "URLs
  reload themselves". But the only writer of artifact params is UIX-7's clear path, whose stated
  invariant is narrower — `clearInputs.ts:10`, "a reload must not resurrect a cleared input". Nothing
  covers the opposite drift, and `clearInputs.ts` plus `bootConfig.ts` (which writes `index=` only) are
  the sole `history.replaceState` / `location.hash` config writers in `src/`.
- **Suggested fix:** Reuse `syncHashAfterClear`'s "rewrite from the live sources" step on every
  successful slot load/replace, not only on clears — one shared `syncHashFromStores()` called from both.

### UX-03 — "Focus matching grid rows" empties the grid for a rule the same panel says has 1 violation

- **Status:** **Fixed** (2026-07-26, UIX-11 — see the master-plan progress log). The "likely cause" below is confirmed, and
  the divergence sits one layer lower than "the run evaluated VARCHAR": QuaC never casts to DATE at all. `data` — the view
  the rules ran against AND the source of the display export — types `interview_date` `VARCHAR` (read off the Load preview's
  type row); data-table's own loaded copy of those exported bytes types it `DATE`, so `2026-02-30` is already null there and
  `TRY_CAST(interview_date AS DATE) IS NULL` can never fire. Measured through data-table's own Validate button on the live
  grid: `typeof(interview_date) = 'DATE'` → **101 rows match**, H004's exact condition → **valid, 0 rows match**. That count
  was already in `validateSQLFilter`'s reply and QuaC was throwing it away. Now a zero-match focus is a failed best effort —
  no filter applied, any previous rule's chip removed, and its own toast. Guarded by `offenderFocus.browser.test.ts` and
  `offenderFocus.spec.ts`; the Studio's twin affordance got the same guard.
- **Severity:** Bug
- **Where:** QC Report · Offenders panel · row-click `addRawSQLFilter` path
- **Repro:**
  1. Cold load, **Load example files**, **Run QC**.
  2. Open the **Offenders** panel. Find the `H004` row: `error · interview_date · Count 1 · 1.0%`.
  3. Click **H004**.
- **Observed:** An `Active filters: SQL H004` chip appears and every column header reads **`0 / 101
  rows`** — the grid is empty. The panel still says H004 has 1 violation, and that row's
  `interview_date` cell is annotated in the unfiltered grid. No toast, no explanation. `Clear focus`
  restores the grid correctly. `Q003` (Count 4) by contrast focuses perfectly — `4 / 101 rows`, showing
  exactly the four annotated rows — so the feature works, and this rule silently disagrees with its own
  count.
- **Why it matters:** The one interaction whose entire purpose is "show me the rows behind this number"
  answers "there are none", which reads as the count being wrong.
- **Likely cause (not proven):** H004's condition is `interview_date IS NOT NULL AND
  TRY_CAST(interview_date AS DATE) IS NULL`. The run evaluates it where `interview_date` is **VARCHAR**
  (the Load preview's type row shows `VARCHAR` for that column even with the schema loaded), but the
  focus filter is evaluated by data-table against its own loaded copy, where the same column is typed
  **`date`** (visible under the grid's column header) and the offending value has already become null —
  so the predicate can never match. The two surfaces are filtering different typings of one column.
- **Spec check:** **Partly addressed.** `qc-report-spec.md` §33 makes the focus "best effort, window-free
  only; otherwise focus the rule's entry", and the window-function case is handled well — clicking `Q002`
  produces the honest toast "This rule cannot filter the grid (window functions or unavailable
  columns)." What the spec does not cover is a filter that is *accepted*, runs, and returns nothing.
- **Suggested fix:** Treat a focus filter that matches zero rows as a failed best-effort — restore the
  unfiltered grid and show the same explanatory toast the window-function path already uses.
- **Evidence:** [`assets/ux-03-h004-focus-empty.jpg`](assets/ux-03-h004-focus-empty.jpg)

### UX-04 — A URL fetch never shows `Loading`, so the Clear that is meant to cancel a hung fetch is hidden

- **Status:** **Fixed** (2026-07-26, UIX-12 — see the master-plan progress log). Reproduced exactly as filed, with the
  sampling anchored to each card's own form `submit`. The suggested reorder is right and was necessary, but it is
  **sufficient only for the schema half**: `addRuleUrls` published *nothing* until the bytes were in hand — its first
  `phase: 'loading'` came from `addRuleFiles`, downstream of the fetch — so no guard order could have surfaced the
  rules fetch window. It now enters the phase before the loop and holds it through fetch → parse → lint, with an
  explicit settle for the all-URLs-failed path (`addRuleFiles` returns at its own empty guard and would otherwise
  strand the badge at `Loading…`). A third defect this repro turned up: the rules `Clear` cancelled the *store* but
  not the *card* — `run()` releases `busy` in a `.finally()` that a hung request never reaches, so a successful clear
  left the field disabled at `Fetching…` over an `Empty` badge; `run()` is now generation-counted and Clear releases
  the latch. One correction to the report above: the two slots do **not** behave identically — the rules card does
  swap its button to `Fetching…`; the schema card, which had no busy latch at all, showed nothing. It has one now,
  derived from the phase so Clear releases it. Guarded by `hungFetch.spec.ts` (golden journey 12) and new
  `summarizeSlot` cases in `schemaStore.test.ts` / `rulesStore.test.ts`.
- **Severity:** Bug
- **Where:** Load view · JSON Schema and QC Rules slot cards · `src/core/schema/schema-store.ts:133-134`,
  `src/core/rules/rules-store.ts:390-393`
- **Repro:**
  1. Cold load `http://localhost:4173/quac/`.
  2. In the JSON Schema **URL** field, fetch a URL whose host never answers. (I served one from a
     throwaway node script on `:4201` holding the response open for 60 s; its log confirms the request
     left the browser.)
  3. Watch the JSON Schema card.
- **Observed:** Nothing happens. Sampled at **300 ms, 1.5 s and 4 s** into the live fetch, the card
  reads badge `Empty`, summary blank, and its `Clear` button `hidden`. There is no `Loading` badge, no
  `Fetching…` label, and no way to abandon the fetch. The QC Rules slot behaves identically.
- **Why it matters:** On the local fixture server every fetch returns in milliseconds, so this is
  invisible in testing — but the schema slot's job is to crawl a `$ref` network (14 files for HESP) from
  a real host. During that window the app looks like it ignored the click, and the one control designed
  to get the user out is the one that is hidden.
- **Spec check:** **Contradicts two pinned specs, and the intended code is unreachable.** `ingestion.md`
  §15 lists the badge states as "Empty / **Loading** / Valid / Warning / Error", and §19 plus
  `ui-design.md` §5 both state that schema/rules `Clear` "hide only when empty and stay ENABLED during
  `loading` — that is the cancel for a hung no-timeout fetch". Both stores *do* enter `phase: 'loading'`
  and both `summarizeSlot`s *do* have a loading branch — but it sits **after** an emptiness guard that
  the loading state always satisfies: `schema-store.ts:133` returns `'empty'` when `state.set === null`,
  and `loadSchemaUrls` sets exactly `{ phase: 'loading', set: null, … }` (line 75);
  `rules-store.ts:390` returns `'empty'` when `files.length === 0`, which is the first-load case. So
  `status: 'loading'` is dead code, and `clearButton.hidden = slot.status === 'empty'` keeps the cancel
  hidden. The UIX-7 progress log already noted the rules half ("the rules URL-fetch window still shows
  no Loading badge, so a hung FIRST rules fetch has nothing visible to clear"); **the schema half is not
  recorded anywhere**, and it is the slot with the longest fetch.
- **Suggested fix:** Move the `phase === 'loading'` check above the emptiness guard in both
  `summarizeSlot`s.

### UX-05 — Clearing the QC rules leaves an empty `Details` disclosure behind

- **Status:** **Fixed** (2026-07-26, UIX-13 — see the master-plan progress log). The diagnosis above is exactly
  right and the suggested swap is the whole fix: `renderDetails` wipes its host *before* its early return, so
  nothing more was needed. Two notes from driving it. The two sibling clear paths the repro mentions in passing
  land in a **worse** state than `Clear all inputs` does — `open === true` as well, since nothing resets a
  disclosure the user expanded, so the card sits visibly unfolded onto nothing and a later re-load comes back
  pre-expanded, unlike a cold card. The effect now collapses on `empty` too; that is safe because
  `summarizeSlot` returns `empty` on precisely "no files AND no fetch errors" — exactly when `renderDetails`
  renders nothing (a card holding only fetch errors reads `error` and keeps its list). `focusAfterRemove` is
  untouched and was re-checked live in both directions. Guarded by `rulesSlotDetails.browser.test.ts` (the
  first slot-card test in the browser tier) and two additions to `clearInputs.spec.ts`.
- **Severity:** Bug
- **Where:** Load view · QC Rules slot card · `src/ui/views/load/rulesSlotCard.ts:117-118`
- **Repro:**
  1. From a cold load of `http://localhost:4173/quac/`, click **Load example files**.
  2. Wait for all three cards to fill (`3 files · 22 rules` on QC Rules).
  3. Click **Clear all inputs** → **Clear all inputs** in the confirm dialog.
     (The per-slot rules **Clear** reproduces it identically, as does removing the last file with `✕`.)
- **Observed:** The QC Rules card returns to the `Empty` badge but keeps a visible `▶ Details`
  disclosure that the cold-load card never had. Opening it reveals nothing — `detailHost` has zero
  children while `<details>.hidden === false`. The Dataset and JSON Schema cards correctly re-hide
  theirs.
- **Why it matters:** An empty slot advertises detail it does not have, and the one affordance it offers
  is a dead end.
- **Spec check:** Not addressed as such, but `ui-design.md` §5 makes all three slots one primitive, and
  this is a local ordering slip against the pattern the other two cards follow. The rules effect calls
  `card.update(slot)` — which computes `details.hidden = detailHost.childElementCount === 0`
  (`components/slotCard.ts:101`) — *before* `renderDetails()` empties the host, so `update` still sees
  the previous run's three file blocks. `schemaSlotCard.ts:192-197` and `datasetCard.ts:124,139` both
  render details **first**. The comment directly above (`// Clear visibility BEFORE update()…`) shows the
  same hazard was already understood for the Clear button in that very effect.
- **Suggested fix:** Swap the two lines — call `renderDetails(...)` before `card.update(slot)`, as the
  other two cards do.
- **Evidence:** [`assets/ux-05-empty-details.jpg`](assets/ux-05-empty-details.jpg) — Dataset has no
  disclosure, JSON Schema has a populated `▶ Details`, QC Rules is `Empty` with `▼ Details` open onto
  nothing.

### UX-06 — A cleared slot still shows the URL of the file it no longer holds

- **Status:** **Fixed** (2026-07-26, UIX-14 — see the master-plan progress log). The diagnosis is exactly right,
  including the one-call-site count; the structural reason it is the two check-source cards is that only the
  Dataset card has a hook `clearInputs.ts` can reach, so the fix gives the other two the same one rather than
  calling `urlField.clear()` from their click handlers — which would miss `Clear all inputs` and the `✕` that
  empties the slot. The suggestion's parenthetical is answered by splitting it: an **abandoned** URL load empties
  the field (the SheetPicker's Cancel, URL leg only — the file leg must not wipe a field describing the *loaded*
  dataset), a **failed** one does not, because that text is what a typo gets fixed in and what the CORS Retry
  sits beside. Reproducing it turned up a third defect of the UX-04 class the report does not have:
  `Clear all inputs` during a hung rules fetch left the field DISABLED at `Fetching…` under an `Empty` badge,
  since only the card's own Clear released the latch `ui-design.md` §5 says the cancel owns; that release now
  lives in the shared hook. Guarded by `slotClearUrlField.browser.test.ts`, a new pass in `clearInputs.spec.ts`
  plus additions to two of its others, and additions to `hungFetch.spec.ts` and `ingest.spec.ts`.
- **Severity:** Bug
- **Where:** Load view · JSON Schema and QC Rules slot cards · `src/ui/views/load/`
- **Repro:**
  1. Cold load `http://localhost:4173/quac/`.
  2. In **Rules URL**, fetch `http://localhost:4199/hesp/rules/hesp_consistency.quac.csv`.
     The card reads `Valid · 1 file · 5 rules`.
  3. Click the QC Rules card's **Clear**.
- **Observed:** The badge flips to `Empty` and the toast says `QC rules cleared.`, but the Rules URL
  field still holds `http://localhost:4199/hesp/rules/hesp_consistency.quac.csv`. The JSON Schema slot
  behaves the same way (verified separately with `…/hesp/json_schema/core/core.schema.json`). The Dataset
  slot is correct — it empties its field. A **cancelled SheetPicker** leaves the same lie: the field
  reads `…/tiny/two_sheets.xlsx` while the slot still holds the previous dataset.
- **Why it matters:** The card's own badge and its URL field disagree about whether anything is loaded,
  on the one surface whose whole job is telling you what is in the session.
- **Spec check:** **Contradicts a pinned contract.** `ui-design.md` §5 specifies `createUrlField`'s
  `clear()` as "empties the typed URL **on slot clear**", and `components/urlField.ts:18` documents it as
  "Empty the typed URL (slot clear — a stale URL must not survive it)". The helper exists and is wired on
  exactly one of three slots: `datasetCard.ts:126` is the only `urlField.clear()` call site in `src/`.
- **Suggested fix:** Call `urlField.clear()` from the schema and rules clear paths too (and on a
  cancelled/failed load, if the field is meant to track the slot rather than the typing).

### UX-07 — On the deployed site, the bundled example's own share link is over the limit, and the Copy button disappears

- **Status:** **Fixed** (2026-07-27, UIX-15 — see the master-plan progress log). Both halves of the suggested fix
  were taken. The modal half is exactly as filed: the early `return` at `shareModal.ts:209` was the whole defect,
  and the link row, char count and `index=` callout now render unconditionally with the advice + manifest button
  appended below. The report's computed 2062 was confirmed live, from the page's own link. The headroom half was
  answered better than by shortening paths: every one of the other 13 schema files is `$ref`-reachable from
  `core/core.schema.json`, so `index.json` now lists the **root only** as a crawl base and the crawl still resolves
  the same 14 files — the deployed link falls **2062 → 591**, and the fixture paths, their `$ref`s and every pinned
  ground-truth string stay untouched. One correction to the report: the over-limit modal's focus lands on `×`, not
  on the Download button — `openModal` focuses the dialog's own close control, which precedes body content, so what
  the bug cost a keyboard user was the first control *after* it. Guarded by `shareModal.browser.test.ts`,
  `exampleLink.test.ts` (which measures at the **deployed** origin — pinning it locally would have reproduced the
  blind spot rather than closed it), a second `shareLink.spec.ts` pass, and a one-`schema=` assertion in
  `loadExample.spec.ts`.
- **Severity:** Friction
- **Where:** ShareModal · `src/core/share/shareModel.ts` / `components/shareModal.ts`
- **Repro:**
  1. Cold load `http://localhost:4173/quac/`, click **Load example files**, click **Share**.
  2. Read the character count. (Locally: a 1965-character link, with `Copy` present and working —
     verified, the clipboard receives all 1965 characters.)
  3. Add any fourth rules file and re-open **Share**.
- **Observed:** At 2025 characters the modal replaces the link entirely: no readonly input, no `Copy` —
  the only two controls left are `×` and `Download config manifest (JSON)`, under "This link is 2025
  characters — beyond the 2000-character limit for reliable sharing. Share a config manifest instead:".
  The manifest path itself works end to end (I downloaded it, hosted it, and booted `#/load?config=<url>`
  successfully — dataset, 14-file schema and rules all restored, no auto-run). The problem is the
  threshold: **the bundled example is 35 characters under it locally and over it in production.**
  Substituting the deployed origin `https://jeyabbalas.github.io/quac/` for
  `http://localhost:4173/quac/` in the measured link — the base plus 18 percent-encoded artifact URLs —
  gives **2062 characters**. (A deterministic string computation from the real link, not a test of the
  live site.)
- **Why it matters:** On the site QuaC actually ships to, the flagship "Load example files → Share" path
  — plausibly the first thing anyone tries — offers no shareable link at all, and the only way forward
  asks a data steward to host a JSON file themselves.
- **Spec check:** **The behaviour follows the spec; the threshold's consequence looks unintended.**
  `url-params.md` §25 says "Keep assembled links ≤ 2,000 chars (portability); beyond that, push users to
  `config=`", and §41 says "If > 2,000 chars → **offer** 'Download config manifest (JSON)' +
  instructions". The implementation reads "push" as *replace* rather than §41's "offer" as *add*, so a
  slightly-too-long link becomes unreachable rather than merely discouraged. Nothing in the spec
  anticipates the bundled example landing on the wrong side of the line.
- **Suggested fix:** Keep the link and `Copy` visible alongside the manifest offer, with the warning
  demoted to advice — and check the example's link length against the production origin (shortening the
  example's schema paths would also buy headroom).
- **Evidence:** [`assets/ux-07-share-over-limit.jpg`](assets/ux-07-share-over-limit.jpg)

### UX-08 — Clearing the JSON Schema silently disables 12 rules, explained only by raw DuckDB binder errors

- **Status:** **Fixed** (2026-07-27, UIX-16 — see the master-plan progress log). Reproduced exactly as filed, `12`
  included, and the constraint the finding sets is met to the number: after the fix the badge, the summary
  `3 files · 22 rules · 12 lint errors` and a subsequent run's `9 Rules run` are all unchanged — only the account
  changes. The fix is one branch in stage 4's `dryRun` (`lint.ts`), so it reaches the slot card and BOTH Studio
  surfaces at once (verified live in the Studio) with no renderer touched and no entry-bundle delta. It **fails
  closed**, which is the part worth naming: the class needs `Binder Error` + a `VARCHAR` token + one of four
  phrase families **and** at least one implicated VARCHAR column, or the engine's words stand — so a typo still
  reads `Referenced column "x" not found`, and the suggested generic sentence for the un-nameable case was
  deliberately NOT taken, since it would have thrown away the one useful thing left. Two departures from the
  suggested copy, both driven by the live strings. The message says a column is "**stored as** text" rather than
  needs typing, because with no schema *every* column is VARCHAR and the sentence must stay true of `household_id`
  (Q008) and `record_id` (Q003), which are text on purpose. And `TRY_CAST` names a real column only when exactly
  one is implicated (4 of the 12); with several the binder never says which it choked on, so naming the first
  would be a guess — Q003 would have advised casting `record_id` when only `wave` wants it. A third thing driving
  it turned up: the columns cannot come from `target_variables` alone. A column-scope assertion's text
  (`in_range(0, 120)`) names none, and Q038 targets only `monthly_rent` while failing on `wave` — so each wrapper
  passes what it was actually built from, unioned with a word-bounded scan of the rule text. The report's
  phrase-family list is now recorded in V23 from the live run (3 `No function matches`, 4 `Cannot compare values
  of type`, 5 `Cannot mix values of type` — one of those a **CASE** form the desk analysis did not predict).
  Guarded by 10 new `lint.test.ts` cases (4 of them fail-closed guards), a `draftLint.test.ts` case for the Studio,
  and two e2e passes — `partialRun.spec.ts` as the duckdb-wasm-binder pin and a new `clearInputs.spec.ts` pass that
  is this repro end to end.
- **Severity:** Friction
- **Where:** Load view · QC Rules card → Details · lint stage 4 messages
- **Repro:**
  1. Cold load, **Load example files** (QC Rules reads `Valid · 3 files · 22 rules`).
  2. Click the JSON Schema card's **Clear**.
  3. Open the QC Rules card's **Details**.
- **Observed:** The rules card drops to `Warning · 3 files · 22 rules · 12 lint errors`, and the
  explanation offered for each disabled rule is engine text:
  `Q011: condition failed the SQL dry-run: Binder Error: No function matches the given name and argument
  types '+(VARCHAR, VARCHAR)'. You might need to add explicit type casts.` A subsequent run reports
  `9 Rules run` instead of 20. Nothing connects any of this to the action just taken — that removing the
  schema made every column text, so the arithmetic rules can no longer bind.
- **Why it matters:** A steward experimenting with "what does the schema actually buy me?" performs one
  click and loses more than half their rules, with a database error as the only account of why.
- **Spec check:** **The behaviour is documented and deliberate; the in-app explanation is not.**
  `architecture.md` V23 records this precisely ("duckdb-wasm's binder does **NOT implicitly cast
  VARCHAR** … lint stage 4's EXPLAIN dry-run catches them pre-run … partial acceptance excludes them
  (Warning badge), and the remainder runs"), and names the fix as author-side `TRY_CAST`, scheduled as a
  "**P20 README limitation**"; UIX-6's log calls it a "docs-only caveat". So the *rule exclusion* is
  correct and must not change. This is reported only because driving it showed the documented reasoning
  does not survive contact: a README cannot help someone reading `'+(VARCHAR, VARCHAR)'` inside the
  card, and the message never mentions the schema — the one thing the user changed. Note the contrast
  with the Studio's own lint, which for a genuine typo says `Referenced column "nosuchcol" not found in
  FROM clause!` — actionable, because it names something the user wrote.
- **Suggested fix:** Prefix or replace the binder text for this lint class with one plain sentence —
  e.g. "needs a JSON Schema to type this column, or `TRY_CAST` in the rule" — keeping the engine detail
  behind it.

### UX-09 — The Findings list buries each message behind a machine id up to 111 characters long

- **Status:** **Fixed** (2026-07-27, UIX-17 — see the master-plan progress log). The suggested fix was taken as filed: the
  findings list and the grid popover now take a bare `renderFlagMessage`, and `renderFlag` (unchanged in name, signature and
  output) is a composition of it, so the `__review` cells this finding exempts are untouched by construction. Two
  clarifications from driving it. The measured prefixes are the *rendered row* lengths — id plus the severity chip's own word
  (`error ` = 6, `info ` = 5); the ids themselves are 32, 4, 30, 101, 106, 91, 85, 4, 4, so the longest is **106**, not 111.
  And the popover was the easy half but the panel was not: the finding says to "let the existing id/source line carry the
  identifier", and the popover does already have one (data-table prints `code · source` itself) — the **findings list had
  none**, so the id needed a home rather than a deletion. It now sits on a muted mono second line, the same split Sheet 3 and
  the Offenders panel already make. The id scheme is untouched, which retires the `relativePath` change
  `phase-14-run-report.md:117-119` had deferred to P19/P20 as a spec deviation. Guarded by 6 new unit cases across
  `messages.test.ts` / `annotations.test.ts` / `reportModel.test.ts`, a new `loadExample.spec.ts` pass (the only path that
  produces URL ids — `runQc.spec` uploads its schema files and gets short ones) carrying a 1440/1280/1024/768 overflow sweep,
  and two invariants added to `runQc.spec.ts`.
- **Severity:** Friction
- **Where:** QC Report · Findings panel · `src/core/flags/messages.ts` rendering
- **Repro:**
  1. Cold load, **Load example files**, **Run QC**.
  2. Open the **Findings** panel and read down the list.
- **Observed:** Of the 9 findings, the id prefixes measure 38, 10, 36, **106, 111, 96, 90**, 9 and 9
  characters. Four of nine open with a full absolute URL before the sentence starts, e.g.:
  `info schema:advisory:http://localhost:4173/quac/examples/json_schema/core/categories/derived_measures.json:
  Schema note (core/categories/derived_measures.json): Soft checks: net_worth = total_assets − total_debt; …`
  — the file is named **twice**, first as a 106-character URL and then, immediately, in the short readable
  form. This is the *default* first-run experience, because `Load example files` loads by URL and
  `fileId` is the retrieval URL for URL-loaded sets (`schema-set.ts:190`); on the deployed
  `jeyabbalas.github.io` build the URL is a comparable length.
- **Why it matters:** The panel a steward reads to find out what is wrong with their data opens each of
  its longest entries with the least useful text on screen, pushing the actual advisory below the fold.
- **Spec check:** **Both halves are spec'd; the composition isn't.** `qc-report-spec.md` §14 pins one
  shared renderer, `"{ruleId}: {message}"`, deliberately shared by annotations, `__review` cells and the
  findings list; `json-schema-subsystem.md:322,335` defines the id as `schema:advisory:<fileId>` **and**
  pins the message as `"Schema note ({file}): {text}"` — i.e. the message already names the file by
  design. Nothing addresses what happens when both apply at once. The shared format genuinely earns its
  place in Excel, where `<col>__review` cells have nowhere else to put the id — and in the workbook's
  *Dataset Findings* and *Repeat Offenders* sheets the id sits in its own `Rule ID` column, which reads
  fine. The grid's cell popover is the other loser: it prints
  `schema:prop:reference_year:value: 2150 exceeds the maximum 2,100 …` and then repeats
  `schema:prop:reference_year:value · schema` in its own footer line one row below.
- **Suggested fix:** Give the two consumers that already have somewhere to put the id — the findings list
  and the grid popover — the bare `message`, and let the existing id/source line carry the identifier.
- **Evidence:** [`assets/ux-09-findings-id-prefix.jpg`](assets/ux-09-findings-id-prefix.jpg)

### UX-10 — The schema parse error names a path that does not exist, and repeats itself

- **Status:** **Fixed** (2026-07-27, UIX-18 — see the master-plan progress log). Both halves of the suggested fix were
  taken, the second one layer below where the finding points. The stutter: the V8 form the report quotes carries no
  position *and* closes with this template's own clause, so `{reason}` now drops that tail — but gated ON the tail
  rather than cutting at the first comma unconditionally, so a message that merely contains a comma is never
  truncated. The path: `stripCommonRoot` is a `webkitRelativePath` helper (`schema-set.ts:66`, and §A.2.1 scopes it to
  uploads) that `intakeFiles` was applying to every origin — a URL's first `/`-delimited segment is its scheme, so it
  ate `http:` off every URL entry. It is now uploads-only, which is why the fix is one line rather than a special case
  for "no meaningful common root": the degenerate single-URL set was not a separate branch, it was the same bug the
  14-file set survives only because `relativizeUrlPaths` (`:341`, off `fileId`) repairs the *stored* path afterwards —
  too late for messages, which are frozen at intake. That freeze is why `E_DUP_ID` and every `ref-graph` message had
  the same defect unreported; they are fixed by the same line. `E_PARSE` also now names the file by `fileId` rather
  than `relativePath`: identical for uploads, and for URL sets it is the exact string *Ignored files* prints, so the
  card's two lines agree by construction rather than by coincidence — that is now the unit invariant. Measured live:
  the finding falls 126 → 97 characters, `is not valid JSON` goes 2 → 1, and the HESP set is byte-identical
  (`14 files · root: core/core.schema.json`, `set id: 636a370031d8ef6f`). Guarded by a new `messages.test.ts` (the
  first direct test of that module — the two existing E_PARSE cases were upload-only, matched `.+\.`, and the
  positional one self-neutralises on modern V8, which is how this got in), two `schema-set.test.ts` cases, and a
  `schemaLoad.spec.ts` pass that is this repro end to end.
- **Severity:** Friction
- **Where:** Load view · JSON Schema card → Findings · `src/core/schema/messages.ts:26-32`,
  `src/core/schema/schema-set.ts:198`
- **Repro:**
  1. Cold load `http://localhost:4173/quac/`.
  2. In the JSON Schema **URL** field, fetch `http://localhost:4199/synthetic/mixed/notes.txt`.
  3. Read the auto-opened `Details → Findings`.
- **Observed:** ``Error: `/localhost:4199/synthetic/mixed/notes.txt` is not valid JSON: Unexpected token
  'T', "This file "... is not valid JSON.`` Two problems in one sentence: the path has lost its scheme
  (`http:` is gone — verified at the character level, so not a rendering artifact) and disagrees with the
  correct full URL printed two lines above under *Ignored files*; and the sentence ends "is not valid
  JSON: … is not valid JSON." The second finding on the same card — "None of the loaded files look like
  JSON Schemas. QuaC looked for keys like `$schema`, `type`, or `properties`." — is by contrast exactly
  right, which is what makes the first one stand out.
- **Why it matters:** The one line that names the offending file is the least readable thing on the card,
  and the path it prints cannot be pasted or searched for.
- **Spec check:** **Contradicts the golden message.** `json-schema-subsystem.md:122` pins `E_PARSE` as
  "``​`{path}` is not valid JSON: {reason} (near position {n}).``". `messages.ts` anticipates format drift
  ("V8 formats vary") and falls back to pasting the raw engine string in as `{reason}` — but current V8
  emits `Unexpected token 'T', "This file "... is not valid JSON`, which carries no `at position N` (so
  the position is silently dropped) and already ends in the same clause (so it stutters). The path comes
  from `entry.relativePath` after `stripCommonRoot` (`schema-set.ts:254`), whose "longest common
  directory" display-path logic is right for the 14-file HESP set (`core/core.schema.json`) but
  degenerates for a single URL.
- **Suggested fix:** Take only the leading clause of the V8 message (up to the first `,`) as `{reason}`,
  and print the entry's retrieval URL rather than the stripped display path when the set has no
  meaningful common root.

## Notes, not findings

**Things that went conspicuously right** (worth not regressing):

- **The Excel workbook.** Five sheets exactly per `qc-report-spec.md` §5; filename
  `quac-report_hesp_dirty_100_20260726-1748.xlsx`; `Data` at 102 × 291 with 25 `<col>__review` sister
  columns; review text that reads like prose ("2150 exceeds the maximum 2,100 — expected an integer
  2,000–2,100. [Unit: calendar year]"; "when baseline_record = 1, move_reason must be -666 (Not
  applicable / structural skip). Found 3."); corrections rendering as `(corrected: 777 → -777)` and
  `(corrected: 'hh-42' → 'HH00000042')`, 6 of them matching the panel; `Run Info` listing all 14 schema
  files, per-file rule counts, stage durations and caps.
- **Cancel-mid-run and assess-only.** Cancelling at `Preparing tables` yields a warning-tinted banner,
  "Partial run — cancelled before completion. Counts below cover the work finished.", honest partial
  counts and stripped annotations. Assess-only says "Assess-only run: corrections were not applied.",
  `0 Corrections applied`, `14 Rules run` instead of 20.
- **The run bar's reason line** names the problem *and* the way out in all four states: "Load a dataset
  to run QC." · "Load a JSON Schema or a QC rules file to run QC." · "The JSON Schema has errors that
  block validation — fix it or load a QC rules file to run QC." · "Choose the index schema on the JSON
  Schema card to run QC. Or load a QC rules file — either input is enough to run." A failed re-ingest
  disables Run QC and says "The dataset failed to load — fix it or load another…".
- **Clearing** is otherwise solid: a check-source clear **mid-run** invalidated the run (pill gone,
  panels back to "No findings yet. Results land here after a QC run.", data grid kept, annotations
  stripped, hash rewritten to drop `rules=`); a dataset clear then re-loading the same file re-ingested
  cleanly; reload-after-clear left everything cleared; and the clear-all toast gained its conditional
  "The QC report was reset." hint only once a run existed.
- **All five Studio dirty guards** route through one identical `Discard changes?` dialog, and the
  rules-clear confirm correctly detected an *unsaved open draft* that `dirtyFiles` cannot see.

**Smaller observations, deliberately not raised to findings:**

- **An intermittent second face of UX-01, seen once and not reproduced.** In one longer sequence
  (example → Run → clear the rules **mid-run** → clear the dataset → re-load the same dataset → Run) the
  grid came back empty with **no toast at all** — panels fully correct (`13 / 0 / 4`, scope note,
  em-dashes, pill 17), grid stuck on "Load data to see the table". Four subsequent attempts, including
  that exact sequence and each shorter prefix of it, all passed. Recorded as an observation because I
  could not re-trigger it — but it suggests the grid re-mount path is fragile in more than the one
  deterministic way UX-01 pins down, and that variant fails *silently*, which is worse.
- **`Run Info` reports `QuaC version | 0.0.0`.** Version bumping is explicitly P20's job, so not a
  finding — but P20 should know the exported workbook is a *user-visible* surface for it.
- **`Missing Variables` says nothing when nothing is missing.** The in-app panel gives the good news
  ("All schema variables are present in the dataset."); the emailed sheet is headers and nothing else.
  §62 only specifies a note row for the *no-schema* case.
- **The disabled `Add to file` never says why.** It carries no `title` and no `aria-describedby`, and the
  footer status reads `Untested` both when the rule is merely untested and when a lint error blocks it.
  Sighted users have the red diagnostic inches away, and pressing `Test rule` resolves the ambiguity
  ("Test failed — see the preview panel."), so this is minor — but a screen-reader user gets no reason
  at all.
- **The `Discard changes?` dialog opens focus on `×`**, while its two siblings (`Delete rule?` and the
  clear confirms) explicitly focus `Cancel` per `ui-design.md` §5 / UIX-3. Harmless — `×` and
  `Keep editing` do the same thing — but inconsistent.
- **Dataset-scope rules show `Count 1 · 0.0% rows`.** Literally correct (they affect no particular row)
  and consistent between panel and Sheet 4, but it reads oddly beside row-scoped percentages.
- **A CORS failure also emits "None of the loaded files look like JSON Schemas"**, which describes an
  empty set and makes one problem look like two.
- **Rules filenames wrap mid-extension**: at 1440 `hesp_consistency.quac.csv` breaks as
  `hesp_consistency.quac.cs` + a lone `v`; at 768 it breaks better but
  `hesp_keys_and_structure.quac.csv` still splits mid-word. Character-based wrapping, consistently
  present, purely cosmetic.
- **The empty-set `set id`.** A failed schema load still prints `set id: 4fb04455825d20ba` under `0
  schema files`. `setId` is an internal content hash (`json-schema-subsystem.md:63`) surfaced verbatim,
  and a hash over an empty set means nothing.
- **Rules errors don't auto-open their disclosure.** Loading a non-rules file gives `1 file · 3 rules · 6
  lint errors` with `Details` **collapsed**, while the schema card in the same state auto-opens its
  Details *and* says "— see details". The rules lint messages themselves are excellent (`Required column
  "rule_id" is missing from the header row.`, one per missing column).
- **A new preconfigured link pasted into an already-open tab does nothing** until reload —
  `applyBootConfig` runs once at startup. Normal SPA behaviour; noted because Pass D exercises
  preconfigured boots.
