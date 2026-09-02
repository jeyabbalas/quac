/**
 * QC Report view (P14, qc-report-spec.md §4): left = the annotated display
 * grid (lazy data-table chunk), right = the four report panels. During a run
 * the grid area shows DuckProgress + Cancel; the presenter registered here is
 * what the pipeline's annotate stage awaits. Header tooltips recompute
 * whenever schema, rules, or dataset change — inspectable before any run.
 */
import { effect } from '../../../app/signals';
import { QuacError, reportError } from '../../../app/errors';
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

  // WCAG 2.4.1 (bypass blocks) — a convenience now, not a rescue. Under
  // data-table 0.5.1 the grid put ~1600 focusable controls (266 columns ×
  // header buttons) between the nav and the panel column AND trapped Tab
  // outright; 0.6.0 fixed both, and the whole `.dt-root` now contributes five
  // tab stops at any column count (ui-design.md §9). Five is not a bypass-block
  // failure, but the grid is still the largest thing between the run bar and
  // Download QC Report, and the DOM order is ours to keep matching reading
  // order (2.4.3) rather than reshuffle — so the skip control stays.
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

  // The Escape hatch that used to sit here is gone with the trap it existed
  // for. Escape is data-table's own key now — drop the cursor, leave F2
  // controls mode, cancel a Shift+F2 layout gesture — and the library stops
  // propagation whenever it owns the press. A hatch would therefore catch only
  // the presses the grid ignored, silently throwing focus to the panel column
  // for a key the user meant for the grid.
  gridArea.append(capBanner, progressWrap, runStatus, skipGrid, gridHost);

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
    onOffenderFocus: async (rows, label) => {
      const mod = await loadGridModule();
      const outcome = await mod.focusRows(rows, label);
      if (outcome.kind === 'no-rows') {
        // The panel does not offer a focus button for these, so reaching here
        // means the aggregate and the row set disagreed. Say the true thing.
        showToast(`${label} is not tied to specific rows, so the grid is unchanged.`, {
          kind: 'info',
        });
        return false;
      }
      if (outcome.kind === 'unfilterable') {
        // Row-identity focus cannot be rejected by a healthy grid (the ids ARE
        // what the run flagged), so this is a defect, not a rule we can't
        // express — it goes through the error channel, not a chatty toast.
        reportError(
          new QuacError('BRIDGE_FAILED', 'The grid could not focus this rule\u2019s rows.', {
            hint: 'Re-run QC to rebuild the grid.',
          }),
          { fallbackCode: 'BRIDGE_FAILED' },
        );
        return false;
      }
      // The engine caps flag emission per rule, so a very large offender can be
      // focused on only the rows it managed to flag. Say so rather than let the
      // grid's count quietly contradict the panel's.
      const stat = ctx.store.runArtifacts.get()?.rules?.perRule.find((s) => s.ruleId === label);
      if (stat?.truncated === true) {
        showToast(
          `Focused the first ${outcome.shown.toLocaleString('en-US')} rows ${label} flagged.`,
          {
            kind: 'info',
            hint: "This rule's flags were capped during the run, so later rows are not focused.",
          },
        );
      }
      return true;
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

  // Tracks which dataset generation the grid currently shows. Declared here
  // because BOTH the presenter (below) and the pre-run effect (further down)
  // write it — a run's present is a render, and leaving it stale made the
  // effect rebuild the whole grid a second time the moment the run finished.
  let renderedGeneration = 0;
  // The generation whose grid failure has already been announced. The run's
  // present and the pre-run effect are two attempts at ONE build, and both
  // report — which is why UX-01 counted two identical toasts per failure.
  // The retry still happens; only its second announcement is suppressed.
  let announcedFailureGeneration = 0;

  // The pipeline's annotate stage awaits this (registered before any run).
  setPresenter(async (payload) => {
    const generation = ctx.store.dataset.get()?.generation ?? 0;
    const mod = await loadGridModule();
    try {
      await mod.presentPayload(gridHost, generation, payload, severity);
    } catch (err) {
      // runController toasts this as the annotate stage error; the effect
      // below must not say the same thing again after its retry.
      announcedFailureGeneration = generation;
      throw err;
    }
    // Only on success: a failed present must leave this stale, so the effect
    // below gets its one automatic rebuild attempt when the run ends.
    renderedGeneration = generation;
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
  let rendering = false;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const route = ctx.router.route.get();
    const stage = ctx.store.pipeline.get().stage;

    if (!dataset) {
      empty.hidden = false;
      layout.hidden = true;
      renderedGeneration = 0;
      announcedFailureGeneration = 0;
      // Dataset cleared (UIX-7): the grid's data is gone — dispose the
      // instance (never force-loading the chunk) and drop run-paint leftovers
      // so a later session cannot inherit them.
      capBanner.hidden = true;
      pendingTooltips = null;
      void gridModule?.disposeGrid();
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
        // Already announced for this dataset by the run that just failed —
        // this attempt WAS the retry. Reset, so a later independent failure
        // on the same dataset still speaks.
        if (announcedFailureGeneration === dataset.generation) {
          announcedFailureGeneration = 0;
          return;
        }
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

  // Any run invalidation (invalidateRun nulls runArtifacts) strips the run's
  // paint from the surviving grid — annotations, offender raw-SQL filter, cap
  // banner. A rules/schema-only clear keeps the data grid, so this must NOT
  // dispose it; a dataset clear disposes via the dataset-null branch above.
  // Never force-loads the chunk: no module ⇒ no table ⇒ nothing painted.
  let hadArtifacts = false;
  effect(() => {
    const artifacts = ctx.store.runArtifacts.get();
    if (artifacts !== null) {
      hadArtifacts = true;
      return;
    }
    if (!hadArtifacts) return;
    hadArtifacts = false;
    void gridModule?.clearRunPresentation();
    capBanner.hidden = true;
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
    if (digest === null && rules.files.length === 0) {
      // Dataset present, no check sources left (schema/rules cleared): apply
      // an EMPTY plan — setTooltips prunes every previously-set header — and
      // drop any stale stash a not-yet-rendered grid would otherwise flush.
      pendingTooltips = null;
      gridModule?.applyTooltips({ byColumn: new Map() });
      return;
    }
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
