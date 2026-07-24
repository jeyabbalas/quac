/**
 * The QC Rules slot card (P12, ingestion.md §4): multi-file drop zone + URL
 * field on the generic SlotCard frame, per-file badges with the lint detail
 * list grouped file → rule, and a per-file pertinence line. Parsing/linting
 * live in core/rules/rules-store.ts (whose heavy imports are lazy); this card
 * renders exclusively from the store snapshot.
 *
 * The dataset effect below owns the §7 lint lifecycle: whenever the dataset
 * (generation) changes, it installs a DatasetLintContext built from the
 * already-booted bridge — the no-dataset path NEVER touches getBridge(), so
 * dropping rules before data does not boot the 35 MB wasm.
 */
import { effect } from '../../../app/signals';
import {
  addRuleFiles,
  addRuleUrls,
  rulesState,
  setLintContext,
  summarizeSlot,
  type RulesSlotState,
} from '../../../core/rules/rules-store';
import { createBadge } from '../../components/badge';
import { createCorsHelp } from '../../components/corsHelp';
import { createDropZone } from '../../components/dropZone';
import { createSlotCard } from '../../components/slotCard';
import { createUrlField } from '../../components/urlField';
import type { RuleFileLintResult, RuleLintIssue } from '../../../core/rules/types';
import type { ShellContext } from '../../../app/shell';

export function mountRulesSlotCard(container: HTMLElement, ctx: ShellContext): void {
  const card = createSlotCard('QC Rules');

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    dropZone.setDisabled(value);
    urlField.setBusy(value);
  };
  const run = (task: () => Promise<void>): void => {
    if (busy) return;
    setBusy(true);
    void task().finally(() => {
      setBusy(false);
    });
  };

  const dropZone = createDropZone({
    label: 'Drop QC rules files (.quac.csv) or',
    accept: '.csv',
    multiple: true,
    onFiles: (files) => {
      run(async () => {
        const entries = await Promise.all(
          files.map(async (file) => ({ name: file.name, text: await file.text() })),
        );
        await addRuleFiles(entries);
      });
    },
  });

  const urlField = createUrlField({
    label: 'Rules URL',
    onFetch: (url) => {
      run(async () => {
        await addRuleUrls(url.split(/\s+/));
      });
    },
  });

  card.bodyHost.append(dropZone.el, urlField.el);
  container.append(card.el);

  effect(() => {
    const state = rulesState.get();
    card.update(summarizeSlot(state));
    renderDetails(card.detailHost, state);
  });

  // Dataset-driven re-lint (qc-rules-engine.md §7: "re-runs when the dataset
  // changes"). Generation-guarded with post-await stale checks.
  let lintedGeneration = -1;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const generation = dataset?.generation ?? 0;
    if (generation === lintedGeneration) return;
    lintedGeneration = generation;
    void (async () => {
      if (!dataset) {
        await setLintContext(null);
        return;
      }
      const { getBridge } = await import('../../../core/bridge/bridge');
      const bridge = await getBridge();
      if (ctx.store.dataset.get()?.generation !== generation) return; // stale
      bridge.clearQueryCache(); // V2 insurance: EXPLAIN output is cacheable
      await setLintContext({ runner: bridge, datasetColumns: dataset.columns });
    })().catch(() => {
      // Lint is advisory; a failed re-lint leaves the previous results standing.
    });
  });
}

function renderDetails(host: HTMLElement, state: RulesSlotState): void {
  host.replaceChildren();
  if (state.files.length === 0 && state.fetchErrors.length === 0) return;

  for (const parsed of state.files) {
    const name = parsed.file.name;
    const result = state.results.find((r) => r.file === name);
    host.append(renderFileBlock(name, parsed.file.rules.length, result));
  }

  if (state.fetchErrors.length > 0) {
    const list = document.createElement('ul');
    list.className = 'q-slotcard-issues';
    for (const message of state.fetchErrors) {
      const item = document.createElement('li');
      item.className = 'q-rulesissue q-rulesissue--error';
      item.textContent = message;
      list.append(item);
    }
    host.append(list);
    // P16: a cross-origin fetch failure gets the "which hosts work?" table.
    if (state.fetchErrors.some((m) => /cross-origin|CORS/i.test(m))) {
      host.append(createCorsHelp());
    }
  }
}

function renderFileBlock(
  name: string,
  ruleCount: number,
  result: RuleFileLintResult | undefined,
): HTMLElement {
  const block = document.createElement('div');
  block.className = 'q-rulesfile';

  const header = document.createElement('p');
  header.className = 'q-rulesfile-header';
  const fileName = document.createElement('span');
  fileName.className = 'q-rulesfile-name';
  fileName.textContent = name;
  header.append(fileName);

  if (result === undefined) {
    header.append(createBadge('Linting…', 'neutral'));
    block.append(header);
    return block;
  }

  const errors = result.issues.filter((i) => i.severity === 'error').length;
  const warnings = result.issues.filter((i) => i.severity === 'warning').length;
  header.append(
    errors > 0
      ? createBadge(errors === 1 ? '1 error' : `${String(errors)} errors`, 'error')
      : warnings > 0
        ? createBadge(warnings === 1 ? '1 warning' : `${String(warnings)} warnings`, 'warning')
        : createBadge('OK', 'valid'),
  );
  const counts = document.createElement('span');
  counts.className = 'q-rulesfile-counts';
  counts.textContent = ` ${String(ruleCount)} rules · ${String(result.executable)} executable`;
  header.append(counts);
  block.append(header);

  if (result.pertinence !== undefined) {
    const line = document.createElement('p');
    line.className = 'q-rulesfile-pertinence';
    const { targetsFound, targetsTotal, missing } = result.pertinence;
    line.textContent =
      `Targets: ${String(targetsFound)}/${String(targetsTotal)} present in the dataset` +
      (missing.length > 0 ? ` · missing: ${missing.join(', ')}` : '');
    block.append(line);
  }

  if (result.issues.length > 0) {
    const list = document.createElement('ul');
    list.className = 'q-slotcard-issues';
    for (const issue of result.issues) {
      list.append(renderIssue(issue));
    }
    block.append(list);
  }
  return block;
}

function renderIssue(issue: RuleLintIssue): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `q-rulesissue q-rulesissue--${issue.severity}`;
  const where =
    issue.ruleId !== undefined
      ? `${issue.ruleId}: `
      : issue.rowNumber !== undefined
        ? `row ${String(issue.rowNumber)}: `
        : '';
  item.textContent = `${where}${issue.message}`;
  item.title = issue.detail ?? '';
  return item;
}
