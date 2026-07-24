/**
 * Report right-panel tabs (qc-report-spec.md §4): Summary (stat cards,
 * severity filter toggles, Download stub, Re-run) · Missing variables ·
 * Dataset findings · Repeat offenders. Pure DOM over store signals — entry-
 * chunk safe (flag/messages, column-meta and the module stores are already in
 * the entry graph; no data-table imports here). Grid interactions travel
 * through the hooks the view provides.
 */
import { effect } from '../../../app/signals';
import { signal } from '../../../app/signals';
import { createBadge } from '../../components/badge';
import { createEmptyState } from '../../components/emptyState';
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
  /** Best-effort offender focus; resolves false when not filterable. */
  onOffenderFocus: (condition: string, label: string) => Promise<boolean>;
  onClearOffenderFocus: () => void;
  onRerun: () => void;
}

const TABS = ['Summary', 'Missing variables', 'Dataset findings', 'Repeat offenders'] as const;
type TabName = (typeof TABS)[number];

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

function statCard(label: string, value: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'q-statcard';
  const v = document.createElement('div');
  v.className = 'q-statcard-value';
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'q-statcard-label';
  l.textContent = label;
  card.append(v, l);
  return card;
}

function severityPillEl(severity: 'error' | 'warning' | 'info'): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `q-pill q-pill--${severity}`;
  el.textContent = severity;
  return el;
}

export function mountReportPanels(
  host: HTMLElement,
  ctx: ShellContext,
  hooks: PanelHooks,
): void {
  host.className = 'q-report-panels';
  const activeTab = signal<TabName>('Summary');
  const severity = signal<SeverityToggles>({ error: true, warning: true, info: true });

  const tablist = document.createElement('div');
  tablist.className = 'q-paneltabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Report panels');
  const panels = new Map<TabName, HTMLElement>();
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  for (const name of TABS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'q-paneltab';
    button.setAttribute('role', 'tab');
    button.id = `q-tab-${name.replaceAll(' ', '-')}`;
    button.textContent = name;
    button.addEventListener('click', () => {
      activeTab.set(name);
    });
    tabButtons.set(name, button);
    tablist.append(button);

    const panel = document.createElement('div');
    panel.className = 'q-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(name, panel);
  }
  host.append(tablist, ...panels.values());

  effect(() => {
    const current = activeTab.get();
    for (const name of TABS) {
      const selected = name === current;
      tabButtons.get(name)?.setAttribute('aria-selected', String(selected));
      tabButtons.get(name)?.classList.toggle('q-paneltab--active', selected);
      const panel = panels.get(name);
      if (panel) panel.hidden = !selected;
    }
  });

  // ---- Summary ----
  const renderSummary = (target: HTMLElement, artifacts: RunArtifacts | null): void => {
    target.replaceChildren();
    if (artifacts === null) {
      target.append(
        createEmptyState({
          title: 'No findings yet.',
          body: 'Results land here after a QC run.',
        }),
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

    const cards = document.createElement('div');
    cards.className = 'q-statgrid';
    cards.append(
      statCard('Rows', num(dataset?.rowCount ?? artifacts.rowsTotal)),
      statCard('Columns', num(dataset?.columnCount ?? 0)),
      statCard('Errors', num(summary.severityTotals.error)),
      statCard('Warnings', num(summary.severityTotals.warning)),
      statCard('Info', num(summary.severityTotals.info)),
      statCard('Corrections applied', num(artifacts.rules?.correctedCells ?? 0)),
      statCard('Rules run', num(rulesRun)),
      statCard('Rules skipped', num(rulesSkipped)),
    );
    target.append(cards);

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
    download.disabled = true;
    download.title = 'The Excel export arrives in the next release.';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'q-btn';
    rerun.textContent = 'Re-run QC';
    rerun.addEventListener('click', () => {
      hooks.onRerun();
    });
    actions.append(download, rerun);
    target.append(actions);
  };

  // ---- Missing variables ----
  const renderMissing = (target: HTMLElement): void => {
    target.replaceChildren();
    const schema = schemaState.get();
    const dataset = ctx.store.dataset.get();
    const digest = schema.phase === 'ready' && schema.set !== null ? columnDigest(schema.set) : null;
    if (digest === null || dataset === null) {
      target.append(
        createEmptyState({
          title: 'Nothing to compare.',
          body: 'Load a JSON Schema and a dataset to see schema variables missing from the data.',
        }),
      );
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
        createEmptyState({
          title: 'No dataset findings yet.',
          body: 'Dataset- and column-level findings appear here after a run.',
        }),
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
    for (const row of rows) {
      const item = document.createElement('li');
      item.append(severityPillEl(row.severity));
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
        createEmptyState({
          title: 'No offenders yet.',
          body: 'Frequently-firing rules appear here after a run.',
        }),
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

    const table = document.createElement('table');
    table.className = 'q-offenders';
    const head = document.createElement('thead');
    head.innerHTML =
      '<tr><th>Rule</th><th>Source</th><th>Severity</th><th>Targets</th>' +
      '<th class="q-num">Count</th><th class="q-num">% rows</th></tr>';
    const body = document.createElement('tbody');
    for (const aggregate of ranked) {
      const row = document.createElement('tr');
      const rule = findRule(aggregate.ruleId);
      const targets = targetsCellText(
        aggregate.source === 'rules'
          ? (rule?.targetVariables ?? [])
          : [schemaRuleTargets(aggregate.ruleId)],
      );
      const exact = exactOf(aggregate.ruleId, aggregate.count);
      const cells = [
        aggregate.ruleId,
        aggregate.source,
        aggregate.severity,
        targets.text,
        num(exact),
        aggregate.pctOfRows === undefined ? '—' : pct(aggregate.pctOfRows),
      ];
      for (const [i, textContent] of cells.entries()) {
        const cell = document.createElement('td');
        cell.textContent = textContent;
        if (i === 3 && targets.text !== targets.full) cell.title = targets.full;
        if (i >= 4) cell.className = 'q-num';
        row.append(cell);
      }
      const filterable =
        rule !== undefined &&
        rule.ruleType !== 'correct' &&
        (rule.ruleScope === 'row' || rule.ruleScope === 'longitudinal');
      if (filterable) {
        row.classList.add('q-offender--clickable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.title = 'Focus matching rows in the grid';
        const focus = (): void => {
          void hooks.onOffenderFocus(rule.condition, aggregate.ruleId);
        };
        row.addEventListener('click', focus);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            focus();
          }
        });
      }
      body.append(row);
    }
    table.append(head, body);
    const scroller = document.createElement('div');
    scroller.className = 'q-offenders-scroll';
    scroller.append(table);
    target.append(scroller);
  };

  // Re-render panels whenever the run artifacts / dataset / schema change.
  effect(() => {
    const artifacts = ctx.store.runArtifacts.get();
    ctx.store.dataset.get();
    schemaState.get();
    rulesState.get();
    const summaryPanel = panels.get('Summary');
    const missingPanel = panels.get('Missing variables');
    const findingsPanel = panels.get('Dataset findings');
    const offendersPanel = panels.get('Repeat offenders');
    if (summaryPanel) renderSummary(summaryPanel, artifacts);
    if (missingPanel) renderMissing(missingPanel);
    if (findingsPanel) renderFindings(findingsPanel, artifacts);
    if (offendersPanel) renderOffenders(offendersPanel, artifacts);
  });
}
