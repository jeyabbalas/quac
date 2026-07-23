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
*(agent fills in — e.g., measured rows/sec on HESP-width data)*
