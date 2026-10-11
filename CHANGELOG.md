# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and QuaC adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

QuaC ships as two products from one repository, and they version together:

- **the web app**, deployed to <https://jeyabbalas.github.io/quac/>
- **the `@jeyabbalas/quac` npm package** — the `quac` CLI and a `runQuac()` API

Entries below say which half they apply to.

## [1.2.0] — Unreleased

> Prepared, not released: this section collects the 1.2.0 changes so far. Set the date when the version is
> tagged.

Two of QuaC's own libraries moved, and the report and the Load view move with them. `@jeyabbalas/data-table`
0.7.0 → 0.10.0 holds a million annotations, so the report grid now paints every flag a run records.
`json-schema-data-dictionary` 0.1.0 → 0.7.0 brings its own dictionary component, which now renders the JSON
Schema preview. The CLI's flags, exit codes, summary record and `runQuac()` surface are unchanged.

### Added — web app

- **Every flag is painted on the grid.** The report grid used to colour at most 20,000 cells, errors first,
  under a "Painting 20,000 of N" banner. data-table 0.10 renders annotations from per-row, per-column and
  per-cell summaries instead of scanning them, so the cap and the banner are gone: every flag the run records is
  on screen (a run materializes up to 200,000). Measured on a 2,000,000-row dataset with 170,000 flagged cells:
  the run lands in about 12 seconds and the grid scrolls in 4–7 ms frames.
- **<kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> step through the flagged cells**, in the grid's order, across
  the whole dataset — the severity checkboxes decide which flags count — and a screen reader hears where it
  landed and what was flagged there ("Row 13 of 2,000,000, weight_kg: warning, …").
- **The JSON Schema preview is a full data dictionary.** The Load view's JSON Schema tab is now
  json-schema-data-dictionary's own component: skip patterns you can follow from either end (a **Skip logic**
  panel listing every rule, a "Skips N" chip on each variable that drives one, conditions that link to the
  variable they set), a **Metadata** panel, search that ranks the exact variable name first, a column header
  that stays in view, resizable columns, and **Copy** / **CSV**. It wears QuaC's fonts and colours, stays light
  on a dark-mode machine, and runs without semantic search, which would download a model.

### Changed — web app

- **Larger datasets fit.** The grid receives its data as a file it reads from disk rather than a buffer copied
  into the database's memory, which keeps the copy out of the memory QuaC's working tables already fill (at
  equal speed: 1.8 s for a million rows either way). Only the columns near the view are rendered, so a
  266-column dataset carries a tenth of the controls it did.
- **A date column with one bad value stays text in the grid**, as it is in the data QuaC validated. It used to be
  converted to dates, which showed the bad value as `null`.
- The annotation popover lists five entries per section and counts the rest ("+3 more"), and leaves out the
  severities you have hidden.

### Removed — web app

- The "Painting N of M cell flags" banner, with the cap it reported.
- QuaC's own dictionary table and its search, replaced by the component above.

### Changed — both

- **Run Info no longer lists "Cell annotations painted"** — in the browser's workbook and the CLI's alike — since
  there is no such cap. "Flags materialized" stays.

### Changed — CLI

- **DuckDB 1.5.6** (`@duckdb/node-api` 1.5.6-r.1, was 1.5.5-r.4). The browser keeps DuckDB 1.5.4 inside
  duckdb-wasm; the shared ground-truth manifests pass on both.
- An install brings about 85 more small packages, transitively: `exceljs` → … → `traverse` 0.3.10 now depends
  on a family of ECMAScript polyfills. npm resolves this fresh for every install, whatever QuaC's lockfile says.

### Security

- **`fast-uri` 3.1.8** under `ajv`, in the published package's runtime tree — the `$ref`-resolution path, which
  the CLI uses for `--schema` URLs: authority injection via an unvalidated port, host confusion via an unclosed
  bracket, and percent-encoded host case. **`brace-expansion`** under `exceljs` is patched too. `npm audit`: 6
  findings → 2, the same `uuid`-under-`exceljs` pair as 1.1.0, whose only offered remedy is a downgrade to
  `exceljs` 3.4.0 — declined.

### Accessibility

- data-table 0.10 re-measures clean: the grid is five tab stops (of 743 focusable controls on a 266-column
  dataset, down from 6,923), crossed in seven <kbd>Tab</kbd> presses and back.
