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
*(agent fills in)*
