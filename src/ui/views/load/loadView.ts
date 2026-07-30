/**
 * Load view (ingestion.md §1): persistent hint line, the three input slot
 * cards (Dataset P05 · JSON Schema P06 · QC Rules P12), the tabbed Preview
 * section (UIX-4 — dataset rows, data dictionary, QC rules), and the P14 run
 * bar (Apply-corrections toggle + Run QC button — enabled when Dataset + at
 * least one of Schema/Rules are valid; never auto-runs).
 */
import { effect } from '../../../app/signals';
import { clearAllInputs, isDatasetUiBusy } from '../../../app/clearInputs';
import { reportError } from '../../../app/errors';
import { assetUrl } from '../../../app/urlBase';
import { registerDatasetUrlLoader } from '../../../app/bootConfig';
import { registerDatasetRestoreLoader } from '../../../app/sessionPersistence';
import { addRuleUrls } from '../../../core/rules/rules-store';
import { loadSchemaUrls } from '../../../core/schema/schema-store';
import { mountDatasetCard } from './datasetCard';
import { mountPreviewSection } from './preview/previewSection';
import { mountRulesSlotCard } from './rulesSlotCard';
import { mountSchemaSlotCard } from './schema/schemaSlotCard';
import { assessRunReadiness } from '../../../app/runReadiness';
import type { ShellContext } from '../../../app/shell';
import type { SlotState } from '../../../app/store';
import './loadView.css';

interface ExampleIndex {
  dataset: string;
  schema: string[];
  rules: string[];
}

