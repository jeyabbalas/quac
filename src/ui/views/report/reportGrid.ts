/**
 * Report-view display grid (lazy chunk — everything data-table stays out of
 * the entry bundle). Canonical round trip (architecture.md §9, proven in
 * roundtrip.browser.test.ts): export display bytes from the `data` view
 * ORDER BY __row__ with __row__ excluded, feed them to createDataTable, and
 * the grid's __rowid__ equals QuaC's __row__ — annotations use rowId =
 * flag.row directly (V7). A dataset replacement destroys and recreates the
 * instance (a live loadData would keep filters/sort referencing the old
 * dataset's columns); a re-run on the SAME dataset refreshes via loadData and
 * repaints, because annotations/tooltips do not survive a reload.
 *
 * All operations run through one serialization queue: the initial render and
 * a run's present can arrive interleaved (the Run button navigates before the
 * pipeline finishes), and data-table calls must not overlap.
 */
import { createDataTable } from '@jeyabbalas/data-table';
import type { DataTable, NewAnnotation } from '@jeyabbalas/data-table';
import '@jeyabbalas/data-table/styles';
import { getBridge } from '../../../core/bridge/bridge';
import {
  DISPLAY_EXPORT_SQL,
  QUAC_DISPLAY,
  copyToParquetBytes,
} from '../../../core/bridge/tables';
import { PROGRESS_LABELS, createDuckProgress } from '../../components/duckProgress';
import type { PresentPayload } from '../../../core/pipeline';
import type { HeaderTooltipPlan } from '../../../core/report/headerTooltips';

export interface SeverityToggles {
  error: boolean;
  warning: boolean;
  info: boolean;
}

const ADD_MANY_CHUNK = 2000;

let table: DataTable | undefined;
let tableGeneration = 0;
let tooltipColumns = new Set<string>();
let pendingTooltips: HeaderTooltipPlan | null = null;
let offenderFilterId: string | null = null;

let queue: Promise<unknown> = Promise.resolve();
/** Serialize every grid operation; failures do not poison the queue. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

function severityFilterShape(s: SeverityToggles): { error: boolean; warning: boolean; info: boolean } {
  return { error: s.error, warning: s.warning, info: s.info };
}

function setTooltips(t: DataTable, plan: HeaderTooltipPlan): void {
  const next = new Set<string>();
  for (const [column, content] of plan.byColumn) {
    t.actions.setColumnHeaderTooltip(column, content);
    next.add(column);
  }
  for (const column of tooltipColumns) {
    if (!next.has(column)) t.actions.setColumnHeaderTooltip(column, null);
  }
  tooltipColumns = next;
}

async function ensureTable(
  host: HTMLElement,
  generation: number,
  bytes: Uint8Array | null,
  showLocalProgress: boolean,
): Promise<DataTable> {
  if (table !== undefined && tableGeneration === generation) {
    if (bytes !== null) await table.loadData(bytes.slice().buffer);
    return table;
  }

  // One progress surface at a time: during a run the run-level duck already
  // covers this work, so the local "Preparing the grid" bar renders only for
  // the pre-run path (renderGrid).
  const progress = showLocalProgress ? createDuckProgress() : null;
  progress?.setProgress(PROGRESS_LABELS.gridPrep, null);
  const gridHost = document.createElement('div');
  gridHost.className = 'q-report-grid';
  if (progress !== null) host.replaceChildren(progress.el, gridHost);
  else host.replaceChildren(gridHost);

  try {
    if (table !== undefined) {
      await table.destroy();
      table = undefined;
      tooltipColumns = new Set();
      offenderFilterId = null;
    }
    const bridge = await getBridge();
    const source = bytes ?? (await copyToParquetBytes(bridge, DISPLAY_EXPORT_SQL));
    const t = await createDataTable({
      container: gridHost,
      source: source.slice().buffer,
      sourceFormat: 'parquet',
      tableName: QUAC_DISPLAY,
      bridge,
      persistence: false,
      // NOT the library default ('auto'), which flips the whole grid dark under
      // prefers-color-scheme: dark unless the instance carries
      // data-dt-color-scheme="light" — a dark grid inside QuaC's white work
      // area. The white work area is a brief requirement and dark mode is out
      // of scope for v1 (ui-design.md §2).
      colorScheme: 'light',
    });
    table = t;
    tableGeneration = generation;
    if (pendingTooltips !== null) {
      setTooltips(t, pendingTooltips);
      pendingTooltips = null;
    }
    return t;
  } finally {
    if (progress !== null) {
      progress.dispose();
      progress.el.remove();
    }
  }
}

/** Initial (pre-run) display of the ingested dataset. */
export function renderGrid(host: HTMLElement, generation: number): Promise<void> {
  return enqueue(async () => {
    await ensureTable(host, generation, null, true);
  });
}

