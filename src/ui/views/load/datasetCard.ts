/**
 * The Dataset slot card (P05): drop zone (single file), URL field, status
 * badge + details from the store, DuckProgress while ingesting. All engine
 * work lives in ingestController.ts, which is imported lazily on the first
 * user action so the entry chunk stays free of bridge/data-table code.
 */
import { effect } from '../../../app/signals';
import { createDropZone } from '../../components/dropZone';
import { createDuckProgress } from '../../components/duckProgress';
import { createSlotCard } from '../../components/slotCard';
import { createUrlField } from '../../components/urlField';
import type { ShellContext } from '../../../app/shell';

export function mountDatasetCard(container: HTMLElement, ctx: ShellContext): void {
  const card = createSlotCard('Dataset');

  const progress = createDuckProgress();
  progress.el.hidden = true;

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    dropZone.setDisabled(value);
    urlField.setBusy(value);
    progress.el.hidden = !value;
  };

  const controllerUi = {
    setProgress: (label: string, pct: number | null): void => {
      progress.setProgress(label, pct);
    },
    detailHost: card.detailHost,
  };

  const run = (action: 'file' | 'url', payload: File | string): void => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      const controller = await import('./ingestController');
      if (action === 'file') await controller.ingestFromFile(ctx, payload as File, controllerUi);
      else await controller.ingestFromUrl(ctx, payload as string, controllerUi);
    })().finally(() => {
      setBusy(false);
    });
  };

  const dropZone = createDropZone({
    label: 'Drop dataset file (CSV, TSV, JSON, Excel, Parquet) or',
    accept: '.csv,.tsv,.tab,.json,.xlsx,.parquet,.pq',
    onFiles: (files) => {
      const file = files[0];
      if (file) run('file', file);
    },
  });

  const urlField = createUrlField({
    label: 'Dataset URL',
    onFetch: (url) => {
      run('url', url);
    },
  });

  card.bodyHost.append(dropZone.el, urlField.el, progress.el);
  container.append(card.el);

  effect(() => {
    card.update(ctx.store.slots.data.get());
  });
}
