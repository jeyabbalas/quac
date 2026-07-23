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
*(agent fills in)*
