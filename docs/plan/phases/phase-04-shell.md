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
*(agent fills in)*
