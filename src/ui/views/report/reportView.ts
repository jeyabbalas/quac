/**
 * QC Report view (P14, qc-report-spec.md §4): left = the annotated display
 * grid (lazy data-table chunk), right = the four report panels. During a run
 * the grid area shows DuckProgress + Cancel; the presenter registered here is
 * what the pipeline's annotate stage awaits. Header tooltips recompute
 * whenever schema, rules, or dataset change — inspectable before any run.
 */
import { effect } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { showToast } from '../../../app/toast';
import { assetUrl } from '../../../app/urlBase';
import {
  collapseProgressSurface,
  createDuckProgress,
  revealProgressSurface,
} from '../../components/duckProgress';
import { createEmptyState } from '../../components/emptyState';
import { buildHeaderTooltips } from '../../../core/report/headerTooltips';
import { columnDigest } from '../../../core/schema/column-meta';
import { schemaState } from '../../../core/schema/schema-store';
import { rulesState } from '../../../core/rules/rules-store';
import { isRunningStage } from '../../../app/store';
import { createRunProgressMapper } from './runProgressModel';
import { mountReportPanels } from './reportPanels';
import { setPresenter } from './presenter';
import type { ShellContext } from '../../../app/shell';
import type { HeaderTooltipPlan } from '../../../core/report/headerTooltips';
import type { SeverityToggles } from './reportGrid';
import './reportView.css';

type GridModule = typeof import('./reportGrid');

