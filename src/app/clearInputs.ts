/**
 * Clear-input actions (UIX-7): every explicit clear routes through here.
 * Contract per action —
 *   1. confirm only when work would be lost (unsaved Studio edits; clear-all
 *      always asks),
 *   2. invalidate the previous run (`invalidateRun` — pill dark, panels
 *      empty, in-flight run cancelled),
 *   3. clear the slot's store,
 *   4. re-sync the address bar from the REMAINING live sources through the one
 *      shared writer (`hashSync`), which rebuilds the fragment from whatever
 *      the stores now hold — so a reload restores exactly what is on screen,
 *      and Back never becomes "un-clear",
 *   5. announce with one polite toast — the only announcement path AT users
 *      get, badges are not live regions.
 *
 * Step 4 is also driven by `installHashSync`'s store effect (UIX-10); these
 * explicit calls are kept anyway — they are idempotent, and they cover a clear
 * that lands during the boot window, before that effect is armed.
 *
 * Entry-chunk discipline: bridge/tables stay behind dynamic imports; the
 * static imports here are stores and signals-adjacent app modules — all
 * already entry-resident.
 */
import { syncHashFromStores } from './hashSync';
import { openModal } from './modal';
import { invalidateRun } from './runInvalidation';
import { peekRulesDraftFile } from './rulesDraftProbe';
import { signal } from './signals';
import { showToast } from './toast';
import { clearRuleFiles, removeRuleFile, rulesState } from '../core/rules/rules-store';
import { resetSchemaSlot } from '../core/schema/schema-store';
import type { ShellContext } from './shell';

// ---- dataset-card UI hooks --------------------------------------------------

export interface DatasetClearUi {
  /** Hold/release the card's busy latch (gates EVERY ingest entry point —
   *  drop, browse, URL, example, boot — without revealing the progress bar). */
  setBusy: (busy: boolean) => void;
  /** Wipe card-local DOM: details list, CORS guidance, typed URL. */
  clearLocalUi: () => void;
  /** True while an ingest (or another clear) owns the card. */
  isBusy: () => boolean;
}

let datasetClearUi: DatasetClearUi | null = null;

/** The Dataset card registers its closure hooks on mount (bootConfig's
 *  `registerDatasetUrlLoader` precedent) so clear-all can drive them too. */
export function registerDatasetClearUi(ui: DatasetClearUi): void {
  datasetClearUi = ui;
}

/** The latch as a SIGNAL: the release comes AFTER the last slot write, so a
 *  plain closure read would leave run-bar effects stuck on the stale value. */
const datasetBusy = signal(false);

/** The dataset card reports every latch transition (ingest and clear paths). */
export function noteDatasetBusy(value: boolean): void {
  datasetBusy.set(value);
}

/** Run-bar gating: whether the dataset card's busy latch is held (an ingest
 *  or another clear owns the slot — clear-all would refuse the dataset leg).
 *  Reads the signal, so calling effects re-run on release. */
export function isDatasetUiBusy(): boolean {
  return datasetBusy.get();
}

// ---- feedback ---------------------------------------------------------------

function announceClear(message: string, hadRun: boolean): void {
  showToast(message, {
    kind: 'info',
    ...(hadRun ? { hint: 'The QC report was reset.' } : {}),
  });
}

// ---- confirm dialog ---------------------------------------------------------

interface ConfirmOptions {
  title: string;
  question: string;
  note: string;
  verb: string;
}

/** Shared destructive-confirm dialog (Studio's confirmDeleteRule pattern):
 *  Cancel-then-verb order, focus opens on Cancel, ×/Esc/backdrop = false. */
function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const modal = openModal({
      title: options.title,
      onClose: () => {
        settle(false);
      },
    });
    const text = document.createElement('p');
    text.textContent = options.question;
    const note = document.createElement('p');
    note.className = 'q-panel-note';
    note.textContent = options.note;
    const actions = document.createElement('div');
    actions.className = 'q-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'q-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      modal.close();
    });
    const verb = document.createElement('button');
    verb.type = 'button';
    verb.className = 'q-btn q-btn--primary';
    verb.textContent = options.verb;
    verb.addEventListener('click', () => {
      settle(true);
      modal.close();
    });
    actions.append(cancel, verb);
    modal.body.append(text, note, actions);
    // openModal focuses the first focusable (the header ×); a destructive
    // dialog should open on the safe choice instead.
    cancel.focus();
  });
}

/** dirtyFiles ∪ the open unsaved drawer draft (invisible to dirtyFiles —
 *  only saved edits land there, yet a clear destroys the draft too). */
function unsavedRuleWork(): string[] {
  const names = [...rulesState.get().dirtyFiles];
  const draft = peekRulesDraftFile();
  if (draft !== null && !names.includes(draft)) names.push(draft);
  return names;
}

// ---- actions ----------------------------------------------------------------

/**
 * Clear the dataset slot: run invalidated, card UI wiped, slot emptied, hash
 * rewritten, and the DuckDB tables dropped best-effort. The card's busy latch
 * is HELD across the awaited drop (R4): it gates every ingest entry point, so
 * a re-upload cannot land between the clear and the drop and lose its fresh
 * tables; the dataset-null re-check after the lazy import is the backstop.
 * Refuses while an ingest owns the slot — `runIngest` would overwrite the
 * cleared slot on settle, and a mid-CTAS worker cannot be interrupted.
 */
