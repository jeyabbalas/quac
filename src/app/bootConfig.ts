/**
 * Boot-time URL configuration (url-params.md §2). Parses the hash fragment,
 * expands a `config=` manifest, and auto-loads the three slots — schema/rules
 * through their module stores, the dataset through the card loader registered
 * on mount. **Never auto-runs QC** (consent to compute).
 *
 * It also owns the ARMING of the address-bar sync (UIX-10). Boot loads the
 * three slots concurrently, so the sync cannot be live while they land: an
 * effect armed at t0 would fire the moment the schema resolved and drop the
 * still-in-flight `rules=`/`data=` params — and if one of those fetches then
 * failed, the param would be gone for good, destroying the very link the user
 * opened. So every leg is awaited first and `installHashSync` goes on last, on
 * EVERY exit path; its initial run performs the first sync (which is also what
 * writes `index=` back once the root resolves — the old `installIndexSync`).
 */
import { reportError } from './errors';
import { installHashSync } from './hashSync';
import { parseHash, readRawHash } from './router';
import { showToast } from './toast';
import { addRuleUrls } from '../core/rules/rules-store';
import { browserFetchJson } from '../core/schema/fetch-json';
import { loadSchemaUrls } from '../core/schema/schema-store';
import { applyPrecedence, fetchConfigManifest, manifestToConfig } from '../core/share/configManifest';
import { decodeConfig, isEmptyConfig } from '../core/share/urlConfig';
import type { AppStore } from './store';

let datasetUrlLoader: ((url: string) => Promise<void>) | null = null;
let pendingDataUrl: string | null = null;

/**
 * The Dataset card registers its URL loader on mount so boot drives the real
 * card UX (progress + status). If boot beats the mount, the URL is flushed here.
 */
export function registerDatasetUrlLoader(load: (url: string) => Promise<void>): void {
  datasetUrlLoader = load;
  if (pendingDataUrl !== null) {
    const url = pendingDataUrl;
    pendingDataUrl = null;
    void load(url);
  }
}

/** `mountShell` runs synchronously before `applyBootConfig` (main.ts), so the
 *  flush branch is unreachable in practice — it resolves immediately and the
 *  ingest it started is simply not awaited. */
function loadDataset(url: string): Promise<void> {
  if (datasetUrlLoader) return datasetUrlLoader(url);
  pendingDataUrl = url;
  return Promise.resolve();
}

/** Parse → (expand config=) → auto-load slots → arm the hash sync. Called once
 *  after the shell mounts. */
export async function applyBootConfig(store: AppStore): Promise<void> {
  const inline = decodeConfig(parseHash(readRawHash()).query);
  if (isEmptyConfig(inline)) {
    installHashSync(store);
    return;
  }

  let config = inline;
  if (inline.config !== undefined) {
    try {
      const manifest = await fetchConfigManifest(inline.config);
      const { merged, overridden } = applyPrecedence(manifestToConfig(manifest), inline);
      config = merged;
      if (overridden.length > 0) {
        showToast(`Link params override the shared config: ${overridden.join(', ')}.`, {
          kind: 'info',
        });
      }
    } catch (err) {
      // Manifest unreachable/malformed: fall back to the inline params.
      reportError(err, { fallbackCode: 'FETCH_HTTP' });
      config = { ...inline, config: undefined };
    }
  }

  if (config.schema.length > 0 || config.rules.length > 0 || config.data !== undefined) {
    store.preconfigured.set(true);
  }

  // The three legs still start CONCURRENTLY (each awaited only at the join),
  // so arming costs nothing beyond the slowest fetch.
  const legs: Promise<void>[] = [];
  if (config.schema.length > 0) {
    legs.push(
      loadSchemaUrls(config.schema, browserFetchJson, config.index).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'SCHEMA_INVALID', slot: store.slots.schema });
      }),
    );
  }
  if (config.rules.length > 0) {
    legs.push(
      addRuleUrls(config.rules).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'RULES_PARSE', slot: store.slots.rules });
      }),
    );
  }
  if (config.data !== undefined) {
    legs.push(
      loadDataset(config.data).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'FETCH_HTTP', slot: store.slots.data });
      }),
    );
  }
  await Promise.all(legs);

  installHashSync(store);
}
