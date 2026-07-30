/**
 * Boot-time configuration (url-params.md §2 + P19b session restore). Parses
 * the hash fragment, expands a `config=` manifest, consults the stored
 * session (`decideBoot`), and loads the three slots — schema/rules through
 * their module stores, the dataset through the card loaders registered on
 * mount. **Never auto-runs QC** (consent to compute), restore included.
 *
 * It also owns the ARMING of the address-bar sync (UIX-10) and of the session
 * write-through (P19b). Boot loads the slots concurrently, so neither may be
 * live while legs land: a sync armed at t0 would drop still-in-flight params
 * from the very link the user opened, and a write-through armed at t0 would
 * persist half-restored state. So every leg — URL and IDB restore alike — is
 * awaited first, and `installHashSync` + `armSessionWriteThrough` go on LAST,
 * in that order, on EVERY exit path. hashSync's initial run then rewrites the
 * bar from live provenance, which is what makes a restored URL-origin slot
 * self-heal back to refetch semantics on the next reload.
 */
import { reportError } from './errors';
import { installHashSync } from './hashSync';
import { parseHash, readRawHash } from './router';
import {
  armSessionWriteThrough,
  initSessionPersistence,
  restoreStoredSession,
  readSessionHint,
  rulesSlotNeedsIdb,
} from './sessionPersistence';
import { decideBoot } from './sessionSnapshot';
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

/** `mountShell` mounts the Load view synchronously on every route before
 *  `applyBootConfig` (main.ts, UIX-19), so the pending branch is unreachable
 *  in practice — kept as the safety net if that ordering ever changes. A
 *  flushed-late URL would resolve this promise immediately and the ingest it
 *  started would simply not be awaited. */
function loadDataset(url: string): Promise<void> {
  if (datasetUrlLoader) return datasetUrlLoader(url);
  pendingDataUrl = url;
  return Promise.resolve();
}

/** Parse → (expand config=) → decide vs the stored session → load slots →
 *  arm the syncs. Called once after the shell mounts. */
export async function applyBootConfig(store: AppStore): Promise<void> {
  const inline = decodeConfig(parseHash(readRawHash()).query);
  const inlineEmpty = isEmptyConfig(inline);
  // Synchronous, before the first await: the presence hint keeps the
  // first-run hero from flashing while the async IDB read resolves.
  if (inlineEmpty && readSessionHint()) store.preconfigured.set(true);

  const stored = await initSessionPersistence();
  let restoredAny = false;

  if (inlineEmpty) {
    if (decideBoot(inline, stored) === 'restore-stored' && stored !== null) {
      store.preconfigured.set(true); // covers a lost hint (storage denied)
      restoredAny = await restoreStoredSession(store, stored, 'all');
    }
    if (!restoredAny) store.preconfigured.set(false); // the hint lied
  } else {
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

    // Rows 3/4 of the decision table, compared AFTER manifest expansion. On
    // the equal-config refresh, URL-provenance slots refetch through today's
    // legs ("URLs reload themselves" stays true) while upload-provenance
    // slots restore from IDB; a different link boots wholesale and the
    // write-through overwrites the old session on its first change.
    const uploads =
      decideBoot(config, stored) === 'refresh-with-upload-restore' ? stored : null;
    const rulesFromIdb = uploads?.rules !== null && uploads?.rules !== undefined
      ? rulesSlotNeedsIdb(uploads.rules)
      : false;

    // Every leg still starts CONCURRENTLY (each awaited only at the join),
    // so arming costs nothing beyond the slowest fetch.
    const legs: Promise<void>[] = [];
    if (config.schema.length > 0) {
      legs.push(
        loadSchemaUrls(config.schema, browserFetchJson, config.index).catch((err: unknown) => {
          reportError(err, { fallbackCode: 'SCHEMA_INVALID', slot: store.slots.schema });
        }),
      );
    }
    // The rules slot restores as a WHOLE from IDB when any stored file is an
    // upload (cross-file correction order is a contract) — the URL leg would
    // race it for the same slot.
    if (config.rules.length > 0 && !rulesFromIdb) {
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
    if (uploads !== null) {
      legs.push(
        restoreStoredSession(store, uploads, 'uploads-only').then((restored) => {
          restoredAny = restored;
        }),
      );
    }
    await Promise.all(legs);
  }

  installHashSync(store);
  armSessionWriteThrough(store);
  if (restoredAny) {
    showToast('Restored your previous session.', { hint: 'Reset in the header starts fresh.' });
  }
}
