# P13 — QuickJS sandbox & JS corrections

## Goal
`lang=js` correction rules run inside a lazy-loaded QuickJS-WASM sandbox with hard memory/time caps and zero ambient authority; the JS path plugs into the corrections pipeline (chunked fetch → sandbox → staged CTAS merge).

## Depends on
P12.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/qc-rules-format.md` (§6) · `docs/plan/specs/qc-rules-engine.md` (§1 JSSandbox, §3 js branch, §5 error policy) · `docs/plan/specs/architecture.md` (§8.3).

## Tasks
1. `src/core/rules/sandbox.ts` implementing `JSSandbox` over `quickjs-emscripten` (lazy `import()` — the chunk must load ONLY when a loaded rules file contains js rules):
   - `compileCheck(fnSource)` — syntax/arrow-shape check (must evaluate to a function).
   - `runCorrection(fnSource, batch, budget)` — fresh context per rule; `setMemoryLimit(~128MB)`, `setMaxStackSize`, interrupt handler with deadline (~2 s/chunk); marshal `{row, value, rowData}` in / `{row, value, changed}` out via JSON; `undefined` return ⇒ `changed:false`; dispose handles rigorously.
2. Engine integration: keyset-paginated fetch (5,000 rows by `__row__`), staged temp table `__qc_updates`, CTAS LEFT JOIN merge with `CAST(u.val AS <declared type>)`, swap + view refresh + `clearQueryCache`; per-row JS exceptions → up to 50 individual flags, rule broken past 1% chunk-failure rate.
3. Lint completion: js rules now get real `compileCheck` results (replacing P12's pending stub).
4. Bundle: verify the quickjs chunk is code-split and absent from the entry (extend `check-bundle-size.mjs` lazy-chunk allowlist).

## Deliverables
Working H006-style JS corrections; sandbox with proven kill-switches; lazy loading.

## Out of scope
JS *validation* rules (format allows only corrections in js — `update_language` applies to `update_expression` only); Studio JS editor niceties (P17).

## Verification
- **Unit (node — quickjs-emscripten runs in node):** `tests/unit/rules/sandbox.test.ts` (**T-JS-SANDBOX**) — H006 normalizes `'hh-42'`→`'HH00000042'` and leaves unrecognized formats unchanged (`undefined` path); `fetch`/`XMLHttpRequest`/`WebSocket` are `undefined` inside; `while(true)` killed within budget (rule → broken, run continues); allocation bomb hits the memory cap cleanly; `null` return writes SQL NULL.
- **Browser:** `tests/browser/jsSandbox.browser.test.ts` — same smoke in-browser; lazy-chunk assertion: loading a rules file WITHOUT js rules never requests the quickjs chunk; adding one triggers exactly one load.
- **UI/UX:** n/a beyond the slot's lint display updating for js rules.

## Deferred notes

Spec-silent / superseded calls made in P13 (successors trust these):

- **Merge shape supersedes engine-§3's per-pair sketch.** All pairs collect updates against the stable pre-rule `data` (phase A, read-only), captures/counts run pre-merge, then ONE all-targets `CREATE OR REPLACE TABLE quac_work AS jsMergeSelectSQL(parts)` (V14, `rebuildSelectSQL` symmetry). Rationale: §5's broken-rule "working table untouched" invariant is unsatisfiable with per-pair swaps (pair 2 failing would strand pair 1's merge), and this also preserves SQL corrections' single-pass read semantics for multi-target js rules. Un-castable staged values throw at the COUNT query — before any mutation.
- **`JSSandbox.runCorrection` result entries gain `error?: string`** (`JSCorrectionResult` in types.ts) — §1's interface has no per-row failure channel; fatal conditions (interrupt, OOM) reject the call instead.
- **In-guest OOM is catchable** (spike finding): QuickJS's out-of-memory InternalError can be caught by guest try/catch. The chunk driver rethrows `e instanceof InternalError` so the kill-switch stays fatal past the DRIVER's per-row catch; a guest fn's OWN try/catch can still observe its failed allocation and return normally — contained (the cap held; wasm heap bounded by setMemoryLimit; retry loops die at the interrupt deadline). Pinned in sandbox.test.ts.
- **Fresh runtime+context per `runCorrection`/`compileCheck` CALL** (= per chunk), a fortiori satisfying §6's fresh-context-per-rule; caps guest garbage per chunk. `compileCheck` runs under its own deadline (~1 s) because evaluating `(expr)` executes expression code (IIFE bombs).
- **Chunk fetch aliases**: engine-§3's `{t} AS value, (cond) AS hit` are collision-unsafe against real dataset columns named `value`/`hit`. Shipped shape injects only `__qc_hit__` (`__`-columns are ingestion-rejected) and reads the target's value from the `*` projection. Staging tables are regular (not TEMP) `__qc_updates_<i>` — TEMP scoping across possible bridge connections is unverified; DROP'd in `finally`, `CREATE OR REPLACE` self-heals strays.
- **Row-failure policy semantics** ("1%"/"50 flags" in §5): failure rate = failed rows / processed rows, evaluated at each chunk boundary; small datasets therefore break on a single failure (1 of 16 rows = 6% > 1%). Surviving rules emit ≤ 50 cell flags, severity `warning` (an execution problem, not a data judgement — rule-severity stays on correction flags), value = input value, then one column-scope overflow summary. Cumulative sandbox time per rule > `jsRuleTimeoutMs` (default 30 s) → broken.
- **EngineOptions knobs** `jsChunkTimeoutMs` (2000) / `jsRuleTimeoutMs` (30000) added for testability; chunk size stays the constant `JS_CHUNK_SIZE = 5000` (no knob).
- **Zero-update merge skip**: a js rule whose matches all return `undefined` (or only cast-normalization no-ops) performs NO CTAS — deliberate asymmetry vs SQL corrections (which always rebuild); idempotent re-runs leave the table physically untouched.
- **JSON marshaling edges**: BigInt→Number (precision accepted past 2^53), Date→ISO string on the way in; NaN/Infinity serialize to null; a fn returning a function/symbol surfaces as `value: undefined` → treated as unchanged. DuckDB exotic types (DECIMAL objects) pass through JSON.stringify as-is — quac_typed only carries BIGINT/DOUBLE/VARCHAR/BOOLEAN today.
- **Task 4's "extend the lazy-chunk allowlist" was a no-op**: check-bundle-size.mjs has no allowlist — lazy chunks are excluded by construction (never referenced from index.html). The quickjs packages are `optimizeDeps.exclude`'d (pre-bundling would break the `new URL(…, import.meta.url)` wasm resolution; excluded deps also can't late-discovery-reload mid-test).
- **Lint stage 5 is dataset-independent** and NOT gated by applicability (an inapplicable js rule with a broken fn still gets the compile error — small behavior change vs the P12 placeholder, which skipped inapplicable rules). No-sandbox pending message reworded to "JS compile check pending — no sandbox available." A js-error rule joins errorRows before stage 4, so its condition dry-run is skipped like any other error-broken rule. Declared CAST types are re-read (`DESCRIBE data`) inside each js rule — an earlier correction's CTAS can retype a column.
- **Sync eval blocks the main thread** up to ~2 s per chunk during runs (RELEASE_SYNC variant). Accepted for v1; P14's progress UI should expect coarse ticks during js rules (engine-in-worker is a P20-class consideration).
- **Names `__qc_hit__`/`__qc_updates_*` are engine-reserved**; datasets can't collide (ingestion rejects `__`-prefixed columns), but Studio docs (P17) should mention them as reserved anyway.
