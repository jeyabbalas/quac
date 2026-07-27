# Spec: URL Parameters, Sharing, CORS

> Audience: P16 (URL config & sharing), P06 (`index=` consumption), P05/P12 (URL fields in slots).
> Depends on: `json-schema-subsystem.md §A.4` (the `indexFileId` contract), `architecture.md §8` (privacy).

## 1. Principles

- All configuration lives in the **hash fragment** — nothing after `#` is ever sent to any server (no server logs, no Referer leakage) and it survives reloads. This is the app's only persistence.
- The fragment is **bidirectional** (UIX-10): it is not just read at boot but rewritten from the live session on every load, replace, upload-over and clear, so a reload always restores what is on screen. One writer owns this — `app/hashSync.ts` — and it computes the same live-provenance rule the Share modal does (`buildShareModel`), so the address bar and the Share link can never disagree.
- Loading from params NEVER auto-runs QC (user consent to compute). Partial configs are first-class: a rules-only link leaves the Dataset slot highlighted: "Rules are pre-loaded. Add your dataset to run QC."
- Only URL-loaded artifacts are shareable; uploads cannot travel in a link (UX in §4) — and an upload **over** a URL-loaded slot drops that slot's param, for the same reason.

## 2. Grammar

Route and config share the fragment:

```
https://jeyabbalas.github.io/quac/#/load?schema=<enc>&schema=<enc>&rules=<enc>&rules=<enc>&index=<enc>&data=<enc>
```

- Everything after the first `?` inside the fragment parses with `URLSearchParams`. Repeated `schema=`/`rules=` keys (`getAll`) preserve order — **order matters** (rules cross-file execution order; schema crawl bases).
- Values are `encodeURIComponent`-encoded **absolute `https:` URLs**.
- `index=<indexFileId>` — the disambiguated root schema; resolution order (exact `$id` → exact URL → relativePath → unique basename → modal + warning) per `json-schema-subsystem.md §A.4`. **Derived** from the live resolved root (`schemaState.set.root.indexFileId`), never copied forward from the current fragment, so it appears automatically once a root resolves (auto-detected or IndexPickerModal-chosen — recipients never see the modal) and a schema swap can never leave the previous set's index behind. Only emitted while `schema=` params remain.
- `data=<url>` — allowed (a dataset already hosted at a URL leaks nothing new by being linked); listed plainly in the Share modal.
- **`config=<url>` escape hatch** for >2,000-char cases: JSON manifest `{ "schema": [...], "rules": [...], "index"?: "...", "data"?: "..." }`. Precedence: `config` loads first; any inline `schema`/`rules`/`index`/`data` params **override that key wholesale** (toast notes the override).
- Keep assembled links ≤ **2,000 chars** (portability); beyond that, offer `config=` **as well as** the link, never instead of it (UX-07 — see §4). The limit is a portability caution, not a hard ceiling: a longer link is still assembled, still shown and still copyable, because "too long for some clients" beats "no link at all".
- The bundled example is held under the limit **at the deployed origin**, not merely at a localhost preview: `public/examples/index.json` lists the schema's **root only** as a crawl base, since every other file is `$ref`-reachable from it (`scripts/example-manifest.mjs`; pinned by `exampleLink.test.ts`). Listing all 14 cost 2062 chars at `https://jeyabbalas.github.io/quac/` while measuring 1965 at `http://localhost:4173/quac/` — over the line only in production, which is precisely where nobody was testing.

Boot flow (`main.ts`): parse fragment → slots auto-load with progress → statuses land → if complete, "Run QC" is primed but idle. `applyBootConfig` then **arms** the address-bar sync, and only then: the three legs load concurrently, so an effect armed at t0 would fire when the first one resolves and drop the params of the ones still in flight. Every exit path arms, including the empty-config and manifest-failure paths.

Writing back (UIX-10, `app/hashSync.ts` — the single writer):

- Every slot is rebuilt **wholly from the live stores**; nothing is copied forward from the current fragment except `passthrough` params, which are preserved verbatim. That is what makes a *replacement* (not just a clear) land in the bar.
- `config=` always drops on the first change — the manifest still names the artifact that just changed — with the remaining slots materialized inline.
- Writes go through `history.replaceState`: no history entry (Back is never "undo my last load") and no `hashchange`. Guarded by an equality check, so it is idempotent and cannot loop.
- The writer owns the **query, not the path**: the raw path travels through verbatim (an unknown route keeps rendering Load without being canonicalized, per the router's read-only contract), defaulting to `#/load` only when there is no fragment at all. A consequence: params ride the current route, so a run started from a URL-loaded session lands on `#/report?schema=…&data=…`.

## 3. `share/` modules

- `urlConfig.ts` — pure encode/decode of the fragment grammar (round-trip tested; unknown params preserved on re-encode).
- `configManifest.ts` — fetch/parse/emit the manifest JSON (schema-validated shape; friendly errors).
- `fetchArtifact.ts` — CORS-aware fetch wrapper with typed failures:
  - HTTP error (status available) → `FETCH_HTTP` ("Server responded 404 for {url}").
  - Opaque `TypeError` (no status — the CORS signature) → `FETCH_CORS`.
  - Timeouts/aborts distinguished. Never silently hang; every failure leaves the slot's drop zone active as the fallback.

## 4. "Copy share link" UI (header Share button → ShareModal)

- Lists each loaded artifact with provenance: URL-loaded ⇒ included ✓; uploaded ⇒ excluded ✗ with inline explanation: "Uploaded files can't travel in a link. Host this file (GitHub raw / gist) and load it by URL to include it."
- Below: assembled link preview, char count, Copy button — **unconditionally**, whatever the link measures. If > 2,000 chars → **additionally** offer "Download config manifest (JSON)" + instructions to host it and share `#/load?config=<url>`, under one line of advice (`.q-share-overlimit`, warning-tinted) that names the length and says the link still works in most places. Copy stays the modal's one primary; the manifest button is a plain `q-btn`. Reading "offer" as *replace* was UX-07: past the limit the modal rendered no input and no Copy, leaving `×` and a Download button as the only two controls.
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
