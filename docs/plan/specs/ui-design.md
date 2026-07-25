# Spec: UI Design System — Tokens, Wireframes, Components, Copy, A11y

> Audience: P04 (shell/tokens), P05/P06/P12 (slot UIs), P14 (report view), P17–P18 (studio), P19 (polish/a11y).
> Brand source: `assets/logo/quac-logo.svg` — light-blue disk `#00CCFF` with thick black stroke (width 10), duck as an
> embedded PNG raster (yellow body, orange beak). NOTE: the BRIEF calls it `QuaC.svg`; the actual file is `quac-logo.svg`.

## 1. Design stance

Elegant, simple, focused. The header banner may be playful; the main work area is minimal on white — **the data is the interface**. Duck jokes exist but are rationed (§6). Desktop-first (usable ≥1024px; below that, panels stack).

## 2. Tokens (`src/styles/tokens.css`)

Brand:
```
--q-sky:    #00CCFF;   /* header/banners. BLACK text on sky, never white (white fails contrast ~2.1:1) */
--q-yellow: #FFD21E;   /* primary action accent; black text/icons on yellow ≈ 12:1 */
--q-orange: #FF9F1C;   /* secondary accent: hover/focus flourishes; kept AWAY from warning semantics */
--q-ink:    #111111;   /* strokes, headings */
--q-paper:  #FFFFFF;   /* main work area */
--q-gray-{50..900}     /* neutral ramp */
```

Semantic (distinct from brand so duck-yellow never means "warning"). Each severity has **three** roles and they are
not interchangeable — `--q-*` is a border / pill background / text on white or `--q-gray-50`; `--q-*-fill` is the
tinted background; **`--q-*-ink` is the text colour to use ON the matching fill** (P19):
```
--q-error:   #D7263D;  fill #FFC7CE;  ink #9C0006
--q-warning: #B45309;  fill #FFF4CC;  ink = --q-warning (already 4.56 on its own fill)
--q-info:    #0369A1;  fill #DDEBF7;  ink #1F4E79
--q-success: #15803D;  fill #C6EFCE;  ink #276749   /* corrected cells */
```
The ink values are the font colours `qc-report-spec.md §5`'s workbook already pairs with these fills, so workbook,
grid, and chrome agree on one palette. They exist because the mid-tone on its own fill **fails AA**: measured
`--q-error` on `--q-error-fill` = 3.38, `--q-success` on `--q-success-fill` = 3.97. With ink: 5.92 / 5.33 / 7.14 /
4.56. The **fills are frozen** — a P05 e2e asserts `--dt-annotation-error-bg` computes to `#ffc7ce`.

Brand tints (washes only, never semantic):
```
--q-yellow-tint: #FFF8EC;  /* warm hover wash (drop zones) */
--q-sky-deep:    #0099CC;  /* wave stroke in the duck-progress water SVG; the data-URI keeps the literal hex */
```

Map onto data-table (all on `body`, not `:root` — the library ships its own `:root` defaults and inheritance from a
nearer ancestor beats cascade order): `-bg` ← `--q-*-fill`, `-bdr` ← `--q-*` (it is a border, and it is what makes a
tint legible as a severity), and **`-fg` ← `--q-*-ink`** — `-fg` paints the annotated *cell text* on `-bg`, so it is a
text-on-fill role. `--dt-font-family` ← `--q-font-sans` so the grid reads as part of the app. `--dt-primary` /
`--dt-accent` are deliberately **not** remapped: 96 usages, several of them white-on-primary fills, so brand hues
there would *create* failures (white on `--q-sky` is 2.1:1).

`colorScheme: 'light'` must be **passed explicitly to every `createDataTable` call** (P19). The library default is
`'auto'`, and its stylesheet flips the whole grid dark under `prefers-color-scheme: dark` unless the instance carries
`data-dt-color-scheme="light"` — which only that option sets. The white work area is a brief requirement and dark mode
is out of scope for v1, so a dark-OS user seeing a dark grid inside QuaC's white page is a bug, not a preference.

Type: **Inter** (UI) + **JetBrains Mono** (code, rule IDs, SQL) — self-hosted via `@fontsource` (privacy: no Google Fonts CDN); system-stack fallbacks.

Structural tokens (all `src/styles/tokens.css`; component CSS uses these, not raw values):

| Tier | Tokens | Values |
| --- | --- | --- |
| Type scale | `--q-text-xs / sm / md / lg / xl / 2xl` | 0.75 / 0.8125 / 0.875 / 1 / 1.125 / 1.25 rem (wordmark/h1 sizes stay component-local) |
| Space | `--q-space-1..7` | 4 / 8 / 12 / 16 / 24 / 32 / 48 px (4px grid) |
| Radius | `--q-radius-sm / md / lg / pill` | 6 / 8 / 12 / 999 px |
| Borders | `--q-border-hairline` · `--q-border-input` · `--q-stroke` · `--q-stroke-heavy` | 1px gray-200 · 1px gray-300 · 2px ink · 3px ink |
| Elevation | `--q-shadow-1 / 2 / 3` · `--q-scrim` | subtle → floating soft shadows · `rgb(17 17 17 / 0.5)` overlay |
| Z layers | `--q-z-sticky / modal / toast` | 10 / 50 / 60 |
| Motion | `--q-ease-out` · `--q-dur-1 / 2 / 3` | easeOutCubic · 120 / 200 / 300 ms |

