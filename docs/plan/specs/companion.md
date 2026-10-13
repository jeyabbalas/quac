# Spec: Companion Channel

> Audience: anyone touching `core/share/companion.ts`, `app/companion.ts`, or the `companion=` link parameter.
> Depends on: `url-params.md` (§2 grammar — `companion=` is a passthrough the boot config ignores), `ingestion.md` §1 (consent to compute), `qc-report-spec.md` §7 (the findings without data), `architecture.md` §8 (privacy).

## 1. Purpose and privacy posture

A page served from the person's own machine — schemify's project website, for one — can keep a dataset checked as its JSON Schemas change, without the dataset ever leaving QuaC. The page opens QuaC with `#/load?companion=<its origin>`; the person loads their dataset in QuaC as always (the session persists it between visits) and presses **Allow**; from then on, every set of schema files the page sends is loaded into the schema slot and checked against that dataset, and the page receives **the findings without data** — the same document the Summary panel's export builds (`collectFindings`), nothing else of the run.

The promise is unchanged: the data stays in this browser. What crosses the window boundary is schema text (inbound) and findings, statuses and a hello (outbound); `findingsMessage` refuses any document that does not declare `containsData: false`.

## 2. Who may be a companion

`companionOrigin()` accepts an exact `http(s)://` origin — no path, query, fragment or credentials — on the loopback interface: `127.0.0.1`, `localhost`, `[::1]`, or a `*.localhost` name. Anything else is ignored: QuaC never reports to a page on another machine, so a link someone sends cannot make it report anywhere. Messages are accepted only when `event.origin` is that origin **and** `event.source` is `window.opener`; replies are posted only to `window.opener` with that origin as `targetOrigin`. A tab not opened by its companion says so and connects nothing.

## 3. Consent

Nothing is listened to or sent until the person presses **Allow** in the bar the module mounts above the views. That press is the person's standing consent to compute for this tab — the one exception to "never auto-runs" (`ingestion.md` §1, `url-params.md` §1) — and it lasts until **Disconnect**, the companion's `close`, or a reload (which asks again). **Not now** leaves QuaC exactly as it was.

## 4. Protocol (version 1)

Every message, both ways, is an object `{ protocol: 'quac-companion', version: 1, kind, … }`. Anything else is ignored silently (the window may carry other scripts' messages).

Companion → QuaC:

| kind | fields | effect |
|---|---|---|
| `schemas` | `id` (echoed on replies), `files: [{path, text}]` (paths relative to the schema folder, safe and unique, `.json`; ≤ 500 files, ≤ 20 M chars), `index?` (the root's path, one of `files`) | Load the files into the schema slot (`loadCompanionSchemas`: paths kept as given, so the setId is the companion's own fingerprint of its folder), then run when ready |
| `ping` | — | Reply `hello` (lets a reloaded companion re-attach to a tab that is still connected) |
| `close` | — | Disconnect; nothing more is sent |

QuaC → companion:

| kind | fields | when |
|---|---|---|
| `hello` | `quacVersion`, `datasetLoaded` | On Allow, and in answer to `ping` |
| `status` | `id`, `status` (`needs-dataset` · `running` · `busy` · `schemas-unusable` · `failed`), `detail?` | Whenever the request in hand changes state |
| `findings` | `id`, `findings` (`QcFindings`, `containsData: false`) | A run for the request finished |
| `closed` | — | Disconnect, or the tab is closing (`pagehide`) |

Only the newest `schemas` request counts. An older one still loading or waiting is dropped, and one whose run is in flight finishes without sending its findings, which would answer an old question.

The newest request's schemas are judged first, before any dataset is needed. A set QuaC cannot check against gets `schemas-unusable` at once. That holds even when the person's own QC rules would let a run start, because those findings would not be about the companion's schemas.

A usable request waits in two cases. With no dataset loaded, it waits (`needs-dataset`) and runs as soon as one is in. During a run, the person's own or one for an older request, it waits (`busy`) and runs when that run ends. If the schema slot no longer holds the companion's set when its turn comes (the person loaded another, or reset), the request has `failed`.

A run the person starts themselves is not reported — only runs of the companion's requests are.

## 5. Loading

`app/companion.ts` is imported only when the fragment carries `companion=` (`main.ts`), so the entry chunk is unaffected; it waits for the boot config (`applyBootConfig`) before handling a request, so a restored session's dataset is in place first. The `companion=` parameter is a passthrough to the boot config — the stored session restores as with an empty link.

## 6. Tests

`tests/unit/core/share/companion.test.ts` pins the origin rule (loopback only, exact origins, look-alike hosts refused), request validation (unsafe or duplicate paths, size limits, a root outside the set), the message envelope, and the `containsData` refusal.

`tests/e2e/companion.spec.ts` drives the wiring end to end, with a companion page of its own on a loopback origin. It covers:

- consent before anything is heard;
- the findings without data for each request, with none of the dataset's values, and the re-check on new schemas;
- the handover from a run in flight to the newest request;
- `schemas-unusable` before any dataset is in, and when the person's own rules could run alone;
- the opener and origin checks, **Not now**, **Disconnect**, and `closed` when the tab closes.
