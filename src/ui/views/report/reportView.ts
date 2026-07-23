/**
 * QC Report view. P05 scope: host the display grid for the ingested dataset
 * via the byte round-trip; the annotation/report panels arrive in P14. The
 * grid (re)builds only while this view is the active route — data-table
 * mis-measures inside hidden containers — and a generation counter marks
 * staleness while the tab is away.
 */
import { effect } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { createEmptyState } from '../../components/emptyState';
import type { ShellContext } from '../../../app/shell';

export function mountReportView(container: HTMLElement, ctx: ShellContext): void {
  const empty = createEmptyState({
    title: 'No flags yet.',
    body: 'Load a dataset to see it here, then run QC and see what floats up.',
  });
  const gridHost = document.createElement('div');
  gridHost.hidden = true;
  container.append(empty, gridHost);

  let renderedGeneration = 0;
  let rendering = false;

  effect(() => {
    const dataset = ctx.store.dataset.get();
    const route = ctx.router.route.get();

    if (!dataset) {
      empty.hidden = false;
      gridHost.hidden = true;
      renderedGeneration = 0;
      return;
    }
    if (route !== 'report' || dataset.generation === renderedGeneration || rendering) return;

    rendering = true;
    renderedGeneration = dataset.generation;
    empty.hidden = true;
    gridHost.hidden = false;
    void (async () => {
      const { renderGrid } = await import('./reportGrid');
      await renderGrid(gridHost);
    })()
      .catch((err: unknown) => {
        renderedGeneration = 0; // allow a retry on the next route visit
        reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
      })
      .finally(() => {
        rendering = false;
      });
  });
}
