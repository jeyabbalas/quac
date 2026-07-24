/**
 * Rules-slot state: a module-scoped signal owning the loaded rule files and
 * their lint results (schema-store precedent — P14 bridges it onto
 * `store.slots.rules` with `bindSlotSignal`). Snapshots are immutable.
 *
 * Import discipline (bundle gate): top-level imports here are the tiny signals
 * module + types ONLY. parse/lint (which pull sql.ts → @jeyabbalas/data-table)
 * are dynamically imported inside the actions, so mounting the Rules slot card
 * never drags engine code into the entry chunk.
 *
 * Lint lifecycle (ingestion.md §4): files lint on load with the last-known
 * dataset context; `setLintContext` re-lints when the dataset changes (or
 * clears). A monotonic token guards BOTH staleness dimensions — the dataset
 * context and the files array can each change while a lint is in flight; only
 * the newest lint may publish.
 */
import { effect, signal } from '../../app/signals';
import type { Signal } from '../../app/signals';
import type { SlotState } from '../../app/store';
import type { DatasetLintContext } from './lint';
import type { ParsedRuleFile } from './parse';
import type { RuleFileLintResult } from './types';

export type RulesSlotPhase = 'empty' | 'loading' | 'ready';

export interface RulesSlotState {
  phase: RulesSlotPhase;
  /** Load order preserved — it is the cross-file correction-order contract. */
  files: readonly ParsedRuleFile[];
  /** Aligned with `files` once phase is 'ready'; look up by file name. */
  results: readonly RuleFileLintResult[];
  /** False while results carry only static checks + pending-data. */
  lintedWithData: boolean;
  /** URL-fetch failures from the last addRuleUrls call. */
  fetchErrors: readonly string[];
  /** Aligned with `files`: the URL each came from, or null for uploads (P16). */
  sources: readonly (string | null)[];
}

const EMPTY: RulesSlotState = {
  phase: 'empty',
  files: [],
  results: [],
  lintedWithData: false,
  fetchErrors: [],
  sources: [],
};

export const rulesState: Signal<RulesSlotState> = signal<RulesSlotState>(EMPTY);

let lintToken = 0;
let currentCtx: DatasetLintContext | null = null;

async function relint(files: readonly ParsedRuleFile[]): Promise<void> {
  const token = ++lintToken;
  const ctx = currentCtx;
  // sandbox-loader is a tiny stub — the quickjs chunk itself only downloads
  // if lint actually calls loadSandbox (i.e. a js correction rule is loaded).
  const [{ lintRuleFilesWithDataset }, { loadJSSandbox }] = await Promise.all([
    import('./lint'),
    import('./sandbox-loader'),
  ]);
  const results = await lintRuleFilesWithDataset([...files], ctx, { loadSandbox: loadJSSandbox });
  if (token !== lintToken) return; // a newer load/relint superseded this one
  rulesState.set({
    ...rulesState.get(),
    phase: 'ready',
    files,
    results,
    lintedWithData: ctx !== null,
  });
}

/**
 * Add uploaded rules files (drop or browse). Re-adding a filename replaces
 * that file IN PLACE — position is load order, and load order is the
 * correction-order contract (engine §2).
 */
