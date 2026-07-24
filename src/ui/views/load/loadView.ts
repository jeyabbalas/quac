/**
 * Load view (ingestion.md §1): persistent hint line, the three input slot
 * cards (Dataset P05 · JSON Schema P06 · QC Rules P12), the plain 50-row
 * preview, and the P14 run bar (Apply-corrections toggle + Run QC button —
 * enabled when Dataset + at least one of Schema/Rules are valid; never
 * auto-runs).
 */
import { effect } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { assetUrl } from '../../../app/urlBase';
import { registerDatasetUrlLoader } from '../../../app/bootConfig';
import { renderPreviewTable } from '../../components/plainPreviewTable';
import { addRuleUrls } from '../../../core/rules/rules-store';
import { loadSchemaUrls } from '../../../core/schema/schema-store';
import { mountDatasetCard } from './datasetCard';
import { mountPertinenceStrip } from './pertinence/pertinenceStrip';
import { mountRulesSlotCard } from './rulesSlotCard';
import { mountSchemaSlotCard } from './schema/schemaSlotCard';
import { isRunningStage } from '../../../app/store';
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
      dataCard.fetchUrl(abs(manifest.dataset)); // dataset card owns its own progress UI
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
  mountSchemaSlotCard(schemaHost);
  mountRulesSlotCard(rulesHost, ctx);

  // P16: the boot flow drives the Dataset card's own URL loader (real progress).
  registerDatasetUrlLoader(dataCard.fetchUrl);

  // P16 partial-config UX: a pre-configured link that filled Schema/Rules but
  // not the Dataset highlights the empty slot with a nudge (never auto-runs).
  const preconfigHint = document.createElement('p');
  preconfigHint.className = 'q-preconfig-hint';
  preconfigHint.hidden = true;
  dataHost.prepend(preconfigHint);

  // Pertinence verdict sits between the slot cards and the preview (§E.5).
  const pertinenceHost = document.createElement('div');
  mountPertinenceStrip(pertinenceHost, ctx);

  const preview = document.createElement('section');
  preview.className = 'q-preview';
  preview.hidden = true;
  const previewTitle = document.createElement('h2');
  previewTitle.className = 'q-preview-title';
  const previewHost = document.createElement('div');
  preview.append(previewTitle, previewHost);

  // ---- Run bar (P14): toggle + Run QC + disabled-state reason ----
  const runBar = document.createElement('section');
  runBar.className = 'q-runbar';
  const reason = document.createElement('p');
  reason.className = 'q-runbar-reason';
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'q-runbar-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = ctx.store.applyCorrections.get();
  toggle.addEventListener('change', () => {
    ctx.store.applyCorrections.set(toggle.checked);
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
  runBar.append(reason, toggleLabel, runButton);

  container.append(hint, example, grid, pertinenceHost, preview, runBar);

  const usable = (slot: SlotState): boolean =>
    slot.status === 'valid' || slot.status === 'warning';

  // Hero visibility: first-run only. Any filled slot (or a pre-configured
  // link) means the user is past the pitch.
  effect(() => {
    const anyFilled =
      ctx.store.slots.data.get().status !== 'empty' ||
      ctx.store.slots.schema.get().status !== 'empty' ||
      ctx.store.slots.rules.get().status !== 'empty';
    example.hidden = anyFilled || ctx.store.preconfigured.get();
  });
  effect(() => {
    const data = ctx.store.slots.data.get();
    const schema = ctx.store.slots.schema.get();
    const rules = ctx.store.slots.rules.get();
    const running = isRunningStage(ctx.store.pipeline.get().stage);

    let why = '';
    if (running) why = 'A QC run is in progress…';
    else if (data.status === 'loading') why = 'The dataset is still loading…';
    else if (data.status !== 'valid') why = 'Load a dataset to run QC.';
    else if (!usable(schema) && !usable(rules))
      why = 'Load a JSON Schema or a QC rules file to run QC.';
    runButton.disabled = why !== '';
    reason.textContent = why;
    reason.hidden = why === '';
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

  // Preview refresh: engine access stays behind a dynamic import so the
  // entry chunk never pulls bridge/data-table code (bundle gate).
  let renderedGeneration = 0;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    if (!dataset) {
      preview.hidden = true;
      renderedGeneration = 0;
      return;
    }
    if (dataset.generation === renderedGeneration) return;
    renderedGeneration = dataset.generation;
    const generation = dataset.generation;
    void (async () => {
      const [{ getBridge }, { DATA_VIEW }] = await Promise.all([
        import('../../../core/bridge/bridge'),
        import('../../../core/bridge/tables'),
      ]);
      const bridge = await getBridge();
      const rows = await bridge.query(
        `SELECT * EXCLUDE (__row__) FROM ${DATA_VIEW} ORDER BY __row__ LIMIT 50`,
      );
      if (ctx.store.dataset.get()?.generation !== generation) return; // stale
      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      previewTitle.textContent = `Preview (first ${String(rows.length)} rows)`;
      renderPreviewTable(previewHost, columns, rows);
      preview.hidden = false;
    })().catch(() => {
      preview.hidden = true; // preview is best-effort; errors surface via the slot
    });
  });
}
