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

**Load (`#/load`)**
```
+------------------------------------------------------------------------------+
| [duck] QuaC  in-browser data quality control            [Share] [GitHub]     |
|  Load   |   QC Report (•12)   |   Rule Studio                                |
+------------------------------------------------------------------------------+
|  Your data never leaves this browser. No uploads, no servers, no storage.    |
|                                                                              |
|  +--- DATASET ------------+  +--- JSON SCHEMA --------+  +--- QC RULES ----+ |
|  | [OK Valid]             |  | [OK Valid]             |  | [! 2 warnings]  | |
|  | hesp_dirty.csv         |  | 14 files               |  | 2 files         | |
|  | 100 rows x 265 cols    |  | root: core.schema.json |  | 60 rules        | |
|  |  ....................  |  |  ....................  |  |  .............. | |
|  |  : drop file          :|  |  : drop file(s)/dir  : |  |  : drop CSV(s) :| |
|  |  : [browse]           :|  |  : [browse]          : |  |  : [browse]    :| |
|  |  :....................:|  |  :...................: |  |  :.............:| |
|  | URL: [________][Fetch] |  | URL: [________][Fetch] |  | URL: [___][Fetch]||
|  | [details v]            |  | [details v]            |  | [details v]     | |
|  +------------------------+  +------------------------+  +-----------------+ |
|                                                                              |
|  Pertinence: 263/265 schema variables present · 2 missing · 3 extra   [OK]  |
|  Preview (first 50 rows)  [plain table..................................]   |
|                                                        [ Run QC  > ]        |
+------------------------------------------------------------------------------+
```

**QC Report (`#/report`)** — during a run the grid area shows DuckProgress (`~~~(duck)~~~ 62% — Quacking the checks…  [Cancel]`).
```
+------------------------------------------------------------------------------+
| header + nav                                                                 |
+-------------------------------------------+----------------------------------+
| [data-table: annotated grid, filters,     | [Summary][Missing][Dataset][Top] |
|  header tooltips, severity tints]         |  Rows 100 · Cols 265             |
|                                           |  312 errors · 41 warn · 9 info   |
|                                           |  27 corrections applied          |
|                                           |  Filter: [err][warn][info]       |
|                                           |  ------------------------------  |
|                                           |  [ Download QC Report (.xlsx) ]  |
|  ! Painting 20,000 of 143,201 flags —     |  Repeat offenders                |
|    full detail in Excel report            |   Q001 dup record_id ....... 18  |
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
- **ShareModal** — per `url-params.md §4`.
- **Pertinence block modal** — per `json-schema-subsystem.md §E.5`.

## 5. Component inventory

AppShell, NavTabs, SlotCard, DropZone (button semantics), UrlField, Badge, SeverityPill, Toast, Modal, IndexPickerModal, SheetPickerModal, ShareModal, DuckProgress, PlainPreviewTable, StatCard, PanelTabs, MissingVarsList, DatasetFindingsList, OffendersTable, DownloadButton, EmptyState, PertinenceStrip, PrivacyBanner, CodeEditor (CM6 wrapper), RuleForm, RuleList, RuleTestPanel.

Conventions:
- **Modal footers**: every modal's action row is `.q-modal-actions` (right-aligned, gap-2) — SheetPicker, IndexPicker, and the pertinence block modal share it. One primary per modal at most.
- **Severity labels**: the nav-tab count pill is `createSeverityPill()`; inline severity name chips (offenders table, findings list) are `createSeverityLabel(severity)` — both live in `severityPill.ts`; no bespoke pill markup elsewhere.
- **Empty states**: framed `createEmptyState` is for view-level empties only (a whole route with nothing to show). In-panel empties are a quiet `.q-panel-note` paragraph — a dashed box inside a sticker card reads as a broken drop zone.

## 6. Duck usage & copy deck (rationed — "lean into the joke, but sparingly")

- Logo in header; `quac-logo.svg` used as a static asset (280 KB embedded-raster SVG — never inline it into the bundle).
- **DuckProgress**: small duck bobbing left→right along a wavy line; `prefers-reduced-motion` ⇒ plain determinate bar. Used for ingest, QC run, export.
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