export async function addRuleFiles(
  entries: readonly { name: string; text: string; sourceUrl?: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  const { parseRuleFile } = await import('./parse');
  const current = rulesState.get();
  const files = [...current.files];
  const sources = [...current.sources];
  for (const entry of entries) {
    const parsed = parseRuleFile(entry.text, entry.name);
    const source = entry.sourceUrl ?? null;
    const existing = files.findIndex((f) => f.file.name === entry.name);
    if (existing >= 0) {
      files[existing] = parsed;
      sources[existing] = source; // provenance follows a same-name replace
    } else {
      files.push(parsed);
      sources.push(source);
    }
  }
  rulesState.set({ ...rulesState.get(), phase: 'loading', files, sources });
  await relint(files);
}

/** Fetch one or more rules-file URLs (space-separated in the field). */
export async function addRuleUrls(urls: readonly string[]): Promise<void> {
  const targets = urls.map((u) => u.trim()).filter((u) => u !== '');
  if (targets.length === 0) return;
  const entries: { name: string; text: string; sourceUrl?: string }[] = [];
  const fetchErrors: string[] = [];
  for (const url of targets) {
    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) {
        fetchErrors.push(`Fetch failed for ${url}: HTTP ${String(response.status)}.`);
        continue;
      }
      entries.push({ name: nameFromUrl(url), text: await response.text(), sourceUrl: url });
    } catch {
      fetchErrors.push(
        `Could not fetch ${url} — the server may not allow cross-origin requests (CORS).`,
      );
    }
  }
  rulesState.set({ ...rulesState.get(), fetchErrors });
  await addRuleFiles(entries);
}

function nameFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split('/').filter((s) => s !== '');
    const last = segments.at(-1);
    return last === undefined || last === '' ? 'rules.quac.csv' : decodeURIComponent(last);
  } catch {
    return 'rules.quac.csv';
  }
}

/**
 * Install or clear the dataset lint context, re-linting loaded files.
 * `null` = no dataset (SQL checks report pending-data). The context is kept
 * for files added later.
 */
export async function setLintContext(ctx: DatasetLintContext | null): Promise<void> {
  currentCtx = ctx;
  const { files } = rulesState.get();
  if (files.length === 0) return;
  await relint(files);
}

export function resetRulesSlot(): void {
  lintToken += 1; // kill any in-flight lint
  currentCtx = null;
  rulesState.set(EMPTY);
}

/** True when the file failed structurally (nothing in it can execute). */
function hasStructuralError(result: RuleFileLintResult): boolean {
  return result.issues.some((i) => i.severity === 'error' && i.rowNumber === undefined);
}

/** Pure SlotState projection — the slot card and the P14 bridge share it. */
export function summarizeSlot(state: RulesSlotState): SlotState {
  if (state.files.length === 0 && state.fetchErrors.length === 0) {
    return { status: 'empty', detail: '' };
  }
  if (state.phase === 'loading') return { status: 'loading', detail: 'Loading rules files…' };

  const fileCount = state.files.length;
  const ruleCount = state.results.reduce((sum, r) => sum + r.ruleCount, 0);
  const issues = state.results.flatMap((r) => r.issues);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;

  const parts = [
    fileCount === 1 ? '1 file' : `${String(fileCount)} files`,
    ruleCount === 1 ? '1 rule' : `${String(ruleCount)} rules`,
  ];
  if (errors > 0) parts.push(errors === 1 ? '1 lint error' : `${String(errors)} lint errors`);
  if (warnings > 0)
    parts.push(warnings === 1 ? '1 lint warning' : `${String(warnings)} lint warnings`);
  if (state.fetchErrors.length > 0) {
    const n = state.fetchErrors.length;
    parts.push(n === 1 ? '1 fetch error' : `${String(n)} fetch errors`);
  }
  if (errors === 0 && warnings === 0 && !state.lintedWithData && fileCount > 0) {
    parts.push('data checks pending');
  }
  const detail = parts.join(' · ');

  // Partial acceptance (engine §7): row-level errors still leave the loadable
  // remainder running — badge Warning. Error is reserved for files that failed
  // structurally (nothing executes) and for fetch failures.
  if (state.fetchErrors.length > 0 || state.results.some(hasStructuralError)) {
    return { status: 'error', detail };
  }
  if (errors > 0 || warnings > 0) return { status: 'warning', detail };
  return { status: 'valid', detail };
}

/** P14 wiring: mirror this slot into `store.slots.rules`. Returns dispose. */
export function bindSlotSignal(slot: Signal<SlotState>): () => void {
  return effect(() => {
    slot.set(summarizeSlot(rulesState.get()));
  });
}
