/**
 * Rule Studio workspace (P17/P18) — the lazy chunk behind studioView's route
 * gate: file rail + rule grid + live preview pane (row 1) and the full-width
 * editor drawer (row 2, user-approved layout).
 *
 * Owns every workspace effect — all created once here and never disposed
 * (views live for the app lifetime). The drawer + both CodeMirror editors are
 * built once at mount and toggled per open.
 *
 * Async disciplines:
 * - Draft lint: ONE 400 ms debounce for the whole form → runDraftLint →
 *   editors/field hints; token-guarded; PAUSED while the pipeline runs (a
 *   mid-run EXPLAIN could hit a swapped quac_work) and resumed on settle.
 * - Completion catalog: DESCRIBE quac_work + duckdb_functions() through the
 *   rules-store's lint context — Studio never boots the bridge itself; no
 *   context yet → short retry (the Load view installs it moments after the
 *   dataset signal fires). Functions are session-cached; publishes are
 *   deduped so editors are not reconfigured for identical catalogs.
 */
import { effect, signal } from '../../../app/signals';
import { isRunningStage } from '../../../app/store';
import { openModal } from '../../../app/modal';
import { showToast } from '../../../app/toast';
import { createBadge } from '../../components/badge';
import { createSeverityLabel } from '../../components/severityPill';
import {
  createRuleFile,
  duplicateRule,
  getLintContext,
  insertRule,
  moveRule,
  removeRule,
  rulesState,
  updateRule,
} from '../../../core/rules/rules-store';
import { loadJSSandbox } from '../../../core/rules/sandbox-loader';
import { exportFileName, serializeRuleFile } from '../../../core/rules/serialize';
import { describeColumns } from '../../../core/schema/casting';
import { QUAC_WORK } from '../../../core/bridge/tables';
import { triggerDownload } from '../../components/download';
import { bucketStoredIssues, runDraftLint } from './draftLint';
import { createPreviewPane } from './previewPane';
import { createRuleForm } from './ruleForm';
import { runRuleTest } from './ruleTest';
import type { RuleFormCatalog, TestGateState } from './ruleForm';
import type { ShellContext } from '../../../app/shell';
import type { RulesSlotState } from '../../../core/rules/rules-store';
import type { QCRule, RuleFileLintResult } from '../../../core/rules/types';
import './studioView.css';

type DrawerTarget =
  | { kind: 'new'; fileName: string }
  | { kind: 'edit'; fileName: string; index: number };

