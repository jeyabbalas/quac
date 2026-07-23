/**
 * Load view (ingestion.md §1): persistent hint line, the three input slot
 * cards (Dataset P05 · JSON Schema P06 · QC Rules P12), the plain 50-row
 * preview, and the P14 run bar (Apply-corrections toggle + Run QC button —
 * enabled when Dataset + at least one of Schema/Rules are valid; never
 * auto-runs).
 */
import { effect } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { renderPreviewTable } from '../../components/plainPreviewTable';
import { mountDatasetCard } from './datasetCard';
import { mountPertinenceStrip } from './pertinence/pertinenceStrip';
import { mountRulesSlotCard } from './rulesSlotCard';
import { mountSchemaSlotCard } from './schema/schemaSlotCard';
import type { ShellContext } from '../../../app/shell';
import type { SlotState } from '../../../app/store';

export function mountLoadView(container: HTMLElement, ctx: ShellContext): void {
  const hint = document.createElement('p');
  hint.className = 'q-load-hint';
  hint.textContent = 'Uploads live only in this tab. Reload = re-upload. URLs reload themselves.';

  const grid = document.createElement('div');
  grid.className = 'q-slotgrid';
  const dataHost = document.createElement('div');
  dataHost.dataset.slot = 'data';
  const schemaHost = document.createElement('div');
  schemaHost.dataset.slot = 'schema';
  const rulesHost = document.createElement('div');
  rulesHost.dataset.slot = 'rules';
  grid.append(dataHost, schemaHost, rulesHost);

  mountDatasetCard(dataHost, ctx);
  mountSchemaSlotCard(schemaHost);
  mountRulesSlotCard(rulesHost, ctx);

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
  runButton.textContent = 'Run QC ▸';
  runButton.addEventListener('click', () => {
    void (async () => {
      const { startRun } = await import('../../../app/runController');
      await startRun(ctx);
    })().catch((err: unknown) => {
      reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
    });
  });
  runBar.append(reason, toggleLabel, runButton);

  container.append(hint, grid, pertinenceHost, preview, runBar);

  const usable = (slot: SlotState): boolean =>
    slot.status === 'valid' || slot.status === 'warning';
  effect(() => {
    const data = ctx.store.slots.data.get();
    const schema = ctx.store.slots.schema.get();
    const rules = ctx.store.slots.rules.get();
    const stage = ctx.store.pipeline.get().stage;
    const running = stage !== 'idle' && stage !== 'done' && stage !== 'cancelled' && stage !== 'failed';

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
