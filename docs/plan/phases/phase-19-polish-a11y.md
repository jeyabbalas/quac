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
*(agent fills in)*
