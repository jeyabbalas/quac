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
import { renderPreviewTable } from '../../components/plainPreviewTable';
import type { DuckProgress } from '../../components/duckProgress';
import type { DatasetSession } from '../../../app/store';
import type { QCRule } from '../../../core/rules/types';
import type { RuleTestResult } from './ruleTest';

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
  /** Show the test-in-flight progress bar in the test panel. */
  setTestRunning: () => void;
  /** Render a completed test: result line + sample bodies + filter toggle. */
  renderTestResult: (draft: QCRule, result: RuleTestResult) => void;
  /** Empty + hide the test panel and drop any preview filter. */
  clearTest: () => void;
}

const fmt = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, word: string): string => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

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
  let previewFilterId: string | null = null;
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
    previewFilterId = null; // filters die with the instance
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

  // ---- test panel (RuleTestPanel) ----
  let testProgress: DuckProgress | null = null;
  /** Guards the async filter-toggle append against a newer render/clear. */
  let renderToken = 0;

  function stopTestProgress(): void {
    if (testProgress !== null) {
      testProgress.dispose();
      testProgress = null;
    }
  }

  /** Drop the applied preview filter (serialized with the grid queue). */
  function removePreviewFilter(): void {
    void enqueue(async () => {
      if (table !== undefined && previewFilterId !== null) {
        table.actions.removeRawSQLFilter(previewFilterId);
      }
      previewFilterId = null;
      return Promise.resolve();
    });
  }

  function clearTest(): void {
    renderToken += 1;
    stopTestProgress();
    removePreviewFilter();
    testPanel.replaceChildren();
    testPanel.hidden = true;
  }

  function setTestRunning(): void {
    renderToken += 1;
    stopTestProgress();
    testProgress = createDuckProgress();
    testProgress.setProgress(PROGRESS_LABELS.ruleTest, null);
    testPanel.replaceChildren(testProgress.el);
    testPanel.hidden = false;
  }

  function appendSampleTable(
    host: HTMLElement,
    columns: readonly string[],
    rows: readonly Record<string, unknown>[],
    truncated: boolean,
  ): void {
    if (rows.length === 0) return;
    const body = document.createElement('div');
    body.className = 'q-test-body';
    renderPreviewTable(body, columns, rows);
    host.append(body);
    if (truncated) {
      const note = document.createElement('p');
      note.className = 'q-test-trunc';
      note.textContent = 'showing first 20';
      host.append(note);
    }
  }

  /** Read-only expanded-assertion SQL, tucked behind a disclosure. */
  function expansionDetails(sql: string): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'q-test-sql';
    const summary = document.createElement('summary');
    summary.textContent = 'Expanded SQL';
    const code = document.createElement('code');
    code.textContent = sql;
    details.append(summary, code);
    return details;
  }

  /** "Filter preview to matches" — offered only when the raw condition passes
   *  validateSQLFilter on the sample table (window functions or `__row__`
   *  references simply fail validation; same contract as the report grid). */
  function offerPreviewFilter(draft: QCRule, condition: string): void {
    const token = renderToken;
    void enqueue(async () => {
      const t = table;
      if (t === undefined || token !== renderToken) return;
      const verdict = await t.actions.validateSQLFilter(condition);
      if (!verdict.valid || token !== renderToken) return;
      const label = draft.ruleId === '' ? 'rule test' : draft.ruleId;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'q-btn q-btn--small q-test-filter';
      toggle.textContent = 'Filter preview to matches';
      toggle.addEventListener('click', () => {
        void enqueue(async () => {
          if (table === undefined) return Promise.resolve();
          if (previewFilterId === null) {
            previewFilterId = table.actions.addRawSQLFilter(condition, label);
            toggle.textContent = 'Clear preview filter';
          } else {
            table.actions.removeRawSQLFilter(previewFilterId);
            previewFilterId = null;
            toggle.textContent = 'Filter preview to matches';
          }
          return Promise.resolve();
        });
      });
      testPanel.append(toggle);
    });
  }

  function correctionLine(result: Extract<RuleTestResult, { kind: 'correction' }>): string {
    if (!result.sampleOnly) return `Test result: ${plural(result.count, 'cell')} would change`;
    const verb = result.count === 1 ? 'matches' : 'match';
    let line =
      `Test result: ${plural(result.count, 'row')} ${verb} · ` +
      `corrections sampled on ${plural(result.sampledRows, 'row')}`;
    if (result.sampleErrors > 0) line += ` · ${plural(result.sampleErrors, 'sample error')}`;
    return line;
  }

  function renderTestResult(draft: QCRule, result: RuleTestResult): void {
    renderToken += 1;
    stopTestProgress();
    removePreviewFilter(); // a new test replaces the previous filter state
    testPanel.replaceChildren();
    testPanel.hidden = false;
    const line = document.createElement('p');
    line.className = 'q-test-result';
    testPanel.append(line);

    switch (result.kind) {
      case 'validate': {
        const verb = result.count === 1 ? 'matches' : 'match';
        line.textContent = `Test result: ${plural(result.count, 'row')} ${verb}`;
        appendSampleTable(testPanel, result.columns, result.rows, result.truncated);
        offerPreviewFilter(draft, draft.condition);
        return;
      }
      case 'assert': {
        const violating = result.perTarget.filter((t) =>
          'aggregate' in t ? !t.aggregate.pass : t.count > 0,
        ).length;
        line.textContent =
          `Test result: ${String(violating)} of ` +
          `${plural(result.perTarget.length, 'target')} violating`;
        for (const target of result.perTarget) {
          const section = document.createElement('div');
          section.className = 'q-test-target';
          const head = document.createElement('p');
          head.className = 'q-test-targethead';
          if ('aggregate' in target) {
            const { count, lo, hi, pass } = target.aggregate;
            head.textContent =
              `${target.target}: ${plural(count, 'distinct value')} — ` +
              (pass ? 'pass' : `outside ${fmt(lo)}–${fmt(hi)}`);
            section.append(head, expansionDetails(target.sql));
          } else {
            const verb = target.count === 1 ? 'matches' : 'match';
            head.textContent = `${target.target}: ${plural(target.count, 'row')} ${verb}`;
            section.append(head, expansionDetails(target.sql));
            appendSampleTable(section, ['__row__', target.target], target.rows, target.truncated);
          }
          testPanel.append(section);
        }
        return;
      }
      case 'correction': {
        line.textContent = correctionLine(result);
        const columns = ['__row__', 'target', 'before', 'after'];
        if (result.sampleErrors > 0) columns.push('error');
        appendSampleTable(
          testPanel,
          columns,
          result.captures.map((c) => ({
            __row__: c.row,
            target: c.target,
            before: c.before,
            after: c.after,
            error: c.error,
          })),
          !result.sampleOnly && result.count > result.captures.length,
        );
        return;
      }
      case 'dataset': {
        line.textContent = `Test result: ${plural(result.count, 'result row')}`;
        appendSampleTable(testPanel, result.columns, result.rows, result.truncated);
        return;
      }
      case 'not-testable': {
        line.textContent = `Not testable: ${result.reason}`;
        return;
      }
      case 'error': {
        line.classList.add('q-test-result--error');
        line.textContent = `Test failed: ${result.message}`;
        return;
      }
    }
  }

  return { el, syncDataset, setTestRunning, renderTestResult, clearTest };
}
