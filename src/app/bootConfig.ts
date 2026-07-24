/**
 * Boot-time URL configuration (url-params.md §2). Parses the hash fragment,
 * expands a `config=` manifest, and auto-loads the three slots — schema/rules
 * through their module stores, the dataset through the card loader registered
 * on mount. **Never auto-runs QC** (consent to compute). Also keeps a
 * preconfigured session's `index=` param current once the root resolves.
 */
import { reportError } from './errors';
import { formatHash, parseHash, readRawHash } from './router';
import { effect } from './signals';
import { showToast } from './toast';
import { addRuleUrls } from '../core/rules/rules-store';
import { browserFetchJson } from '../core/schema/fetch-json';
import { loadSchemaUrls, schemaState } from '../core/schema/schema-store';
import { applyPrecedence, fetchConfigManifest, manifestToConfig } from '../core/share/configManifest';
import { decodeConfig, encodeConfig, isEmptyConfig } from '../core/share/urlConfig';
import type { AppStore } from './store';
import type { UrlConfig } from '../core/share/urlConfig';

let datasetUrlLoader: ((url: string) => void) | null = null;
let pendingDataUrl: string | null = null;

/**
 * The Dataset card registers its URL loader on mount so boot drives the real
 * card UX (progress + status). If boot beats the mount, the URL is flushed here.
 */
export function registerDatasetUrlLoader(load: (url: string) => void): void {
  datasetUrlLoader = load;
  if (pendingDataUrl !== null) {
    const url = pendingDataUrl;
    pendingDataUrl = null;
    load(url);
  }
}

function loadDataset(url: string): void {
  if (datasetUrlLoader) datasetUrlLoader(url);
  else pendingDataUrl = url;
}

/**
 * §A.4 address-bar sync: when the URL-loaded schema resolves an `indexFileId`
 * AND the fragment is already a preconfigured session (carries `schema=`), write
 * `index=` back so a reload/re-share never re-prompts the IndexPickerModal. Only
 * touches the bar when the value actually changes; never emits a bare `index=`.
 */
function installIndexSync(): void {
  effect(() => {
    const state = schemaState.get();
    const set = state.set;
    if (state.phase !== 'ready' || set === null) return;
    if (set.origin !== 'url') return;
    const indexId = set.root.indexFileId;
    if (indexId === undefined) return;

    const { route, query } = parseHash(readRawHash());
    const current = decodeConfig(query);
    if (current.schema.length === 0 || current.index === indexId) return;

    const next: UrlConfig = { ...current, index: indexId };
    const target = formatHash(route, encodeConfig(next));
    if (readRawHash() !== target) window.location.hash = target;
  });
}

/** Parse → (expand config=) → auto-load slots. Called once after the shell mounts. */
export async function applyBootConfig(store: AppStore): Promise<void> {
  installIndexSync();

  const inline = decodeConfig(parseHash(readRawHash()).query);
  if (isEmptyConfig(inline)) return;

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

  if (config.schema.length > 0) {
    void loadSchemaUrls(config.schema, browserFetchJson, config.index).catch((err: unknown) => {
      reportError(err, { fallbackCode: 'SCHEMA_INVALID', slot: store.slots.schema });
    });
  }
  if (config.rules.length > 0) {
    void addRuleUrls(config.rules).catch((err: unknown) => {
      reportError(err, { fallbackCode: 'RULES_PARSE', slot: store.slots.rules });
    });
  }
  if (config.data !== undefined) loadDataset(config.data);
}