Surface tiers (the "sticker" language — decided in the UIX overhaul):
- **Tier 1 — sticker containers** (`--q-stroke`, `--q-radius-lg`, paper, `--q-shadow-2`): slot cards, report panel, pertinence strip, run/export progress cards. Bold ink outline = a thing you act on.
- **Tier 2 — inner structure** (`--q-border-hairline`/`--q-border-input`, `--q-radius-sm/md`): stat tiles, choice rows, inputs, table rules. Quiet gray lines organize inside a sticker.
- **Tier 3 — data surfaces** (borderless or hairline, white): preview table, report grid container, finding lists. The data is the interface.
- **Chrome** (header, tabs, buttons, toasts, modals) keeps its existing ink-stroke language.

Focus ring: 2px `--q-orange` **plus `--q-focus-edge`**, an ink companion laid either side of the orange band as a
`box-shadow` behind the outline. The orange alone is not an indicator — measured 2.05:1 on paper, 1.42:1 on
`--q-yellow`, **1.08:1 on `--q-sky`**, so keyboard focus on the header's Share / GitHub / nav tabs was effectively
unmarked. Ink is 18.9 / 13.0 / 10.0 on those same surfaces, clearing SC 1.4.11's 3:1 everywhere QuaC paints.
`.q-btn:hover:focus-visible` re-declares the edge: the hover rules out-specify the global `:focus-visible` and would
otherwise drop it when the pointer rests on a keyboard-focused button.

## 3. Layout & navigation

Header banner (sky background, black bottom stroke): logo (40px) + wordmark "QuaC" + subtitle "in-browser data quality control" · right: **Share** button, GitHub link (`github-logo.svg`). Primary nav = 3 tabs: **Load** · **QC Report** · **Rule Studio** (Report tab shows a severity-count pill after a run). Persistent slim privacy line under the header on Load: "Your data never leaves this browser. No uploads, no servers, no storage."

## 4. Wireframes

**Load (`#/load`)** — the first-run hero recedes once any slot fills (or the session came pre-configured from a link); the run bar is sticky at the viewport bottom so the CTA is always in reach (`html { scroll-padding-bottom }` keeps scrolled-to targets clear of it).
```
+------------------------------------------------------------------------------+
| [duck] QuaC  in-browser data quality control            [Share] [GitHub]     |
|  Load   |   QC Report (•12)   |   Rule Studio                                |
+------------------------------------------------------------------------------+
|  Files stay in this tab and are gone on reload — re-upload then, or load    |
|  by URL and let QuaC re-fetch for you.                                       |
|  +==========================================================================+ |
|  | (duck)  New here? Take QuaC for a spin.         [ Load example files ]  | |  <- first-run hero
|  |         One click loads the bundled HESP example…                       | |     (Tier 1 sticker)
|  +==========================================================================+ |
|  +== Dataset ======[Valid]=+  +== JSON Schema ==[Valid]=+  +== QC Rules ===+ |
|  | hesp_dirty.csv · 101x266|  | 14 files · root: core…  |  | 3 files · 22  | |
|  |  .....................  |  |  .....................  |  |   businesses.. | |
|  |  : drop file / browse:  |  |  : drop files/folder :  |  |  : drop CSVs: | |
|  |  :...................:  |  |  :...................:  |  |  :..........: | |
|  | Dataset URL [___][Fetch]|  | URL [________][Fetch]   |  | Rules URL […] | |
|  | [details v]             |  | [Browse folder]         |  | [details v]   | |
|  +-------------------------+  | [details v]             |  +---------------+ |
|                               +-------------------------+                    |
|  [OK] Pertinence: 265/265 schema variables present · Rules: 28/28 present    |
|  +== Preview =============================================================+ |
|  |  Dataset | JSON Schema | QC rules            <- PanelTabs (APG tablist) | |
|  |------------------------------------------------------------------------| |
|  |  Dataset preview             first 50 of 101 rows · 266 columns         | |
|  |  | record_id | wave   | household_id |  ...     <- sticky <thead>       | |
|  |  | VARCHAR   | BIGINT | VARCHAR      |          <- type row (<td>, mono)| |
|  |  |-----------------------------------|                                 | |
|  |  | HH0000001 |      1 | HH00000001   |  ...                             | |
|  +========================================================================+ |
+------------------------------------------------------------------------------+
|  Load a dataset to run QC.       [x] Apply corrections          [ Run QC ]  |  <- sticky bottom bar
+------------------------------------------------------------------------------+
```

**QC Report (`#/report`)** — during a run one monotonic DuckProgress card sits above the grid area (`~(duck)~ Validating against the schema · 43%  [Cancel]`); the panel column is a sticky Tier 1 sticker with one-line tabs.
```
+------------------------------------------------------------------------------+
| header + nav                                                                 |
+-------------------------------------------+----------------------------------+
| [data-table: annotated grid, filters,     | +== panel sticker (sticky) ====+ |
|  header tooltips, severity tints]         | | Summary · Missing vars ·     | |
|                                           | |  Findings · Offenders        | |
|                                           | | +--39----+ +--13----+        | |
|                                           | | | Errors | | Warnings|  <- severity-tinted hero
|                                           | | +--10----+ +---6----+        | |
|                                           | | | Info   | | Corrections|    | |
|                                           | | Rows 101 · Cols 266 · run/skip| |
|                                           | | Show annotations [x][x][x]   | |
|                                           | | [ Download QC Report (.xlsx) ]| |
|  ! Painting 20,000 of 143,201 flags —     | |            [ Re-run QC ]     | |
|    full detail in Excel report            | +------------------------------+ |
+-------------------------------------------+----------------------------------+
```

