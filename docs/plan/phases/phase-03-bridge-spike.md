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

**data-table library suggestions (for the author):**
- An attach-to-existing-table API (`createDataTable({bridge, tableName})` without `source`, V3) would eliminate the whole byte round trip.
- Auto-invalidate the query cache on DDL/DML through `query()` — every QuaC mutating helper must remember `clearQueryCache()` (V2); alternatively expose `cache: false` per query.
- Document `exportToBuffer(sql, 'parquet')` publicly (it is the linchpin of the refresh loop; `data-table-api.md §3` guessed `bridge.export()`), and consider `'csv'`/`'json'` formats.
- Make the loaders' per-load `SET TimeZone` optional or lazy: it forces the icu extension (a hidden CDN fetch for library users) and breaks under `lock_configuration`.
- Document that duckdb-wasm autoloads parquet/icu/json from `extensions.duckdb.org` at first use — a privacy/reliability footgun for any self-hosting consumer (QuaC vendors them; V11).

**For later QuaC phases:**
- P05: re-ingest of a new dataset works on the same worker (no config lock is used); no worker recreation needed.
- P12/P14: pass per-run caps (e.g. memory limit) as `hardenBridge(bridge, appSets)`; the annotate stage needs no access toggling — exportToBuffer/loadData work post-harden.
- P19/P20: add an e2e assertion that `/quac/duckdb/*` (wasm, quac-workers, extensions) all serve 200 from the deployed site; P20's network-isolation Playwright test should assert zero non-origin requests during a full QC run (the worker prelude makes any attempt fail locally — V6).
- P20: consider a GitHub Actions cache for `public/duckdb/extensions/` (the copy script downloads ~20 MB from extensions.duckdb.org on a cold run) and pinning extension file hashes for supply-chain integrity.
- Unify `joinBase` (duplicated in `src/app/urlBase.ts` and privately in `src/core/bridge/bridge.ts` because core must not import from app) into a shared non-app module, e.g. `src/lib/`.
