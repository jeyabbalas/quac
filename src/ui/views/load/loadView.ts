/**
 * Load view (ingestion.md §1): persistent hint line, the three input slot
 * cards, and the plain 50-row preview under them. Dataset (P05) and JSON
 * Schema (P06) cards are live — the Rules card is an inert placeholder frame
 * P12 replaces with a single mount call.
 */
import { effect } from '../../../app/signals';
import { createSlotCard } from '../../components/slotCard';
import { renderPreviewTable } from '../../components/plainPreviewTable';
import { mountDatasetCard } from './datasetCard';
import { mountSchemaSlotCard } from './schema/schemaSlotCard';
import type { ShellContext } from '../../../app/shell';

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
  mountPlaceholderCard(rulesHost, 'QC Rules', 'Rules loading arrives in a later phase.');

  const preview = document.createElement('section');
  preview.className = 'q-preview';
  preview.hidden = true;
  const previewTitle = document.createElement('h2');
  previewTitle.className = 'q-preview-title';
  const previewHost = document.createElement('div');
  preview.append(previewTitle, previewHost);

  container.append(hint, grid, preview);

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

function mountPlaceholderCard(container: HTMLElement, title: string, body: string): void {
  const card = createSlotCard(title);
  const note = document.createElement('p');
  note.className = 'q-slotcard-placeholder';
  note.textContent = body;
  card.bodyHost.append(note);
  container.append(card.el);
}
