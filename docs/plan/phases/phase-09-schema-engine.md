# P09 — Schema validation engine

## Goal
Full schema validation at scale: schema-driven casting into `quac_typed` (cast failures = flags), row shaping, Ajv2020 setup with the `#/items` pointer compile, the chunked/pipelined validation worker with abort + flag cap, and the SQL dataset-level checks.

## Depends on
P05 (ingest + quac_raw), P08 (translator + FlagStore).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/json-schema-subsystem.md` (§B, §C, §F, §H edge ledger 10–19) · `docs/plan/specs/architecture.md` (§4 tables, **Verified facts**) · `docs/plan/specs/testing-strategy.md` (mini-fixture manifest).

## Tasks
1. `src/core/schema/casting.ts`: target-type derivation from ColumnMeta (§C.1 table), `CastPlan` + SQL generation (TRY_CAST ladder), `CREATE TABLE quac_typed AS SELECT __row__, <casts> FROM quac_raw` (replacing P05's plain-copy stub); typed-input path (Parquet/JSON: passthrough when types already match); cast-failure scan → `schema:prop:<col>:cast` flags + the `castFailures` set; `clearQueryCache()` after CTAS.
2. `row-shaping.ts` per §C.3 (NULL→absent vs JSON null, missing/extra columns, BigInt→number + precision flags, NaN/Inf interception, mixed heuristic).
3. `ajv-engine.ts` per §B.1–§B.3: `buildAjv(draft)` exact config; register all files (retrievalUri keys); complete `E_META` collection (finish P06's stub if present); `getSchema(rootBase + '#/items')`.
4. `validation.worker.ts` + `worker-protocol.ts` + `validation-run.ts` per §F: init payload (files, digests, missingColumns, castFailures, flagCap 100k), 5,000-row batches fetched by `__row__` range predicate, single-slot pipelining, `batchDone` flags → FlagStore, progress events (throttled), abort, exact `countsByRuleId` past the cap.
5. Dataset-level SQL checks in `validation-run.ts`: `uniqueItems` (GROUP BY ALL over typed columns → duplicate row pairs), `minItems`, empty dataset; category/root `$comment` advisory flags (`schema:advisory:*`).
6. Wire into the store enough to run headless (a temporary dev button or console hook is fine — the real Run button is P14).

## Deliverables
End-to-end schema validation producing flags for the dirty fixtures, off the main thread, with progress + abort.

## Out of scope
Rules engine, orchestration UI, annotations display (P14).

## Verification
- **Unit (node + @duckdb/node-api):** `tests/unit/schema/ajv-setup.test.ts` — HESP set registers; pointer compile works; **unevaluatedProperties smoke** (extra property ⇒ exactly one error); draft-07 fixture routes to the draft-07 class; E_META list collected. `casting.test.ts` — derivation table; SQL snapshot; execution: `'abc'`→NULL+flag, `'42.0'`→42, `'42.5'`→non-integral flag, `''`→NULL, `'007'` stays `'007'` in a pattern column. `row-shaping.test.ts` per §C.3 table.
- **Browser:** `tests/browser/validation-worker.browser.test.ts` — `synthetic/mini` end-to-end: flags deep-equal `mini_expected_flags.json`; progress events monotone; abort mid-run returns partial summary; cap truncation keeps exact counts. Plus a 100k-row generated smoke (no crash, sensible time — record ms in the log).
- **UI/UX:** n/a beyond the dev hook; visual verification arrives in P14.

## Deferred notes

**Measured performance** (Chromium headless, M-series macOS, 2026-07-23): 100k×4 (mini schema) full run 268 ms wall,
worker validate 107 ms ≈ **935k rows/s at mini width**. HESP width (265 cols, 171 conditionals): full pipeline
(set build + digest + ingest + cast + validate + dataset checks) 509 ms for 101 rows — dominated by fixed costs
(Ajv compile of the 5,117-line root, digest build); per-row cost unresolvable at n=101, revisit at scale in P14/P20.

**Deviations & spec-silent resolutions** (all pinned by tests):
- **V19 (Verified facts)**: DuckDB TRY_CAST rounds decimal strings to BIGINT — §C.1's ladder replaced with an
  integrality-gated CASE. Browser + node pins guard engine bumps.
- **Abort at batch boundaries**, not §F's "checks between rows": the single-slot pipeline queues ≤1 batch, so worst-case
  latency ≈ one batch (~300 ms at the 5k default) — arch §6's "cancellable between chunks". setTimeout-yield rejected
  (nested-timeout 4 ms clamp ≈ 10–40 % dead time per batch); MessageChannel yield unnecessary at this latency.
- NaN/±Inf interception emits **cast-family** flags (`schema:prop:<col>:cast`, "<v> is not a finite number.") and a
  castKey, so the translator suppresses the follow-on `required` from the absent property (§C.3 named no ruleId).
- Cast-noun per storage type: BIGINT 'integer', DOUBLE 'number', BOOLEAN 'true/false value' (§C.2 listed integer only).
- Optional-declared missing columns: info flag "declared in the schema but not present in the dataset" (§E.3 gave only
  the required-column wording). Case-mismatch flags keyed to the **schema** column name; case-mismatched headers are
  excluded from `unexpected` (edge 11: one warning, not both).
- Advisory source = **document-root `$comment`** of each schema file → `schema:advisory:<fileId>` info, message
  "Schema note ({relativePath}): {text}"; emitted once per run regardless of data. HESP: core + income carry one each.
- Duplicate-pair messages use 0-based `__row__` values (pinned by the mini fixture: "Rows 8 and 9"); P15 may re-map to
  Excel rows (data row = `__row__` + 2) — decide there.
- **Extras keep native storage types** in `quac_typed` (spec §C.1 row said "VARCHAR passthrough" — written for
  all-VARCHAR delimited raw where they coincide); P11/P12 rules target extras through `data` with real types.
- Worker `ValidationSummary.countsByRuleId` covers worker-emitted flags only; cast/column/dataset flags are main-side
  (FlagStore aggregates stay exact for Sheet 4). Past worker truncation the FlagStore materialized set undercounts —
  read `summary.countsByRuleId` for exact worker totals (browser cap test pins this).
- JSON/parquet inputs with an explicit `""` in a VARCHAR column reach Ajv as present-empty-string (pattern failures are
  real findings); the delimited path already maps `''`→NULL at ingest (wrappedJson), so `required` semantics hold there.
  HESP dirty JSON contains zero `""` cells.
- Integral-but-overflowing strings (`'1e20'`) get the non-integral message (numeric-looking, BIGINT overflow) — accepted.
- Cast-failure scan materializes every failing (row, raw) pair and the complete castFailures key set (suppression
  correctness needs all keys); a degenerate all-dirty 1M-row dataset would build large arrays — P20 perf hardening
  candidate if it ever bites.
- Edge 16: HESP-safe (`if.required` guard). A *generic* `then.required` targeting a missing column surfaces as a
  conditional flag rather than being suppressed by the missing-column rule — P08 translator precedence, noted not changed.
- `quac_work`/`data` intentionally keep the plain ingest copy after a dev-hook run; P14's prepare stage re-CTASes them.
- vite `optimizeDeps.include` gained ajv/ajv-formats (late discovery mid-browser-test reloads Vite and flakes — same
  class as V8's data-table entry). Ajv import style: named + `.js` extensions (repo precedent), not §B.1's default-import.
- Production-build smoke (not committed): vite preview under `/quac/` + real Load-view uploads + the dev hook → worker
  chunk (160 KB raw, Ajv inside) loads, mini summary correct, zero page errors. Entry 19.9 KB gz.
