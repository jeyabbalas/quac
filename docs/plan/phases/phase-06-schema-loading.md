# P06 — Schema loading & root detection

## Goal
The JSON Schema slot accepts single files, multi-file sets, folders, and URLs; classifies files, builds the `$ref` graph across all three ref styles, detects the root/index schema (modal on ambiguity), runs all validity pre-checks, and exposes the `indexFileId` share contract.

## Depends on
P02 (synthetic fixtures), P04 (shell, Modal).

## Context files to read
`docs/plan/00-master-plan.md` · `docs/plan/specs/json-schema-subsystem.md` (§A complete, §G fixtures, §H edge ledger items 1–9) · `docs/plan/specs/ingestion.md` (§3) · `docs/plan/specs/ui-design.md` (IndexPickerModal).

## Tasks
1. `src/core/schema/types.ts` (all §A interfaces) + `schema-set.ts` (intake, BOM strip, classification incl. manifest-hint capture, `$id`/draft extraction, `setId` fingerprint).
2. `ref-graph.ts`: deep ref scan, RFC 3986 resolution with the `quac-set:/` synthetic-base scheme, the 5-step match order incl. retrieval-base fallback and URL crawl (caps 64 files / depth 8; injected `fetchJson` so node tests stub it; never fetch `$id`-derived hosts), fragment pre-checks.
3. `root-detection.ts`: in-degree-0 candidates, `arrayOfObjects` shape heuristic, the four-way decision (`auto` / `auto-preferred` / `ambiguous` / `none`), manifest-hint ordering, post-selection checks (`E_ROOT_NOT_TABULAR`), and `indexFileId` computation + `index=` resolution order (§A.4).
4. Pre-check error collection (`E_*` table §A.5) — collect ALL, never stop at first; user-facing copy exactly per spec.
5. UI: Schema `SlotCard` (multi-file + `webkitdirectory` + URL list; details: file count, root name, ignored files, error list) and `IndexPickerModal` (candidate list with path/$id/title/shape badge; selection stores `indexFileId` and re-runs downstream).
6. Ajv meta-validation (`E_META`) may be stubbed to "parse-level only" if you defer Ajv setup to P09 — if so, mark it clearly in code + progress log (P09 completes it). Prefer wiring Ajv `validateSchema` now if time allows (Ajv runs in node; no worker needed here).

## Deliverables
`schema-set.ts`, `ref-graph.ts`, `root-detection.ts`, slot UI, IndexPickerModal; HESP folder loads clean with auto root.

## Out of scope
Row validation, casting, digests (P07/P09); `index=` URL parsing (P16 — but the resolution function ships now).

## Verification
- **Unit (node):** `tests/unit/schema/root-detection.test.ts` — single file auto; full HESP dir → auto `core/core.schema.json`; in-memory dual-root (HESP + synthetic bundle copy) → `ambiguous` with manifest-hint ordering; `cycle/` → `none`; `index=` resolution by $id / relpath / basename; non-array sole candidate warning. `tests/unit/schema/ref-graph.test.ts` — 3 HESP ref styles resolve; `no-ids/` via `quac-set:`; unresolved ref lists tried URIs; `E_DUP_ID`; bad fragment; `mixed/` manifest classified non-schema.
- **UI/UX:** Playwright `tests/e2e/schemaLoad.spec.ts` — drop the 14 HESP files (and separately the folder) → Valid badge "root: core.schema.json"; drop the two-roots fixture → IndexPickerModal appears, selection resolves the slot; malformed JSON shows the `E_PARSE` copy.

## Deferred notes

- **AppStore `slots.schema` not bridged.** Views receive no store context (`VIEW_MOUNTERS` pass only a container — P05
  touches that plumbing too). Schema slot state lives in `src/core/schema/schema-store.ts` (module-scoped signal);
  `bindSlotSignal(store.slots.schema)` is exported and unit-tested for P14's one-line wiring.
- **Component consolidation.** The slot card is self-contained (`q-schemaslot-*` classes, view-local `schemaSlot.css`)
  so P05 can claim the generic `SlotCard`/`DropZone`/`UrlField` names. Whoever merges second (or P19) should consolidate
  and fold the CSS into `components.css`. `loadView.ts` is the single shared-edit file (slot row + mount call).
- **E_META under mixed drafts:** one Ajv instance per set (root file's draft); files declaring a different known draft
  are skipped — their meta-schema is absent on that instance and `E_MIXED_DRAFT` already warns. Documented in
  `meta-validate.ts`.
- **URL-mode e2e deferred to P16** (needs the CORS fixture host table). The crawl/fetch path is fully unit-tested with
  a stubbed `fetchJson` (redirects, CORS vs HTTP copy, caps 64/8, never `$id` hosts, never `quac-set:`).
- **Crawl scope:** per edge-ledger 6 ("retrieval-URL relative only") absolute `$ref` URLs are never fetched, even in
  URL mode — only relative refs resolved against the retrieval base crawl.
- **Synthetic-drop e2e** uses the documented `dt.files` fallback (synthetic `DataTransfer` yields no
  `webkitGetAsEntry` entries); no `window.__quac` hook was needed.
- Warning/notice codes beyond the §A.5 table were added as `W_*`/`I_*` (`W_RETRIEVAL_FALLBACK`, `W_ROOT_NOT_ARRAY`,
  `W_INDEX_BASENAME`, `W_INDEX_NO_MATCH`, `I_AUTO_PREFERRED`, `I_NON_SCHEMA_IGNORED`) so every §A copy string has a
  typed carrier; severities in `SCHEMA_LOAD_SEVERITY`.
