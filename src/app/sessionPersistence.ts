/**
 * Session persistence orchestrator (P19b, ingestion.md §6): reads the stored
 * session at boot, replays it through the EXISTING loaders (a restored session
 * is indistinguishable from a fresh load — no store seeding, no grid-memo
 * hazards), and keeps IndexedDB current afterwards with one write-through
 * effect. Everything here is best-effort: IDB unavailable/corrupt/foreign
 * means today's boot verbatim (fail open), and a failed save costs at most
 * one toast — the app never breaks because storage did.
 *
 * Write-through disciplines:
 * - ONE effect reading every relevant signal UNCONDITIONALLY (`hashSync.ts`'s
 *   rule: `effect` re-tracks deps per run, so an early return would deafen it).
 * - Slots in a `loading` phase are never flushed — a hung fetch must not
 *   persist a stuck badge; every load settles with a publish that re-fires
 *   the effect, so the settled state is picked up then.
 * - Debounce by weight: the dataset blob flushes immediately on a generation
 *   change, schema/rules/prefs coalesce 500 ms, Studio typing 1 s;
 *   `visibilitychange → hidden` flushes whatever is pending.
 * - Every flush that writes anything rewrites `meta` from
 *   `buildSyncedConfig(EMPTY, readLiveSources(store))` — the same writer as
 *   the address bar, so bar and stored config cannot disagree — plus the
 *   (tiny) prefs and studio records.
 * - The all-empty state clears the backend outright (empty ≡ absent), which
 *   is what keeps "a cleared session stays cleared across reload" true by
 *   construction.
 * - Markers hold the last WRITTEN snapshots and are seeded from the live
 *   state at arm time, so a boot restore never echo-saves what it just read.
 *
 * Multi-tab: one transaction per flush, last-flush-wins (documented in
 * ingestion.md §6, not solved).
 *
 * Entry-chunk discipline: rules serialization (papaparse) is imported
 * dynamically at flush time; everything static here is already entry-resident.
 */
import { reportError } from './errors';
import { buildSyncedConfig, readLiveSources } from './hashSync';
import { openSessionBackend } from './sessionBackend';
import {
  SNAPSHOT_VERSION,
  readStoredSession,
  toSyncedConfig,
} from './sessionSnapshot';
import { effect } from './signals';
import { readStudioSession, setPendingStudioRestore, studioSessionRev } from './studioSession';
import { showToast } from './toast';
import { restoreRuleFiles, rulesState } from '../core/rules/rules-store';
import { restoreSchemaEntries, schemaState } from '../core/schema/schema-store';
import type { SessionBackend, SessionKey } from './sessionBackend';
import type {
  DatasetRecord,
  MetaRecord,
  RulesRecord,
  SchemaRecord,
  StoredSession,
} from './sessionSnapshot';
import type { AppStore, DatasetSession } from './store';
import type { RulesSlotState } from '../core/rules/rules-store';
import type { SchemaSlotState } from '../core/schema/schema-store';
import type { UrlConfig } from '../core/share/urlConfig';

// ---- presence hint ----------------------------------------------------------

/**
 * localStorage flag mirroring "the backend holds a session". Read
 * SYNCHRONOUSLY in `applyBootConfig` before its first await, so the first-run
 * hero never flashes while the async IDB read resolves. Swallow-guarded like
 * the Studio RAIL_PREF — storage access throws outright in some privacy modes.
 */
const SESSION_HINT = 'quac.session.hint';

export function readSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT) === '1';
  } catch {
    return false;
  }
}

function writeSessionHint(present: boolean): void {
  try {
    if (present) localStorage.setItem(SESSION_HINT, '1');
    else localStorage.removeItem(SESSION_HINT);
  } catch {
    // Best-effort: a lost hint only costs a hero flash on the next boot.
  }
}

// ---- module state -----------------------------------------------------------

let backend: SessionBackend | null = null;

/** The armed write-through's handles, reachable by `purgeSession`. */
interface ActivePersister {
  cancelPending: () => void;
  noteCleared: () => void;
}

let active: ActivePersister | null = null;

/**
 * Open the backend and admit the stored session through the guards.
 * `null` for every failure mode: IDB unavailable, nothing stored, foreign
 * snapshot version or torn meta (those two also best-effort purge — a
 * snapshot we cannot read is a snapshot we must not keep).
 */
export async function initSessionPersistence(
  open: () => Promise<SessionBackend | null> = openSessionBackend,
): Promise<StoredSession | null> {
  backend = await open();
  if (backend === null) {
    writeSessionHint(false); // nothing can be stored here — do not suppress the hero
    return null;
  }
  const records = await backend.readAll();
  if (Object.keys(records).length === 0) return null;
  const session = readStoredSession(records);
  if (session === null) {
    void backend.clear();
    writeSessionHint(false);
    return null;
  }
  return session;
}

