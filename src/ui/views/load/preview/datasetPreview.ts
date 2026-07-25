/**
 * Preview → Dataset panel: the first 50 rows of the `data` view, with each
 * column's DuckDB storage type under its name.
 *
 * Engine access stays behind dynamic imports so the entry chunk never pulls
 * bridge/data-table code (bundle gate) — tables.ts statically imports
 * @jeyabbalas/data-table, so even PREVIEW_SQL has to arrive this way.
 */
import { effect } from '../../../../app/signals';
import { typedRevision } from '../../../../app/typedSync';
import { renderPreviewTable } from '../../../components/plainPreviewTable';
import { datasetMetaLine } from './previewModel';
import type { ShellContext } from '../../../../app/shell';

export function mountDatasetPreview(panel: HTMLElement, ctx: ShellContext): void {
  const head = document.createElement('div');
  head.className = 'q-preview-panelhead';
  const title = document.createElement('h3');
  title.className = 'q-preview-paneltitle';
  title.textContent = 'Dataset preview';
  const meta = document.createElement('span');
  meta.className = 'q-preview-meta';
  head.append(title, meta);

  const body = document.createElement('div');
  panel.append(head, body);

  const showNote = (text: string): void => {
    meta.textContent = '';
    const note = document.createElement('p');
    note.className = 'q-panel-note';
    note.textContent = text;
    body.replaceChildren(note);
  };
  showNote('Load a dataset to see its rows here.');

  let renderedKey = '';
  effect(() => {
    const dataset = ctx.store.dataset.get();
    // Keyed on the typed rebuild too, not generation alone: installTypedSync
    // re-points the `data` view at CAST columns without touching generation,
    // so a generation-only key would leave the type row reading VARCHAR for
    // ever after a schema loads (see typedSync.ts's typedRevision).
    const revision = typedRevision.get();
    if (dataset === null) {
      renderedKey = '';
      showNote('Load a dataset to see its rows here.');
      return;
    }
    const key = `${String(dataset.generation)}|${String(revision)}`;
    if (key === renderedKey) return;
    renderedKey = key;
    const isStale = (): boolean =>
      ctx.store.dataset.get()?.generation !== dataset.generation ||
      typedRevision.get() !== revision;

    void (async () => {
      const [{ getBridge }, { PREVIEW_SQL, DATA_VIEW }, { describeColumns }] = await Promise.all([
        import('../../../../core/bridge/bridge'),
        import('../../../../core/bridge/tables'),
        import('../../../../core/schema/casting'),
      ]);
      const bridge = await getBridge();
      // Rows first, types second, so a DESCRIBE failure costs the type row and
      // nothing else.
      const rows = await bridge.query(PREVIEW_SQL);
      if (isStale()) return;
      // DATA_VIEW explicitly: describeColumns defaults to quac_raw, which is
      // all-VARCHAR by construction for CSV/TSV/XLSX (ingest.ts:9) and would
      // never show a BIGINT. DESCRIBE "data" returns post-cast types — what
      // these rows actually contain.
      const columnTypes = await describeColumns(bridge, DATA_VIEW).catch(() => null);
      if (isStale()) return; // re-check: DESCRIBE was a second await

      const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];
      const line = datasetMetaLine(rows.length, dataset.rowCount, dataset.columnCount);
      meta.textContent = line;
      // The visible meta line uses a middle dot; a screen reader reading the
      // caption wants a comma and a sentence.
      const spoken = line.replace(' · ', ', ');
      renderPreviewTable(body, columns, rows, {
        ...(columnTypes === null ? {} : { columnTypes }),
        regionLabel: 'Dataset preview',
        caption:
          `Dataset preview. ${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}.` +
          (columnTypes === null ? '' : " The second header row gives each column's storage type."),
      });
    })().catch(() => {
      // Best-effort: real ingest errors surface on the slot card.
      renderedKey = '';
      showNote('Load a dataset to see its rows here.');
    });
  });
}
