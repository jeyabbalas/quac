/**
 * The rule editor form (P17) — fields ↔ .quac.csv columns 1:1. Built ONCE at
 * workspace mount together with its two CodeMirror editors and toggled per
 * drawer open (`load()`), so nothing leaks per open.
 *
 * Live rules enforced here:
 * - (type,scope) matrix: invalid scope options are disabled with the lint
 *   helper's exact message as the tooltip; a type change that would strand an
 *   invalid pair auto-snaps scope to `row`.
 * - A type change resets severity to its format default (correct→info, else
 *   error) — the §2 defaults, applied eagerly so the form never lies.
 * - Save gate (P18): rule_id pattern-valid + unique (synchronous via
 *   deps.isDuplicateId) AND the last completed draft lint had zero errors
 *   (`lastLintOk`, nulled by any edit) AND — in 'test' gate mode — a test
 *   passed since the last edit. 'lint-only' mode (no dataset, external, or
 *   inapplicable targets — the engine would skip the rule) drops the test
 *   requirement; the workspace supplies the submit label ("Save untested"
 *   when the skip is data-shaped).
 * - Values are trimmed on read, matching what parse would do to the CSV cell.
 */
import { isValidTypeScope, typeScopeComboError } from '../../../core/rules/lint';
import { createCodeEditor } from './codeEditor';
import { createTargetsSelect } from './targetsSelect';
import type { CodeEditor, EditorMode } from './codeEditor';
import type { ColumnFeedEntry } from './completionSource';
import type { DraftLintResult } from './draftLint';
import type { QCRule, RuleLintIssue, RuleScope, RuleType, Severity } from '../../../core/rules/types';

export interface RuleFormCatalog {
  columns: readonly ColumnFeedEntry[];
  functions: readonly string[];
}

export interface RuleFormDeps {
  onChange: () => void;
  /** "Test rule" click — the workspace owns the async test run. */
  onTest: () => void;
  onSubmit: (draft: QCRule) => void;
  onCancel: () => void;
  isDuplicateId: (id: string) => boolean;
}

export type TestGateState = 'untested' | 'testing' | 'passed' | 'failed';

export interface TestGate {
  /** 'lint-only' hides the test affordances and drops the test requirement. */
  mode: 'test' | 'lint-only';
  state: TestGateState;
  /** True while the pipeline runs — tests are suspended, not queued. */
  suspended: boolean;
  /** Submit label — the workspace computes "Save untested" for lint-only. */
  saveLabel: string;
}

export interface RuleForm {
  readonly el: HTMLElement;
  load: (rule: QCRule | null, opts: { mode: 'new' | 'edit' }) => void;
  readDraft: () => QCRule;
  setIssues: (result: DraftLintResult | null) => void;
  setTestGate: (gate: TestGate) => void;
  setColumns: (catalog: RuleFormCatalog | null) => void;
  isDirty: () => boolean;
  focusFirst: () => void;
}

const RULE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const TYPES: readonly RuleType[] = ['validate', 'correct', 'external'];
const SCOPES: readonly RuleScope[] = ['row', 'column', 'dataset', 'longitudinal'];
const SEVERITIES: readonly Severity[] = ['error', 'warning', 'info'];

const defaultSeverity = (type: RuleType): Severity => (type === 'correct' ? 'info' : 'error');

const NEW_RULE: QCRule = {
  ruleId: '',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: [],
  condition: '',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: '',
  enabled: true,
  sourceFile: '',
  rowNumber: 0,
  extras: {},
};

const TEST_STATUS_TEXT: Record<TestGateState, string> = {
  untested: 'Untested',
  testing: 'Testing…',
  passed: 'Tested ✓',
  failed: 'Test failed — see the preview panel.',
};

