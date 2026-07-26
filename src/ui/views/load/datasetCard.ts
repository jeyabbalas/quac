/**
 * The Dataset slot card (P05): drop zone (single file), URL field, status
 * badge + details from the store, DuckProgress while ingesting. All engine
 * work lives in ingestController.ts, which is imported lazily on the first
 * user action so the entry chunk stays free of bridge/data-table code.
 */
import { clearDataset, registerDatasetClearUi } from '../../../app/clearInputs';
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
  const card = createSlotCard('Dataset', { requirement: 'required' });

  const progress = createDuckProgress();
  progress.el.hidden = true;
  // P16: FETCH_CORS guidance (host table + Retry) lands here below the inputs.
  const corsHost = document.createElement('div');

  let busy = false;
  /** The dataset Clear is the strict one: ingest is uninterruptible mid-CTAS
   *  and runIngest would overwrite the cleared slot on settle, so it hides
   *  when empty and DISABLES while loading/busy. Also called from setBusy —
   *  the closure `busy` flips before any signal does, so the effect alone
   *  would leave the button stale (e.g. still disabled after an ingest). */
  const syncClear = (): void => {
    const state = ctx.store.slots.data.get();
    clearButton.hidden = state.status === 'empty';
    clearButton.disabled = state.status === 'loading' || busy;
  };
  const setBusy = (value: boolean): void => {
    busy = value;
    dropZone.setDisabled(value);
    urlField.setBusy(value);
    progress.el.hidden = !value;
    syncClear();
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

  // UIX-7: whole-slot clear. Also the designated escape hatch from a failed
  // re-ingest's stale session (dataset-error keeps working) — clearLocalUi
  // wipes the details list that survives such a failure.
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'q-btn q-btn--small q-slotcard-clear';
  clearButton.textContent = 'Clear';
  clearButton.setAttribute('aria-label', 'Clear dataset');
  clearButton.hidden = true;
  clearButton.addEventListener('click', () => {
    void clearDataset(ctx).then((cleared) => {
      // The button hid itself — keyboard focus must not strand on <body>.
      if (cleared) dropZone.el.focus();
    });
  });
  registerDatasetClearUi({
    setBusy: (value) => {
      // The clear path holds the SAME latch as ingest (gates every entry
      // point) but must not reveal the ingest progress bar or its label.
      busy = value;
      dropZone.setDisabled(value);
      urlField.setDisabled(value);
      syncClear();
    },
    clearLocalUi: () => {
      card.detailHost.replaceChildren();
      corsHost.replaceChildren();
      urlField.clear();
    },
    isBusy: () => busy,
  });

  card.bodyHost.append(dropZone.el, urlField.el, progress.el, corsHost);
  card.actionsHost.append(clearButton);
  container.append(card.el);

  effect(() => {
    // Clear visibility BEFORE update() — update derives the actions-row
    // visibility from its children's hidden state.
    syncClear();
    card.update(ctx.store.slots.data.get());
  });

  return {
    fetchUrl: (url) => {
      run('url', url);
    },
  };
}