/**
 * The run presenter body (pipeline annotate stage): refresh the display bytes,
 * repaint annotations (chunked addMany, they do not survive the reload),
 * re-apply the severity filter and the aggregated header tooltips.
 */
export function presentPayload(
  host: HTMLElement,
  generation: number,
  payload: PresentPayload,
  severity: SeverityToggles,
): Promise<void> {
  return enqueue(async () => {
    const t = await ensureTable(host, generation, payload.displayBytes, false);
    t.annotations.clear();
    // PlannedAnnotation is structurally a NewAnnotation by construction
    // (annotations.ts emits rowId/column per scope); the cast bridges the
    // non-discriminated planner type to the library's union.
    const items = payload.annotations.items as unknown as NewAnnotation[];
    for (let i = 0; i < items.length; i += ADD_MANY_CHUNK) {
      t.annotations.addMany(items.slice(i, i + ADD_MANY_CHUNK));
    }
    t.annotations.setSeverityFilter(severityFilterShape(severity));
    setTooltips(t, payload.tooltips);
  });
}

/** Severity toggle changes (Summary panel) — hides tiers without deleting. */
export function applySeverityFilter(severity: SeverityToggles): void {
  void enqueue(async () => {
    table?.annotations.setSeverityFilter(severityFilterShape(severity));
    return Promise.resolve();
  });
}

/** Pre-run tooltip application (schema/rules/dataset changed, no run yet). */
export function applyTooltips(plan: HeaderTooltipPlan): void {
  void enqueue(async () => {
    if (table === undefined) {
      pendingTooltips = plan;
      return Promise.resolve();
    }
    setTooltips(table, plan);
    return Promise.resolve();
  });
}

/**
 * Repeat-offenders row click (qc-report-spec §4): best-effort raw-SQL filter
 * for window-free row-scope SQL rules. Returns false when the condition
 * cannot filter the display table (window fns, missing columns, __row__).
 */
export function tryFilterByCondition(condition: string, label: string): Promise<boolean> {
  return enqueue(async () => {
    if (table === undefined) return false;
    const t = table;
    const verdict = await t.actions.validateSQLFilter(condition);
    if (!verdict.valid) return false;
    if (offenderFilterId !== null) {
      t.actions.removeRawSQLFilter(offenderFilterId);
      offenderFilterId = null;
    }
    offenderFilterId = t.actions.addRawSQLFilter(condition, label);
    return true;
  });
}

/** Clear the offender focus filter (panel "clear" affordance). */
export function clearOffenderFilter(): void {
  void enqueue(async () => {
    if (table !== undefined && offenderFilterId !== null) {
      table.actions.removeRawSQLFilter(offenderFilterId);
      offenderFilterId = null;
    }
    return Promise.resolve();
  });
}

/**
 * Dataset cleared (UIX-7): destroy the DataTable outright — dropping its
 * quac_display table with it — and reset every module latch, so a later
 * re-upload (even of the same file) builds a fresh grid from fresh bytes.
 */
export function disposeGrid(): Promise<void> {
  return enqueue(async () => {
    if (table !== undefined) {
      await table.destroy();
      table = undefined;
    }
    tableGeneration = 0;
    tooltipColumns = new Set();
    pendingTooltips = null;
    offenderFilterId = null;
  });
}

/**
 * Run invalidated while the dataset survives (rules/schema-only clear): strip
 * the run's paint — annotations and any offender raw-SQL filter — but KEEP
 * the data grid. Disposing here instead would strand the report on an empty
 * host: the pre-run render memoizes on generation, which did not change. The
 * offender filter must go too — its only other remover, the panels' "Clear
 * focus" affordance, vanished with the findings.
 */
export function clearRunPresentation(): Promise<void> {
  return enqueue(async () => {
    if (table === undefined) return;
    table.annotations.clear();
    if (offenderFilterId !== null) {
      table.actions.removeRawSQLFilter(offenderFilterId);
      offenderFilterId = null;
    }
    return Promise.resolve();
  });
}
