/**
 * The Dataset slot card (P05): drop zone (single file), URL field, status
 * badge + details from the store, DuckProgress while ingesting. All engine
 * work lives in ingestController.ts, which is imported lazily on the first
 * user action so the entry chunk stays free of bridge/data-table code.
 */
import { effect } from '../../../app/signals';
import { createCorsHelp } from '../../components/corsHelp';
import { createDropZone } from '../../components/dropZone';
import { createDuckProgress } from '../../components/duckProgress';
import { createSlotCard } from '../../components/slotCard';
import { createUrlField } from '../../components/urlField';
import type { ShellContext } from '../../../app/shell';

export interface DatasetCardHandle {
  /** Programmatic URL ingest — the "Load example files" path (P14). */
  fetchUrl: (url: string) => void;
}

export function mountDatasetCard(container: HTMLElement, ctx: ShellContext): DatasetCardHandle {
  const card = createSlotCard('Dataset');

  const progress = createDuckProgress();
  progress.el.hidden = true;
  // P16: FETCH_CORS guidance (host table + Retry) lands here below the inputs.
  const corsHost = document.createElement('div');

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
    onCorsError: (url: string): void => {
      corsHost.replaceChildren(
        createCorsHelp({
          onRetry: () => {
            run('url', url);
          },
        }),
      );
    },
  };

  // Hoisted so controllerUi.onCorsError can re-invoke it (mutual reference).
  function run(action: 'file' | 'url', payload: File | string): void {
    if (busy) return;
    setBusy(true);
    corsHost.replaceChildren(); // clear stale CORS guidance on a fresh attempt
    void (async () => {
      const controller = await import('./ingestController');
      if (action === 'file') await controller.ingestFromFile(ctx, payload as File, controllerUi);
      else await controller.ingestFromUrl(ctx, payload as string, controllerUi);
    })().finally(() => {
      setBusy(false);
    });
  }

  const dropZone = createDropZone({
    label: 'Drop dataset file (CSV, TSV, JSON, Excel, Parquet) or',
    accept: '.csv,.tsv,.tab,.json,.xlsx,.parquet,.pq',
    dropTarget: card.el, // whole card accepts drops
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

  card.bodyHost.append(dropZone.el, urlField.el, progress.el, corsHost);
  container.append(card.el);

  effect(() => {
    card.update(ctx.store.slots.data.get());
  });

  return {
    fetchUrl: (url) => {
      run('url', url);
    },
  };
}
