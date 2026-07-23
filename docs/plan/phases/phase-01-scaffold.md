# P01 — Scaffold, CI, deployed shell

## Goal
Stand up the Vite + vanilla-TS project with strict tooling, all three test harnesses, CI with GitHub Pages deploy, and a placeholder app shell live at `https://jeyabbalas.github.io/quac/`.

## Depends on
Nothing (first phase; repo currently has no package.json/src).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/architecture.md` (§1, §2 tree, §10) · `docs/plan/specs/testing-strategy.md` (§1, §4) · `docs/plan/specs/ui-design.md` (§2 tokens only, for the placeholder header).

## Tasks
1. `npm init`; add deps: `@jeyabbalas/data-table` (+ its peer `@duckdb/duckdb-wasm` at the version data-table's package.json requests), and devDeps: `typescript`, `vite`, `vitest`, `@vitest/browser-playwright`, `@playwright/test`, `eslint` (flat) + `typescript-eslint` + `prettier`, `@duckdb/node-api`. (Other libs arrive in the phases that use them.)
2. `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, bundler resolution.
3. `vite.config.ts`: `base: '/quac/'`, `optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] }`.
4. Minimal shell: `index.html` + `src/main.ts` + `src/app/shell.ts` — header (logo + "QuaC" + privacy line, sky background per tokens) and an empty main region. Copy `assets/logo/*.svg` into `public/logo/`. Placeholder `public/favicon.svg` (simple yellow circle is fine; real favicon in P19).
5. `src/styles/tokens.css` with the §2 brand/semantic custom properties (values from `ui-design.md`); `base.css` reset.
6. Scripts: `dev`, `build`, `preview`, `test` (vitest node), `test:browser`, `test:e2e`, `typecheck`, `lint`, `format`, `verify` (= typecheck+lint+test), `fixtures` + `fixtures:check` (stubs that no-op until P02).
7. `scripts/check-bundle-size.mjs` — fail if entry JS gz > 300 KB (read from `dist/`; exempt wasm + lazy chunks).
8. One node unit test (`tests/unit/app/urlBase.test.ts` — asserts `import.meta.env.BASE_URL`-derived asset helper), one Playwright smoke (`tests/e2e/smoke.spec.ts` — page loads under `/quac/` base via `vite preview`, header text + logo visible, title "QuaC").
9. `.github/workflows/ci.yml` per `testing-strategy.md §4` (PR gates; main additionally deploys Pages). Enable Pages via workflow (`actions/configure-pages@v5`).
10. Root `.gitignore` additions (node_modules, dist, playwright artifacts); `README.md` stub ("QuaC — under construction", link to BRIEF; full README in P20).

## Deliverables
Building, linting, tested, deployed placeholder app; CI green on PR and main; bundle-size gate wired.

## Out of scope
DuckDB usage, any real view, fixtures, router/signals (P04).

## Verification
- **Unit:** `urlBase.test.ts` passes; `npm run verify` green.
- **UI/UX:** `smoke.spec.ts` passes against `vite preview`; after merge to main, the Pages URL serves the shell (manual check, note the URL in the progress log); favicon + logo load (no 404s under `/quac/`).

## Deferred notes
- TypeScript pinned `~6.0.3`: typescript-eslint 8.65 requires TS `<6.1.0`; TS 7 (native port) unsupported by the lint toolchain. Revisit at P20.
- `@fontsource` Inter/JetBrains Mono not installed; tokens carry the family names with system-stack fallbacks. P04 (real shell) should add the self-hosted fonts per `ui-design.md §2`.
- Shell styles live in `base.css` for now; migrate to `components.css` when P04 builds the real shell. Gray-ramp values (`--q-gray-50..900`) were chosen in P01 — spec named only the ramp.
- `tests/browser/env.browser.test.ts` is a harness-proof placeholder (window/WASM/Worker); P03's bridge tests supersede it as the meat of the browser tier.
- No `tests/**` lint relaxation was needed; strict-type-checked passes as written. If a later phase hits a test-only rule, add a scoped override and note it.
- npm 11 auto-installs data-table's CodeMirror peers into the lockfile; unused until P05/P17, zero bundle impact (nothing imports them).
