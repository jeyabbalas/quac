# P21 — Headless CLI & packaging

## Goal
A pipeline user can run `quac <dataset> --schema … --rules …` (or call `runQuac()` from their own Node script) and get the styled five-sheet QC report, a machine-readable summary, deterministic exit codes, and CI gating via `--fail-on` — built with the repo's own Vite, black-box-tested against the built binary, and publish-ready (the publish itself is P22's).

## Depends on
P20.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/headless.md` (§1, §4–§10 — the contract, follow verbatim) · `docs/plan/specs/ingestion.md` (§2 formats, §5 guardrails) · `docs/plan/specs/json-schema-subsystem.md` (§A.4 `index=` resolution) · `docs/plan/specs/testing-strategy.md` (§2 journeys 18–19, §3.2, §4).

## Tasks
1. `src/cli/args.ts` — the `headless.md §5` grammar over `node:util` parseArgs: positional dataset; repeatable `--schema`/`--rules`; `--index`, `--sheet`, `--out`, `--no-corrections`, `--summary <path|->`, `--fail-on <error|warning|none>` (default `none`), `--quiet`, `--version`, `--help`. Refusals per §5/§6 with the exact copy notes (the `runReadiness` `'no-checks'` echo; the single-kind `--schema` rule).
2. `src/headless/intake.ts` — §8 intake: dataset bytes + sniff + guardrails; multi-sheet/unknown `--sheet` → exit-2 error listing `sheetNames`; schema dir/file/URL → `IntakeEntry[]` → `buildSchemaSet` (`indexParam` from `--index`; ambiguity → exit-3 error listing candidates); rules files/URLs in arg order. (P20's `run.ts` consumes this; if P20 landed a minimal internal intake, this task finishes and exports it.)
3. `src/headless/index.ts` — the public library export: `runQuac`, option/result/error types. `src/cli/quac.ts` — `main()`: args → `runQuac` → `--summary` write (`-` = stdout) → `--fail-on` gate → §6 exit mapping incl. 130 on SIGINT (wire an `AbortController`); the only `process.exit` site; Node-floor guard (refuse <20, warn <24).
4. `src/cli/summary.ts` — §7 assembly (Maps via `Object.fromEntries`; `summarySchemaVersion: 1`). `src/cli/progress.ts` — §5 stderr/TTY rules, the final `report written → <path>` + counts line, warning surfaces (lint exclusions with the UIX-16 plain-language diagnosis, broken rules, missing variables, pertinence, `W_INDEX_BASENAME`).
5. `vite.cli.config.ts` + scripts per §9: `build:cli` (SSR build, two entries → `dist-cli/{quac.mjs,index.mjs}`, node22 target, ESM, deps external, `__QUAC_VERSION__` define, shebang banner on the bin entry — NOT esbuild; Vite 8 ships rolldown and the SSR path is spike-proven); `cli` = `npm run build:cli --silent && node dist-cli/quac.mjs`; `test:cli` = `vitest run --project cli` with `pretest:cli` = `npm run build:cli`. Add the `cli` vitest project (`tests/cli/**/*.test.ts`, node env) to `vite.config.ts`; add `dist-cli/` to `.gitignore`.
6. `package.json` per §9: `bin`, `exports` (with `types/quac.d.ts` — hand-written, committed), `files`, `prepack`; move `@duckdb/node-api` devDependencies → dependencies; keep `"private": true` and version `0.0.0` (P22 flips/publishes).
7. Tests: `tests/unit/cli/args.test.ts` + `tests/unit/cli/summary.test.ts` (unit project — no build needed); `tests/cli/run.test.ts` (golden journey 18) + `tests/cli/exitCodes.test.ts` (journey 19) black-boxing `node dist-cli/quac.mjs` on the committed fixtures, exceljs re-reads, an in-test `node:http` fixture server for the URL-intake cases, and one `npm pack` → install-from-tarball → run smoke.
8. CI (`.github/workflows/ci.yml`): insert `- run: npm run test:cli` after the `fixtures:check` step (its pre-script builds `dist-cli/`; no browsers, no duckdb-asset copying). The bundle gate and Pages artifact are untouched (`dist-cli/` is disjoint from `dist/`).
9. README stub: add a short **Headless / CLI** section above the existing links — one invocation example, the §6 exit-code table, the engines note, "arg order = correction order", and a pointer to `docs/plan/specs/headless.md`. The full README rewrite stays P22's.

## Deliverables
`quac` binary + `runQuac` library export building to `dist-cli/`, journeys 18–19 green in CI, publish-ready package metadata; web app, browser tier, and e2e suite unchanged.

## Out of scope
`npm publish`, version bump, changelog, full README (P22); any browser-app change; `--strict` lint gating, count-based `--fail-on`, xlsx-to-stdout, corrected-data file export (v1.1 candidates — list in Deferred notes if demand appears).

## Verification
- **Unit (node):** `args.test.ts` (every flag + every refusal), `summary.test.ts` (field-by-field vs `headless.md §7`); CLI tier: `run.test.ts` — journey 18 (exit 0, stdout-is-summary-JSON, five sheets re-read with a seeded review text + corrected marker, summary↔workbook count parity, pack-install smoke), `exitCodes.test.ts` — journey 19 (each code 1–6 observed on fixtures, incl. `two_sheets.xlsx` sheet listing, `two-roots/` candidates listing then `--index` success, `--fail-on error` → 6 with the report still on disk).
- **UI/UX:** n/a (no browser surface — journeys 18–19 live in the CLI tier). `npm run build && npm run size` — entry KB gz unchanged; `npm run test:e2e` untouched and green.

## Deferred notes
*(agent fills in)*