- **Two findings inside the new dictionary component**, which QuaC's own table did not have: the column resize
  handles are focusable separators without `aria-valuenow` (critical), and the Valid values list nests a bare
  separator inside a `<dl>` (serious). They are upstream, recorded with their fixes in `ui-design.md` §9, and
  outside the axe gate like every other third-party subtree.

### Changed — dependencies

- `@jeyabbalas/data-table` 0.7.0 → **0.10.0** and `json-schema-data-dictionary` 0.1.0 → **0.7.0**, both pinned
  exactly. `vitest` and `@vitest/browser-playwright` 4 → 5, `es-module-lexer` 2 → 3, and every in-range update:
  vite 8.3, playwright 1.64, eslint 10.12, typescript-eslint 8.71, CodeMirror and Lezer patches.
- **Still held**, for 1.1.0's reasons: TypeScript 6.0 (typescript-eslint, through its latest canary, declares
  `<6.1.0`) and `@types/node` 24 (the `engines` floor). duckdb-wasm stays at 1.33.1-dev57.0, data-table's peer
  and the build the vendored extensions are hashed against; `xlsx` 0.20.3 is still SheetJS's latest.

### Numbers

| Measure                           | 1.1.0   | 1.2.0                    |
| --------------------------------- | ------- | ------------------------ |
| Entry JS (gzipped, 300 KB budget) | 48.7 KB | 47.2 KB                  |
| Cells the report grid can colour  | 20,000  | every recorded flag      |
| Unit tests                        | 1,211   | 1,202                    |
| Browser tests                     | 73      | 73                       |
| CLI tests                         | 45      | 53                       |
| End-to-end tests                  | 124     | 122                      |
| `npm audit` findings              | 2       | 2                        |
| Third-party a11y items open       | 0       | 2 (dictionary component) |

The unit count falls because QuaC's own dictionary search and its tests went with it; the 1.2.0 numbers are
from a local run (Node 26, macOS), the 1.1.0 ones from CI.

### Known limitations

Carried over from 1.1.0, minus the 20,000-highlight cap, which is gone. Still true: `external` rules are listed
rather than executed; a rules-only run leaves every column `VARCHAR`; column names are matched case-sensitively;
the Excel data sheet stops at 1,048,575 rows; Chromium is the only browser with automated coverage; and `xlsx`
installs from `cdn.sheetjs.com` rather than the npm registry.

## [1.1.0] — 2026-09-02

A dependency sweep, the accessibility debt it let us discharge, and a report
panel that now does what it always claimed to. Nothing breaking: the CLI flags,
the exit codes and the `runQuac()` surface are untouched.

### Fixed — web app

- **Clicking a rule in the Offenders panel focuses the grid on its rows.** The
  panel lists every rule that fired, and clicking one is meant to filter the grid
  to the rows behind its Count. On the bundled example the panel lists 28 rules
  and 3 of them did that. Focus worked by re-running the rule's SQL condition,
  which silently excluded everything that has no SQL condition to re-run — every
  schema finding, every column assertion, every dataset check, every correction.
  Of the few that were clickable, two used window functions (illegal in a `WHERE`
  clause) and one re-cast a column the report's own view types as text, matching
  nothing. None of this was a regression; the feature worked exactly as built,
  and as built it almost never fired.

  Focus is by row identity now. Every flag already records the row it came from
  and the grid already carries the same identity, so nothing is re-evaluated on
  click. **21 of the 28 focus.** The seven that do not are the findings that name
  no row at all — schema advisories and dataset-level checks — and they now say
  so in a tooltip instead of being a click that does nothing.

