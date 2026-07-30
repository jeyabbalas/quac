# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and QuaC adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

QuaC ships as two products from one repository, and they version together:

- **the web app**, deployed to <https://jeyabbalas.github.io/quac/>
- **the `quac` npm package**, a CLI and a `runQuac()` API

Entries below say which half they apply to.

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
package `quac` → Settings → Trusted Publisher → GitHub Actions, org
`jeyabbalas`, repo `quac`, workflow `release.yml`, no environment.

[1.0.0]: https://github.com/jeyabbalas/quac/releases/tag/v1.0.0