**Rule Studio (`#/studio`)** — **ONE** Tier 1 sticker for the whole workspace (UIX-2); the three zones are
divided by Tier 2 hairlines, not by four competing outlines. The middle **work column has two faces** and shows
exactly one: browsing shows the rule table, opening a rule swaps in the editor. The preview column never moves, so
the form you type in and the result you read sit side by side and the page stops growing when you edit.

Browsing (≥1280):
```
+------------------------------------------------------------------------------+
| header + nav                                                                 |
+==============================================================================+
| RULE FILES  [New file] | my_rules.quac.csv  [Download CSV] [Add rule]        |
|  hesp_keys… 10 rules OK|  ID   Type·Scope    Targets  Sev Lint On Actions    |
| >hesp_cons…  5 rules OK|  Q001 validate·col  record_id err  OK  [x] ⧉ ✕  ↑ ↓ |
|  hesp_corr…  7 rules OK|  Q002 validate·row  hh_id,…  err  OK  [x] ⧉ ✕  ↑ ↓ |
|  19/19 targets         |                                                     |
|                        |------------- (hairlines, one card) -----------------|
|                        |                    | LIVE PREVIEW  10,000-row sample|
|                        |                    | Test result: 7 rows match      |
|                        |                    | [ Filter preview to matches ]  |
|                        |                    | [data-table: sampled rows]     |
+==============================================================================+
```
Editing — the editor takes the same column, the preview stays put:
```
| RULE FILES  [New file] | [← Rules]  Edit rule — my_rules.quac.csv            |
|  …                     | rule_id [Q061_____________]   enabled [x]           |
|                        | rule_type [validate v] rule_scope [row v] severity[]|
|                        | target_variables [income_total x] [add column…]     |
|                        | condition   [CodeMirror: completion + lint]         |
|                        | Correction  [SQL|JS] [CodeMirror]        (if correct)|
|                        | comment     [_____________________________]         |
|                        | [Test rule] Tested ✓        [Cancel] [Save rule]    |
```
Collapsed rail (UIX-3) — `«` in the rail head trades the file list for its width; the files stay as dots so
switching never needs a round trip through expand:
```
+------------------------------------------------------------------------------+
| »  | my_rules.quac.csv  [Download CSV] [Add rule] | LIVE PREVIEW   101 rows    |
| •  |  Q001 validate·col  record_id err OK [x] ⧉ ✕ | Test result: 7 rows match  |
| ·  |  Q002 validate·row  hh_id,…    err OK [x] ⧉ ✕ | [data-table: 6 columns    |
| ·* |                                              |  instead of 4]            |
+------------------------------------------------------------------------------+
```

