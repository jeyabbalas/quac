# P20 — Hardening, perf, docs, release

## Goal
Ship v1.0: error-path sweep, performance sanity at 100k rows, the real README with verifiable privacy claims, changelog, final budget numbers, tag + Pages release.

## Depends on
All previous phases.

## Context files to read
`docs/plan/00-master-plan.md` (progress log — read ALL deviations) · `docs/plan/specs/testing-strategy.md` (§2, §5) · `docs/plan/specs/architecture.md` (§8, Verified facts) · `docs/BRIEF.md` (final trace pass) · `docs/plan/specs/qc-rules-format.md` (README's rules guide summarizes it).

## Tasks
1. Error-injection sweep: corrupt files per format, wrong-shaped JSON, truncated parquet, bad URLs (404/CORS/timeout), oversize files, rules with every LintCode, schema with every `E_*` — each shows its designed message, never a blank screen or console-only failure. Fix gaps.
2. Perf: `perf.smoke.spec.ts` — 100k×20 synthetic full run completes < 60 s CI-hardware, annotation cap engages cleanly, memory stays bounded (no crash); record numbers in the log. Spot-check HESP-width (265-col) 10k run.
3. `network-isolation` Playwright assertion: after app load, zero non-origin requests during a full local-file run (backs the README claim).
4. **README.md** (replaces the stub): what QuaC is + screenshots; privacy section ("your data never leaves the browser — QuaC stores nothing; zero third-party requests after load; verify in DevTools"); supported inputs (incl. Excel sheet choice); **"Use JSON Schema for schema validation rules"** guidance (per BRIEF) with the QC-rules file positioned for everything else; the `.quac.csv` format quick guide (link `docs/plan/specs/qc-rules-format.md` or a trimmed `docs/rules-format.md` copy); URL-parameter API with examples + CORS-friendly hosts; local dev guide; limitations (external rules not executable, 1M-row Excel truncation, case-sensitive headers).
5. `CHANGELOG.md` (v1.0.0); final bundle-size numbers recorded; version in package.json + a `Run Info` sheet version constant.
6. Confirm all six+1 golden journeys green in CI; tag `v1.0.0`; verify the Pages deployment serves the tagged build; close out the master checklist.

## Deliverables
v1.0.0 tagged, deployed, documented; CI matrix fully green.

## Out of scope
New features. File follow-up issues instead (list them in the progress log).

## Verification
- **Unit/CI:** full matrix green (all tiers, all journeys, fixtures:check, bundle gate, axe).
- **UI/UX:** `perf.smoke.spec.ts` + `network-isolation` green; manual: walk the README top-to-bottom on the live Pages URL doing exactly what it says (fresh browser profile) — every instruction works verbatim.

## Deferred notes
*(agent fills in — the v1.1 seed list)*