// ---- dataset restore loader seam -------------------------------------------

export interface DatasetRestoreArgs {
  source: Blob;
  name: string;
  sheetName?: string;
  sourceUrl?: string;
}

let datasetRestoreLoader: ((args: DatasetRestoreArgs) => Promise<void>) | null = null;
let pendingRestoreArgs: DatasetRestoreArgs | null = null;

/**
 * The Dataset card registers its restore loader on mount (mirrors
 * `registerDatasetUrlLoader`, bootConfig.ts) so restore drives the real card
 * UX. If restore beats the mount — a `#/studio` reload never mounts Load
 * first — the args are flushed here when the card arrives.
 */
export function registerDatasetRestoreLoader(
  load: (args: DatasetRestoreArgs) => Promise<void>,
): void {
  datasetRestoreLoader = load;
  if (pendingRestoreArgs !== null) {
    const args = pendingRestoreArgs;
    pendingRestoreArgs = null;
    void load(args);
  }
}

function loadDatasetFromRecord(record: DatasetRecord): Promise<void> {
  const args: DatasetRestoreArgs = {
    source: record.blob,
    name: record.name,
    ...(record.sheetName !== undefined ? { sheetName: record.sheetName } : {}),
    ...(record.sourceUrl !== undefined ? { sourceUrl: record.sourceUrl } : {}),
  };
  if (datasetRestoreLoader !== null) return datasetRestoreLoader(args);
  pendingRestoreArgs = args;
  return Promise.resolve();
}

// ---- restore ----------------------------------------------------------------

/**
 * Replay a stored session through the existing loaders. `'all'` restores every
 * present slot (the empty-fragment boot); `'uploads-only'` restores only the
 * slots the URL cannot reload itself — upload-origin dataset/schema, and the
 * rules slot as a WHOLE iff any stored file is an upload (cross-file
 * correction order is a contract; a slot cannot be half-restored). Prefs land
 * first (synchronous — the checkbox effect repaints before anything async),
 * the studio record is parked for the lazy workspace, and the slot legs run
 * CONCURRENTLY, each reporting into its own slot on failure (boot's pattern).
 * Returns whether any slot leg was launched — the restore toast's predicate.
 */
export async function restoreStoredSession(
  store: AppStore,
  session: StoredSession,
  mode: 'all' | 'uploads-only',
): Promise<boolean> {
  if (session.prefs !== null) store.applyCorrections.set(session.prefs.applyCorrections);
  if (session.studio !== null) setPendingStudioRestore(session.studio);

  const legs: Promise<void>[] = [];
  const schema = session.schema;
  if (schema !== null && (mode === 'all' || schema.origin === 'upload')) {
    legs.push(
      restoreSchemaEntries({
        entries: schema.entries,
        origin: schema.origin,
        sourceUrls: schema.sourceUrls,
        ...(schema.chosenIndexFileId !== undefined
          ? { chosenIndexFileId: schema.chosenIndexFileId }
          : {}),
      }).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'SCHEMA_INVALID', slot: store.slots.schema });
      }),
    );
  }
  const rules = session.rules;
  if (rules !== null && (mode === 'all' || rulesSlotNeedsIdb(rules))) {
    legs.push(
      restoreRuleFiles(rules.files, rules.dirty).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'RULES_PARSE', slot: store.slots.rules });
      }),
    );
  }
  const dataset = session.dataset;
  if (dataset !== null && (mode === 'all' || dataset.sourceUrl === undefined)) {
    legs.push(
      loadDatasetFromRecord(dataset).catch((err: unknown) => {
        reportError(err, { fallbackCode: 'INGEST_UNSUPPORTED', slot: store.slots.data });
      }),
    );
  }
  await Promise.all(legs);
  return legs.length > 0;
}

/** The rules slot restores from IDB iff ANY stored file is an upload — the
 *  boot flow uses the same predicate to suppress its `rules=` URL leg. */
export function rulesSlotNeedsIdb(rules: RulesRecord): boolean {
  return rules.files.some((f) => f.sourceUrl === null);
}

// ---- write-through ----------------------------------------------------------

const EMPTY_CONFIG: UrlConfig = { schema: [], rules: [], passthrough: [] };

function buildMetaRecord(store: AppStore): MetaRecord {
  return {
    v: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    syncedConfig: toSyncedConfig(buildSyncedConfig(EMPTY_CONFIG, readLiveSources(store))),
  };
}

function buildDatasetRecord(dataset: DatasetSession): DatasetRecord {
  return {
    blob: dataset.source,
    name: dataset.name,
    format: dataset.format,
    ...(dataset.sheetName !== undefined ? { sheetName: dataset.sheetName } : {}),
    ...(dataset.sourceUrl !== undefined ? { sourceUrl: dataset.sourceUrl } : {}),
  };
}

