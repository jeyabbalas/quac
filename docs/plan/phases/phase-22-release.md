# P22 — Hardening, perf, docs, release

*(Renumbered from P20 in the 2026-07-30 plan amendment that inserted the headless phases P20–P21; content updated for the headless feature, the 17-journey reality, and P19b's storage amendment.)*

## Goal
Ship v1.0: error-path sweep, performance sanity at 100k rows, the real README with verifiable privacy claims (browser AND headless), changelog, final budget numbers, the npm publish decision executed, tag + Pages release.

## Depends on
All previous phases.

## Context files to read
`docs/plan/00-master-plan.md` (progress log — read ALL deviations) · `docs/plan/specs/testing-strategy.md` (§2, §5) · `docs/plan/specs/architecture.md` (§8, Verified facts) · `docs/plan/specs/headless.md` (§1, §5–§7, §9) · `docs/BRIEF.md` (final trace pass — note the two owner amendments recorded in the traceability table: P19b storage, P20–P21 headless) · `docs/plan/specs/qc-rules-format.md` (README's rules guide summarizes it).

## Tasks
1. Error-injection sweep (browser): corrupt files per format, wrong-shaped JSON, truncated parquet, bad URLs (404/CORS/timeout), oversize files, rules with every LintCode, schema with every `E_*` — each shows its designed message, never a blank screen or console-only failure. Fix gaps. CLI leg: the exits 1–6 are already automated (`tests/cli/exitCodes.test.ts`) — spot-check that the stderr copy reads well and matches `headless.md §6`.
2. Perf: `perf.smoke.spec.ts` — 100k×20 synthetic full run completes < 60 s CI-hardware, annotation cap engages cleanly, memory stays bounded (no crash); record numbers in the log. Mind V20's CSV-ingest ceiling (use the JSON route if the CSV route OOMs; file the follow-up either way). Spot-check HESP-width (265-col) 10k run, and record one headless 100k×20 wall-clock (`quac` on a generated file — record only, no gate).
3. `network-isolation` Playwright assertion: after app load, zero non-origin requests during a full local-file run (backs the README claim). Browser-scoped by design — the headless CLI is a local Node process (`headless.md §1`); say so in the README rather than test it here.
4. **README.md** (replaces the stub): what QuaC is + screenshots; privacy section with both legs — browser ("your data never leaves the browser; zero third-party requests after load; verify in DevTools"), **reworded for P19b truth** (inputs persist in THIS browser's IndexedDB until header Reset / Clear all inputs; the report is never stored; restore never auto-runs — do NOT claim "QuaC stores nothing"), plus the headless leg (`headless.md §1`'s paragraph); **the input contract (UIX-6): the dataset plus at least one of JSON Schema / QC rules — only the dataset is mandatory, either check source alone is enough and every surface degrades gracefully**; supported inputs (incl. Excel sheet choice); **"Use JSON Schema for schema validation rules"** guidance (per BRIEF) with the QC-rules file positioned for everything else; the `.quac.csv` format quick guide (link `docs/plan/specs/qc-rules-format.md` or a trimmed `docs/rules-format.md` copy); URL-parameter API with examples + CORS-friendly hosts; **Headless / CLI section** (npm and clone install paths, the `quac` synopsis, the exit-code table, `--summary` + `--fail-on` pipeline recipes, a `runQuac()` snippet, engines ≥ 24, the no-CORS note for headless URL fetches); local dev guide; limitations (external rules not executable, 1M-row Excel truncation, case-sensitive headers, **and rules-only sessions on CSV/TSV/Excel run against all-VARCHAR columns — no schema means no cast plan, so numeric comparisons need explicit casts (e.g. `TRY_CAST`) or they lint-fail the SQL dry-run and are excluded; the Preview's storage-type row shows the actual types — V23**, V20's CSV scale ceiling).
5. `CHANGELOG.md` (v1.0.0 — the web app AND the headless CLI/`runQuac` API); final bundle-size numbers recorded; version bump in package.json flows through `__QUAC_VERSION__` to the app, the `Run Info` sheet, `quac --version`, and the summary JSON's `quacVersion` at once.
6. Publish (`headless.md §9` posture): check npm name `quac` (fallback `@jeyabbalas/quac`; `bin` keeps the command name either way — update README if scoped); flip `"private"`; audit `npm pack` contents against the `files` whitelist (note the `xlsx` CDN-tarball dependency resolves for installers); publish; verify `npx quac` end-to-end on a clean environment (fresh profile, Node 24).
7. Debt sweep (obligations recorded in earlier phases' deferred notes — discharge them, do not rewrite history): delete the unused `store.shareables` + `ArtifactProvenance` (phase-16); fix or pin the `download.spec` VARCHAR-window lint-race flake (mechanism in phase-17/18 notes); add the deployed-site `/quac/duckdb/*` all-200 e2e assertion and consider the extensions download cache + hash pinning (phase-03); file the data-table keyboard-trap upstream issue and re-check `ui-design.md §9` (V22); revisit the TypeScript `~6.0.3` pin (phase-01).
8. Confirm all **nineteen** golden journeys green in CI (`testing-strategy.md §2` — 1–17 Playwright, 18–19 CLI tier); tag `v1.0.0`; verify the Pages deployment serves the tagged build; close out the master checklist.

## Deliverables
v1.0.0 tagged, deployed, documented, and published (or the scoped fallback executed and documented); CI matrix fully green.

## Out of scope
New features. File follow-up issues instead (list them in the progress log).

## Verification
- **Unit/CI:** full matrix green (all tiers incl. `test:cli`, all nineteen journeys, fixtures:check, bundle gate, axe).
- **UI/UX:** `perf.smoke.spec.ts` + `network-isolation` green; manual: walk the README top-to-bottom on the live Pages URL doing exactly what it says (fresh browser profile) — every instruction works verbatim, including the headless section on a clean Node 24 (`npx` or clone path).

## Deferred notes

The v1.1 seed list. Each entry is something P22 measured and consciously did not do, with enough
detail that the next agent does not have to re-derive it.

**Filed as follow-ups, with the evidence already gathered**

1. **The CSV route cannot reach the perf gate — at all, not marginally.** `perf.smoke.spec.ts` uses
   Parquet because V20's delimited ceiling is `rows × cols × rowJsonBytes ≈ 10⁹` and 100k × 20 is
   ~380× past it. The PapaParse → wrapped-JSON → `json_extract_string` route is the bottleneck, and
   it is the route most users' first file takes. A streaming CSV ingest (DuckDB's own `read_csv`
   over a registered file buffer, skipping the JSON hop entirely) is the obvious fix and would
   change the ceiling by orders of magnitude. Sized, not attempted: it rewrites the one path every
   other ingest format is defined against.
2. **`quoteIdentifier` is now duplicated between QuaC and `@jeyabbalas/data-table`.** P22 lifted it
   (`src/core/sql-identifier.ts`) so the CLI's `dependencies` could drop the grid, and
   `tests/unit/core/sql-identifier.test.ts` holds the two copies to character-for-character
   agreement. That test is the only thing keeping them honest; it will fail loudly rather than
   drift silently, but the real fix is upstream publishing the helper as a zero-dependency
   subpath export (`@jeyabbalas/data-table/sql`) that a Node program can import without the grid.
3. **`xlsx` installs from `cdn.sheetjs.com`, not the npm registry** (`headless.md §9`). Pinned and
   integrity-checked, so the exposure is availability and policy rather than substitution — but an
   air-gapped installer, a corporate registry mirror, or an allowlisting proxy fails the install
   with a fetch error. There is no fix that keeps the capability: the registry's copy stopped at
   0.18.5 and predates the API this code uses. The real decision, when it comes, is whether Excel
   input is worth a non-registry dependency, and that is a product call rather than a technical one.
4. **A GitHub Actions cache for `public/duckdb/extensions/`.** Phase-03 bundled this with the hash
   pinning; P22 answered them separately, because the pinning changes what executes and the cache is
   CI-only wall-clock on a step measured in seconds. The exact recipe is recorded in
   `scripts/copy-duckdb-assets.mjs`'s docstring, and it is now SAFE to add — a cache hit gets the
   same SHA-256 check a cold download does, and keying on the script's own hash invalidates the
   cache whenever `DUCKDB_CORE_VERSION` or the hash table changes.
5. **`jeyabbalas/data-table#84` — the keyboard trap (V22).** Filed with the 900-press evidence and
   the note that axe cannot detect a WCAG 2.1.2 violation. The diagnostic list was re-run at the
   pinned 0.5.1 and is unchanged. QuaC's mitigations (skip control, Escape hatch) stay until a fixed
   version ships; re-check `ui-design.md §9` on any upgrade.

**Known gaps in coverage, stated rather than implied**

6. **Exit codes 4 and 130 are not observed by any test.** 4 is "the run could not execute", which no
   fixture can provoke without breaking the engine on purpose; 130 is SIGINT, which needs a spawn
   the test interrupts mid-run. `tests/cli/exitCodes.test.ts`'s docstring says so explicitly rather
   than implying a closed set. What *is* pinned is the boundary between 4 and 5: the exit-5 case
   succeeds at the run and fails only at the write.
7. **Chromium is the only browser with automated coverage**, and there is no in-app support
   detection — an incapable browser fails with a generic error rather than a clear message. Both
   Playwright projects and the Vitest browser tier are Chromium. A WebKit/Firefox project is cheap
   to add and would probably find something; nobody has looked.
8. **The 265-column spot-check is opt-in** (`QUAC_PERF_WIDE=1`). It is typechecked and linted on
   every run but executed on demand, because width costs schema-translation time the 60 s gate is
   not about and the phase asked for the number, not a second gate.

**Small, real, and cheap**

9. **`APP_VERSION` renders nowhere in the DOM.** It reaches the Excel Run Info sheet and
   `quac --version` and nothing else, which is why P22's Pages check compares deployment SHAs rather
   than reading a version off the page. A footer version string would make "is the deployed site the
   tagged build?" answerable by looking at it.
10. **Zenodo's row in `CORS_HOSTS` is more conservative than today's measurement.** Re-verified
    2026-07-30: both `zenodo.org/api/records/<id>` and the file-content endpoint returned
    `Access-Control-Allow-Origin: *`, which is not what "file server unreliable — treat as blocked"
    claims. One probe is not grounds to flip a recommendation in a release commit, so the table was
    left alone and the README says what was measured. Worth a handful of probes over a few days
    before changing the verdict either way.
