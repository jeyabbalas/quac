/**
 * Studio live-preview pane (P18): a second data-table instance browsing a
 * ≤10,000-row sample of the canonical `data` view, with the rule-test panel
 * docked below. Lives in the lazy studio chunk, so the static data-table
 * import costs the entry bundle nothing.
 *
 * Grid discipline copied from reportGrid verbatim, as closure state: ONE
 * serialization queue (data-table calls must not overlap), a dataset
 * generation change destroys + recreates the instance, a same-generation
 * refresh (post-run corrected values) reuses loadData, and the build shows a
 * local DuckProgress. The sample export uses STUDIO_SAMPLE_SQL (__row__
 * excluded, ORDER BY __row__), so the grid's __rowid__ === QuaC's __row__
 * (V7) for every sampled row.
 */
import { createDataTable } from '@jeyabbalas/data-table';
import type { DataTable } from '@jeyabbalas/data-table';
import '@jeyabbalas/data-table/styles';
import { reportError } from '../../../app/errors';
import { getBridge } from '../../../core/bridge/bridge';
import {
  QUAC_STUDIO_DISPLAY,
  STUDIO_SAMPLE_ROW_CAP,
  STUDIO_SAMPLE_SQL,
  copyToParquetBytes,
} from '../../../core/bridge/tables';
import { PROGRESS_LABELS, createDuckProgress } from '../../components/duckProgress';
import type { DatasetSession } from '../../../app/store';

export interface PreviewPane {
  readonly el: HTMLElement;
  /**
   * Sync the sample grid to the dataset. `null` destroys the grid and shows
   * the no-dataset note; a generation change rebuilds; `{refresh: true}` on
   * the same generation reloads the sample bytes (post-run corrected values).
   * Callers gate on the studio route being ACTIVE — data-table mis-measures
   * in hidden containers.
   */
  syncDataset: (session: DatasetSession | null, opts?: { refresh?: boolean }) => void;
}

export function createPreviewPane(): PreviewPane {
  const el = document.createElement('section');
  el.className = 'q-studio-preview';
  el.setAttribute('aria-label', 'Live preview');

  const head = document.createElement('div');
  head.className = 'q-studio-previewhead';
  const title = document.createElement('h2');
  title.className = 'q-studio-previewtitle';
  title.textContent = 'Live preview';
  const meta = document.createElement('span');
  meta.className = 'q-studio-previewmeta';
  head.append(title, meta);

  const sampleWrap = document.createElement('div');
  sampleWrap.className = 'q-studio-samplewrap';
  const noDataNote = document.createElement('p');
  noDataNote.className = 'q-panel-note';
  noDataNote.textContent = 'Load a dataset to preview rules against it.';
  sampleWrap.append(noDataNote);

  const testPanel = document.createElement('div');
  testPanel.className = 'q-studio-testpanel';
  testPanel.hidden = true;

  el.append(head, sampleWrap, testPanel);

  // ---- sample grid (reportGrid's discipline, closure-scoped) ----
  let table: DataTable | undefined;
  let tableGeneration = 0;
  let queue: Promise<unknown> = Promise.resolve();
  /** Serialize every grid operation; failures do not poison the queue. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function destroyTable(): Promise<void> {
    if (table !== undefined) {
      await table.destroy();
      table = undefined;
    }
  }

  async function ensureTable(generation: number, refresh: boolean): Promise<void> {
    const bridge = await getBridge();
    if (table !== undefined && tableGeneration === generation) {
      if (!refresh) return;
      const bytes = await copyToParquetBytes(bridge, STUDIO_SAMPLE_SQL);
      await table.loadData(bytes.slice().buffer);
      return;
    }

    const progress = createDuckProgress();
    progress.setProgress(PROGRESS_LABELS.gridPrep, null);
    const gridHost = document.createElement('div');
    gridHost.className = 'q-studio-samplegrid';
    sampleWrap.replaceChildren(progress.el, gridHost);
    try {
      await destroyTable();
      const source = await copyToParquetBytes(bridge, STUDIO_SAMPLE_SQL);
      table = await createDataTable({
        container: gridHost,
        source: source.slice().buffer,
        sourceFormat: 'parquet',
        tableName: QUAC_STUDIO_DISPLAY,
        bridge,
        persistence: false,
      });
      tableGeneration = generation;
    } catch (err) {
      tableGeneration = 0; // retry on the next sync
      throw err;
    } finally {
      progress.dispose();
      progress.el.remove();
    }
  }

  function syncDataset(session: DatasetSession | null, opts?: { refresh?: boolean }): void {
    if (session === null) {
      meta.textContent = '';
      void enqueue(async () => {
        await destroyTable();
        tableGeneration = 0;
        sampleWrap.replaceChildren(noDataNote);
      });
      return;
    }
    meta.textContent =
      session.rowCount > STUDIO_SAMPLE_ROW_CAP
        ? 'previewing on a 10,000-row sample'
        : `${session.rowCount.toLocaleString('en-US')} row${session.rowCount === 1 ? '' : 's'}`;
    enqueue(() => ensureTable(session.generation, opts?.refresh === true)).catch((err: unknown) => {
      reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
    });
  }

  return { el, syncDataset };
}