- **The data grid no longer traps keyboard focus.** `@jeyabbalas/data-table`
  0.6.0 fixes the WCAG 2.1.2 violation reported against 0.5.1
  ([data-table#84](https://github.com/jeyabbalas/data-table/issues/84)). The
  grid's root is five tab stops now rather than a wall of several thousand:
  <kbd>Tab</kbd> walks in and out of it and <kbd>Shift</kbd>+<kbd>Tab</kbd>
  retraces. Three axe findings against the grid go with it. This was the last
  item on QuaC's third-party accessibility list, which is now empty.

  Worth recording alongside the fix: the trap sat unnoticed behind a green suite
  for a whole release, because axe structurally cannot see a keyboard trap. A
  passing accessibility scan is not evidence about 2.1.2 — only a keyboard walk
  is.

### Changed — web app

- **The Offenders panel now reads as clickable.** A focusable rule id is
  underlined at rest rather than only on hover, the whole row takes the click,
  and the row currently focusing the grid is marked — data-table's own filter
  chip sits a column away and is easy to miss.
- data-table 0.6.0 moves the grid's filter bar above the column headers and adds
  <kbd>Shift</kbd>+<kbd>F2</kbd> keyboard column resize and reorder. Both grid
  hosts — the QC report and Rule Studio's preview — absorb the move.

### Removed — web app

- **The grid's <kbd>Escape</kbd> hatch, and the screen-reader line announcing
  it.** Both existed only to mitigate the 0.5.1 keyboard trap, and with the trap
  gone both had become false statements, read aloud to exactly the users who most
  need them to be true. <kbd>Escape</kbd> is the grid's own key now — it drops
  the cursor and cancels a layout gesture — so the hatch could only ever fire on
  presses the grid had already ignored, throwing focus out of the grid for a key
  aimed at it. The skip link stays, as a convenience rather than a rescue.

### Changed — dependencies

- **Swept to latest.** `@jeyabbalas/data-table` 0.5.1 → 0.7.0 is the headline;
  alongside it `@duckdb/node-api` 1.5.5-r.4 and `papaparse` 5.7.0, plus vite,
  vitest, playwright, eslint, typescript-eslint, axe and three CodeMirror
  patches.
- **Two versions are held back deliberately.** TypeScript stays on 6.0.x because
  typescript-eslint declares `<6.1.0` and no release supports 7 yet — bumping
  breaks `npm run lint`. `@types/node` stays on 24 to match the `engines` floor,
  so a Node-26-only API cannot typecheck clean here and then fail on the oldest
  runtime QuaC claims to support.

### Security

- `fast-uri` 3.1.4 → 3.1.6 under `ajv` — a host-confusion fix in URI parsing,
  which is the `$ref`-resolution path. Four other transitive patches came with
  it, taking `npm audit` from 6 findings to 2. The remaining two are `uuid` under
  `exceljs`, whose only offered remedy is a downgrade to `exceljs` 3.4.0 —
  declined.

### Numbers

| Measure                            | 1.0.0          | 1.1.0    |
| ---------------------------------- | -------------- | -------- |
| Entry JS (gzipped, 300 KB budget)  | 50.3 KB        | 48.7 KB  |
| Unit tests                         | 1,199          | 1,211    |
| Browser tests                      | 73             | 73       |
| CLI tests                          | 43             | 45       |
| End-to-end tests                   | 124            | 124      |
| `npm audit` findings               | 6              | 2        |
| Third-party a11y items open        | 1 (WCAG 2.1.2) | 0        |
| Offenders rows that focus the grid | 3 of 28        | 21 of 28 |

### Known limitations

Carried over from 1.0.0 unchanged, minus the data grid keyboard trap, which is
resolved. Still true: `external` rules are listed rather than executed; a
rules-only run leaves every column `VARCHAR`; column names are matched
case-sensitively; the Excel data sheet stops at 1,048,575 rows; the on-screen
grid paints at most 20,000 cell highlights; Chromium is the only browser with
automated coverage; and `xlsx` installs from `cdn.sheetjs.com` rather than the
npm registry.

## [1.0.0] — 2026-07-30

First stable release. Both halves are feature-complete against
[docs/BRIEF.md](docs/BRIEF.md) and covered by the full test matrix.

### Added — web app

- **Three-slot input model.** A dataset (required) plus a JSON Schema, a QC
  rules file, or both. Either check source alone is enough to run; every
  surface degrades gracefully when the other is absent.
- **Ingest** of CSV, TSV, JSON, Excel and Parquet, with format decided by magic
  bytes before extension, a sheet picker for multi-sheet workbooks, and size
  guardrails (warn at 100 MB, refuse above 500 MB).
- **JSON Schema validation** over a whole folder of schemas: `$ref` resolution,
  root detection with disambiguation, a generated data dictionary, per-column
  type casting, and cast-failure reporting.
- **QC rules** in a ten-column `.quac.csv`: `validate`, `correct` and
  `external` rule types across `row`, `column`, `dataset` and `longitudinal`
  scope; eight column assertions; SQL corrections and JavaScript corrections
  run in a QuickJS WebAssembly sandbox.
- **The QC report**: stat cards, four panels, and the dataset itself with every
  flagged cell coloured by severity — plus a five-sheet `.xlsx` download (Data,
  Missing Variables, Dataset Findings, Repeat Offenders, Run Info).
- **Rule Studio** — a per-rule editor with CodeMirror, SQL and JavaScript
  highlighting, live lint, a live data preview and **Test rule**, which
  executes a rule against the loaded data before it is part of a run.
- **Shareable links.** `data`, `schema`, `rules`, `index` and `config` URL
  parameters, a Share dialog, and a manifest escape hatch for long links.
  Opening a link never auto-runs QC.
- **Session persistence.** Inputs — never the report — are kept in this
  browser's IndexedDB so a reload does not cost the setup. Reset and Clear all
  inputs remove them; a restored session never runs itself.
- **Accessibility and motion.** Keyboard paths, focus management, live-region
  announcements, and `prefers-reduced-motion` honoured throughout QuaC's own
  UI. (See _Known limitations_ for the third-party grid.)

### Added — headless CLI

- **`quac <dataset>`** — the same pipeline under Node: ingest → schema
  validation → rules and corrections → the same five-sheet `.xlsx`.
- **Flags**: repeatable `--schema` and `--rules` (argument order is correction
  order), `--index`, `--sheet`, `--out`, `--no-corrections`, `--summary`,
  `--fail-on`, `--quiet`, `--version`, `--help`.
- **Exit codes as a contract** — 0 written, 1 usage, 2 input, 3 schema-set,
  4 run failure, 5 write failure, 6 `--fail-on` tripped (after the report is
  written), 130 interrupted.
- **`--summary`** writes a versioned machine-readable run record; `--summary -`
  sends it to stdout, which then carries nothing else.
- **`runQuac()`** as a library entry point, with hand-maintained types in
  `types/quac.d.ts`.
- Node ≥ 24 declared; 20–23 runs with a warning, below 20 refuses.

### Privacy

- **The web app makes no third-party request after load.** DuckDB's WebAssembly
  build and its parquet/icu/json extensions are vendored and served
  same-origin instead of autoloaded from `extensions.duckdb.org`, and the
  worker that executes rule SQL has its network removed at the platform level.
  An end-to-end test fails the build if a single off-origin request is made
  during a full run.
- The vendored extensions are **pinned by SHA-256**, verified on download and
  on every cache hit.
- **The CLI is an ordinary local process.** No telemetry, no uploads, no server
  side. Its only possible network activity is fetching `--schema` and `--rules`
  URLs the user passed it.

### Numbers at release

| Measure                          | Value                                      |
| -------------------------------- | ------------------------------------------ |
| Entry JS (gzipped)               | 50.3 KB, against a 300 KB budget           |
| 100,000 × 20 run, CI hardware    | 5,103 ms against a 60,000 ms gate          |
| — of which ingest / rules        | 1,867 ms / 3,062 ms                        |
| Peak JS heap on that run         | 45 MB                                      |
| Published package `dependencies` | 8                                          |
| Tests                            | 1,199 unit · 73 browser · 43 CLI · 124 e2e |

### Known limitations

- `external` rules are listed in the report but never executed.
- A rules-only run leaves every column `VARCHAR`; numeric conditions need
  `TRY_CAST`, or a JSON Schema. Affected rules are excluded by lint with a
  message naming the column.
- Column names are matched case-sensitively.
- The Excel report's Data sheet stops at 1,048,575 rows (Excel's own limit);
  every row is still validated.
- The on-screen grid paints at most 20,000 cell highlights; the Excel report
  is not limited by that figure.
- The data grid is a **keyboard trap** (WCAG 2.1.2) in its upstream library.
  QuaC adds a skip link and an Escape hatch but cannot fix it.
- Chromium is the only browser with automated coverage.
- `xlsx` installs from `cdn.sheetjs.com` rather than the npm registry, pinned
  and integrity-checked. Behind a registry mirror, that install step fails.

### Release process

From 1.0.1 onward, pushing a `v*` tag publishes to npm through
[`.github/workflows/release.yml`](.github/workflows/release.yml) using **OIDC
trusted publishing** — no token exists in the repository, and provenance is
attached automatically. The one setting a human owns lives on npmjs.com:
package `@jeyabbalas/quac` → Settings → Trusted Publisher → GitHub Actions, org
`jeyabbalas`, repo `quac`, workflow `release.yml`, no environment.

[1.2.0]: https://github.com/jeyabbalas/quac/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/jeyabbalas/quac/releases/tag/v1.1.0
[1.0.0]: https://github.com/jeyabbalas/quac/releases/tag/v1.0.0