export function mountReportView(container: HTMLElement, ctx: ShellContext): void {
  // View-level empty (title + body copy pinned by nav.spec) with the duck
  // mark and a way back to the inputs.
  const empty = createEmptyState({
    title: 'No flags yet.',
    body: 'Load a dataset to see it here, then run QC and see what floats up.',
  });
  const emptyDuck = document.createElement('img');
  emptyDuck.className = 'q-empty-duck';
  emptyDuck.src = assetUrl('logo/quac-duck.svg');
  emptyDuck.alt = '';
  empty.prepend(emptyDuck);
  const emptyAction = document.createElement('a');
  emptyAction.className = 'q-btn q-empty-action';
  emptyAction.href = '#/load';
  emptyAction.textContent = 'Go to Load';
  empty.append(emptyAction);

  const layout = document.createElement('div');
  layout.className = 'q-report-layout';
  layout.hidden = true;

  const gridArea = document.createElement('div');
  gridArea.className = 'q-report-gridarea';
  const capBanner = document.createElement('p');
  capBanner.className = 'q-cap-banner';
  capBanner.hidden = true;
  const progressWrap = document.createElement('div');
  progressWrap.className = 'q-run-progress';
  progressWrap.hidden = true;
  const progress = createDuckProgress();
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'q-btn q-run-cancel';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    ctx.store.pipeline.get().cancel.cancel();
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
  });
  progressWrap.append(progress.el, cancelButton);
  // ui-design.md §7 asks for a polite live region on pipeline progress, but the
  // DuckProgress bar itself must NOT be one — it retargets every few ms and
  // would narrate every percent. This announces STAGE CHANGES only, and it
  // lives OUTSIDE progressWrap on purpose: the card ends every run in
  // `[hidden]`, and a live region inside a hidden subtree announces nothing.
  const runStatus = document.createElement('p');
  runStatus.className = 'q-sr-only';
  runStatus.setAttribute('role', 'status');
  runStatus.setAttribute('aria-live', 'polite');
  const gridHost = document.createElement('div');
  gridHost.className = 'q-report-gridhost';

  const panelHost = document.createElement('aside');
  panelHost.tabIndex = -1; // programmatic focus target for the skip control

  // WCAG 2.4.1 (bypass blocks). Measured on the HESP example: the grid puts
  // ~1600 focusable controls (266 columns × header buttons) between the nav and
  // the panel column, so Download QC Report and Re-run QC were unreachable by
  // keyboard in any practical sense. The count is data-table's; the DOM order
  // is ours, and reordering would divorce focus order from reading order
  // (2.4.3) — so: a skip control, visible only when focused.
  //
  // A <button>, NOT an <a href="#…">: QuaC routes on the hash, and an in-page
  // anchor would rewrite it and navigate the app.
  const skipGrid = document.createElement('button');
  skipGrid.type = 'button';
  skipGrid.className = 'q-skiplink';
  skipGrid.textContent = 'Skip the data grid';
  skipGrid.addEventListener('click', () => {
    panelHost.focus();
    panelHost.scrollIntoView({ block: 'nearest' });
  });

  // …and an escape hatch, because the grid is also a hard keyboard TRAP
  // (WCAG 2.1.2, Level A). Measured: focus `.dt-root` and neither Tab nor
  // Shift+Tab moves it — `document.querySelector('.dt-root :focus')` stays
  // null through any number of presses. That is data-table's own doing and is
  // logged as an upstream to-do; from here the fix is to give Escape a way
  // out. It only fires for keydowns originating INSIDE the grid, so the
  // annotation popover's own Escape (pinned in runQc.spec, pressed while focus
  // is elsewhere) is untouched.
  const gridEscapeNote = document.createElement('p');
  gridEscapeNote.className = 'q-sr-only';
  gridEscapeNote.textContent = 'The data grid captures Tab. Press Escape to leave it.';
  gridHost.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    panelHost.focus();
  });
  gridArea.append(capBanner, progressWrap, runStatus, skipGrid, gridEscapeNote, gridHost);

  layout.append(gridArea, panelHost);
  container.append(empty, layout);

  let gridModule: GridModule | null = null;
  let severity: SeverityToggles = { error: true, warning: true, info: true };
  let pendingTooltips: HeaderTooltipPlan | null = null;
  const loadGridModule = async (): Promise<GridModule> => {
    gridModule ??= await import('./reportGrid');
    if (pendingTooltips !== null) {
      gridModule.applyTooltips(pendingTooltips);
      pendingTooltips = null;
    }
    return gridModule;
  };

  mountReportPanels(panelHost, ctx, {
    onSeverityChange: (next) => {
      severity = next;
      gridModule?.applySeverityFilter(next);
    },
    onOffenderFocus: async (condition, label) => {
      const mod = await loadGridModule();
      const applied = await mod.tryFilterByCondition(condition, label);
      if (!applied) {
        showToast('This rule cannot filter the grid (window functions or unavailable columns).', {
          kind: 'info',
        });
      }
      return applied;
    },
    onClearOffenderFocus: () => {
      gridModule?.clearOffenderFilter();
    },
    onRerun: () => {
      void (async () => {
        const { startRun } = await import('../../../app/runController');
        await startRun(ctx);
      })().catch((err: unknown) => {
        reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
      });
    },
  });

  // The pipeline's annotate stage awaits this (registered before any run).
  setPresenter(async (payload) => {
    const generation = ctx.store.dataset.get()?.generation ?? 0;
    const mod = await loadGridModule();
    await mod.presentPayload(gridHost, generation, payload, severity);
    if (payload.annotations.capped) {
      capBanner.textContent =
        `Painting ${payload.annotations.cellPainted.toLocaleString('en-US')} of ` +
        `${payload.annotations.cellTotal.toLocaleString('en-US')} cell flags — ` +
        'full detail in the panels and the Excel report.';
      capBanner.hidden = false;
    } else {
      capBanner.hidden = true;
    }
  });

  // Initial (pre-run) grid: render the ingested dataset while the view is the
  // active route (data-table mis-measures in hidden containers). Skipped when
  // a run is in flight — its presenter builds the grid with fresh bytes.
  let renderedGeneration = 0;
  let rendering = false;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const route = ctx.router.route.get();
    const stage = ctx.store.pipeline.get().stage;

    if (!dataset) {
      empty.hidden = false;
      layout.hidden = true;
      renderedGeneration = 0;
      return;
    }
    empty.hidden = true;
    layout.hidden = false;
    if (route !== 'report' || isRunningStage(stage)) return;
    if (dataset.generation === renderedGeneration || rendering) return;

    rendering = true;
    renderedGeneration = dataset.generation;
    void (async () => {
      const mod = await loadGridModule();
      await mod.renderGrid(gridHost, dataset.generation);
    })()
      .catch((err: unknown) => {
        renderedGeneration = 0; // allow a retry on the next route visit
        reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
      })
      .finally(() => {
        rendering = false;
      });
  });

  // Run progress overlay + cancel state. The mapper folds per-stage
  // {done,total} into one monotonic run bar (runProgressModel.ts); the
  // surface animates in/out so nothing snaps.
  const runProgress = createRunProgressMapper();
  let wasRunning = false;
  // Deduped so the mapper's per-tick label only reaches the live region when
  // the STAGE changed — the percentage never does.
  let announced = '';
  const announce = (text: string): void => {
    if (text === announced) return;
    announced = text;
    runStatus.textContent = text;
  };
  effect(() => {
    const state = ctx.store.pipeline.get();
    const running = isRunningStage(state.stage);
    if (running) {
      if (!wasRunning) {
        // New run: snap the bar to 0 before the first glide.
        runProgress.reset();
        announced = ''; // a re-run re-announces from stage one
        progress.setProgress('Starting the run', 0, { glideMs: 0 });
        revealProgressSurface(progressWrap);
      }
      const view = runProgress.view(state.stage, state.progress.done, state.progress.total);
      progress.setProgress(view.label, view.pct, { glideMs: view.glideMs });
      announce(view.label);
      cancelButton.disabled = state.cancel.cancelled;
      if (!state.cancel.cancelled) cancelButton.textContent = 'Cancel';
    } else if (wasRunning) {
      collapseProgressSurface(progressWrap);
      // Cancellation already speaks through runController's toast (its own
      // polite region) — announcing it here too would say it twice.
      if (!state.cancel.cancelled) announce('QC run complete.');
    }
    wasRunning = running;
  });

  // Header tooltips recompute on schema/rules/dataset change (spec §3) so the
  // pre-run grid is already inspectable. Applied via the grid module when (or
  // once) a table exists; cheap to rebuild.
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const schema = schemaState.get();
    const rules = rulesState.get();
    if (dataset === null) return;
    const digest = schema.phase === 'ready' && schema.set !== null ? columnDigest(schema.set) : null;
    if (digest === null && rules.files.length === 0) return;
    const plan = buildHeaderTooltips(
      digest,
      rules.files.map((f) => f.file),
      dataset.columns,
    );
    if (gridModule !== null) {
      gridModule.applyTooltips(plan);
    } else {
      // Grid chunk not loaded yet — stash; loadGridModule flushes it the
      // moment the grid first renders (never force-loads the chunk early).
      pendingTooltips = plan;
    }
  });
}
