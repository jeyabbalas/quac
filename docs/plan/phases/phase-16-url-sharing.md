# P16 — URL configuration & sharing

## Goal
Hash-fragment pre-configuration works end-to-end: boot loading of `schema=`/`rules=`/`data=`/`index=`/`config=` params, partial configs, the ShareModal with provenance rules, and polished CORS failure UX.

## Depends on
P05, P06, P12 (slots exist); P14 recommended (full-journey test).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/url-params.md` (ALL — the contract) · `docs/plan/specs/json-schema-subsystem.md` (§A.4) · `docs/plan/specs/ui-design.md` (ShareModal).

## Tasks
1. `src/core/share/urlConfig.ts`: pure fragment grammar encode/decode (route + params split at first `?`; repeated keys via `getAll`, order preserved; unknown params preserved on re-encode; >2,000-char detection).
2. `configManifest.ts`: fetch/validate/emit the `{schema[], rules[], index?, data?}` manifest; precedence (config first, inline keys override wholesale, toast on override).
3. `fetchArtifact.ts` finalized: typed `FETCH_HTTP` vs `FETCH_CORS` (opaque TypeError), timeouts, retry hook; slot error card copy + "which hosts work?" popover with the verified host table.
4. Boot flow in `main.ts`: parse fragment → auto-load slots with progress → statuses land → Run primed, never auto-run; partial-config UX (highlighted empty Dataset slot: "Rules are pre-loaded. Add your dataset to run QC.").
5. `index=` consumption wired to P06's resolution function (matched id suppresses the modal; miss → modal + warning); manual modal resolution updates the fragment's `index=`.
6. ShareModal per `url-params.md §4`: per-artifact provenance ✓/✗ with the hosting explanation, assembled link + char count + Copy, >2000 → manifest download path. Enable the header Share button.
7. Local CORS fixture server for tests (serves the HESP schema tree + rules CSVs with ACAO:*; plus one endpoint WITHOUT CORS headers for the failure journey).

## Deliverables
Shareable pre-configured links; graceful CORS UX; Share button live.

## Out of scope
Any new slot/report behavior.

## Verification
- **Unit (node):** `tests/unit/share/urlConfig.test.ts` — encode/decode round-trip incl. repeated keys + order, route preservation, unknown-param preservation, precedence matrix, length detection. `configManifest.test.ts` — shape validation, override semantics.
- **UI/UX:** Playwright — `preconfig.spec.ts` (journey 2: `#/load?schema=…&rules=…&index=…` from the fixture server → slots auto-load → upload data → run); `shareLink.spec.ts` (journey 4: ambiguous-root fixture → modal pick → Share link contains `index=`; an uploaded rules file is excluded with the explanation); `corsFallback.spec.ts` (journey 6: non-CORS URL → typed message + hosts popover → manual upload succeeds).

## Deferred notes

- **`index=` was nearly free.** P06's `buildSchemaSet` already accepts `options.indexParam` and runs the full §A.4
  resolution atomically before publishing state (`schema-set.ts`). P16 only threads it through `loadSchemaUrls(urls,
  fetchJson?, indexParam?)`. Because signals are synchronous, resolving inside the loader means a matched index
  suppresses the IndexPickerModal with no flash — no boot-time race handling was needed.
- **Provenance is co-located, not centralized.** The reserved `store.shareables` signal (`ArtifactProvenance[]`) is
  **superseded** — the ShareModal computes its model on demand from the authoritative slot states via the pure
  `buildShareModel`, which avoids keeping a denormalized list in sync across three loaders. Added instead:
  `DatasetSession.sourceUrl`, `SchemaSlotState.sourceUrls` (the user-provided crawl bases), `RulesSlotState.sources`
  (aligned with `files`, maintained through same-name replace-in-place). `shareables` is left unused — **P20 should
  delete it** (and `ArtifactProvenance` if nothing else adopts it).
- **Address-bar `index=` sync is deliberately narrow.** An app-layer effect writes `index=` back only when the current
  fragment already carries `schema=` (a preconfigured session), so it never emits a bare `index=`-without-`schema=`
  URL that would break on reload. Manual card loads (no `schema=` in the bar) rely solely on the ShareModal's assembled
  link. This satisfies "manual modal resolution updates the fragment's index=" without continuous full-config syncing.
- **CORS test server is real, not mocked.** `tests/e2e/support/cors-server.mjs` is a second Playwright `webServer` on
  :4199; a different port from the app (:4173) makes every fetch genuinely cross-origin, so the journeys exercise real
  CORS *and* the real 14-file schema `$ref` crawl over HTTP (a single `schema=core.schema.json` URL crawls the tree).
  The `/no-cors/` prefix serves the same files with no ACAO for the opaque-failure path.
- **Unit-test location deviation.** New tests live under `tests/unit/core/share/` (beside the pre-existing
  `fetchArtifact.test.ts`) rather than the phase's stated `tests/unit/share/` — kept all share tests together. Trivial.
- **`fetchArtifact` retry hook is off by default.** Added `{ signal?, timeoutMs?, retries? }`; `retries` (default 0)
  re-attempts only the CORS-shaped opaque failure. The user-facing Retry is the Dataset card's button (re-runs the
  fetch), independent of this internal count. The 30 s `AbortController` timeout is the load-bearing addition (§3: never
  silently hang) and maps a timer-fired abort to `FETCH_HTTP` with a timeout message (distinct from `FETCH_CORS`).
- **Partial-config nudge is state-driven.** Shown whenever `preconfigured && Dataset empty && (schema||rules usable)`;
  copy adapts ("Rules are" / "A schema is" / "Rules and a schema are pre-loaded…"). Clears the moment a dataset loads.