export function createRuleForm(deps: RuleFormDeps): RuleForm {
  let mode: 'new' | 'edit' = 'new';
  let loaded: QCRule | null = null;
  let dirty = false;
  let loadingFields = false;
  let catalog: RuleFormCatalog | null = null;
  let updateLanguage: 'sql' | 'js' = 'sql';
  /** Verdict of the last COMPLETED draft lint; null = edited since (pending). */
  let lastLintOk: boolean | null = null;
  let gate: TestGate = { mode: 'lint-only', state: 'untested', suspended: false, saveLabel: 'Add to file' };

  // ---------- controls ----------
  const el = document.createElement('form');
  el.className = 'q-ruleform';
  el.noValidate = true;

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.id = 'q-rf-id';
  idInput.className = 'q-rf-mono';
  idInput.autocomplete = 'off';
  idInput.spellcheck = false;

  const idError = document.createElement('p');
  idError.className = 'q-field-error';
  idError.hidden = true;

  const makeSelect = (id: string, options: readonly string[]): HTMLSelectElement => {
    const select = document.createElement('select');
    select.id = id;
    for (const value of options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    return select;
  };
  const typeSelect = makeSelect('q-rf-type', TYPES);
  const scopeSelect = makeSelect('q-rf-scope', SCOPES);
  const severitySelect = makeSelect('q-rf-severity', SEVERITIES);

  const enabledCheck = document.createElement('input');
  enabledCheck.type = 'checkbox';
  enabledCheck.id = 'q-rf-enabled';
  enabledCheck.checked = true;

  const targets = createTargetsSelect({ onChange: handleChange });

  const conditionEditor = createCodeEditor({
    mode: 'sql',
    ariaLabel: 'condition',
    onChange: handleChange,
  });
  const externalNote = document.createElement('p');
  externalNote.className = 'q-panel-note';
  externalNote.textContent = 'External rules are loaded and listed, never executed.';
  externalNote.hidden = true;

  const langTabs = document.createElement('div');
  langTabs.className = 'q-paneltabs q-rf-langtabs';
  const makeLangTab = (label: string, value: 'sql' | 'js'): HTMLButtonElement => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'q-paneltab';
    tab.textContent = label;
    tab.addEventListener('click', () => {
      if (loadingFields || updateLanguage === value) return;
      updateLanguage = value;
      markChanged();
      syncMatrixAndModes();
      syncPreviewAndGate();
      deps.onChange();
    });
    return tab;
  };
  const langSqlTab = makeLangTab('SQL', 'sql');
  const langJsTab = makeLangTab('JS', 'js');
  langTabs.append(langSqlTab, langJsTab);

  const updateEditor = createCodeEditor({
    mode: 'sql',
    ariaLabel: 'update_expression',
    onChange: handleChange,
  });

  const commentInput = document.createElement('textarea');
  commentInput.id = 'q-rf-comment';
  commentInput.rows = 2;

  const preview = document.createElement('p');
  preview.className = 'q-rf-preview';

  const generalIssues = document.createElement('ul');
  generalIssues.className = 'q-form-general';
  generalIssues.setAttribute('aria-live', 'polite');
  generalIssues.hidden = true;

  const testButton = document.createElement('button');
  testButton.type = 'button';
  testButton.className = 'q-btn q-rf-test';
  testButton.textContent = 'Test rule';
  testButton.addEventListener('click', () => {
    deps.onTest();
  });
  const testStatus = document.createElement('span');
  testStatus.className = 'q-rf-teststatus';
  testStatus.setAttribute('aria-live', 'polite');
  testStatus.textContent = TEST_STATUS_TEXT.untested;

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'q-btn';
  cancelButton.textContent = 'Cancel';
  cancelButton.addEventListener('click', () => {
    deps.onCancel();
  });
  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'q-btn q-btn--primary';
  submitButton.textContent = 'Add to file';

  // ---------- layout ----------
  interface FieldParts {
    wrap: HTMLDivElement;
    issues: HTMLUListElement;
  }
  const field = (
    labelText: string,
    controlId: string | null,
    control: HTMLElement,
    className: string,
  ): FieldParts => {
    const wrap = document.createElement('div');
    wrap.className = `q-rf-field ${className}`;
    let labelEl: HTMLElement;
    if (controlId === null) {
      // CodeMirror hosts carry their own aria-label; this is the visual label.
      labelEl = document.createElement('span');
      labelEl.setAttribute('aria-hidden', 'true');
    } else {
      const label = document.createElement('label');
      label.htmlFor = controlId;
      labelEl = label;
    }
    labelEl.className = 'q-rf-label';
    labelEl.textContent = labelText;
    const issues = document.createElement('ul');
    issues.className = 'q-field-issues';
    issues.hidden = true;
    wrap.append(labelEl, control, issues);
    return { wrap, issues };
  };

  const idField = field('rule_id', 'q-rf-id', idInput, 'q-rf-field--id');
  idField.wrap.insertBefore(idError, idField.issues);
  const typeField = field('rule_type', 'q-rf-type', typeSelect, 'q-rf-field--type');
  const scopeField = field('rule_scope', 'q-rf-scope', scopeSelect, 'q-rf-field--scope');
  const severityField = field('severity', 'q-rf-severity', severitySelect, 'q-rf-field--severity');

  const enabledWrap = document.createElement('div');
  enabledWrap.className = 'q-rf-field q-rf-field--enabled';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'q-rf-check';
  enabledLabel.htmlFor = 'q-rf-enabled';
  enabledLabel.append(enabledCheck, document.createTextNode(' enabled'));
  enabledWrap.append(enabledLabel);

  const targetsField = field(
    'target_variables',
    'q-rf-targets',
    targets.el,
    'q-rf-field--targets',
  );
  const conditionField = field('condition', null, conditionEditor.el, 'q-rf-field--condition');
  conditionField.wrap.append(externalNote);

  const correctionBlock = document.createElement('fieldset');
  correctionBlock.className = 'q-rf-correction';
  const correctionLegend = document.createElement('legend');
  correctionLegend.textContent = 'Correction';
  const updateField = field(
    'update_expression',
    null,
    updateEditor.el,
    'q-rf-field--update',
  );
  correctionBlock.append(correctionLegend, langTabs, updateField.wrap);

  const commentField = field('comment', 'q-rf-comment', commentInput, 'q-rf-field--comment');
  commentField.wrap.append(preview);

  const head = document.createElement('div');
  head.className = 'q-rf-head';
  head.append(idField.wrap, typeField.wrap, scopeField.wrap, severityField.wrap, enabledWrap);

  const footer = document.createElement('div');
  footer.className = 'q-rf-footer';
  footer.append(testButton, testStatus, cancelButton, submitButton);

  el.append(head, targetsField.wrap, conditionField.wrap, correctionBlock, commentField.wrap, generalIssues, footer);

  // ---------- behaviour ----------
  function currentType(): RuleType {
    return typeSelect.value as RuleType;
  }
  function currentScope(): RuleScope {
    return scopeSelect.value as RuleScope;
  }

  /** Any edit invalidates the last lint verdict (the gate goes pending). */
  function markChanged(): void {
    dirty = true;
    lastLintOk = null;
  }

  function handleChange(): void {
    if (loadingFields) return;
    markChanged();
    syncPreviewAndGate();
    deps.onChange();
  }

  typeSelect.addEventListener('change', () => {
    if (loadingFields) return;
    const type = currentType();
    severitySelect.value = defaultSeverity(type);
    if (!isValidTypeScope(type, currentScope())) scopeSelect.value = 'row'; // auto-snap
    markChanged();
    syncMatrixAndModes();
    syncPreviewAndGate();
    deps.onChange();
  });
  scopeSelect.addEventListener('change', () => {
    if (loadingFields) return;
    markChanged();
    syncMatrixAndModes();
    syncPreviewAndGate();
    deps.onChange();
  });
  severitySelect.addEventListener('change', handleChange);
  enabledCheck.addEventListener('change', handleChange);
  idInput.addEventListener('input', handleChange);
  commentInput.addEventListener('input', handleChange);

  el.addEventListener('submit', (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;
    deps.onSubmit(readDraft());
  });

  function conditionMode(type: RuleType): EditorMode {
    return type === 'external' ? 'text' : 'sql';
  }

  function feedFor(
    editor: 'condition' | 'update_expression',
  ): Parameters<CodeEditor['setCompletionFeed']>[0] {
    // No catalog yet (or no dataset): the engine tokens and assertion
    // snippets still complete — only columns/functions need the dataset.
    return {
      columns: catalog?.columns ?? [],
      functions: catalog?.functions ?? [],
      ruleType: currentType(),
      ruleScope: currentScope(),
      field: editor,
    };
  }

  /** Everything derived from (type, scope, update_language) — matrix state,
   *  editor modes, completion feeds, and block visibility. */
  function syncMatrixAndModes(): void {
    const type = currentType();
    for (const option of scopeSelect.options) {
      const comboError = typeScopeComboError(type, option.value as RuleScope);
      option.disabled = comboError !== null;
      option.title = comboError ?? '';
    }
    conditionEditor.setMode(conditionMode(type));
    externalNote.hidden = type !== 'external';
    correctionBlock.hidden = type !== 'correct';
    updateEditor.setMode(updateLanguage === 'js' ? 'js' : 'sql');
    langSqlTab.classList.toggle('q-paneltab--active', updateLanguage === 'sql');
    langSqlTab.setAttribute('aria-pressed', updateLanguage === 'sql' ? 'true' : 'false');
    langJsTab.classList.toggle('q-paneltab--active', updateLanguage === 'js');
    langJsTab.setAttribute('aria-pressed', updateLanguage === 'js' ? 'true' : 'false');
    conditionEditor.setCompletionFeed(feedFor('condition'));
    updateEditor.setCompletionFeed(feedFor('update_expression'));
  }

  function idErrorText(id: string): string | null {
    if (id === '') return 'rule_id is required.';
    if (!RULE_ID_RE.test(id)) return 'rule_id must match [A-Za-z][A-Za-z0-9_-]*.';
    if (deps.isDuplicateId(id)) return 'This rule_id is already used by another rule.';
    return null;
  }

  function syncPreviewAndGate(): void {
    const id = idInput.value.trim();
    preview.textContent = `${id === '' ? 'rule_id' : id}: ${commentInput.value.trim()}`;
    const error = idErrorText(id);
    idError.textContent = error ?? '';
    idError.hidden = error === null;
    // The P18 gate: valid unique id AND a clean completed lint AND — unless
    // the rule is lint-only — a test passed since the last edit.
    const tested = gate.mode === 'lint-only' || gate.state === 'passed';
    submitButton.disabled = error !== null || lastLintOk !== true || !tested;
    submitButton.textContent = gate.saveLabel;
    const lintOnly = gate.mode === 'lint-only';
    testButton.hidden = lintOnly;
    testStatus.hidden = lintOnly;
    testButton.disabled = gate.state === 'testing' || gate.suspended;
    testStatus.textContent = TEST_STATUS_TEXT[gate.state];
  }

  function applyCatalog(): void {
    targets.setColumns(catalog?.columns ?? [], catalog !== null);
    conditionEditor.setCompletionFeed(feedFor('condition'));
    updateEditor.setCompletionFeed(feedFor('update_expression'));
  }

  function renderIssueList(container: HTMLUListElement, issues: readonly RuleLintIssue[]): void {
    container.replaceChildren();
    container.hidden = issues.length === 0;
    for (const issue of issues) {
      const item = document.createElement('li');
      item.className = `q-field-issue q-field-issue--${issue.severity}`;
      item.textContent = issue.message;
      if (issue.detail !== undefined) item.title = issue.detail;
      container.append(item);
    }
  }

  function setIssues(result: DraftLintResult | null): void {
    lastLintOk = result === null ? null : result.ok;
    conditionEditor.setIssues(result?.byField.condition ?? []);
    updateEditor.setIssues(result?.byField.update_expression ?? []);
    // rule_id issues are owned by the synchronous gate above — not mirrored.
    renderIssueList(typeField.issues, result?.byField.rule_type ?? []);
    renderIssueList(scopeField.issues, result?.byField.rule_scope ?? []);
    renderIssueList(severityField.issues, result?.byField.severity ?? []);
    renderIssueList(targetsField.issues, result?.byField.target_variables ?? []);
    renderIssueList(commentField.issues, result?.byField.comment ?? []);
    renderIssueList(updateField.issues, result?.byField.update_language ?? []);
    renderIssueList(generalIssues, result?.general ?? []);
    syncPreviewAndGate(); // lastLintOk feeds the submit gate
  }

  function readDraft(): QCRule {
    const type = currentType();
    return {
      ruleId: idInput.value.trim(),
      ruleType: type,
      ruleScope: currentScope(),
      targetVariables: targets.getValues(),
      condition: conditionEditor.getValue().trim(),
      updateLanguage,
      updateExpression: type === 'correct' ? updateEditor.getValue().trim() : '',
      severity: severitySelect.value as Severity,
      comment: commentInput.value.trim(),
      enabled: enabledCheck.checked,
      // Placeholders — the store's serialize→parse round-trip recomputes them.
      sourceFile: loaded?.sourceFile ?? '',
      rowNumber: loaded?.rowNumber ?? 0,
      extras: loaded?.extras ?? {},
    };
  }

  function load(rule: QCRule | null, opts: { mode: 'new' | 'edit' }): void {
    mode = opts.mode;
    loaded = rule;
    loadingFields = true;
    const source = rule ?? NEW_RULE;
    idInput.value = source.ruleId;
    // Structured controls cannot represent an invalid enum (parse keeps the
    // raw text after a bad-enum error) — fall back to the format defaults;
    // saving then normalizes the row, which fixes the lint error.
    typeSelect.value = TYPES.includes(source.ruleType) ? source.ruleType : 'validate';
    scopeSelect.value = SCOPES.includes(source.ruleScope) ? source.ruleScope : 'row';
    if (!isValidTypeScope(currentType(), currentScope())) scopeSelect.value = 'row';
    severitySelect.value = SEVERITIES.includes(source.severity)
      ? source.severity
      : defaultSeverity(currentType());
    enabledCheck.checked = source.enabled;
    targets.setValues(source.targetVariables);
    conditionEditor.setValue(source.condition);
    updateLanguage = source.updateLanguage === 'js' ? 'js' : 'sql';
    updateEditor.setValue(source.updateExpression);
    commentInput.value = source.comment;
    // Fresh gate per open — the workspace immediately follows with the real
    // setTestGate; this default only bridges the synchronous gap.
    gate = {
      mode: 'lint-only',
      state: 'untested',
      suspended: false,
      saveLabel: mode === 'edit' ? 'Save rule' : 'Add to file',
    };
    dirty = false;
    setIssues(null);
    applyCatalog();
    syncMatrixAndModes();
    syncPreviewAndGate();
    loadingFields = false;
  }

  load(null, { mode: 'new' });

  return {
    el,
    load,
    readDraft,
    setIssues,
    setTestGate: (next) => {
      gate = next;
      syncPreviewAndGate();
    },
    setColumns: (next) => {
      catalog = next;
      applyCatalog();
    },
    isDirty: () => dirty,
    focusFirst: () => {
      idInput.focus();
    },
  };
}
