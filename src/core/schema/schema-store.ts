/**
 * Schema-slot state: a module-scoped signal owning the loaded SchemaSet.
 * Deliberately NOT part of AppStore — views receive no store context yet and
 * that plumbing is P05/P14 territory (parallel branches). P14 bridges this
 * signal onto `store.slots.schema` with `bindSlotSignal` (one line).
 * Snapshots are immutable: every action `set()`s a fresh object.
 */
import { effect, signal } from '../../app/signals';
import type { Signal } from '../../app/signals';
import type { SlotState } from '../../app/store';
import { browserFetchJson } from './fetch-json';
import { fetchCorsMessage, fetchHttpMessage, loadError } from './messages';
import { applyRootSelection } from './root-detection';
import { buildSchemaSet } from './schema-set';
import type { FetchJson, IntakeEntry, SchemaLoadError, SchemaSet } from './types';

export type SchemaSlotPhase = 'empty' | 'loading' | 'ready';

export interface SchemaSlotState {
  phase: SchemaSlotPhase;
  /** Full result incl. errors; null until the first load resolves. */
  set: SchemaSet | null;
  /** User-provided crawl-base URLs (P16 share provenance); `[]` for uploads. */
  sourceUrls: readonly string[];
}

export const schemaState: Signal<SchemaSlotState> = signal<SchemaSlotState>({
  phase: 'empty',
  set: null,
  sourceUrls: [],
});

/** True when the IndexPickerModal is required (§A.3.4) and nothing chose yet. */
export function needsRootChoice(set: SchemaSet): boolean {
  return (
    (set.root.status === 'ambiguous' || set.root.status === 'none') &&
    set.root.rootFileId === undefined
  );
}

/** Load uploaded files (browse, folder, or drop) into the schema slot. */
export async function loadSchemaEntries(entries: readonly IntakeEntry[]): Promise<void> {
  schemaState.set({ phase: 'loading', set: null, sourceUrls: [] });
  try {
    const set = await buildSchemaSet(entries, { origin: 'upload' });
    schemaState.set({ phase: 'ready', set, sourceUrls: [] });
  } catch (err) {
    schemaState.set({ phase: 'empty', set: null, sourceUrls: [] });
    throw err;
  }
}

/**
 * Load one or more schema URLs. Top-level fetch failures become E_FETCH
 * findings on the resulting set (never a rejection); the ref-graph crawl gets
 * the same fetch port for transitive refs.
 */
export async function loadSchemaUrls(
  urls: readonly string[],
  fetchJson: FetchJson = browserFetchJson,
  indexParam?: string,
): Promise<void> {
  const targets = urls.map((u) => u.trim()).filter((u) => u !== '');
  if (targets.length === 0) return;
  schemaState.set({ phase: 'loading', set: null, sourceUrls: targets });
  try {
    const entries: IntakeEntry[] = [];
    const fetchErrors: SchemaLoadError[] = [];
    for (const url of targets) {
      try {
        const fetched = await fetchJson(url);
        entries.push({
          relativePath: fetched.finalUrl,
          raw: fetched.text,
          retrievalUri: fetched.finalUrl,
        });
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        fetchErrors.push(
          loadError(
            'E_FETCH',
            typeof status === 'number' ? fetchHttpMessage(url, status) : fetchCorsMessage(url),
            { meta: { url } },
          ),
        );
      }
    }
    // §A.4: buildSchemaSet resolves `index=` atomically before we publish, so
    // a matched index suppresses the IndexPickerModal (no flash — signals sync).
    const set = await buildSchemaSet(entries, {
      origin: 'url',
      fetchJson,
      ...(indexParam !== undefined ? { indexParam } : {}),
    });
    set.errors.unshift(...fetchErrors);
    schemaState.set({ phase: 'ready', set, sourceUrls: targets });
  } catch (err) {
    schemaState.set({ phase: 'empty', set: null, sourceUrls: [] });
    throw err;
  }
}

/** IndexPickerModal selection → new snapshot with the §A.3.5 post-checks run. */
export function chooseRoot(fileId: string): void {
  const current = schemaState.get();
  if (current.phase !== 'ready' || current.set === null) return;
  schemaState.set({
    phase: 'ready',
    set: applyRootSelection(current.set, fileId),
    sourceUrls: current.sourceUrls,
  });
}

export function resetSchemaSlot(): void {
  schemaState.set({ phase: 'empty', set: null, sourceUrls: [] });
}

/** Pure SlotState projection — the slot card and the P14 bridge share it. */
export function summarizeSlot(state: SchemaSlotState): SlotState {
  if (state.phase === 'empty' || state.set === null) return { status: 'empty', detail: '' };
  if (state.phase === 'loading') return { status: 'loading', detail: 'Loading schema files…' };
  const set = state.set;
  const count = set.schemas.length;
  const filesLabel = count === 1 ? '1 file' : `${String(count)} files`;
  const fatals = set.errors.filter((e) => e.severity === 'fatal');
  if (fatals.length > 0) {
    const label = fatals.length === 1 ? '1 error' : `${String(fatals.length)} errors`;
    return { status: 'error', detail: `${filesLabel} · ${label} — see details` };
  }
  if (needsRootChoice(set)) {
    return { status: 'warning', detail: `${filesLabel} · choose the index schema` };
  }
  const root = set.files.find((f) => f.fileId === set.root.rootFileId);
  const detail = root === undefined ? filesLabel : `${filesLabel} · root: ${root.relativePath}`;
  const hasWarnings = set.errors.some((e) => e.severity === 'warning');
  return { status: hasWarnings ? 'warning' : 'valid', detail };
}

/** P14 wiring: mirror this slot into `store.slots.schema`. Returns dispose. */
export function bindSlotSignal(slot: Signal<SlotState>): () => void {
  return effect(() => {
    slot.set(summarizeSlot(schemaState.get()));
  });
}
