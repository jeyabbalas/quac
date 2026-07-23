# P03 — Bridge module & round-trip verification (CRITICAL PATH)

## Goal
Build the shared-DuckDB layer (singleton `WorkerBridge`, hardening, table helpers, self-hosted WASM) and convert every ⏳ unknown in `architecture.md → Verified facts` (V5–V8) into a passing browser regression test with a recorded verdict.

## Depends on
P01.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/architecture.md` (§4, §8, §9, §10 — you will EDIT §10) · `docs/plan/specs/data-table-api.md` (§3, §7, §8).

## Tasks
1. `src/core/bridge/bridge.ts`: `getBridge()` lazy singleton — `new WorkerBridge(bridgeOptions)`, `initialize()` once; `terminateBridge()` for teardown/tests.
2. `scripts/copy-duckdb-assets.mjs`: copy mvp/eh bundles from `node_modules/@duckdb/duckdb-wasm/dist/` to `public/duckdb/` at build (wire into `build`/`dev`); `bridgeOptions` URLs built from `import.meta.env.BASE_URL` (V8: record exact filenames + wiring).
3. `src/core/bridge/harden.ts`: `hardenBridge()` issuing app SETs → `SET enable_external_access=false` → `SET lock_configuration=true`.
4. `src/core/bridge/tables.ts`: name constants (`quac_raw`, `quac_typed`, `quac_work`, view `data`, `quac_display`, `quac_studio_display`), helpers `ctas()`, `swapWorkTable()`, `refreshDataView()`, `copyToParquetBytes()` — each mutating helper ends with `bridge.clearQueryCache()`.
5. Browser-tier tests (these ARE the spike; they stay as regressions):
   - `bridge.browser.test.ts` — V1/V2: CREATE TABLE/INSERT/UPDATE via `query()`; prove the stale-cache behavior (same SELECT string before/after UPDATE) and that `clearQueryCache()` fixes it.
   - `roundtrip.browser.test.ts` — V5/V7: create a small table with `__row__`; `COPY (SELECT * EXCLUDE (__row__) FROM t ORDER BY __row__) TO 'x.parquet'`; retrieve bytes (try `bridge.export()`; else registered-buffer approaches); `createDataTable({container, source: bytes, bridge})`; assert grid row order matches and `__rowid__ === __row__` (add a cell annotation at rowId k, verify it lands on the right row). If NO byte path works: implement + test the documented JSON-serialization fallback and record it.
   - `harden.browser.test.ts` — V6: after `hardenBridge()`, `read_csv('https://…')` fails; `SET enable_external_access=true` fails (locked); registered file buffers still readable; a subsequent `loadData()` still works. If ordering constraints emerge, record the working sequencing.
6. **Update `specs/architecture.md → Verified facts`** rows V5–V8 with verdicts, dates, and test names. If any spike fails, also update §9 (activate the fallback) — do not leave the spec contradicting reality.

## Deliverables
`core/bridge/*` modules; self-host WASM build step; three browser test files; Verified facts completed.

## Out of scope
Ingestion formats (P05), any UI.

## Verification
- **Unit/Browser:** the three `*.browser.test.ts` files green in CI's browser tier.
- **UI/UX:** n/a (headless). Confirm `vite build && vite preview` serves duckdb assets under `/quac/duckdb/` (note in log).

## Deferred notes
*(agent fills in — especially any data-table library change that would simplify this, for the author to consider)*
