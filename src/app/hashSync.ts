/**
 * The address bar as a pure function of the live session (UIX-10, url-params.md
 * §1/§2). The fragment is the app's ONLY persistence, so "URLs reload
 * themselves" has to hold in both directions: a load, a replacement, an
 * upload-over and a clear must each leave a fragment that restores what is on
 * screen. This module is the single writer that makes that true — the same
 * live-provenance rule the Share modal computes (`buildShareModel`), so the two
 * surfaces cannot disagree.
 *
 * Never a history entry: every write goes through `history.replaceState`, so
 * Back never becomes "undo my last load" and no `hashchange` fires.
 *
 * Entry-chunk discipline (clearInputs.ts's rule): stores, signals-adjacent app
 * modules and the pure share codec only — all already entry-resident.
 */
import { DEFAULT_ROUTE, formatHash, parseHash, readRawHash } from './router';
import { effect } from './signals';
import { rulesState } from '../core/rules/rules-store';
import { schemaState } from '../core/schema/schema-store';
import { decodeConfig, encodeConfig } from '../core/share/urlConfig';
import type { AppStore } from './store';
import type { UrlConfig } from '../core/share/urlConfig';

/** The provenance of what is loaded RIGHT NOW — uploads contribute nothing. */
export interface LiveSources {
  /** `schemaState.sourceUrls` — `[]` for uploads. */
  schemaUrls: readonly string[];
  /** Non-null `rulesState.sources` — uploads contribute nothing. */
  rulesUrls: readonly string[];
  /** `dataset.sourceUrl` — null for uploads / no dataset. */
  dataUrl: string | null;
  /** `set.root.indexFileId` — the §A.4 share id, undefined until one resolves. */
  schemaIndexId: string | undefined;
}

/**
 * Pure: rebuild the share config from the LIVE stores.
 *
 * Every slot is rebuilt wholly from `live` — nothing is copied forward from the
 * current fragment, which is what makes a replacement (and not just a clear)
 * land in the bar. `current` is consulted for exactly one thing: `passthrough`
 * params, which are contractually preserved verbatim. `config=` always drops
 * (the manifest still names the artifact that just changed) with the remaining
 * slots materialized inline. `index=` is derived from the live root rather than
 * copied, so a schema swap can never leave the previous set's index behind; it
 * only means something while `schema=` params remain.
 */
export function buildSyncedConfig(current: UrlConfig, live: LiveSources): UrlConfig {
  const next: UrlConfig = {
    schema: [...live.schemaUrls],
    rules: [...live.rulesUrls],
    passthrough: current.passthrough,
  };
  if (next.schema.length > 0 && live.schemaIndexId !== undefined) next.index = live.schemaIndexId;
  if (live.dataUrl !== null) next.data = live.dataUrl;
  return next;
}

/** Snapshot the three provenance signals. Reads all of them UNCONDITIONALLY —
 *  `effect` re-tracks dependencies each run and unlinks branches it did not
 *  read, so an early return here would silently deafen the sync. */
export function readLiveSources(store: AppStore): LiveSources {
  const schema = schemaState.get();
  const rules = rulesState.get();
  const dataset = store.dataset.get();
  return {
    schemaUrls: schema.sourceUrls,
    rulesUrls: rules.sources.filter((s): s is string => s !== null),
    dataUrl: dataset?.sourceUrl ?? null,
    schemaIndexId: schema.set?.root.indexFileId,
  };
}

/**
 * The path this sync writes back. It owns the QUERY, never the path, so the
 * raw path travels through verbatim — an unknown route must keep rendering
 * Load WITHOUT being silently canonicalized (router.ts's read-only contract,
 * pinned by nav.spec). A URL with no fragment at all gets the default route,
 * which is what makes a first-run session gain `#/load?…` on its first load.
 */
function currentPath(raw: string): string {
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  return path === '' || path === '#' ? formatHash(DEFAULT_ROUTE, '') : path;
}

/** Rewrite the address bar from the live stores, on the CURRENT route.
 *  `replaceState`: no history entry, no hashchange. Guarded by an equality
 *  check, so it is idempotent and cannot loop. */
export function syncHashFromStores(store: AppStore): void {
  const raw = readRawHash();
  const next = buildSyncedConfig(decodeConfig(parseHash(raw).query), readLiveSources(store));
  const query = encodeConfig(next);
  const path = currentPath(raw);
  const target = query === '' ? path : `${path}?${query}`;
  if (raw !== target) history.replaceState(null, '', target);
}

/**
 * Arm the sync: one effect over the three provenance signals, whose initial run
 * performs the first write. Install it only ONCE BOOT HAS SETTLED — boot loads
 * the three slots concurrently, and an effect armed at t0 would fire the moment
 * the schema resolved and drop the still-in-flight `rules=`/`data=` params from
 * the link the user just opened. Returns the dispose.
 */
export function installHashSync(store: AppStore): () => void {
  return effect(() => {
    syncHashFromStores(store);
  });
}
