/**
 * Report right-panel tabs (qc-report-spec.md §4): Summary (stat cards,
 * severity filter toggles, Download stub, Re-run) · Missing variables ·
 * Dataset findings · Repeat offenders. Pure DOM over store signals — entry-
 * chunk safe (flag/messages, column-meta and the module stores are already in
 * the entry graph; no data-table imports here). Grid interactions travel
 * through the hooks the view provides.
 */
import { computed, effect } from '../../../app/signals';
import { signal } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { showToast } from '../../../app/toast';
import { isRunningStage } from '../../../app/store';
import { createBadge } from '../../components/badge';
import { createPanelTabs } from '../../components/panelTabs';
import type { PanelTabSpec } from '../../components/panelTabs';
import { PROGRESS_LABELS, createDuckProgress } from '../../components/duckProgress';
import { createSeverityLabel } from '../../components/severityPill';
import { renderFlag } from '../../../core/flags/messages';
import { columnDigest, missingVariables } from '../../../core/schema/column-meta';
import { schemaState } from '../../../core/schema/schema-store';
import { rulesState } from '../../../core/rules/rules-store';
import {
  RULE_STATUS_LABELS,
  exactRuleCounts,
  rankOffenders,
  schemaRuleTargets,
} from '../../../core/report/reportModel';
import type { ShellContext } from '../../../app/shell';
import type { RunArtifacts } from '../../../core/pipeline';
import type { QCRule } from '../../../core/rules/types';
import type { SeverityToggles } from './reportGrid';

export interface PanelHooks {
  onSeverityChange: (severity: SeverityToggles) => void;
  /** Best-effort offender focus; resolves false when the grid was left
   *  unfiltered (not filterable, or filterable but matching no rows — the
   *  view says which). The panel discards the value. */
  onOffenderFocus: (condition: string, label: string) => Promise<boolean>;
  onClearOffenderFocus: () => void;
  onRerun: () => void;
}

/* Short one-line tab labels (they must fit a single row at 1280×720 — the
   pinned e2e viewport); full names travel via title/aria-label. The label
   strings are pinned by runQc.spec/a11y.spec locators. */
const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'missing', label: 'Missing vars', fullLabel: 'Missing variables' },
  { id: 'findings', label: 'Findings', fullLabel: 'Dataset findings' },
  { id: 'offenders', label: 'Offenders', fullLabel: 'Repeat offenders' },
] as const satisfies readonly PanelTabSpec<string>[];
type TabId = (typeof TABS)[number]['id'];

const RUNNING_NOTE = 'QC run in progress — results land here when it finishes.';

function panelNote(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'q-panel-note';
  p.textContent = text;
  return p;
}

/** Mono identifiers (rule ids, variable names) get soft break opportunities
 *  after underscores so `wage_income_annual` wraps between words instead of
 *  mid-character. */
function monoBreakable(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const segments = text.split(/(?<=_)/);
  segments.forEach((segment, index) => {
    if (index > 0) frag.append(document.createElement('wbr'));
    frag.append(segment);
  });
  return frag;
}

const num = (n: number): string => n.toLocaleString('en-US');
const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/** The panel's Targets column is ~70px wide — a 10-target rule would make the
 *  row 200px tall. Show three; the rest live in the cell's title. */
const TARGETS_SHOWN = 3;
function targetsCellText(names: readonly string[]): { text: string; full: string } {
  const shown = names.filter((n) => n !== '');
  const full = shown.join(', ');
  if (shown.length <= TARGETS_SHOWN) return { text: full === '' ? '—' : full, full };
  return {
    text: `${shown.slice(0, TARGETS_SHOWN).join(', ')} +${String(shown.length - TARGETS_SHOWN)} more`,
    full,
  };
}

function findRule(ruleId: string): QCRule | undefined {
  for (const parsed of rulesState.get().files) {
    const rule = parsed.file.rules.find((r) => r.ruleId === ruleId);
    if (rule !== undefined) return rule;
  }
  return undefined;
}

