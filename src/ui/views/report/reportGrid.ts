/**
 * Report-view display grid (lazy chunk — everything data-table stays out of
 * the entry bundle). Canonical round trip (architecture.md §9, proven in
 * roundtrip.browser.test.ts): export display bytes from the `data` view
 * ORDER BY __row__ with __row__ excluded, feed them to createDataTable, and
 * the grid's __rowid__ equals QuaC's __row__ — P14 applies annotations with
 * rowId = flag.row directly. A dataset replacement destroys and recreates
 * the instance: loadData() on a live grid would keep filters/sort that
 * reference the old dataset's columns.
 */
import { createDataTable } from '@jeyabbalas/data-table';
import type { DataTable } from '@jeyabbalas/data-table';
import '@jeyabbalas/data-table/styles';
import { getBridge } from '../../../core/bridge/bridge';
import {
  DISPLAY_EXPORT_SQL,
  QUAC_DISPLAY,
  copyToParquetBytes,
} from '../../../core/bridge/tables';
import { createDuckProgress } from '../../components/duckProgress';

let table: DataTable | undefined;

export async function renderGrid(host: HTMLElement): Promise<void> {
  const progress = createDuckProgress();
  progress.setProgress('Exporting display bytes', null);

  const gridHost = document.createElement('div');
  gridHost.className = 'q-report-grid';
  host.replaceChildren(progress.el, gridHost);

  try {
    if (table) {
      await table.destroy();
      table = undefined;
    }
    const bridge = await getBridge();
    const bytes = await copyToParquetBytes(bridge, DISPLAY_EXPORT_SQL);

    const t = await createDataTable({
      container: gridHost,
      source: bytes.slice().buffer,
      sourceFormat: 'parquet',
      tableName: QUAC_DISPLAY,
      bridge,
      persistence: false,
    });
    table = t;
    t.on('loadProgress', (info) => {
      const detail = info as { percent?: number };
      progress.setProgress(
        'Loading the grid',
        typeof detail.percent === 'number' ? detail.percent : null,
      );
    });
  } finally {
    progress.dispose();
    progress.el.remove();
  }
}