export function mountStudioWorkspace(host: HTMLElement, ctx: ShellContext): void {
  // ---------- static DOM ----------
  const banner = document.createElement('p');
  banner.className = 'q-studio-banner';
  banner.hidden = true;
  const bannerText = document.createElement('span');
  bannerText.textContent =
    'Load a dataset to compose rules against it — completions and previews need your columns. ' +
    'SQL checks are pending until then. ';
  const bannerLink = document.createElement('a');
  bannerLink.href = '#/load';
  bannerLink.textContent = 'Go to Load';
  banner.append(bannerText, bannerLink);

  const layout = document.createElement('div');
  layout.className = 'q-studio-layout';

  const rail = document.createElement('nav');
  rail.className = 'q-studio-rail';
  rail.setAttribute('aria-label', 'Rule files');
  const railHead = document.createElement('div');
  railHead.className = 'q-studio-railhead';
  const railTitle = document.createElement('h2');
  railTitle.className = 'q-studio-railtitle';
  railTitle.textContent = 'Rule files';
  const newFileButton = document.createElement('button');
  newFileButton.type = 'button';
  newFileButton.className = 'q-btn q-btn--small q-studio-newfile';
  newFileButton.textContent = 'New file';
  railHead.append(railTitle, newFileButton);
  const fileList = document.createElement('div');
  fileList.className = 'q-studio-files';
  rail.append(railHead, fileList);

  const gridCard = document.createElement('section');
  gridCard.className = 'q-studio-gridcard';
  const gridHead = document.createElement('div');
  gridHead.className = 'q-studio-gridhead';
  const gridTitle = document.createElement('h2');
  gridTitle.className = 'q-studio-gridtitle';
  const downloadButton = document.createElement('button');
  downloadButton.type = 'button';
  downloadButton.className = 'q-btn q-btn--small q-studio-download';
  downloadButton.textContent = 'Download rules CSV';
  const addRuleButton = document.createElement('button');
  addRuleButton.type = 'button';
  addRuleButton.className = 'q-btn q-btn--small q-studio-addrule';
  addRuleButton.textContent = 'Add rule';
  const gridActions = document.createElement('div');
  gridActions.className = 'q-studio-gridactions';
  gridActions.append(downloadButton, addRuleButton);
  gridHead.append(gridTitle, gridActions);
  const gridBody = document.createElement('div');
  gridBody.className = 'q-studio-gridbody';
  gridCard.append(gridHead, gridBody);

  const drawer = document.createElement('section');
  drawer.className = 'q-studio-drawer';
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Rule editor');
  const drawerHead = document.createElement('div');
  drawerHead.className = 'q-studio-drawerhead';
  const drawerTitle = document.createElement('h2');
  drawerTitle.className = 'q-studio-drawertitle';
  drawerHead.append(drawerTitle);
  drawer.append(drawerHead);

  const previewPane = createPreviewPane();

  layout.append(rail, gridCard, previewPane.el, drawer);
  host.append(banner, layout);

  // ---------- state ----------
  const selectedFile = signal<string | null>(null);
  let drawerTarget: DrawerTarget | null = null;

  // ---------- form ----------
  const form = createRuleForm({
    onChange: () => {
      resetTest(); // ANY edit invalidates the last test
      syncGate();
      scheduleDraftLint();
    },
    onTest: () => {
      void runTestNow();
    },
    onSubmit: (draft) => {
      submitDraft(draft);
    },
    onCancel: () => {
      requestDrawerClose();
    },
    isDuplicateId: (id) => {
      const target = drawerTarget;
      const editing = target !== null && target.kind === 'edit' ? target : null;
      for (const parsed of rulesState.get().files) {
        const rules = parsed.file.rules;
        for (let i = 0; i < rules.length; i++) {
          if (editing !== null && parsed.file.name === editing.fileName && i === editing.index) {
            continue;
          }
          if (rules[i]?.ruleId === id) return true;
        }
      }
      return false;
    },
  });
  drawer.append(form.el);

  drawer.addEventListener('keydown', (event) => {
    // CodeMirror/combobox/modal Escapes arrive defaultPrevented — theirs.
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    requestDrawerClose();
  });

  // ---------- draft lint scheduler ----------
  let lintTimer: number | null = null;
  let lintToken = 0;
  let lintPending = false;

  function cancelScheduledLint(): void {
    if (lintTimer !== null) {
      window.clearTimeout(lintTimer);
      lintTimer = null;
    }
    lintToken += 1;
    lintPending = false;
  }

  function scheduleDraftLint(): void {
    if (drawerTarget === null) return;
    if (lintTimer !== null) window.clearTimeout(lintTimer);
    lintTimer = window.setTimeout(() => {
      lintTimer = null;
      void runLintNow();
    }, 400);
  }

  async function runLintNow(): Promise<void> {
    const target = drawerTarget;
    if (target === null) return;
    if (isRunningStage(ctx.store.pipeline.get().stage)) {
      lintPending = true; // resumed by the settle effect below
      return;
    }
    const token = ++lintToken;
    const editing =
      target.kind === 'edit' ? { fileName: target.fileName, index: target.index } : null;
    const result = await runDraftLint(form.readDraft(), target.fileName, editing, {
      ctx: getLintContext(),
      files: rulesState.get().files,
      loadSandbox: loadJSSandbox,
    });
    if (token !== lintToken || drawerTarget === null) return;
    form.setIssues(result);
  }

  // ---------- rule test + save gate (P18) ----------
  let testToken = 0;
  let testState: TestGateState = 'untested';

  /** Invalidate any in-flight test and clear the panel (field change, drawer
   *  open/close, file switch). */
  function resetTest(): void {
    testToken += 1;
    testState = 'untested';
    previewPane.clearTest();
  }

  /**
   * Recompute the gate mode from the draft: lint-only iff there is no lint
   * context OR the rule is external OR any distinct target is missing from
   * the dataset (mirrors engine applicableTargets — the engine would skip the
   * rule, so demanding a test would make the gate unsatisfiable).
   */
  function syncGate(): void {
    const target = drawerTarget;
    if (target === null) return;
    const draft = form.readDraft();
    const lintCtx = getLintContext();
    const external = draft.ruleType === 'external';
    const inapplicable =
      lintCtx !== null &&
      [...new Set(draft.targetVariables)].some((t) => !lintCtx.datasetColumns.includes(t));
    const mode = lintCtx === null || external || inapplicable ? 'lint-only' : 'test';
    // External stays lint-only with the NORMAL label; only data-shaped skips
    // (no dataset / inapplicable targets) get the explicit "Save untested".
    const saveLabel =
      mode === 'lint-only' && !external
        ? 'Save untested'
        : target.kind === 'edit'
          ? 'Save rule'
          : 'Add to file';
    form.setTestGate({
      mode,
      state: testState,
      suspended: isRunningStage(ctx.store.pipeline.get().stage),
      saveLabel,
    });
  }

  async function runTestNow(): Promise<void> {
    // Captured check (runLintNow precedent): narrowing `drawerTarget` here
    // would pin the post-await staleness guard to this value.
    const target = drawerTarget;
    if (target === null) return;
    // Suspended, not queued, while a run holds the bridge — the user re-clicks.
    if (isRunningStage(ctx.store.pipeline.get().stage)) return;
    const lintCtx = getLintContext();
    if (lintCtx === null) return;
    const token = ++testToken;
    testState = 'testing';
    syncGate();
    previewPane.setTestRunning();
    const draft = form.readDraft();
    const result = await runRuleTest(draft, {
      runner: lintCtx.runner,
      datasetColumns: lintCtx.datasetColumns,
      loadSandbox: loadJSSandbox,
    });
    if (token !== testToken || drawerTarget === null) return; // stale — discarded
    testState =
      result.kind === 'error' ? 'failed' : result.kind === 'not-testable' ? 'untested' : 'passed';
    previewPane.renderTestResult(draft, result);
    syncGate();
  }

  // ---------- completion catalog ----------
  let functionsCache: readonly string[] | null = null;
  let catalogToken = 0;
  let publishedKey = '';
  const catalog = signal<RuleFormCatalog | null>(null);

  function refreshCatalog(): void {
    const generation = ctx.store.dataset.get()?.generation ?? 0;
    const token = ++catalogToken;
    if (generation === 0) {
      publishedKey = '';
      catalog.set(null);
      return;
    }
    if (isRunningStage(ctx.store.pipeline.get().stage)) return; // settle re-triggers
    const lintCtx = getLintContext();
    if (lintCtx === null) {
      // The Load view installs the context asynchronously after the dataset
      // signal fires — poll briefly instead of watching a second channel.
      window.setTimeout(() => {
        if (token === catalogToken) refreshCatalog();
      }, 300);
      return;
    }
    void (async () => {
      const columnTypes = await describeColumns(lintCtx.runner, QUAC_WORK);
      functionsCache ??= (
        await lintCtx.runner.query<{ function_name: string }>(
          'SELECT DISTINCT function_name FROM duckdb_functions()',
        )
      ).map((r) => r.function_name);
      if (token !== catalogToken) return;
      const columns = [...columnTypes.entries()].map(([name, type]) => ({ name, type }));
      const key = `${String(generation)}|${columns.map((c) => `${c.name}:${c.type}`).join(',')}`;
      if (key === publishedKey) return;
      publishedKey = key;
      catalog.set({ columns, functions: functionsCache });
    })().catch(() => {
      // Completions are advisory — keep whatever catalog we already had.
    });
  }

  // ---------- drawer ----------
  function openDrawer(target: DrawerTarget): void {
    const state = rulesState.get();
    const parsed = state.files.find((f) => f.file.name === target.fileName);
    if (parsed === undefined) return;
    let rule: QCRule | null = null;
    if (target.kind === 'edit') {
      rule = parsed.file.rules[target.index] ?? null;
      if (rule === null) return;
    }
    drawerTarget = target;
    drawerTitle.textContent =
      target.kind === 'edit' ? `Edit rule — ${target.fileName}` : `New rule — ${target.fileName}`;
    drawer.hidden = false;
    form.load(rule, { mode: target.kind === 'edit' ? 'edit' : 'new' });
    if (target.kind === 'edit' && rule !== null) {
      // Import-back path (P18 task 4): seed the stored file-lint issues for
      // this row instantly — a broken re-imported rule opens with its issues
      // already pinned above the offending fields; the 400 ms debounced draft
      // lint then refreshes them.
      const stored = state.results.find((r) => r.file === target.fileName);
      if (stored !== undefined) form.setIssues(bucketStoredIssues(stored, rule.rowNumber));
    }
    resetTest();
    syncGate();
    scheduleDraftLint();
    form.focusFirst();
  }

  function closeDrawer(restoreFocus: boolean): void {
    const target = drawerTarget;
    if (target === null) return;
    drawerTarget = null;
    cancelScheduledLint();
    resetTest();
    drawer.hidden = true;
    if (restoreFocus) {
      if (target.kind === 'edit') focusGrid(target.fileName, target.index);
      else addRuleButton.focus();
    }
  }

  function requestDrawerClose(): void {
    requestConfirmIfDirty(() => {
      closeDrawer(true);
    });
  }

  function requestConfirmIfDirty(action: () => void): void {
    if (drawerTarget === null || !form.isDirty()) {
      action();
      return;
    }
    void confirmDiscard().then((discard) => {
      if (discard) action();
    });
  }

  function confirmDiscard(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const modal = openModal({
        title: 'Discard changes?',
        onClose: () => {
          settle(false);
        },
      });
      const text = document.createElement('p');
      text.textContent = 'Discard unsaved changes to this rule?';
      const actions = document.createElement('div');
      actions.className = 'q-modal-actions';
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.className = 'q-btn';
      keep.textContent = 'Keep editing';
      keep.addEventListener('click', () => {
        modal.close();
      });
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'q-btn q-btn--primary';
      discard.textContent = 'Discard';
      discard.addEventListener('click', () => {
        settle(true);
        modal.close();
      });
      actions.append(keep, discard);
      modal.body.append(text, actions);
    });
  }

  function submitDraft(draft: QCRule): void {
    const target = drawerTarget;
    if (target === null) return;
    void (async () => {
      if (target.kind === 'edit') {
        const ok = await updateRule(target.fileName, target.index, draft);
        if (!ok) {
          showToast('Could not save — the rule is no longer loaded.', { kind: 'error' });
          return;
        }
        closeDrawer(false);
        focusGrid(target.fileName, target.index);
      } else {
        const index = await insertRule(target.fileName, draft);
        if (index === null) {
          showToast('Could not save — the file is no longer loaded.', { kind: 'error' });
          return;
        }
        closeDrawer(false);
        focusGrid(target.fileName, index);
      }
    })();
  }

  /** Keep an open editor pointing at the same RULE while grid actions
   *  reshuffle indices. Runs BEFORE the mutation publishes — the render
   *  effect fires synchronously on set() and would otherwise close or
   *  mis-target the drawer. */
  function shiftDrawerIndex(fileName: string, map: (index: number) => number): void {
    const target = drawerTarget;
    if (target?.kind !== 'edit' || target.fileName !== fileName) return;
    drawerTarget = { ...target, index: map(target.index) };
  }

  // ---------- rail ----------
  function selectFile(name: string): void {
    if (selectedFile.get() === name) return;
    requestConfirmIfDirty(() => {
      closeDrawer(false);
      selectedFile.set(name);
      // The rail re-rendered (synchronously, in the render effect) — put
      // focus back on the selection so keyboard flow continues from it.
      fileList.querySelector<HTMLElement>('.q-filebtn[aria-current="true"]')?.focus();
    });
  }

  newFileButton.addEventListener('click', () => {
    openNewFileModal();
  });

  function openNewFileModal(): void {
    const modal = openModal({ title: 'New rules file' });
    const intro = document.createElement('p');
    intro.textContent = 'Name the file — .quac.csv is appended automatically.';
    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'q-newfile-field';
    const label = document.createElement('label');
    label.htmlFor = 'q-newfile-name';
    label.textContent = 'File name';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'q-newfile-name';
    input.value = 'my_rules';
    input.autocomplete = 'off';
    input.spellcheck = false;
    const error = document.createElement('p');
    error.className = 'q-field-error';
    error.hidden = true;
    fieldWrap.append(label, input, error);
    const actions = document.createElement('div');
    actions.className = 'q-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'q-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      modal.close();
    });
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'q-btn q-btn--primary';
    create.textContent = 'Create';
    const submit = (): void => {
      void createRuleFile(input.value).then((result) => {
        if (result.ok) {
          modal.close();
          selectFile(result.fileName);
        } else {
          error.textContent =
            result.reason === 'duplicate'
              ? 'A file with this name is already loaded.'
              : 'Enter a file name.';
          error.hidden = false;
        }
      });
    };
    create.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
    actions.append(cancel, create);
    modal.body.append(intro, fieldWrap, actions);
    input.select();
  }

  function renderRail(state: RulesSlotState, selected: string | null): void {
    fileList.replaceChildren();
    if (state.files.length === 0) {
      const note = document.createElement('p');
      note.className = 'q-panel-note';
      note.textContent = 'No rule files yet.';
      fileList.append(note);
      return;
    }
    for (const parsed of state.files) {
      const name = parsed.file.name;
      const result = state.results.find((r) => r.file === name);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'q-filebtn';
      if (name === selected) button.setAttribute('aria-current', 'true');

      const top = document.createElement('span');
      top.className = 'q-filebtn-top';
      const group = document.createElement('span');
      group.className = 'q-filebtn-group';
      group.textContent = parsed.file.group;
      top.append(group);
      if (state.dirtyFiles.has(name)) {
        const dirty = document.createElement('span');
        dirty.className = 'q-filebtn-dirty';
        dirty.textContent = '*';
        dirty.title = 'Edited in this session';
        top.append(dirty);
      }

      const meta = document.createElement('span');
      meta.className = 'q-filebtn-meta';
      const count = document.createElement('span');
      const n = parsed.file.rules.length;
      count.textContent = n === 1 ? '1 rule' : `${String(n)} rules`;
      meta.append(count, fileLintBadge(result));
      button.append(top, meta);

      if (result?.pertinence !== undefined) {
        const line = document.createElement('span');
        line.className = 'q-filebtn-pertinence';
        line.textContent = `${String(result.pertinence.targetsFound)}/${String(
          result.pertinence.targetsTotal,
        )} targets`;
        button.append(line);
      }

      button.addEventListener('click', () => {
        selectFile(name);
      });
      fileList.append(button);
    }
  }

  function fileLintBadge(result: RuleFileLintResult | undefined): HTMLElement {
    if (result === undefined) return createBadge('Linting…', 'neutral');
    const errors = result.issues.filter((i) => i.severity === 'error').length;
    if (errors > 0) {
      return createBadge(errors === 1 ? '1 error' : `${String(errors)} errors`, 'error');
    }
    const warnings = result.issues.filter((i) => i.severity === 'warning').length;
    if (warnings > 0) {
      return createBadge(warnings === 1 ? '1 warning' : `${String(warnings)} warnings`, 'warning');
    }
    return createBadge('OK', 'valid');
  }

  // ---------- rule grid ----------
  function renderGrid(state: RulesSlotState, selected: string | null): void {
    const parsed =
      selected === null ? undefined : state.files.find((f) => f.file.name === selected);
    gridHead.hidden = parsed === undefined;
    gridBody.replaceChildren();
    if (parsed === undefined) {
      const note = document.createElement('p');
      note.className = 'q-panel-note';
      note.textContent =
        'No rule files yet — create one with New file, or load .quac.csv files in the Load view.';
      gridBody.append(note);
      return;
    }
    gridTitle.textContent = parsed.file.name;
    const result = state.results.find((r) => r.file === parsed.file.name);
    const rules = parsed.file.rules;
    if (rules.length === 0) {
      const note = document.createElement('p');
      note.className = 'q-panel-note';
      note.textContent = 'No rules in this file yet.';
      gridBody.append(note);
      return;
    }

    const table = document.createElement('table');
    table.className = 'q-rulegrid';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const heading of ['ID', 'Type', 'Scope', 'Targets', 'Severity', 'Enabled', 'Lint', 'Actions']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = heading;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    rules.forEach((rule, index) => {
      tbody.append(buildRow(parsed.file.name, rule, index, rules.length, result));
    });
    table.append(thead, tbody);
    gridBody.append(table);
  }

  function buildRow(
    fileName: string,
    rule: QCRule,
    index: number,
    total: number,
    result: RuleFileLintResult | undefined,
  ): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    tr.dataset.index = String(index);
    const open = (): void => {
      openRuleAt(fileName, index);
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        open();
      }
    });

    const idCell = document.createElement('td');
    idCell.className = 'q-rulegrid-id';
    idCell.textContent = rule.ruleId === '' ? '(blank)' : rule.ruleId;

    const typeCell = document.createElement('td');
    typeCell.textContent = rule.ruleType;
    const scopeCell = document.createElement('td');
    scopeCell.textContent = rule.ruleScope;

    const targetsCell = document.createElement('td');
    targetsCell.className = 'q-rulegrid-targets';
    const targetsText = rule.targetVariables.join(', ');
    targetsCell.textContent = targetsText;
    if (targetsText !== '') targetsCell.title = targetsText;

    const severityCell = document.createElement('td');
    severityCell.append(createSeverityLabel(rule.severity));

    const enabledCell = document.createElement('td');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled;
    enabled.setAttribute('aria-label', `Enable rule ${rule.ruleId}`);
    enabled.addEventListener('click', (event) => {
      event.stopPropagation(); // a toggle is not a row-open
    });
    enabled.addEventListener('change', () => {
      void updateRule(fileName, index, { ...rule, enabled: enabled.checked }).then((ok) => {
        if (ok) focusGrid(fileName, index, 'input[type="checkbox"]');
      });
    });
    enabledCell.append(enabled);

    const lintCell = document.createElement('td');
    lintCell.append(ruleLintBadge(rule, result));

    const actionsCell = document.createElement('td');
    actionsCell.className = 'q-rulegrid-actions';
    const actionButton = (
      glyph: string,
      ariaLabel: string,
      title: string,
      disabled: boolean,
      onClick: () => void,
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'q-btn q-btn--ghost q-rowbtn';
      button.textContent = glyph;
      button.setAttribute('aria-label', ariaLabel);
      button.title = title;
      button.disabled = disabled;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
      });
      return button;
    };
    const ruleName = rule.ruleId === '' ? `row ${String(index + 1)}` : rule.ruleId;
    actionsCell.append(
      actionButton('⧉', `Duplicate rule ${ruleName}`, 'Duplicate rule', false, () => {
        shiftDrawerIndex(fileName, (i) => (i > index ? i + 1 : i));
        void duplicateRule(fileName, index).then((newIndex) => {
          if (newIndex === null) shiftDrawerIndex(fileName, (i) => (i > index + 1 ? i - 1 : i));
          else focusGrid(fileName, newIndex);
        });
      }),
      actionButton('✕', `Delete rule ${ruleName}`, 'Delete rule', false, () => {
        deleteRuleAt(fileName, index, total);
      }),
      actionButton('↑', `Move rule ${ruleName} up`, 'Row order = correction order', index === 0, () => {
        moveRuleAt(fileName, index, 'up');
      }),
      actionButton(
        '↓',
        `Move rule ${ruleName} down`,
        'Row order = correction order',
        index === total - 1,
        () => {
          moveRuleAt(fileName, index, 'down');
        },
      ),
    );

    tr.append(
      idCell,
      typeCell,
      scopeCell,
      targetsCell,
      severityCell,
      enabledCell,
      lintCell,
      actionsCell,
    );
    return tr;
  }

  function deleteRuleAt(fileName: string, index: number, total: number): void {
    const target = drawerTarget;
    const deletingOpen =
      target !== null &&
      target.kind === 'edit' &&
      target.fileName === fileName &&
      target.index === index;
    const run = (): void => {
      shiftDrawerIndex(fileName, (i) => (i > index ? i - 1 : i));
      void removeRule(fileName, index).then((ok) => {
        if (!ok) {
          shiftDrawerIndex(fileName, (i) => (i >= index ? i + 1 : i));
          return;
        }
        const remaining = total - 1;
        if (remaining > 0) focusGrid(fileName, Math.min(index, remaining - 1));
        else addRuleButton.focus();
      });
    };
    if (deletingOpen) {
      requestConfirmIfDirty(() => {
        closeDrawer(false);
        run();
      });
    } else {
      run();
    }
  }

  function moveRuleAt(fileName: string, index: number, dir: 'up' | 'down'): void {
    const to = dir === 'up' ? index - 1 : index + 1;
    shiftDrawerIndex(fileName, (i) => (i === index ? to : i === to ? index : i));
    void moveRule(fileName, index, dir).then((newIndex) => {
      if (newIndex === null) {
        shiftDrawerIndex(fileName, (i) => (i === index ? to : i === to ? index : i)); // revert
        return;
      }
      focusGrid(fileName, newIndex, 'button[aria-label^="Move"]');
    });
  }

  function ruleLintBadge(rule: QCRule, result: RuleFileLintResult | undefined): HTMLElement {
    if (result === undefined) return createBadge('pending', 'neutral');
    const rowIssues = result.issues.filter((i) => i.rowNumber === rule.rowNumber);
    if (rowIssues.some((i) => i.severity === 'error')) return createBadge('error', 'error');
    if (rowIssues.some((i) => i.severity === 'warning')) return createBadge('warning', 'warning');
    const sqlPendingFile = result.issues.some(
      (i) => i.code === 'pending-data' && i.rowNumber === undefined,
    );
    const sqlLike = rule.ruleType === 'validate' || rule.ruleType === 'correct';
    if (rowIssues.some((i) => i.code === 'pending-data') || (sqlPendingFile && sqlLike)) {
      return createBadge('pending', 'neutral');
    }
    return createBadge('OK', 'valid');
  }

  function openRuleAt(fileName: string, index: number): void {
    const target = drawerTarget;
    if (
      target !== null &&
      target.kind === 'edit' &&
      target.fileName === fileName &&
      target.index === index
    ) {
      form.focusFirst();
      return;
    }
    requestConfirmIfDirty(() => {
      openDrawer({ kind: 'edit', fileName, index });
    });
  }

  // Export (P18 task 3): the §7 writer's bytes, filename <group>.quac.csv.
  // The dirty * is NOT cleared — only a same-name re-import supersedes the
  // session edits (rules-store contract).
  downloadButton.addEventListener('click', () => {
    const selected = selectedFile.get();
    if (selected === null) return;
    const parsed = rulesState.get().files.find((f) => f.file.name === selected);
    if (parsed === undefined) return;
    const text = serializeRuleFile(parsed.file);
    triggerDownload(new Blob([text], { type: 'text/csv' }), exportFileName(parsed.file.name));
  });

  addRuleButton.addEventListener('click', () => {
    const selected = selectedFile.get();
    if (selected === null) return;
    const target = drawerTarget;
    if (target !== null && target.kind === 'new' && target.fileName === selected) {
      form.focusFirst();
      return;
    }
    requestConfirmIfDirty(() => {
      openDrawer({ kind: 'new', fileName: selected });
    });
  });

  function focusGrid(fileName: string, index: number, selector?: string): void {
    if (selectedFile.get() !== fileName) return;
    const row = gridBody.querySelector<HTMLElement>(`tr[data-index="${String(index)}"]`);
    if (row === null) {
      addRuleButton.focus();
      return;
    }
    const inner = selector === undefined ? null : row.querySelector<HTMLElement>(selector);
    (inner ?? row).focus();
  }

  // ---------- effects (all created once; views never unmount) ----------

  // Render: rail + grid from the store snapshot; selection re-derived; the
  // drawer closes when its file (or row) vanished from under it.
  effect(() => {
    const state = rulesState.get();
    const names = state.files.map((f) => f.file.name);
    let selected = selectedFile.get();
    if (selected === null || !names.includes(selected)) selected = names[0] ?? null;
    selectedFile.set(selected); // Object.is-deduped; re-runs this effect once when changed

    const target = drawerTarget;
    if (target !== null) {
      const parsed = state.files.find((f) => f.file.name === target.fileName);
      const stillValid =
        parsed !== undefined &&
        (target.kind === 'new' || target.index < parsed.file.rules.length);
      if (!stillValid) closeDrawer(false);
    }

    renderRail(state, selected);
    renderGrid(state, selected);
  });

  // Notice banner: rules loaded but no dataset yet.
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const state = rulesState.get();
    banner.hidden = !(dataset === null && state.files.length > 0);
  });

  // Draft lint resumes after a pipeline run settles.
  effect(() => {
    const stage = ctx.store.pipeline.get().stage;
    if (!isRunningStage(stage) && lintPending) {
      lintPending = false;
      scheduleDraftLint();
    }
  });

  // Gate mode tracks the lint context and run state: the context installs
  // after the dataset signal (rulesState republish), runs suspend testing,
  // and a dataset change can flip testability entirely.
  effect(() => {
    ctx.store.dataset.get();
    ctx.store.pipeline.get();
    rulesState.get();
    if (drawerTarget !== null) syncGate();
  });

  // Completion catalog: re-check on dataset/pipeline/rules-lint changes.
  effect(() => {
    ctx.store.dataset.get();
    ctx.store.pipeline.get();
    rulesState.get();
    refreshCatalog();
  });

  // Live-preview sample: sync only while the studio route is ACTIVE
  // (data-table mis-measures in hidden containers). A run settling marks the
  // sample stale — post-run `data` holds corrected values — so the next sync
  // refreshes the same generation via loadData.
  let sampleRunInFlight = false;
  let sampleStale = false;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const stage = ctx.store.pipeline.get().stage;
    const route = ctx.router.route.get();
    if (isRunningStage(stage)) {
      sampleRunInFlight = true;
      return;
    }
    if (sampleRunInFlight) {
      sampleRunInFlight = false;
      sampleStale = true;
    }
    if (dataset === null) {
      sampleStale = false;
      previewPane.syncDataset(null);
      return;
    }
    if (route !== 'studio') return;
    previewPane.syncDataset(dataset, { refresh: sampleStale });
    sampleStale = false;
  });

  // Push catalog updates into the form (editors + targets list).
  effect(() => {
    form.setColumns(catalog.get());
  });
}
