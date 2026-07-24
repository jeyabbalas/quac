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
import type { CanonicalColumn, ParsedRuleFile } from './parse';
import type { QCRule, RuleFileLintResult } from './types';

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
  /** File names edited in this session (P17 Studio) — export hint for P18.
   *  A same-name re-upload supersedes session edits and clears the flag. */
  dirtyFiles: ReadonlySet<string>;
}

const EMPTY: RulesSlotState = {
  phase: 'empty',
  files: [],
  results: [],
  lintedWithData: false,
  fetchErrors: [],
  sources: [],
  dirtyFiles: new Set(),
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
  const { parseRuleFile } = await loadCodecs();
  const current = rulesState.get();
  const files = [...current.files];
  const sources = [...current.sources];
  const dirtyFiles = new Set(current.dirtyFiles);
  for (const entry of entries) {
    const parsed = parseRuleFile(entry.text, entry.name);
    const source = entry.sourceUrl ?? null;
    const existing = files.findIndex((f) => f.file.name === entry.name);
    if (existing >= 0) {
      files[existing] = parsed;
      sources[existing] = source; // provenance follows a same-name replace
      dirtyFiles.delete(entry.name); // the re-upload supersedes session edits
    } else {
      files.push(parsed);
      sources.push(source);
    }
  }
  rulesState.set({ ...rulesState.get(), phase: 'loading', files, sources, dirtyFiles });
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

/**
 * The currently installed dataset lint context (null before any dataset).
 * Studio reads it for draft-rule EXPLAIN lint and the completion catalog —
 * any non-null `store.dataset` implies the Load view already installed one,
 * so Studio never has to touch getBridge() itself.
 */
export function getLintContext(): DatasetLintContext | null {
  return currentCtx;
}

// ---- in-session rule mutations (P17 Studio) --------------------------------

interface RuleCodecs {
  parseRuleFile: typeof import('./parse').parseRuleFile;
  serializeRuleFile: typeof import('./serialize').serializeRuleFile;
  deriveGroup: typeof import('./parse').deriveGroup;
  canonicalColumns: readonly CanonicalColumn[];
}

let codecsPromise: Promise<RuleCodecs> | null = null;

/** Memoized dynamic import of parse+serialize (entry-chunk discipline). */
function loadCodecs(): Promise<RuleCodecs> {
  codecsPromise ??= Promise.all([import('./parse'), import('./serialize')]).then(
    ([parseMod, serializeMod]) => ({
      parseRuleFile: parseMod.parseRuleFile,
      serializeRuleFile: serializeMod.serializeRuleFile,
      deriveGroup: parseMod.deriveGroup,
      canonicalColumns: parseMod.CANONICAL_COLUMNS,
    }),
  );
  return codecsPromise;
}

/**
 * Shared mutation core. The mutated RuleFile round-trips serialize→parse so
 * `rowNumber`/`sourceFile` and parse-level issues re-derive from the canonical
 * bytes (a file emptied by deletion re-acquires the spec-true `empty-file`
 * error; rowNumbers renumber — UI selection must key on (fileName, index),
 * never rowNumber). Snapshot → mutate → set() runs with no interleaved await
 * (the codec import happens before the snapshot), then relint publishes.
 * Returns null when the file vanished mid-edit or `mutate` rejected the input.
 */
async function mutateFile(
  fileName: string,
  mutate: (rules: readonly QCRule[], state: RulesSlotState) => QCRule[] | null,
): Promise<ParsedRuleFile | null> {
  const { parseRuleFile, serializeRuleFile } = await loadCodecs();
  const current = rulesState.get();
  const fileIdx = current.files.findIndex((f) => f.file.name === fileName);
  const parsed = current.files[fileIdx];
  if (parsed === undefined) return null;
  const nextRules = mutate(parsed.file.rules, current);
  if (nextRules === null) return null;
  const reparsed = parseRuleFile(
    serializeRuleFile({ ...parsed.file, rules: nextRules }),
    fileName,
  );
  const files = [...current.files];
  files[fileIdx] = reparsed;
  const dirtyFiles = new Set(current.dirtyFiles);
  dirtyFiles.add(fileName);
  rulesState.set({ ...rulesState.get(), phase: 'loading', files, dirtyFiles });
  await relint(files);
  return reparsed;
}

/**
 * Create a pristine in-session rules file (0 rules, all canonical headers, no
 * issues — deliberately NOT the round-trip, which would brand an empty file
 * with the `empty-file` error meant for uploads). Name gets `.quac.csv`
 * appended unless it already ends in `.csv`.
 */
export async function createRuleFile(
  name: string,
): Promise<{ ok: true; fileName: string } | { ok: false; reason: 'duplicate' | 'empty-name' }> {
  const { deriveGroup, canonicalColumns } = await loadCodecs();
  const trimmed = name.trim();
  if (trimmed === '') return { ok: false, reason: 'empty-name' };
  const fileName = /\.csv$/i.test(trimmed) ? trimmed : `${trimmed}.quac.csv`;
  const current = rulesState.get();
  if (current.files.some((f) => f.file.name === fileName)) {
    return { ok: false, reason: 'duplicate' };
  }
  const parsed: ParsedRuleFile = {
    file: { name: fileName, group: deriveGroup(fileName), rules: [], extraColumns: [] },
    issues: [],
    presentHeaders: [...canonicalColumns],
  };
  const files = [...current.files, parsed];
  const sources = [...current.sources, null];
  const dirtyFiles = new Set(current.dirtyFiles);
  dirtyFiles.add(fileName);
  rulesState.set({ ...rulesState.get(), phase: 'loading', files, sources, dirtyFiles });
  await relint(files);
  return { ok: true, fileName };
}

/** Replace the rule at `index`; the round-trip recomputes rowNumber/sourceFile,
 *  so callers may pass placeholders there. False = file/index vanished. */
export async function updateRule(fileName: string, index: number, rule: QCRule): Promise<boolean> {
  const result = await mutateFile(fileName, (rules) => {
    if (index < 0 || index >= rules.length) return null;
    const next = [...rules];
    next[index] = rule;
    return next;
  });
  return result !== null;
}

/** Append a rule (row order = correction order — new rules run last). Returns
 *  the new rule's index, or null when the file vanished. */
export async function insertRule(fileName: string, rule: QCRule): Promise<number | null> {
  let newIndex = -1;
  const result = await mutateFile(fileName, (rules) => {
    newIndex = rules.length;
    return [...rules, rule];
  });
  return result === null ? null : newIndex;
}

/** Delete the rule at `index`. Removing the last rule leaves an empty file —
 *  the round-trip re-acquires the `empty-file` lint error (documented). */
export async function removeRule(fileName: string, index: number): Promise<boolean> {
  const result = await mutateFile(fileName, (rules) => {
    if (index < 0 || index >= rules.length) return null;
    return rules.filter((_, i) => i !== index);
  });
  return result !== null;
}

/** Swap the rule with its neighbour. Returns the rule's new index, or null at
 *  the edges (callers disable the buttons; this is the backstop). */
export async function moveRule(
  fileName: string,
  index: number,
  dir: 'up' | 'down',
): Promise<number | null> {
  const target = dir === 'up' ? index - 1 : index + 1;
  const result = await mutateFile(fileName, (rules) => {
    const a = rules[index];
    const b = rules[target];
    if (a === undefined || b === undefined) return null;
    const next = [...rules];
    next[index] = b;
    next[target] = a;
    return next;
  });
  return result === null ? null : target;
}

/**
 * Duplicate the rule at `index`, inserted right after the original with a
 * fresh id — `{id}_copy`, then `{id}_copy2`… — unique across ALL loaded files.
 * Returns the copy's index, or null when the file/index vanished.
 */
export async function duplicateRule(fileName: string, index: number): Promise<number | null> {
  const result = await mutateFile(fileName, (rules, state) => {
    const original = rules[index];
    if (original === undefined) return null;
    const taken = new Set<string>();
    for (const f of state.files) {
      for (const r of f.file.rules) taken.add(r.ruleId);
    }
    let candidate = `${original.ruleId}_copy`;
    for (let n = 2; taken.has(candidate); n++) candidate = `${original.ruleId}_copy${String(n)}`;
    const copy: QCRule = { ...original, ruleId: candidate, extras: { ...original.extras } };
    const next = [...rules];
    next.splice(index + 1, 0, copy);
    return next;
  });
  return result === null ? null : index + 1;
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