Breakpoints: **≥1280** three zones side by side (`240px · minmax(600px, 1.1fr) · minmax(360px, 1fr)` — the work
floor is measured against the rule table's min-content, see §5); **1024–1279** two columns, rail spanning both
rows, preview under the work column; **≤1023** everything stacks and the rail becomes a horizontal file strip.
The rail collapses to **44px** at ≥1024 only — below that it is already a strip, so the toggle hides and a stored
collapse goes inert (remembered, not honoured) until the window is wide again.

**Modals** (all: focus-trapped, `Esc` closes, `role="dialog"`, labelled):
- **IndexPickerModal** — radio list of candidate root schemas (relativePath, `$id`, title, array-shape badge) + "why this is ambiguous" note; selection recorded → `index=` param.
- **SheetPickerModal** — Excel sheet names, Sheet 1 preselected.
- **ShareModal** — per `url-params.md §4`. Opens **wide** (`openModal({ size: 'wide' })`). Order: intro → "Shareable link" (readonly input + Copy primary + char count + index callout, or the `config=` manifest path) → "Loaded files" provenance. Schema's per-crawl-base rows render as ONE grouped ✓ row ("Schema: N files · root …") with the URLs behind a `<details>`; grouping is render-time only — `shareModel.ts` stays per-URL. Uploaded artifacts keep their ✗ row + "host it by URL" note.
- **Pertinence block modal** — per `json-schema-subsystem.md §E.5`.

## 5. Component inventory

AppShell, NavTabs, SlotCard, DropZone (button semantics), UrlField, Badge, SeverityPill, Toast, Modal, IndexPickerModal, SheetPickerModal, ShareModal, DuckProgress, PlainPreviewTable, DataDictionaryTable, StatCard, PanelTabs, MissingVarsList, DatasetFindingsList, OffendersTable, DownloadButton, EmptyState, PertinenceStrip, PrivacyBanner, CodeEditor (CM6 wrapper), RuleForm, RuleList, RuleTestPanel.

Conventions:
- **Unified slot primitives**: all three Load slots render through `createSlotCard` (header + badge, summary line, body, hidden-when-empty `actionsHost`, optional `<details>` with `setDetailsOpen`), `createDropZone` (a real `<button>`; options: `inputAriaLabel`, `dropTarget` to widen the drop surface, `onDropTransfer` for folder walks), and `createUrlField` (a real `<form>` with a Fetch submit button). Slot-specific code is detail-renderers only (e.g. `schemaSlotCard.ts`'s facts/ignored/findings body).
- **Modal sizes**: `openModal({ size: 'default' | 'wide' })` — 560px / 720px caps. Wide is for content-heavy dialogs; ShareModal is the only wide modal today.
- **Modal footers**: every modal's action row is `.q-modal-actions` (right-aligned, gap-2) — SheetPicker, IndexPicker, and the pertinence block modal share it. One primary per modal at most.
- **Severity labels**: the nav-tab count pill is `createSeverityPill()`; inline severity name chips (offenders table, findings list) are `createSeverityLabel(severity)` — both live in `severityPill.ts`; no bespoke pill markup elsewhere.
- **Empty states**: framed `createEmptyState` is for view-level empties only (a whole route with nothing to show). In-panel empties are a quiet `.q-panel-note` paragraph — a dashed box inside a sticker card reads as a broken drop zone.
- **Preview tabs are named for the INPUT, the panel says what it renders.** The three Load Preview tabs carry the three slot-card names verbatim — `Dataset` · `JSON Schema` · `QC rules` — so the strip under the cards names the same three things the cards do. Where a panel shows something other than the raw input, a `.q-preview-panelcaption` line under its head says so: the JSON Schema panel's is `JSON Schema formatted as a data dictionary`, the QC rules panel's is `QC rules files, one table per file`, both present in every state including empty. The tab IDs (`dataset`/`dictionary`/`rules`) are internal and do not follow the labels.
- **The JSON Schema and QC rules panels are one component over two payloads.** Both are a real `<label for>` search box + a derived `Collapse all`/`Expand all` + a debounced `role="status"` count, over a named tab-stop scroll region holding one `<details open>` per section, each with its own `<table>`. Namespaces are `q-dd-*` and `q-rp-*`; everything identical between them (head, search, toggle, count, scroll, disclosure, table base, chip, muted mono sub-line) is declared ONCE in `preview/preview.css` under a grouped selector, and only the payload cells and the measured column percentages are per-panel. Pinned copy: `Search variables` / `Search rules`, `Collapse all` ⇄ `Expand all`, `N variables` / `N rules` and `M of N …` while filtering, `No variables match 'q'.` / `No rules match 'q'.`, and the panel notes `Load a JSON Schema to see it here.` / `Load a QC rules file to see it here.`, `Reading the rules files…`, `These rule files contain no rules.`
- **Neither preview panel restates its slot card's findings.** The dictionary points at the schema card, the QC rules panel at the rules card. What the rules panel *does* show is properties of the rule rather than findings about it: `enabled: false` as an `off` badge plus a muted row, and `external` as an `external` badge. Its six columns are curated, not the ten CSV ones — `condition` and `update_expression` get the width, because the Studio's rule grid is ~510–710px wide and omits both.
- **Progress**: DuckProgress v2 mechanics + the run-level monotonic mapper (`runProgressModel.ts`) and the `PROGRESS_LABELS` copy home are specified in §6.
- **Tabbed panels go through `createPanelTabs`** (`components/panelTabs.ts`): the Report panel column (`idPrefix: 'q-report'`) and the Load view's Preview section (`'q-preview'`). `idPrefix` is mandatory because the shell keeps all views mounted and toggles `hidden`, so the tablists coexist in the document and a shared prefix would break `aria-controls` and trip `duplicate-id-aria`. The Studio's SQL/JS language switch borrows the `.q-paneltabs`/`.q-paneltab` *look* but is deliberately a pair of `aria-pressed` toggles, **not** a tablist — it switches an editor mode, it does not reveal a panel. Do not "fix" it into `createPanelTabs`.
- **CSS lives with its owner**: `src/styles/` holds only `tokens.css`, `base.css`, and `primitives.css` (buttons, toast, modal, badge, pill, empty state, and — since UIX-4 — the panel-tab strip `.q-paneltabs`/`.q-paneltab*` plus `.q-panel`/`.q-panel-note`, and the syntax-token colours `.q-syntax .tok-*`; imported in `main.ts`). Everything else is co-located and imported by its owning module: `app/shell.css`, `components/{slotCard,duckProgress,sheetPickerModal,shareModal,corsHelp,plainPreviewTable}.css`, `views/load/loadView.css` (+ `schema/schemaSlot.css`, `schema/indexPickerModal.css`, `pertinence/pertinence.css`, `preview/preview.css`), `views/report/reportView.css`. New components follow suit — no additions to `src/styles/`.
  - The panel-tab move is the one sanctioned exception to "no additions", and it *relocated* shared primitives rather than adding a component's styles: `.q-paneltab` had been dual-consumer since P17 (a debt `phase-17-studio-editor.md:41` explicitly scheduled for P19/P20) and reached the Studio only because `reportView.css` happens to be eagerly bundled; `.q-panel-note` had nine consumers across three views. A third inline copy would have compounded it.
  - `.q-syntax .tok-*` moved on the same terms. `@lezer/highlight`'s `classHighlighter` emits those class names in both the Studio's CodeMirror editors and the Load view's QC rules preview, so the palette became cross-view and one definition is the only thing that keeps the two surfaces identical. It is **scoped to a `.q-syntax` marker**, never left bare: `@jeyabbalas/data-table` bundles its own CodeMirror, and an unscoped `.tok-*` rule would restyle the `.dt-root` markup QuaC does not author (the same subtree `a11y.spec.ts` excludes from the axe gate). The marker sits on `.q-editor` (`codeEditor.ts`) and is added by `renderExpr` to every expression cell it paints.
- Bare e2e-hook classes (`.q-run-cancel`, `.q-example-load`) are noted in comments where they'd otherwise look like dead selectors.

**For P17 (Rule Studio)**: compose, don't invent. The studio's two panels are Tier 1 stickers; inner structure (rule rows, form fields) is Tier 2 hairlines; the preview grid is a Tier 3 surface sized like `.q-report-grid`. Buttons come from the `.q-btn` system (one `--primary` per region — "Test rule" and the download live as secondary until a row is ready to commit); modals use `q-modal-actions` footers; tab-like switches reuse the `.q-paneltab` underline pattern; long-running preview queries show DuckProgress with a `PROGRESS_LABELS` entry. Styles go in a co-located `views/studio/studioView.css`. The pinned copy inventory (badges, dialog titles, button names) is the contract — extend it, never reword it.

**Studio layout contract (UIX-2 — binding for later studio work):**
- **One card.** The sticker recipe lives on `.q-studio-layout`; `.q-studio-rail` / `.q-studio-work` /
  `.q-studio-preview` are padded zones inside it, separated by `--q-border-hairline` dividers.
  `align-items: stretch` is what makes those dividers run full height. **Never** put `overflow: hidden` on the
  card — the targets combobox popup (`.q-combolist`, absolute) has to escape it.
- **The work column has two faces.** `syncWorkView()` in `studioWorkspace.ts` owns the invariant: exactly one of
  `.q-studio-gridcard` / `.q-studio-drawer` is visible. It must run **before** any `focusGrid(...)` /
  `addRuleButton.focus()`, which query `gridBody` and focus the grid header button — neither is focusable while
  the card is `hidden` — and before `form.load()`, for the same reason CodeMirror is route-gated.
- **Preview column reads top-down: result, then the grid it describes.** `.q-studio-testpanel` is capped
  (`max-height: min(44vh, 460px)` + scroll) so a 20-row assert result can't push the sample grid off screen, and
  `.q-studio-samplegrid` keeps a **definite** height — an auto-height host makes data-table render every row.
- **≥1280 the card fills the screen and the grid takes what is left (UIX-3).** `.q-studio-layout` carries
  `min-height: calc(100dvh - var(--q-studio-chrome))` (`--q-studio-chrome: 210px` — ~154px of header/nav/page
  padding above, ~56px of privacy footer below; `min-height`, never `height`, so a long rule table can still grow
  the card). `.q-studio-preview` is then a flex column and `.q-studio-samplegrid` is `flex: 1 1 0` with a 360px
  `min-height` floor rather than a clamp. **Why it's a contract, not a nicety:** data-table's own
  column-visualization header is **273–306px tall and grows with the pane's width**, so a fixed-height host loses
  body rows exactly when the pane widens — the pre-fix clamp gave 440px at a 900-tall window (165px of body,
  dropping to 132px collapsed) and 308px at 768-tall (33px → **0px**: the grid showed no rows at all). Filling the
  height gives 625px/350px and 493px/218px, and makes the host height **identical in both rail states**, which is
  the invariant `studio-edit.spec` now pins. Below 1280 the preview is stacked under the work column and cannot
  take "what is left", so it keeps the clamp — with the floor raised 260px → 360px for the same reason.
- **Sizing is measured, not guessed.** The rule table's min-content is what sets the work track's floor; re-measure
  (`.q-studio-gridbody` `scrollWidth` vs `clientWidth` at 1600/1440/1366/1280/1024/768) before adding a column.
  `.q-rulegrid-targets` is the elastic one that yields first (200px, capped to 130px in the three-column band).
- **Quiet is scoped.** The softened severity pill and the muted `OK` lint badge are `.q-rulegrid`-only overrides;
  `createSeverityLabel` / `createBadge` are untouched everywhere else. Severity keeps its text label — never
  color-only.
- Two override blocks sit **after** the rules they override (`.q-filebtn` strip, in-band targets cap) because
  specificity ties and source order decides; the comments there say so.
- **The rail collapses through one knob, and the work track pins when it does (UIX-3).** Every band reads
  `--q-studio-rail` (240px → 44px on `.q-studio-layout--railclosed`), so collapsing is a variable flip, not a
  re-declared template. Flipping it *alone* is not enough: the freed 196px would follow the `1.1fr : 1fr` split
  (measured: work +103, preview +93 at 1600). At ≥1280 the collapsed state therefore also pins the work track to
  its 600px floor, which lands the whole 196px in the preview — measured preview widths 623→904 at 1600,
  547→744 at 1440, 388→584 at 1280, with 0px `.q-studio-gridbody` overflow in **both** states at
  1600/1440/1366/1280/1024/768. In the 1024–1279 band work and preview share one column, so both widen. The
  collapsed dress lives entirely inside `@media (min-width: 1024px)` so the ≤1023 strip can never inherit it.
- **Never animate the grid track.** `minmax(600px, 1.1fr)` → `600px` swaps a `<flex>` for a `<length>`, which is
  not interpolable — the template snaps however it is transitioned. The work column also holds two CodeMirror
  editors whose `DOMObserver` re-measures on resize. One discrete flip measures ~46 ms with the 266-column
  example mounted; only the rail's contents fade (WAAPI, 200 ms, expand only, skipped under reduced motion).
  The preview grid needs no nudge: its column widths are fixed px and its row count derives from height.
- **Collapsed, the file buttons stay visible as dots** — `.q-filebtn-group`/`-meta`/`-pertinence` hide, a
  `::before` dot appears, and the `aria-current` yellow marker and dirty `*` carry over verbatim. `renderRail`
  sets `title` + `aria-label` per file so identity survives the text going away, and must **not** branch on the
  collapse state — a store update mid-collapse would fight the toggle. Because the buttons stay in the tab order
  and expanded is the default, the pinned `.q-filebtn` e2e locators are unaffected.

**P18 copy additions (pinned):** footer test status (aria-live) `Untested` / `Testing…` / `Tested ✓` / `Test failed — see the preview panel.`; submit labels `Add to file` / `Save rule` / `Save untested` (the last only for data-shaped lint-only — no dataset or inapplicable targets; external keeps the normal label); buttons `Test rule` · `Download rules CSV` · `Filter preview to matches` ⇄ `Clear preview filter`; preview head `Live preview` with meta `previewing on a 10,000-row sample` past the cap else `N row(s)`, and the no-dataset note `Load a dataset to preview rules against it.`; result lines `Test result: N row(s) match` (validate) · `Test result: N cell(s) would change` (sql correction) · `Test result: N row(s) match · corrections sampled on K row(s) [· E sample error(s)]` (js correction) · `Test result: N result row(s)` (dataset) · `Test result: V of N target(s) violating` with per-target heads + `Expanded SQL` disclosures (column asserts) · `Not testable: <reason>` · `Test failed: <message>` (engine text verbatim); truncation note `showing first 20`; `PROGRESS_LABELS.ruleTest` = `Testing the rule`.

**UIX-2 copy addition (pinned):** the editor's back affordance is `← Rules` (`.q-studio-back`, ghost, left of the
drawer title) — it routes through the same discard guard as the footer `Cancel`. Rule-grid headers are
`ID · Type · Scope · Targets · Severity · Lint · On · Actions` (`Type · Scope` is one column rendering
`validate · row`). Everything else is unchanged — the Studio empty state keeps `No rules yet.` /
`Load a dataset to compose rules against it — completions and previews need your columns.` verbatim (nav.spec pins
it, and `studioWorkspace.ts`'s banner shares the first clause).

**UIX-3 copy additions (pinned):** the rail toggle (`.q-studio-railtoggle`, ghost, right of `New file`) is glyph
`«` / `»` with `aria-label` + `title` `Collapse rule files` / `Expand rule files` and `aria-expanded` carrying the
state; each `.q-filebtn` gains `aria-label` `<group>, N rules`. The delete confirm is `Delete rule?` /
`Delete <id> from <file>?` + a `.q-panel-note` second line — `This can't be undone. Download the rules CSV first
if you want a copy.`, or, when the row is the open draft, `It's open in the editor, so your unsaved changes go
too. This can't be undone — download the rules CSV first if you want a copy.` — with buttons `Cancel` ·
`Delete rule` (primary, exactly as `Discard` is). Plain and serious: §6 reserves puns for empty states. This
dialog **subsumes** the `Discard changes?` guard when the deleted row is the open draft — `modal.ts` supports one
modal at a time, and once you've agreed to delete the rule the discard question is moot.

## 6. Duck usage & copy deck (rationed — "lean into the joke, but sparingly")

- Logo in header; `quac-logo.svg` used as a static asset (an embedded 280 KB raster until `a44d234` replaced both logo files with clean vector paths — 8.7 KB now, still a static asset, still not worth inlining).
- **DuckProgress**: small duck bobbing left→right along a wavy line; `prefers-reduced-motion` ⇒ plain determinate bar. Used for ingest, QC run, export. Mechanics (v2):
  - The duck is clamped one half-duck (22px) inside each track end — it never hangs outside the card at 0% or overlaps neighbours at 100%; the indeterminate swim/wake keyframes share the same insets.
  - `setProgress(label, pct|null, {glideMs})`: `--q-dp-pct` drives fill + duck, `--q-dp-glide` is the transition length with `--q-ease-out`. A long glide (8 s) toward a stage ceiling IS the asymptotic crawl for unknown totals — no JS ticker; retargeting resumes from the computed value. `glideMs: 0` snaps (new-run reset). `null` = true indeterminate, reserved for ingest, export, grid-prep, and the demo modal — **the pipeline run never passes null**.
  - **Run-level monotonic bar** (`runProgressModel.ts`, unit-tested): stages own fixed segments — prepare 0–8 · corrections 8–22 · schema 22–55 · rules 55–88 · annotate 88–100. Known totals interpolate inside the segment (300 ms glide); unknown totals target ceiling−0.5 (8 s glide). `max(prev, computed)` monotonicity; reset on run start. Static weights: skipped stages read as fast stages.
  - **One progress surface at a time**: during a run only the run-level bar shows (`reportGrid.ensureTable(showLocalProgress)`); progress surfaces animate in/out via WAAPI height+opacity (~200 ms) and always end in `[hidden]`.
  - Pun rotation is armed by `setProgress` activity and parks after 30 s idle (and on dispose); aria-valuenow/meta share one rounded integer.
  - **`PROGRESS_LABELS`** (entry-chunk `duckProgress.ts`, beside `DUCK_LOADING_LINES`) is the single home for stage labels: 'Preparing tables', 'Applying corrections', 'Validating against the schema' (e2e-pinned), 'Running QC rules', 'Painting the report', plus grid-prep and export labels.
- Loading copy, exactly three lines, rotating: **"Getting your ducks in a row…"**, **"Dabbling through your data…"**, **"Quacking the checks…"**.
- Empty states: at most one pun each (e.g. Report empty state: "No flags yet. Run QC and see what floats up."). Everywhere else: plain, serious microcopy — errors are NEVER jokes.
- **Favicon (P19; re-cut from the artwork after it)**: all three files are **generated** from
  `assets/logo/quac-duck.svg` by `scripts/generate-favicons.mjs`, so the tab icon is the header mark's duck rather
  than a redrawing of it. P19 hand-drew a flat duck believing the artwork was a raster that would not downscale; it
  had been vector since `a44d234`, so the hand-drawn one is gone. `public/favicon.svg` is `viewBox="0 0 32 32"`:
  sky disk, the artwork's three paths, ink ring last. **Placement is measured** — the script samples the outline,
  solves its minimal enclosing circle (r 481.2 at (573.4, 533.0) in artwork units) and drops that circle concentric
  with the disk, scaled to leave 1.2 units of sky inside the ring; a bounding-box centre would sit left of true (the
  bill juts right) and cost size. Coordinates are baked into icon space, not left riding a `transform`, because
  favicons meet rasterisers far dumber than a browser. Colours are brand hexes as **literals** (an icon-served SVG
  cannot read the page's custom properties): `--q-sky` / `--q-ink` / `--q-yellow`, plus one deliberate non-token —
  the bill keeps the artwork's `#f95d1d`, since `--q-orange` on `--q-yellow` is **1.42:1** and the bill dissolves
  into the head at 16px, where the artwork orange holds **2.19:1**. The same script rasterises `favicon-32.png` and
  `apple-touch-icon.png` (180×180 on opaque `--q-paper`, disk inset 8% off the iOS mask curve — iOS masks corners
  and ignores alpha) via **Playwright, not `sharp`**: already a devDep, already browser-cached in CI, and it renders
  through the same engine that paints the tab. Outputs are committed and byte-stable across runs; the script stays
  out of the `pre*` hooks and CI, like `scripts/record-ajv-errors.mjs`. `npm run favicons` regenerates all three.

## 7. Accessibility checklist (P19 gates on this)

- **Keyboard**: dropzones are real buttons; full tab order; the two-tone focus ring of §2 on every interactive
  element; modals trap focus and restore it on close.
  - **Actions live in cells, not in rows.** A `<tr role="button" tabindex="0">` puts a button inside a `rowgroup` and
    fails `aria-required-children` (critical). The offenders table's grid-focus action is a real `<button>` in the
    rule-id cell; new tables follow suit.
  - **Capped scroll containers take a tab stop and a name.** `.q-preview-scroll`, `.q-findings-list`,
    `.q-offenders-scroll`, `.q-dd-scroll` (`Data dictionary variables`), `.q-rp-scroll` (`QC rules by file`) — a scroll
    container with no focusable descendant hides everything below its fold from the keyboard
    (`scrollable-region-focusable`). Name them distinctly from the panel they sit in.
  - **`role="tablist"` means the APG pattern.** Both tablists come from `createPanelTabs`, which carries
    `aria-controls`, a roving `tabindex` (the tablist is ONE tab stop), and ←/→/Home/End. Claiming the role without
    the keys is worse than not claiming it.
  - **axe skips `[hidden]`, so tabbed content must be ACTIVATED before it is scanned.** `a11y.spec.ts` clicks every
    Report and Preview tab in turn; without that, most of a tabbed component never reaches the gate.
  - **A grouping header inside a `<tbody>` is not worth the risk.** The data dictionary renders one `<table>` per
    category, and the QC rules panel one per file, rather than a single table with `<th scope="colgroup" colspan="7">`
    rows: `th-has-data-cells` is *serious* (the gate severity) and full-width `th`s in a body are exactly what axe
    associates unpredictably. One table per section also makes each heading reachable by heading navigation, hands the
    sticky header off between sections, and reduces hiding an empty group to one `hidden`. Columns stay aligned via
    `table-layout: fixed` with identical `th:nth-child(n)` percentages.
  - **A visible `<label for>` beats `aria-label` for text inputs** (`label` is critical). Both preview search fields
    carry a real label (`.q-dd-search-label`, `.q-rp-search-label`), matching `createUrlField`.
  - **Disclosure is `<details>` + `<summary>`, and the whole header is the control.** The dictionary's category
    headers, the QC rules panel's file headers, and both panels' `+N more` overflows are all native: `aria-expanded`
    and Enter/Space come from the UA rather than from us, and the `<h4>` stays a real heading inside the `<summary>`
    (whose content model is *phrasing content, optionally intermixed with heading content*), so heading order and
    `aria-labelledby` are unaffected. The chevron is CSS with **no transition** — nothing for
    `prefers-reduced-motion` to remove. Default is **expanded**: axe skips unrendered subtrees, so a collapsed default
    would quietly take every table out of the gate. `a11y.spec.ts` scans the collapsed state of each panel too, since
    that is a second rendering, not the same one smaller.
  - **Highlighted code is OUR markup, so it is inside the gate.** `a11y.spec.ts` excludes `.cm-editor` and `.dt-root`
    as third-party, but the QC rules preview's `tok-*` spans are QuaC's own and must clear colour contrast at
    `--q-text-xs`. This bit once: a disabled rule's muted row painted its target chips `--q-gray-500` on
    `--q-gray-100`, which is 4.35:1 — `tokens.css:23` already said gray-500 is text on WHITE or gray-50. Scan the
    panel only once the lazy highlighter has landed, or the spans are not on screen to be checked.
  - **Getting past the grid.** data-table exposes ~1600 focusable controls on the 266-column example AND traps Tab
    (see §9). The Report view therefore carries a `.q-skiplink` before the grid — a `<button>`, never an
    `<a href="#…">`, because QuaC routes on the hash — and both grid hosts let **Escape** move focus out, announced
    by a `.q-sr-only` line since nothing else would say so.
- **ARIA**: `role="dialog"` + `aria-modal` on modals; labelled slots and URL fields; the annotation popover is
  data-table's (already `role="tooltip"`).
  - Toasts share one polite region (`app/toast.ts`).
  - Pipeline progress announces **stage changes only**, from a `.q-sr-only` `role="status"` element that lives
    *outside* the progress card (the card ends every run in `[hidden]`, and a live region in a hidden subtree
    announces nothing). DuckProgress itself is **not** a live region — it retargets every few ms and would narrate
    every percent — but it does carry an accessible name as well as a value (`aria-progressbar-name`).
  - Severity is never colour-only: pills and labels keep their text, and the pertinence badge gets a `.q-sr-only`
    prefix so "OK" says what is OK.
- **Contrast**: every pairing AA-checked (3:1 for the focus indicator, SC 1.4.11). Never white text on sky or yellow.
  Text on a severity fill takes the `-ink` token of §2. Watch the *tinted* backgrounds specifically —
  `--q-gray-500` passes on white (4.74) but fails on `--q-yellow-tint` (4.49) and `--q-gray-100` (4.35), and
  `--q-gray-400` is not readable text anywhere (2.52 on white).
- **`prefers-reduced-motion`** respected: DuckProgress (CSS block), the reveal/collapse WAAPI helpers (early return,
  still ending in `[hidden]`), the Studio rail fade, and the header GitHub lift. Reduced motion removes MOVEMENT,
  never information or state.
- **Automated**: `tests/e2e/a11y.spec.ts` runs axe over Load (empty + populated), QC Report (post-run, all four
  panels), Rule Studio (browsing + editing), and the Share / SheetPicker / IndexPicker modals; CI already runs
  `test:e2e`, so that IS axe in CI. Gate: **serious + critical**. `.dt-root` and `.cm-editor` are excluded from the
  gate — QuaC does not author that markup — but a second, non-gating pass scans exactly those subtrees and logs what
  it finds, so exclusions never become silence. `tests/e2e/reducedMotion.spec.ts` and
  `tests/unit/ui/copyDeck.test.ts` (pun containment, §6) are the other two standing gates.

## 8. Assets

`public/logo/quac-logo.svg`, `public/logo/github-logo.svg` (copied from `assets/` at build or committed to `public/`),
favicon set — `public/favicon.svg` + `favicon-32.png` + `apple-touch-icon.png`, all three `<link>`ed from
`index.html` and all three committed (§6; `smoke.spec.ts` asserts zero 404s, so each must land in `dist/`). Fonts
under `node_modules/@fontsource/*` imported in `base.css`.

## 9. Third-party accessibility debt (upstream, P19 measured)

QuaC does not author this markup and cannot fix it from here. It is excluded from the axe gate and reported by
`a11y.spec.ts`'s diagnostic pass on every run, so the list stays current rather than forgotten. Re-check on any
`@jeyabbalas/data-table` upgrade.

**`@jeyabbalas/data-table` 0.5.1 (`.dt-root`)**
- **Keyboard trap** — WCAG 2.1.2, Level A, and the most serious of these. Focus `.dt-root` and neither Tab nor
  Shift+Tab moves it again; `document.querySelector('.dt-root :focus')` stays null through any number of presses,
  while ~1600 focusable controls sit inside (266 columns × header buttons). QuaC mitigates with the skip control and
  the Escape hatch of §7; it cannot cure it. *Not* reported by axe — only a keyboard walk finds it.
- `aria-required-children` (critical) on `.dt-root`.
- `color-contrast` (serious) on `.dt-col-stats > .dt-stats-line1/2` and `.dt-hidden-chip-name`.
- `scrollable-region-focusable` (serious) on `.dt-body-scroll`.

**CodeMirror 6 (`.cm-editor`)** — clean; no violations at any severity.