export async function clearDataset(ctx: ShellContext): Promise<boolean> {
  const done = await clearDatasetCore(ctx);
  if (!done) return false;
  syncHashFromStores(ctx.store);
  return true;
}

/** Shared with clearAllInputs (which does its own hash sync + toast).
 *  Returns false when the card is busy (nothing was cleared). */
async function clearDatasetCore(ctx: ShellContext, announce = true): Promise<boolean> {
  const ui = datasetClearUi;
  if (ui === null || ui.isBusy()) return false;
  const hadRun = ctx.store.run.get() !== null;
  ui.setBusy(true);
  try {
    invalidateRun(ctx.store);
    // Card-local DOM before the slot write: the details list must not survive
    // into the empty state (it is also the escape hatch from a failed
    // re-ingest's stale session — dataset-error keeps working).
    ui.clearLocalUi();
    ctx.store.dataset.set(null);
    ctx.store.slots.data.set({ status: 'empty', detail: '' });
    if (announce) announceClear('Dataset cleared.', hadRun);
    await dropTablesBestEffort(ctx);
  } finally {
    ui.setBusy(false);
  }
  return true;
}

/** Never boots the bridge (peekBridge); failures are swallowed — a missed
 *  drop only means the memory is reclaimed when the session ends. */
async function dropTablesBestEffort(ctx: ShellContext): Promise<void> {
  try {
    const { peekBridge } = await import('../core/bridge/bridge');
    const pending = peekBridge();
    if (pending === null) return; // no bridge ⇒ no tables
    const bridge = await pending;
    if (ctx.store.dataset.get() !== null) return; // a re-upload won — keep its tables
    const { dropDatasetTables } = await import('../core/bridge/tables');
    await dropDatasetTables(bridge);
  } catch {
    // Best-effort by design.
  }
}

/** Clear the JSON Schema slot. No confirm — a schema holds no session edits.
 *  The cast revert rides typedSync's hadSchemaForGeneration path. */
export function clearSchema(ctx: ShellContext): void {
  const hadRun = ctx.store.run.get() !== null;
  resetSchemaSlot();
  invalidateRun(ctx.store);
  syncHashFromStores(ctx.store);
  announceClear('JSON Schema cleared.', hadRun);
}

/** Clear ALL rules files. Confirms only when unsaved Studio work would be
 *  lost (saved-dirty files or an open drawer draft). */
export async function clearRules(ctx: ShellContext): Promise<void> {
  const unsaved = unsavedRuleWork();
  if (unsaved.length > 0) {
    const ok = await confirmDialog({
      title: 'Clear the QC rules?',
      question: 'Remove all loaded QC rules files from this session?',
      note: `Unsaved Rule Studio edits in ${unsaved.join(', ')} will be lost. Download the rules CSV first if you want a copy.`,
      verb: 'Clear rules',
    });
    if (!ok) return;
  }
  const hadRun = ctx.store.run.get() !== null;
  invalidateRun(ctx.store);
  clearRuleFiles();
  syncHashFromStores(ctx.store);
  announceClear('QC rules cleared.', hadRun);
}

/** Remove ONE rules file (the per-file ✕). Confirms only when that file
 *  carries unsaved Studio work — saved-dirty or the open drawer draft. */
export async function removeRulesFile(ctx: ShellContext, name: string): Promise<void> {
  const state = rulesState.get();
  if (!state.files.some((f) => f.file.name === name)) return;
  const losesDraft = state.dirtyFiles.has(name) || peekRulesDraftFile() === name;
  if (losesDraft) {
    const ok = await confirmDialog({
      title: 'Remove this rules file?',
      question: `Remove ${name} from this session?`,
      note: 'It has unsaved edits from Rule Studio that will be lost. Download the rules CSV first if you want a copy.',
      verb: 'Remove file',
    });
    if (!ok) return;
  }
  const hadRun = ctx.store.run.get() !== null;
  invalidateRun(ctx.store);
  const removed = await removeRuleFile(name);
  if (!removed) return; // vanished while the dialog was open
  syncHashFromStores(ctx.store);
  announceClear(`Removed ${name}.`, hadRun);
}

/**
 * Clear every input. ALWAYS confirms (owner decision 3). Ordering pinned —
 * the signals have no batching, so the preconfigured flag drops FIRST (the
 * example-hero/preconfig nudge must not flash mid-clear), then rules, schema,
 * dataset, and ONE hash sync at the end.
 */
export async function clearAllInputs(ctx: ShellContext): Promise<void> {
  const unsaved = unsavedRuleWork();
  const baseNote = 'The QC report resets too. Your files stay on your computer.';
  const ok = await confirmDialog({
    title: 'Clear all inputs?',
    question: 'Remove the dataset, the JSON Schema, and the QC rules from this session?',
    note:
      unsaved.length > 0
        ? `Unsaved Rule Studio edits in ${unsaved.join(', ')} will be lost — download the rules CSV first if you want a copy. ${baseNote}`
        : baseNote,
    verb: 'Clear all inputs',
  });
  if (!ok) return;
  const hadRun = ctx.store.run.get() !== null;
  ctx.store.preconfigured.set(false);
  invalidateRun(ctx.store); // even if the dataset card refuses below, the run must die
  clearRuleFiles();
  resetSchemaSlot();
  await clearDatasetCore(ctx, false);
  syncHashFromStores(ctx.store);
  announceClear('All inputs cleared.', hadRun);
}