function statCard(
  label: string,
  value: string,
  tone?: 'error' | 'warning' | 'info' | 'success',
  title?: string,
): HTMLElement {
  const card = document.createElement('div');
  card.className = tone === undefined ? 'q-statcard' : `q-statcard q-statcard--${tone}`;
  if (title !== undefined) card.title = title;
  const v = document.createElement('div');
  v.className = 'q-statcard-value';
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'q-statcard-label';
  l.textContent = label;
  card.append(v, l);
  return card;
}

/** Muted per-run scope line (UIX-6): names the check source this run ran
 *  without, so em-dash cards read as "not applicable", never as zero. */
function scopeNote(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'q-scope-note';
  p.textContent = text;
  return p;
}

const NO_RULES_TITLE = 'No QC rules were loaded for this run.';

export function mountReportPanels(
  host: HTMLElement,
  ctx: ShellContext,
  hooks: PanelHooks,
): void {
  host.className = 'q-report-panels';
  const severity = signal<SeverityToggles>({ error: true, warning: true, info: true });

  // Deduped run predicate: pipeline progress ticks set the signal every few
  // ms — panels only care about the boolean edge.
  const running = computed(() => isRunningStage(ctx.store.pipeline.get().stage));

  const tabs = createPanelTabs<TabId>({
    idPrefix: 'q-report',
    label: 'Report panels',
    tabs: TABS,
  });
  tabs.mount(host);

  // ---- Summary ----
  const renderSummary = (target: HTMLElement, artifacts: RunArtifacts | null): void => {
    target.replaceChildren();
    if (artifacts === null) {
      target.append(
        panelNote(
          running.get() ? RUNNING_NOTE : 'No findings yet. Results land here after a QC run.',
        ),
      );
      return;
    }
    const dataset = ctx.store.dataset.get();
    const summary = artifacts.flagStore.summary(artifacts.rowsTotal);
    const perRule = artifacts.rules?.perRule ?? [];
    const rulesRun = perRule.filter((s) => s.status === 'ok').length;
    const rulesSkipped = perRule.filter((s) => s.status.startsWith('skipped')).length;

    if (artifacts.cancelled || (artifacts.rules?.aborted ?? false)) {
      const banner = document.createElement('p');
      banner.className = 'q-partial-banner';
      banner.textContent =
        'Partial run — cancelled before completion. Counts below cover the work finished.';
      target.append(banner);
    }
    if (!artifacts.correctionsApplied) {
      const note = document.createElement('p');
      note.className = 'q-assess-note';
      note.textContent = 'Assess-only run: corrections were not applied.';
      target.append(note);
    }

    // Partial-run scope (UIX-6): what THIS run was handed, from the artifacts
    // echo — live stores may have changed since. Rules-less runs dash out the
    // three rules-stage cards rather than showing a made-up 0.
    const noRules = artifacts.inputs.ruleFileCount === 0;
    if (!artifacts.inputs.schemaProvided) {
      target.append(
        scopeNote('No JSON Schema was loaded for this run — schema validation was skipped.'),
      );
    }
    if (noRules) {
      target.append(scopeNote('No QC rules were loaded for this run — the rules stage was skipped.'));
    }

    // Hero row: the verdict numbers, severity-tinted so "39 Errors" cannot
    // read like "266 Columns". Quiet fact row below.
    const heroCards = document.createElement('div');
    heroCards.className = 'q-statgrid q-statgrid--hero';
    heroCards.append(
      statCard('Errors', num(summary.severityTotals.error), 'error'),
      statCard('Warnings', num(summary.severityTotals.warning), 'warning'),
      statCard('Info', num(summary.severityTotals.info), 'info'),
      noRules
        ? statCard('Corrections applied', '—', 'success', NO_RULES_TITLE)
        : statCard('Corrections applied', num(artifacts.rules?.correctedCells ?? 0), 'success'),
    );
    const factCards = document.createElement('div');
    factCards.className = 'q-statgrid';
    factCards.append(
      statCard('Rows', num(dataset?.rowCount ?? artifacts.rowsTotal)),
      statCard('Columns', num(dataset?.columnCount ?? 0)),
      noRules
        ? statCard('Rules run', '—', undefined, NO_RULES_TITLE)
        : statCard('Rules run', num(rulesRun)),
      noRules
        ? statCard('Rules skipped', '—', undefined, NO_RULES_TITLE)
        : statCard('Rules skipped', num(rulesSkipped)),
    );
    target.append(heroCards, factCards);

    const filter = document.createElement('fieldset');
    filter.className = 'q-sevfilter';
    const legend = document.createElement('legend');
    legend.textContent = 'Show annotations';
    filter.append(legend);
    for (const tier of ['error', 'warning', 'info'] as const) {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = severity.get()[tier];
      box.addEventListener('change', () => {
        const next = { ...severity.get(), [tier]: box.checked };
        severity.set(next);
        hooks.onSeverityChange(next);
      });
      label.append(box, document.createTextNode(` ${tier}s`));
      filter.append(label);
    }
    target.append(filter);

    const actions = document.createElement('div');
    actions.className = 'q-panel-actions';
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'q-btn q-btn--primary';
    download.textContent = 'Download QC Report (.xlsx)';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'q-btn';
    rerun.textContent = 'Re-run QC';
    rerun.addEventListener('click', () => {
      hooks.onRerun();
    });
    actions.append(download, rerun);
    target.append(actions);

    // Excel export: swap the action buttons for a duck-progress + Cancel while
    // it runs. The orchestrator (and exceljs) load only on first click.
    let exporting = false;
    download.addEventListener('click', () => {
      if (exporting) return;
      exporting = true;
      const controller = new AbortController();
      const progress = createDuckProgress();
      progress.setProgress(PROGRESS_LABELS.exportBuild, null);
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'q-btn q-run-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        controller.abort();
        cancel.disabled = true;
        cancel.textContent = 'Cancelling…';
      });
      const exportWrap = document.createElement('div');
      exportWrap.className = 'q-export-progress';
      exportWrap.append(progress.el, cancel);
      actions.replaceWith(exportWrap);

      void (async () => {
        try {
          const { runReportExport } = await import('./reportExport');
          await runReportExport(ctx, {
            signal: controller.signal,
            onProgress: (done, total) => {
              const pct = total > 0 ? Math.min(100, (done / total) * 100) : null;
              progress.setProgress(
                done >= total ? PROGRESS_LABELS.exportFinish : PROGRESS_LABELS.exportRows,
                pct,
              );
            },
          });
          showToast('QC report downloaded.', { kind: 'info' });
        } catch (err) {
          if (controller.signal.aborted) showToast('Export cancelled.', { kind: 'info' });
          else reportError(err, { fallbackCode: 'EXPORT_FAILED' });
        } finally {
          progress.dispose();
          exporting = false;
          exportWrap.replaceWith(actions);
        }
      })();
    });
  };

  // ---- Missing variables ----
  const renderMissing = (target: HTMLElement): void => {
    target.replaceChildren();
    const schema = schemaState.get();
    const dataset = ctx.store.dataset.get();
    const digest = schema.phase === 'ready' && schema.set !== null ? columnDigest(schema.set) : null;
    // Two distinct empties (UIX-6): a rules-only session has no schema to
    // compare (say which input is absent), while a schema awaiting data needs
    // the dataset. The tab stays visible either way.
    if (digest === null) {
      target.append(
        panelNote(
          'No JSON Schema loaded — nothing to compare. Load one to see schema variables ' +
            'missing from the dataset.',
        ),
      );
      return;
    }
    if (dataset === null) {
      target.append(panelNote("Load a dataset to compare against the schema's variables."));
      return;
    }
    const missing = missingVariables(digest.meta, dataset.columns);
    if (missing.length === 0) {
      const p = document.createElement('p');
      p.className = 'q-panel-note';
      p.textContent = 'All schema variables are present in the dataset.';
      target.append(p);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'q-missing-list';
    for (const entry of missing) {
      const item = document.createElement('li');
      const name = document.createElement('code');
      name.textContent = entry.name;
      item.append(name);
      if (entry.required) item.append(createBadge('required', 'error'));
      const text = document.createElement('div');
      text.className = 'q-missing-text';
      const bits = [entry.title, entry.description, entry.group ? `Group: ${entry.group}` : undefined]
        .filter((v): v is string => v !== undefined && v !== '');
      text.textContent = bits.join(' — ');
      item.append(text);
      list.append(item);
    }
    target.append(list);
  };

  // ---- Dataset findings ----
  const renderFindings = (target: HTMLElement, artifacts: RunArtifacts | null): void => {
    target.replaceChildren();
    if (artifacts === null) {
      target.append(
        panelNote(
          running.get()
            ? RUNNING_NOTE
            : 'No dataset findings yet. Dataset- and column-level findings appear here after a run.',
        ),
      );
      return;
    }
    // Errors first: emission order puts the schema-set `$comment` advisories
    // (info, one per file) ahead of everything, burying the real findings.
    const rows: { severity: 'error' | 'warning' | 'info'; text: string }[] = [
      ...artifacts.flagStore.datasetScope(),
      ...artifacts.flagStore.all().filter((e) => e.flag.scope === 'column'),
    ].map((entry) => ({
      severity: entry.flag.severity,
      text:
        entry.count > 1 ? `${renderFlag(entry.flag)} (×${num(entry.count)})` : renderFlag(entry.flag),
    }));
    for (const stat of (artifacts.rules?.perRule ?? []).filter((s) => s.status !== 'ok')) {
      rows.push({
        severity: stat.status === 'broken' ? 'error' : 'info',
        text:
          stat.status === 'broken'
            ? `${stat.ruleId}: Rule failed to execute: ${stat.error ?? 'unknown error'}`
            : `${stat.ruleId}: ${RULE_STATUS_LABELS[stat.status]}`,
      });
    }
    const rank = { error: 0, warning: 1, info: 2 };
    rows.sort((a, b) => rank[a.severity] - rank[b.severity]); // stable within a tier

    const list = document.createElement('ul');
    list.className = 'q-findings-list';
    // Capped at 480px and scrollable — needs a tab stop of its own so the
    // findings below the fold are reachable without a mouse.
    list.tabIndex = 0;
    list.setAttribute('aria-label', 'Dataset and column findings');
    for (const row of rows) {
      const item = document.createElement('li');
      item.append(createSeverityLabel(row.severity));
      const text = document.createElement('span');
      text.textContent = row.text;
      item.append(text);
      list.append(item);
    }
    if (list.childElementCount === 0) {
      const p = document.createElement('p');
      p.className = 'q-panel-note';
      p.textContent = 'No dataset- or column-level findings. Ducky.';
      target.append(p);
      return;
    }
    target.append(list);
  };

  // ---- Repeat offenders ----
  const renderOffenders = (target: HTMLElement, artifacts: RunArtifacts | null): void => {
    target.replaceChildren();
    if (artifacts === null) {
      target.append(
        panelNote(
          running.get()
            ? RUNNING_NOTE
            : 'No offenders yet. Frequently-firing rules appear here after a run.',
        ),
      );
      return;
    }
    const summary = artifacts.flagStore.summary(artifacts.rowsTotal);
    if (summary.perRule.length === 0) {
      const p = document.createElement('p');
      p.className = 'q-panel-note';
      p.textContent = 'No rule produced any findings.';
      target.append(p);
      return;
    }
    // Exact counts (rules-engine violationCount ∪ schema countsByRuleId — the
    // caps truncate flag emission, never the counters) drive both the numbers
    // shown and the ranking; shared with the Excel Sheet 4 via reportModel.
    const exactByRule = exactRuleCounts(artifacts.rules?.perRule, artifacts.schema?.countsByRuleId);
    const exactOf = (ruleId: string, fallback: number): number =>
      exactByRule.get(ruleId) ?? fallback;
    const ranked = rankOffenders(summary.perRule, exactByRule);

    // Grid-filterable = a validate row/longitudinal rule with a SQL condition;
    // one predicate decides both the hint's presence and each row's button
    // (a schema-only run has zero filterable rows — no hint for a click that
    // can't happen).
    const filterableRule = (rule: QCRule | undefined): rule is QCRule =>
      rule !== undefined &&
      rule.ruleType !== 'correct' &&
      (rule.ruleScope === 'row' || rule.ruleScope === 'longitudinal');
    const rows = ranked.map((aggregate) => ({ aggregate, rule: findRule(aggregate.ruleId) }));

    if (rows.some(({ rule }) => filterableRule(rule))) {
      const hint = document.createElement('p');
      hint.className = 'q-panel-note';
      hint.textContent = 'Click a row-level SQL rule to focus matching grid rows (best effort).';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'q-btn q-btn--small';
      clear.textContent = 'Clear focus';
      clear.addEventListener('click', () => {
        hooks.onClearOffenderFocus();
      });
      hint.append(' ', clear);
      target.append(hint);
    }

    const table = document.createElement('table');
    table.className = 'q-offenders';
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const [text, cls] of [
      ['Rule', ''],
      ['Severity', ''],
      ['Targets', ''],
      ['Count', 'q-num'],
      ['% rows', 'q-num'],
    ] as const) {
      const th = document.createElement('th');
      th.textContent = text;
      if (cls !== '') th.className = cls;
      headRow.append(th);
    }
    head.append(headRow);
    const body = document.createElement('tbody');
    for (const { aggregate, rule } of rows) {
      const row = document.createElement('tr');
      const targets = targetsCellText(
        aggregate.source === 'rules'
          ? (rule?.targetVariables ?? [])
          : [schemaRuleTargets(aggregate.ruleId)],
      );
      const exact = exactOf(aggregate.ruleId, aggregate.count);
      const filterable = filterableRule(rule);

      // Rule cell: breakable mono id + the source as a muted sub-tag (its own
      // column wasted width on a two-value fact). When the rule can drive the
      // grid filter, the id becomes a real <button>. It used to be the whole
      // <tr role="button" tabindex="0"> — which put a `button` inside a
      // `rowgroup` and broke aria-required-children, axe's only CRITICAL
      // finding in the app. A row stays a row; the action lives in a cell.
      const ruleCell = document.createElement('td');
      const ruleId = document.createElement('span');
      ruleId.className = 'q-offenders-ruleid';
      ruleId.append(monoBreakable(aggregate.ruleId));
      const source = document.createElement('span');
      source.className = 'q-offenders-source';
      source.textContent = aggregate.source;
      if (filterable) {
        const focusButton = document.createElement('button');
        focusButton.type = 'button';
        focusButton.className = 'q-offender-focus';
        focusButton.title = 'Focus matching rows in the grid';
        focusButton.setAttribute('aria-label', `Focus grid rows matching ${aggregate.ruleId}`);
        focusButton.append(ruleId);
        focusButton.addEventListener('click', () => {
          void hooks.onOffenderFocus(rule.condition, aggregate.ruleId);
        });
        ruleCell.append(focusButton, source);
      } else {
        ruleCell.append(ruleId, source);
      }

      const severityCell = document.createElement('td');
      severityCell.append(createSeverityLabel(aggregate.severity));

      const targetsCell = document.createElement('td');
      targetsCell.append(monoBreakable(targets.text));
      if (targets.text !== targets.full) targetsCell.title = targets.full;

      const countCell = document.createElement('td');
      countCell.className = 'q-num';
      countCell.textContent = num(exact);

      const pctCell = document.createElement('td');
      pctCell.className = 'q-num';
      pctCell.textContent = aggregate.pctOfRows === undefined ? '—' : pct(aggregate.pctOfRows);

      row.append(ruleCell, severityCell, targetsCell, countCell, pctCell);
      body.append(row);
    }
    table.append(head, body);
    // A capped scroller needs its own tab stop, or the rows below the fold are
    // unreachable without a mouse (axe: scrollable-region-focusable).
    const scroller = document.createElement('div');
    scroller.className = 'q-offenders-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Repeat offenders');
    scroller.append(table);
    target.append(scroller);
  };

  // Re-render panels whenever the run artifacts / dataset / schema / run
  // state change (the deduped `running` computed is read inside the
  // artifact-less branches, so progress ticks never thrash the panels).
  effect(() => {
    const artifacts = ctx.store.runArtifacts.get();
    ctx.store.dataset.get();
    schemaState.get();
    rulesState.get();
    renderSummary(tabs.panel('summary'), artifacts);
    renderMissing(tabs.panel('missing'));
    renderFindings(tabs.panel('findings'), artifacts);
    renderOffenders(tabs.panel('offenders'), artifacts);
  });
}
