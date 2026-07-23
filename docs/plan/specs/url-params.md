# Spec: URL Parameters, Sharing, CORS

> Audience: P16 (URL config & sharing), P06 (`index=` consumption), P05/P12 (URL fields in slots).
> Depends on: `json-schema-subsystem.md §A.4` (the `indexFileId` contract), `architecture.md §8` (privacy).

## 1. Principles

- All configuration lives in the **hash fragment** — nothing after `#` is ever sent to any server (no server logs, no Referer leakage) and it survives reloads. This is the app's only persistence.
- Loading from params NEVER auto-runs QC (user consent to compute). Partial configs are first-class: a rules-only link leaves the Dataset slot highlighted: "Rules are pre-loaded. Add your dataset to run QC."
- Only URL-loaded artifacts are shareable; uploads cannot travel in a link (UX in §4).

## 2. Grammar

Route and config share the fragment:

```
https://jeyabbalas.github.io/quac/#/load?schema=<enc>&schema=<enc>&rules=<enc>&rules=<enc>&index=<enc>&data=<enc>
```

- Everything after the first `?` inside the fragment parses with `URLSearchParams`. Repeated `schema=`/`rules=` keys (`getAll`) preserve order — **order matters** (rules cross-file execution order; schema crawl bases).
- Values are `encodeURIComponent`-encoded **absolute `https:` URLs**.
- `index=<indexFileId>` — the disambiguated root schema; resolution order (exact `$id` → exact URL → relativePath → unique basename → modal + warning) per `json-schema-subsystem.md §A.4`. Written automatically once the user resolves the IndexPickerModal, so recipients never see the modal.
- `data=<url>` — allowed (a dataset already hosted at a URL leaks nothing new by being linked); listed plainly in the Share modal.
- **`config=<url>` escape hatch** for >2,000-char cases: JSON manifest `{ "schema": [...], "rules": [...], "index"?: "...", "data"?: "..." }`. Precedence: `config` loads first; any inline `schema`/`rules`/`index`/`data` params **override that key wholesale** (toast notes the override).
- Keep assembled links ≤ **2,000 chars** (portability); beyond that, push users to `config=`.

Boot flow (`main.ts`): parse fragment → slots auto-load with progress → statuses land → if complete, "Run QC" is primed but idle.

## 3. `share/` modules

- `urlConfig.ts` — pure encode/decode of the fragment grammar (round-trip tested; unknown params preserved on re-encode).
- `configManifest.ts` — fetch/parse/emit the manifest JSON (schema-validated shape; friendly errors).
- `fetchArtifact.ts` — CORS-aware fetch wrapper with typed failures:
  - HTTP error (status available) → `FETCH_HTTP` ("Server responded 404 for {url}").
  - Opaque `TypeError` (no status — the CORS signature) → `FETCH_CORS`.
  - Timeouts/aborts distinguished. Never silently hang; every failure leaves the slot's drop zone active as the fallback.

## 4. "Copy share link" UI (header Share button → ShareModal)

- Lists each loaded artifact with provenance: URL-loaded ⇒ included ✓; uploaded ⇒ excluded ✗ with inline explanation: "Uploaded files can't travel in a link. Host this file (GitHub raw / gist) and load it by URL to include it."
- Below: assembled link preview, char count, Copy button. If > 2,000 chars → offer "Download config manifest (JSON)" + instructions to host it and share `#/load?config=<url>`.
- If the root schema was user-resolved, the link includes `index=` (call this out in the modal: "recipients won't be asked to pick the index file").

## 5. CORS reality (verified live 2026-07-23; re-verify in P16 tests)

| Host | Cross-origin fetch |
|---|---|
| `raw.githubusercontent.com` | ✅ `Access-Control-Allow-Origin: *` |
| `gist.githubusercontent.com` | ✅ `*` |
| `cdn.jsdelivr.net` (incl. `/gh/…`) | ✅ `*` |
| `api.github.com` | ✅ `*` |
| OSF | ❌ ACAO limited to its own origin |
| Zenodo | ⚠️ API sends `*`, file server unreliable — treat as blocked |

Slot error card copy for `FETCH_CORS`: "Couldn't fetch **{host}**. The server may not permit browser access (CORS). Download the file yourself and upload it here." + Retry + a "which hosts work?" popover with the table above.

## 6. Privacy notes (copy requirements)

- README + Load view state: fetches happen only for URLs the user (or their link) explicitly provides; schema-ref auto-crawl fetches **schema files only, never data** (`json-schema-subsystem.md §A.2.6`); the fragment never reaches a server.
- The Share modal never includes anything the user uploaded — no silent uploads, ever.
