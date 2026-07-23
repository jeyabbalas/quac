# P04 — App shell, router, signals, design tokens

## Goal
Turn the placeholder into a navigable app frame: hash router with three views, the signals/store layer, the full token palette, and the shared UI primitives (modal, toast, DuckProgress, badges, empty states).

## Depends on
P01.

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/ui-design.md` (§2–§5, §6 DuckProgress, §7) · `docs/plan/specs/architecture.md` (§2 tree, §7 state/errors).

## Tasks
1. `src/app/signals.ts` (~60 LOC): `signal<T>()` → `{get,set,subscribe}`, `computed()`, `effect()`; no deps.
2. `src/app/router.ts`: hash routes `#/load` (default) | `#/report` | `#/studio`; must coexist with config params in the fragment (`#/load?schema=…` — split route from query at the first `?`; leave param handling to P16, but don't clobber unknown params on navigation).
3. `src/app/store.ts`: AppState per `architecture.md §7` (slots, pipeline, run, shareables) — state only, no behavior yet.
4. `src/app/errors.ts`: `QuacError` with the closed code set + `reportError()` → toast + optional slot state.
5. `src/app/shell.ts`: header (logo, wordmark, subtitle, Share button [disabled stub], GitHub link), NavTabs (Report tab supports a count pill), main region swapping three placeholder views, footer privacy line.
6. `src/styles/`: finalize `tokens.css` (full §2 palette incl. `--dt-annotation-*` mapping), `base.css` (reset + typography via self-hosted `@fontsource` Inter + JetBrains Mono), `components.css`.
7. Components: `Modal` (focus trap, Esc, ARIA), `Toast` (aria-live), `Badge`, `SeverityPill`, `EmptyState`, `DuckProgress` (duck bobbing along a wave; determinate + indeterminate; `prefers-reduced-motion` ⇒ plain bar; exposes `setProgress(stageLabel, pct)`).
8. Tests: `tests/unit/app/{signals,router,errors}.test.ts`; Playwright `tests/e2e/nav.spec.ts` (tab switching updates hash + view; deep-link `#/studio` lands on Studio; focus moves sanely; Esc closes a demo modal).

## Deliverables
Navigable three-view frame with the design system in place; all primitives reusable by later phases.

## Out of scope
Slot cards and any data behavior (P05+); Share behavior (P16).

## Verification
- **Unit:** signals (subscribe/computed/effect semantics incl. unsubscribe), router (parse/format, param preservation), errors mapping.
- **UI/UX:** `nav.spec.ts` green; manual checklist — header contrast (black on sky), focus ring visible on tabs/buttons, DuckProgress animates and respects reduced motion (toggle via emulation), no layout jank at 1024px.

## Deferred notes

- **Privacy line placement**: phase task says footer (implemented, sole instance); ui-design §3 also
  sketches a slim line under the header on Load. P05 (slot UI) or P19 reconcile — keep the sentence
  single-instance in the DOM: smoke.spec + nav.spec locate it with strict-mode `getByText`.
- **`--dt-annotation-*` on `body`, not `:root`**: data-table's dist CSS declares its own `:root`
  defaults, so a QuaC `:root` block would win or lose purely on stylesheet import order; inheritance
  from `body` is order-proof. P05: confirm against a mounted grid, then add a Verified-facts row.
  The lib's `-bg-hover` variants derive from `-bg`/`-bdr` via color-mix — no override needed.
- **Token prefix is `--q-*`** (established P01, concrete in ui-design §2); architecture §1's `--quac-*`
  parenthetical is stale.
- **Router never rewrites the address bar** on unknown/empty routes (listener is read-only; loop-proof).
  P16 may canonicalize the fragment once it owns params. Middle-clicking a nav tab follows the bare
  `href="#/route"` and drops params; intercepted left-clicks/Enter preserve them byte-for-byte.
- **signals**: `computed()` has no dispose (app-lifetime by design); `effect()` returns one. No
  batching — a diamond graph may re-run an effect once per intermediate update; fine at app scale.
- **`createCancelToken()`** lives in `store.ts` only to construct initial pipeline state; P14 may
  relocate it to `core/pipeline.ts`.
- **Focus stays on the clicked tab** on view switch (nav.spec pins this); P19's keyboard audit may
  prefer focusing the view heading or adding a skip link.
- **Toasts**: click-to-dismiss + auto-expire only; P19 may add an explicit dismiss button. Modal
  supports one instance at a time (documented contract; no spec'd use needs stacking through P18).
- **`window.__quac.openDemoModal()`**: tiny always-on hook that drives nav.spec's focus-trap/Esc and
  reduced-motion coverage (both DuckProgress modes live in it). Gate or remove if it grows.
- **`[hidden] { display: none !important }`** added to the base.css reset — component display rules
  (e.g. `.q-pill`'s inline-flex) silently defeat the attribute otherwise.
- **Disabled buttons use solid gray fills**, not opacity: translucent yellow over the sky header
  blends to green.