export function mountLoadView(container: HTMLElement, ctx: ShellContext): void {
  const hint = document.createElement('p');
  hint.className = 'q-load-hint';
  hint.textContent =
    'Files stay in this tab and are gone on reload — re-upload then, or load by URL and let QuaC re-fetch for you.';

  // ---- First-run hero (P14 demo affordance): one click fills all 3 slots.
  // Recedes the moment any slot holds something (or a link pre-configured
  // the session) — returning users go straight to their cards. ----
  const example = document.createElement('section');
  example.className = 'q-example';
  const exampleDuck = document.createElement('img');
  exampleDuck.className = 'q-example-duck';
  exampleDuck.src = assetUrl('logo/quac-duck.svg');
  exampleDuck.alt = '';
  const exampleBody = document.createElement('div');
  exampleBody.className = 'q-example-body';
  const exampleTitle = document.createElement('h2');
  exampleTitle.className = 'q-example-title';
  exampleTitle.textContent = 'New here? Take QuaC for a spin.';
  const examplePitch = document.createElement('p');
  examplePitch.className = 'q-example-pitch';
  examplePitch.textContent =
    'One click loads the bundled HESP example — a dirty dataset, its 14-file JSON Schema, ' +
    'and 3 QC rules files — ready for a full QC run.';
  exampleBody.append(exampleTitle, examplePitch);
  const exampleButton = document.createElement('button');
  exampleButton.type = 'button';
  exampleButton.className = 'q-btn q-btn--primary q-example-load';
  exampleButton.textContent = 'Load example files';
  exampleButton.addEventListener('click', () => {
    exampleButton.disabled = true;
    void (async () => {
      const base = `${import.meta.env.BASE_URL}examples/`;
      const abs = (path: string): string => new URL(base + path, window.location.href).toString();
      const response = await fetch(abs('index.json'));
      if (!response.ok) throw new Error(`example manifest HTTP ${String(response.status)}`);
      const manifest = (await response.json()) as ExampleIndex;
      void dataCard.fetchUrl(abs(manifest.dataset)); // dataset card owns its own progress UI
      await Promise.all([
        loadSchemaUrls(manifest.schema.map(abs)),
        addRuleUrls(manifest.rules.map(abs)),
      ]);
    })()
      .catch((err: unknown) => {
        reportError(err, { fallbackCode: 'FETCH_HTTP' });
      })
      .finally(() => {
        exampleButton.disabled = false;
      });
  });
  example.append(exampleDuck, exampleBody, exampleButton);

  // UIX-6: the input contract, stated once above the cards; the Required /
  // Optional tags on the cards themselves carry the per-slot half.
  const rubric = document.createElement('p');
  rubric.className = 'q-load-rubric';
  rubric.textContent =
    'QuaC needs your dataset plus at least one source of checks — a JSON Schema, QC rules, or both.';

  const grid = document.createElement('div');
  grid.className = 'q-slotgrid';
  const dataHost = document.createElement('div');
  dataHost.dataset.slot = 'data';
  const schemaHost = document.createElement('div');
  schemaHost.dataset.slot = 'schema';
  const rulesHost = document.createElement('div');
  rulesHost.dataset.slot = 'rules';
  grid.append(dataHost, schemaHost, rulesHost);

  const dataCard = mountDatasetCard(dataHost, ctx);
  mountSchemaSlotCard(schemaHost, ctx);
  mountRulesSlotCard(rulesHost, ctx);

  // P16: the boot flow drives the Dataset card's own URL loader (real progress).
  registerDatasetUrlLoader(dataCard.fetchUrl);
  // P19b: session restore replays the persisted bytes through the same card.
  registerDatasetRestoreLoader(dataCard.restoreBlob);

  // P16 partial-config UX: a pre-configured link that filled Schema/Rules but
  // not the Dataset highlights the empty slot with a nudge (never auto-runs).
  const preconfigHint = document.createElement('p');
  preconfigHint.className = 'q-preconfig-hint';
  preconfigHint.hidden = true;
  dataHost.prepend(preconfigHint);

  // Preview (UIX-4): all three inputs in one tabbed panel. Owns its own
  // visibility and data effects — including the §E.5 input-consistency line,
  // which is a caution about these inputs and now sits in the Preview head.
  const previewHost = document.createElement('div');
  mountPreviewSection(previewHost, ctx);

  // ---- Run bar (P14): toggle + Run QC + disabled-state reason ----
  const runBar = document.createElement('section');
  runBar.className = 'q-runbar';
  // UIX-7: session-wide reset, pinned to the bar's far left — diagonally
  // opposite Run QC, so the destructive act can't be fat-fingered from the
  // primary one. Hidden while every slot is empty (which also closes the
  // clear-all-during-boot-manifest-fetch window: nothing shows until a slot
  // fills). clearAllInputs always confirms.
  const clearAll = document.createElement('button');
  clearAll.type = 'button';
  clearAll.className = 'q-btn q-btn--ghost q-btn--small q-clearall';
  clearAll.textContent = 'Clear all inputs';
  clearAll.hidden = true;
  clearAll.addEventListener('click', () => {
    void clearAllInputs(ctx).then(() => {
      const allEmpty = (['data', 'schema', 'rules'] as const).every(
        (id) => ctx.store.slots[id].get().status === 'empty',
      );
      // The button hid itself — hand keyboard focus to the dataset card's
      // browse control. A cancelled confirm keeps the native restore.
      if (allEmpty) dataCard.focusBrowse();
    });
  });
  const reason = document.createElement('p');
  reason.className = 'q-runbar-reason';
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'q-runbar-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.addEventListener('change', () => {
    ctx.store.applyCorrections.set(toggle.checked);
  });
  // Effect, not a one-shot read: the P19b session restore writes this signal
  // (possibly after mount), and a restored `false` must not render checked.
  effect(() => {
    toggle.checked = ctx.store.applyCorrections.get();
  });
  toggleLabel.append(toggle, document.createTextNode(' Apply corrections'));
  toggleLabel.title = 'Off = assess-only: schema and validation rules run on the untouched data.';
  const runButton = document.createElement('button');
  runButton.type = 'button';
  runButton.className = 'q-btn q-btn--primary q-runbar-button';
  runButton.textContent = 'Run QC';
  runButton.addEventListener('click', () => {
    void (async () => {
      const { startRun } = await import('../../../app/runController');
      await startRun(ctx);
    })().catch((err: unknown) => {
      reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
    });
  });
  runBar.append(clearAll, reason, toggleLabel, runButton);

  container.append(hint, example, rubric, grid, previewHost, runBar);

  const usable = (slot: SlotState): boolean =>
    slot.status === 'valid' || slot.status === 'warning';

  // Hero visibility: first-run only. Any filled slot (or a pre-configured
  // link) means the user is past the pitch. The same anyFilled drives the
  // Clear-all button the other way, and the dataset leg gates it: an ingest
  // in flight cannot be cleared (the busy latch also covers the pre-loading
  // sliver the slot status misses).
  effect(() => {
    const anyFilled =
      ctx.store.slots.data.get().status !== 'empty' ||
      ctx.store.slots.schema.get().status !== 'empty' ||
      ctx.store.slots.rules.get().status !== 'empty';
    example.hidden = anyFilled || ctx.store.preconfigured.get();
    clearAll.hidden = !anyFilled;
    clearAll.disabled = ctx.store.slots.data.get().status === 'loading' || isDatasetUiBusy();
  });
  // The disabled state and its reason come from the ONE readiness predicate —
  // the same assessment startRun makes, so button and controller cannot drift.
  effect(() => {
    const readiness = assessRunReadiness(ctx.store);
    runButton.disabled = !readiness.ready;
    const text = readiness.ready
      ? (readiness.note ?? '')
      : [readiness.reason, readiness.hint].filter((s) => s !== undefined).join(' ');
    reason.textContent = text;
    reason.hidden = text === '';
    reason.classList.toggle('q-runbar-note', readiness.ready && readiness.note !== undefined);
  });

  // Partial-config highlight (P16): only for pre-configured sessions, and only
  // while the Dataset is still empty. Clears the moment a dataset loads.
  effect(() => {
    const preconfigured = ctx.store.preconfigured.get();
    const dataEmpty = ctx.store.slots.data.get().status === 'empty';
    const schemaReady = usable(ctx.store.slots.schema.get());
    const rulesReady = usable(ctx.store.slots.rules.get());
    const show = preconfigured && dataEmpty && (schemaReady || rulesReady);
    preconfigHint.hidden = !show;
    dataHost.classList.toggle('q-slot-highlight', show);
    if (show) {
      const subject = rulesReady && schemaReady ? 'Rules and a schema are' : rulesReady ? 'Rules are' : 'A schema is';
      preconfigHint.textContent = `${subject} pre-loaded. Add your dataset to run QC.`;
    }
  });
}
