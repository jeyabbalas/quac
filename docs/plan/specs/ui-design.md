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

Semantic (distinct from brand so duck-yellow never means "warning"):
```
--q-error:   #D7263D;  fill #FFC7CE-family
--q-warning: #B45309 (text) / #FFF4CC (fill)
--q-info:    #0369A1;  fill #DDEBF7-family
--q-success: #15803D;  /* corrected cells */ fill #C6EFCE-family
```

Brand tints (washes only, never semantic):
```
--q-yellow-tint: #FFF8EC;  /* warm hover wash (drop zones) */
--q-sky-deep:    #0099CC;  /* wave stroke in the duck-progress water SVG; the data-URI keeps the literal hex */
```

Map onto data-table: set `--dt-annotation-error-*`, `--dt-annotation-warning-*`, `--dt-annotation-info-*` from the semantic tokens so grid tints match the app. `colorScheme` stays `'light'` for v1 (white work area is a brief requirement); dark mode is out of scope.

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

Focus ring: 2px `--q-orange`, visible on every interactive element.

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
|  Preview (first 50 rows)  [plain table...................................]  |
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

**Rule Studio (`#/studio`)**
```
+------------------------------------------------------------------------------+
| header + nav                                                                 |
+--------------------------------+---------------------------------------------+
| RULES (my_rules.quac.csv)[+New]|  LIVE PREVIEW (sample: 10,000 rows)         |
|  Q001 unique record_id     ok  |  [data-table: rows matching condition]     |
|  Q008 age progression      ok  |                                             |
|  Q061 (draft) *                |  Test result: 7 rows match · 0 SQL errors  |
|--------------------------------|                                             |
| id [Q061] type [validate] scope [row]  severity [warning v]  enabled [x]    |
| targets [income_total, ...]    |                                             |
| condition (SQL)  [CodeMirror: schema-aware completion, lint]                 |
| correction (opt) [SQL|JS] [CodeMirror]                                       |
| comment [___________________________]                                        |
| [ Test rule ]  [ Add to file ]           [ Download rules CSV ]              |
+--------------------------------+---------------------------------------------+
```

**Modals** (all: focus-trapped, `Esc` closes, `role="dialog"`, labelled):
- **IndexPickerModal** — radio list of candidate root schemas (relativePath, `$id`, title, array-shape badge) + "why this is ambiguous" note; selection recorded → `index=` param.
- **SheetPickerModal** — Excel sheet names, Sheet 1 preselected.
- **ShareModal** — per `url-params.md §4`. Opens **wide** (`openModal({ size: 'wide' })`). Order: intro → "Shareable link" (readonly input + Copy primary + char count + index callout, or the `config=` manifest path) → "Loaded files" provenance. Schema's per-crawl-base rows render as ONE grouped ✓ row ("Schema: N files · root …") with the URLs behind a `<details>`; grouping is render-time only — `shareModel.ts` stays per-URL. Uploaded artifacts keep their ✗ row + "host it by URL" note.
- **Pertinence block modal** — per `json-schema-subsystem.md §E.5`.

## 5. Component inventory

AppShell, NavTabs, SlotCard, DropZone (button semantics), UrlField, Badge, SeverityPill, Toast, Modal, IndexPickerModal, SheetPickerModal, ShareModal, DuckProgress, PlainPreviewTable, StatCard, PanelTabs, MissingVarsList, DatasetFindingsList, OffendersTable, DownloadButton, EmptyState, PertinenceStrip, PrivacyBanner, CodeEditor (CM6 wrapper), RuleForm, RuleList, RuleTestPanel.