/**
 * Persist-shape intake entries from the live set (the restore contract's
 * other half): URL sets key every file by its retrieval URL (`fileId`), so
 * replay re-intakes them exactly as the crawler did; upload sets keep their
 * once-stripped `relativePath` and replay with `preserveIntakePaths`.
 */
function buildSchemaRecord(schema: SchemaSlotState): SchemaRecord | null {
  const set = schema.set;
  if (set === null) return null;
  return {
    entries: set.files.map((f) =>
      set.origin === 'url'
        ? { relativePath: f.fileId, raw: f.raw, retrievalUri: f.retrievalUri }
        : { relativePath: f.relativePath, raw: f.raw },
    ),
    origin: set.origin,
    sourceUrls: [...schema.sourceUrls],
    ...(set.root.indexFileId !== undefined ? { chosenIndexFileId: set.root.indexFileId } : {}),
  };
}

async function buildRulesRecord(rules: RulesSlotState): Promise<RulesRecord | null> {
  if (rules.files.length === 0) return null;
  // Dynamic on purpose: a static import would drag papaparse into the entry
  // chunk. Flush time is the first moment the bytes are actually needed.
  const { serializeRuleFile } = await import('../core/rules/serialize');
  return {
    files: rules.files.map((parsed, i) => ({
      name: parsed.file.name,
      text: serializeRuleFile(parsed.file),
      sourceUrl: rules.sources[i] ?? null,
    })),
    dirty: [...rules.dirtyFiles],
  };
}

export interface WriteThroughDelays {
  /** Dataset generation change → flush after this long (default 0). */
  dataset?: number;
  /** Schema/rules/prefs changes coalesce this long (default 500). */
  slots?: number;
  /** Studio typing coalesces this long (default 1000). */
  studio?: number;
}

/**
 * Arm the write-through. Call LAST on every boot exit path (after
 * `installHashSync` — restore legs count as boot legs, and an effect armed
 * earlier would persist half-restored state). Returns the dispose.
 */
