# P19 — Branding polish & accessibility

## Goal
Final duck-themed polish and a hard accessibility pass — without scope creep: favicon set, empty states, copy deck enforcement, keyboard/ARIA audit fixes, axe in CI, responsive stacking, data-table theme alignment.

## Depends on
P14, P16, P18 (all main surfaces exist).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/ui-design.md` (ALL — §6 copy deck and §7 checklist are the gates).

## Tasks
1. Favicon: hand-draw simplified flat `public/favicon.svg` (sky circle, yellow duck head, orange beak, black stroke, legible at 16px); committed script (`scripts/` + `sharp` devDep) generates `favicon-32.png` + `apple-touch-icon.png`; outputs committed; wire `<link>` tags.
2. DuckProgress everywhere long-running (ingest, run, export) with the exact three pun lines rotating; verify NO other puns exist outside the sanctioned spots (grep the copy).
3. Empty states for all three views (≤1 pun each per the deck); error copy sweep — errors are never jokes.
4. Keyboard audit: full app operable keyboard-only (dropzones, tabs, modals, grid focus hand-off, Studio editors); fix findings; visible focus ring everywhere.
5. ARIA: live regions for progress + toasts verified; labels on all slots/fields; modal semantics; severity pills have text equivalents (not color-only).
6. Contrast verification per the §7 pairing table (automated where possible; manual table in the log).
7. `prefers-reduced-motion` end-to-end; responsive stacking pass at <1024px (panels stack, nothing clipped).
8. Align data-table theme: map `--dt-annotation-*` + accent vars to tokens so grid tints match app severity colors exactly; `colorScheme:'light'` pinned.
9. Add axe to Playwright (`a11y.spec.ts`) and CI.

## Deliverables
Polished, accessible v1 UI; axe green in CI.

## Out of scope
New features; dark mode (documented as out of scope).

## Verification
- **Unit:** n/a (UI phase) beyond copy-grep test for pun containment (cheap and real: assert the 3 lines exist and no other file contains "quack"/"duck" puns outside the allowlist).
- **UI/UX:** Playwright `a11y.spec.ts` — axe: zero serious/critical on Load/Report/Studio + open IndexPicker/SheetPicker/Share modals; `reducedMotion.spec.ts` — DuckProgress renders as plain bar under emulation. Manual checklist from `ui-design.md §7` completed and pasted into the progress log (contrast table + keyboard-only journey).

## Deferred notes

**Deviations from this phase file**

1. **Playwright, not `sharp`, rasterises the favicons** (task 1). `sharp` is a native dependency that would have to be
   installed and cached in CI for two 32/180px PNGs that are committed anyway. Playwright is already a devDep, already
   browser-cached in CI, and renders the SVG through the same engine that paints the browser tab — so what gets
   committed is what Chrome shows. `scripts/generate-favicons.mjs`, `npm run favicons`, outputs committed, script not
   wired into `pre*` hooks or CI (same discipline as `scripts/record-ajv-errors.mjs`).
2. **`--dt-primary` / `--dt-accent` deliberately NOT remapped** (task 8 says "accent vars"). 96 usages in the library,
   several of them white-on-primary fills; brand hues there would *create* contrast failures (white on `--q-sky` is
   2.1:1). `--dt-annotation-*` and `--dt-font-family` are mapped, which is the part that changes what a user sees.
3. **One pinned e2e locator became more specific.** `runQc.spec`'s bare `getByText('Validating against the schema')`
   now reads `.q-run-progress .q-duckprogress-meta` — the new polite live region legitimately repeats that string, so
   the assertion was ambiguous, not wrong. The pinned **copy** is untouched.
4. **The favicon is placed artwork, not hand-drawn** (task 1) — decided after the phase merged, on the author's
   review of the shipped icon. "Hand-draw simplified flat" was written when `quac-duck.svg` was an embedded raster;
   `a44d234` had already replaced it with three vector paths, so the redrawing solved a problem that no longer
   existed and put a duck in the tab that was not the duck in the header. `generate-favicons.mjs` now generates
   `favicon.svg` too, placing the artwork by measured minimal enclosing circle. Rationale and constants:
   `ui-design.md §6`.

**Upstream to-do (third-party, from `a11y.spec.ts`'s non-gating diagnostic pass)**

Recorded in `ui-design.md §9`, which is the durable home — successors should read it there. In brief:
`@jeyabbalas/data-table` 0.5.1 is a **keyboard trap** (WCAG 2.1.2 Level A — Tab and Shift+Tab both stop moving once
focus reaches `.dt-root`; axe does not detect this, only a keyboard walk does), plus `aria-required-children`
(critical), `color-contrast` on `.dt-col-stats`/`.dt-hidden-chip-name`, and `scrollable-region-focusable` on
`.dt-body-scroll`. CodeMirror's `.cm-editor` is clean. QuaC mitigates the trap with a skip control and an Escape
hatch; it cannot cure it.

**Genuinely deferred (found, judged out of scope, not done)**

- **Studio rule-grid rows are focusable `<tr>`s with a bare Enter handler and no role.** Unlike the offenders row it
  breaks no axe rule (it never claimed `role="button"`), but a screen-reader user is told "row" and gets no hint that
  Enter opens the rule. Moving the action into a cell button as the offenders table now does would have to be
  reconciled with `focusGrid()`'s row-focus restore and the pinned `.q-rulegrid tbody tr` locators — a P17/P18
  contract area, not a P19 edit.
- **`.q-studio-gridbody` still overflows its own scroller by 62px at 560px wide.** 0px at 1600/1440/1366/1280/1024/
  768/720/640 after the targets-column cap. 560 is below both this phase's measurement set and the spec's
  desktop-first floor, the scroller handles it, and the page never scrolls horizontally; narrowing further starts
  truncating rule IDs.
- **`--q-gray-500` is at the AA floor on white (4.74).** Fine today, but any future surface tint under muted text
  drops it below 4.5 — that is exactly how `.q-filebtn-pertinence` (4.49 on `--q-yellow-tint`) got there. A ramp
  re-tint is a design decision, not a polish edit.
- **Dark mode** remains out of scope, as this phase's "Out of scope" says. P19 only ensured a dark-OS user is not
  served a half-dark app: `colorScheme: 'light'` is now pinned on both grids.