Conventions:
- **Unified slot primitives**: all three Load slots render through `createSlotCard` (header + badge, summary line, body, hidden-when-empty `actionsHost`, optional `<details>` with `setDetailsOpen`), `createDropZone` (a real `<button>`; options: `inputAriaLabel`, `dropTarget` to widen the drop surface, `onDropTransfer` for folder walks), and `createUrlField` (a real `<form>` with a Fetch submit button). Slot-specific code is detail-renderers only (e.g. `schemaSlotCard.ts`'s facts/ignored/findings body).
- **Modal sizes**: `openModal({ size: 'default' | 'wide' })` — 560px / 720px caps. Wide is for content-heavy dialogs; ShareModal is the only wide modal today.
- **Modal footers**: every modal's action row is `.q-modal-actions` (right-aligned, gap-2) — SheetPicker, IndexPicker, and the pertinence block modal share it. One primary per modal at most.
- **Severity labels**: the nav-tab count pill is `createSeverityPill()`; inline severity name chips (offenders table, findings list) are `createSeverityLabel(severity)` — both live in `severityPill.ts`; no bespoke pill markup elsewhere.
- **Empty states**: framed `createEmptyState` is for view-level empties only (a whole route with nothing to show). In-panel empties are a quiet `.q-panel-note` paragraph — a dashed box inside a sticker card reads as a broken drop zone.
- **Progress**: DuckProgress v2 mechanics + the run-level monotonic mapper (`runProgressModel.ts`) and the `PROGRESS_LABELS` copy home are specified in §6.
- **CSS lives with its owner**: `src/styles/` holds only `tokens.css`, `base.css`, and `primitives.css` (buttons, toast, modal, badge, pill, empty state — imported in `main.ts`). Everything else is co-located and imported by its owning module: `app/shell.css`, `components/{slotCard,duckProgress,sheetPickerModal,shareModal,corsHelp}.css`, `views/load/loadView.css` (+ `schema/schemaSlot.css`, `schema/indexPickerModal.css`, `pertinence/pertinence.css`), `views/report/reportView.css`. New components follow suit — no additions to `src/styles/`. Bare e2e-hook classes (`.q-run-cancel`, `.q-example-load`) are noted in comments where they'd otherwise look like dead selectors.

**For P17 (Rule Studio)**: compose, don't invent. The studio's two panels are Tier 1 stickers; inner structure (rule rows, form fields) is Tier 2 hairlines; the preview grid is a Tier 3 surface sized like `.q-report-grid`. Buttons come from the `.q-btn` system (one `--primary` per region — "Test rule" and the download live as secondary until a row is ready to commit); modals use `q-modal-actions` footers; tab-like switches reuse the `.q-paneltab` underline pattern; long-running preview queries show DuckProgress with a `PROGRESS_LABELS` entry. Styles go in a co-located `views/studio/studioView.css`. The pinned copy inventory (badges, dialog titles, button names) is the contract — extend it, never reword it.

## 6. Duck usage & copy deck (rationed — "lean into the joke, but sparingly")

- Logo in header; `quac-logo.svg` used as a static asset (280 KB embedded-raster SVG — never inline it into the bundle).
- **DuckProgress**: small duck bobbing left→right along a wavy line; `prefers-reduced-motion` ⇒ plain determinate bar. Used for ingest, QC run, export. Mechanics (v2):
  - The duck is clamped one half-duck (22px) inside each track end — it never hangs outside the card at 0% or overlaps neighbours at 100%; the indeterminate swim/wake keyframes share the same insets.
  - `setProgress(label, pct|null, {glideMs})`: `--q-dp-pct` drives fill + duck, `--q-dp-glide` is the transition length with `--q-ease-out`. A long glide (8 s) toward a stage ceiling IS the asymptotic crawl for unknown totals — no JS ticker; retargeting resumes from the computed value. `glideMs: 0` snaps (new-run reset). `null` = true indeterminate, reserved for ingest, export, grid-prep, and the demo modal — **the pipeline run never passes null**.
  - **Run-level monotonic bar** (`runProgressModel.ts`, unit-tested): stages own fixed segments — prepare 0–8 · corrections 8–22 · schema 22–55 · rules 55–88 · annotate 88–100. Known totals interpolate inside the segment (300 ms glide); unknown totals target ceiling−0.5 (8 s glide). `max(prev, computed)` monotonicity; reset on run start. Static weights: skipped stages read as fast stages.
  - **One progress surface at a time**: during a run only the run-level bar shows (`reportGrid.ensureTable(showLocalProgress)`); progress surfaces animate in/out via WAAPI height+opacity (~200 ms) and always end in `[hidden]`.
  - Pun rotation is armed by `setProgress` activity and parks after 30 s idle (and on dispose); aria-valuenow/meta share one rounded integer.
  - **`PROGRESS_LABELS`** (entry-chunk `duckProgress.ts`, beside `DUCK_LOADING_LINES`) is the single home for stage labels: 'Preparing tables', 'Applying corrections', 'Validating against the schema' (e2e-pinned), 'Running QC rules', 'Painting the report', plus grid-prep and export labels.
- Loading copy, exactly three lines, rotating: **"Getting your ducks in a row…"**, **"Dabbling through your data…"**, **"Quacking the checks…"**.
- Empty states: at most one pun each (e.g. Report empty state: "No flags yet. Run QC and see what floats up."). Everywhere else: plain, serious microcopy — errors are NEVER jokes.
- **Favicon task (P19)**: the raster duck won't downscale to 16px. Hand-draw a simplified flat `public/favicon.svg` (sky circle, yellow duck head, orange beak, black stroke) + `favicon-32.png` + `apple-touch-icon.png` generated by a committed script (`sharp` devDep), outputs committed.

## 7. Accessibility checklist (P19 gates on this)

- Keyboard: dropzones are real buttons; full tab order; visible 2px `--q-orange` focus ring; modals trap focus and restore it on close.
- ARIA: live region (`aria-live="polite"`) for pipeline progress + toasts; labeled slots and URL fields; `role="dialog"` + `aria-modal` on modals; the annotation popover is data-table's (already `role="tooltip"`).
- Contrast: every pairing AA-checked — black-on-yellow (~12:1) ✓, black-on-sky ✓, severity fills carry their dark text colors (`qc-report-spec.md §5` pairs). Never put white text on sky or yellow.
- `prefers-reduced-motion` respected (DuckProgress, tab transitions).
- Automated: axe smoke in Playwright (`a11y.spec.ts`) on all 3 views + open modals — no serious/critical violations.

## 8. Assets

`public/logo/quac-logo.svg`, `public/logo/github-logo.svg` (copied from `assets/` at build or committed to `public/`), favicon set (§6). Fonts under `node_modules/@fontsource/*` imported in `base.css`.