export function armSessionWriteThrough(
  store: AppStore,
  delays: WriteThroughDelays = {},
): () => void {
  if (backend === null) return () => undefined; // IDB unusable: nothing to arm
  // Typed alias: the hoisted flush functions below capture it, and function
  // declarations do not inherit the null-guard's narrowing.
  const idb: SessionBackend = backend;

  const datasetDelay = delays.dataset ?? 0;
  const slotsDelay = delays.slots ?? 500;
  const studioDelay = delays.studio ?? 1000;

  // Last-WRITTEN markers, seeded from the live state so a boot restore never
  // echo-saves what it just read. Snapshot identity is enough: every store
  // publishes fresh objects, and rules keeps its files/sources/dirty
  // references stable across the relint that follows a load.
  let lastDatasetGeneration = store.dataset.get()?.generation ?? 0;
  let lastSchemaSet = schemaState.get().set;
  let lastSchemaUrls = schemaState.get().sourceUrls;
  let lastRules = rulesState.get();
  let lastApply = store.applyCorrections.get();
  let lastStudioRev = studioSessionRev.get();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline = 0;
  let flushing = false;
  let rerun = false;
  let disposed = false;
  let toastShown = false;

  function cancelPending(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs: number): void {
    if (disposed) return;
    const target = Date.now() + delayMs;
    if (timer !== null) {
      if (target >= deadline) return; // an earlier flush is already due
      clearTimeout(timer);
    }
    deadline = target;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  /** True when a flush landed while another was mid-write — the awaits inside
   *  `flushOnce` are reentrancy windows. Read through a call so the loop below
   *  survives flow analysis (the mutation happens across an await). */
  function consumeRerun(): boolean {
    const again = rerun && !disposed;
    rerun = false;
    return again;
  }

  async function flush(): Promise<void> {
    if (flushing) {
      rerun = true;
      return;
    }
    flushing = true;
    try {
      do {
        await flushOnce();
      } while (consumeRerun());
    } finally {
      flushing = false;
    }
  }

  async function flushOnce(): Promise<void> {
    if (disposed) return;
    const dataset = store.dataset.get();
    const datasetLoading = store.slots.data.get().status === 'loading';
    const schema = schemaState.get();
    const rules = rulesState.get();
    const apply = store.applyCorrections.get();
    const studioRev = studioSessionRev.get();

    const allEmpty =
      dataset === null &&
      !datasetLoading &&
      schema.phase === 'empty' &&
      rules.phase === 'empty' &&
      rules.files.length === 0;
    if (allEmpty) {
      // Empty ≡ absent: a cleared session must stay cleared across reload.
      lastDatasetGeneration = 0;
      lastSchemaSet = schema.set;
      lastSchemaUrls = schema.sourceUrls;
      lastRules = rules;
      lastApply = apply;
      lastStudioRev = studioRev;
      await idb.clear();
      writeSessionHint(false);
      return;
    }

    const entries: Partial<Record<SessionKey, unknown>> = {};
    const generation = dataset?.generation ?? 0;
    const writeDataset = !datasetLoading && generation !== lastDatasetGeneration;
    if (writeDataset) {
      entries.dataset = dataset === null ? null : buildDatasetRecord(dataset);
    }
    const writeSchema =
      schema.phase !== 'loading' &&
      (schema.set !== lastSchemaSet || schema.sourceUrls !== lastSchemaUrls);
    if (writeSchema) entries.schema = buildSchemaRecord(schema);
    const writeRules =
      rules.phase !== 'loading' &&
      (rules.files !== lastRules.files ||
        rules.sources !== lastRules.sources ||
        rules.dirtyFiles !== lastRules.dirtyFiles);
    if (writeRules) entries.rules = await buildRulesRecord(rules);
    const writePrefsOrStudio = apply !== lastApply || studioRev !== lastStudioRev;

    if (!writeDataset && !writeSchema && !writeRules && !writePrefsOrStudio) return;

    // The cheap records ride every flush: meta by the same writer as the bar
    // (the two must never disagree), prefs and studio because diffing them
    // would cost more than writing them.
    entries.meta = buildMetaRecord(store);
    entries.prefs = { applyCorrections: apply };
    entries.studio = readStudioSession();

    const committed = await idb.write(entries);
    if (!committed) {
      if (!toastShown) {
        toastShown = true;
        showToast("Couldn't save your session for resume — it may not survive a reload.", {
          kind: 'error',
        });
      }
      return; // markers untouched — the next change retries
    }
    writeSessionHint(true);
    if (writeDataset) lastDatasetGeneration = generation;
    if (writeSchema) {
      lastSchemaSet = schema.set;
      lastSchemaUrls = schema.sourceUrls;
    }
    if (writeRules) lastRules = rules;
    lastApply = apply;
    lastStudioRev = studioRev;
  }

  const disposeEffect = effect(() => {
    // Read EVERY dependency unconditionally — an early return would unlink
    // whatever it skipped and silently deafen the sync (hashSync.ts:59-62).
    const generation = store.dataset.get()?.generation ?? 0;
    store.slots.data.get(); // re-fires the effect when an ingest settles
    const schema = schemaState.get();
    const rules = rulesState.get();
    const apply = store.applyCorrections.get();
    const studioRev = studioSessionRev.get();

    const datasetChanged = generation !== lastDatasetGeneration;
    const slotsChanged =
      schema.set !== lastSchemaSet ||
      schema.sourceUrls !== lastSchemaUrls ||
      rules.files !== lastRules.files ||
      rules.sources !== lastRules.sources ||
      rules.dirtyFiles !== lastRules.dirtyFiles ||
      apply !== lastApply;
    if (datasetChanged) schedule(datasetDelay);
    else if (slotsChanged) schedule(slotsDelay);
    else if (studioRev !== lastStudioRev) schedule(studioDelay);
  });

  const onVisibility = (): void => {
    // A tab being hidden is the last reliable moment before a close/kill —
    // flush whatever the debounce is still holding.
    if (document.visibilityState === 'hidden' && timer !== null) {
      cancelPending();
      void flush();
    }
  };
  // Guarded so the node-tier unit tests can arm the effect; the flush logic
  // itself is DOM-free.
  const hasDocument = typeof document !== 'undefined';
  if (hasDocument) document.addEventListener('visibilitychange', onVisibility);

  const self: ActivePersister = {
    cancelPending,
    noteCleared: () => {
      lastDatasetGeneration = 0;
      lastSchemaSet = null;
      lastSchemaUrls = [];
      lastRules = rulesState.get();
      lastApply = store.applyCorrections.get();
      lastStudioRev = studioSessionRev.get();
    },
  };
  active = self;

  return () => {
    disposed = true;
    cancelPending();
    disposeEffect();
    if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
    if (active === self) active = null;
  };
}

/**
 * Wipe the persisted session (Reset / Clear all inputs): cancel pending
 * flushes, clear the backend, drop the presence hint and any parked studio
 * restore. Never throws — there is nothing sensible to do about a failed
 * clear of best-effort storage.
 */
export async function purgeSession(): Promise<void> {
  try {
    active?.cancelPending();
    active?.noteCleared();
    setPendingStudioRestore(null);
    if (backend !== null) await backend.clear();
    writeSessionHint(false);
  } catch {
    // Best-effort by contract.
  }
}
