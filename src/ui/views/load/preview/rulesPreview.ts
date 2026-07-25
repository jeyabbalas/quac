/**
 * Preview → QC rules panel: every rule in every loaded .quac.csv, one table
 * per file, with a search box over the lot and the two expression columns
 * syntax-highlighted.
 *
 * The TAB is named for the input (`QC rules`, the slot card's name); the
 * caption inside names the rendering, the way the JSON Schema panel's does.
 * Files keep LOAD ORDER — it is the cross-file correction-order contract
 * (qc-rules-engine.md §2), so re-sorting them would misrepresent the run.
 *
 * DOM only — the model is rulesPreviewModel.ts, the highlighting is
 * exprHighlight.ts. Structure deliberately mirrors dataDictionary.ts so the
 * two panels read as one component: `q-rp-*` is `q-dd-*` with files where the
 * categories are.
 *
 * Deliberately NOT here: lint findings. The rules slot card owns per-file lint
 * blocks and this panel points at it rather than restating them, exactly as
 * the dictionary does with the schema card. `off` and `external` stay, because
 * they are properties of the rule, not findings about it.
 */
import { effect } from '../../../../app/signals';
import { rulesState } from '../../../../core/rules/rules-store';
import { createBadge } from '../../../components/badge';
import { createSeverityLabel } from '../../../components/severityPill';
import { preloadHighlighter, renderExpr } from './exprHighlight';
import { note, overflowDetails } from './previewDom';
import { rulesMetaLine } from './previewModel';
import {
  conditionLang,
  countReadout,
  noMatchMessage,
  parseQuery,
  ruleHaystack,
  ruleIdLabel,
  ruleMatches,
  rulesCount,
  typeScopeLabel,
  updateLang,
} from './rulesPreviewModel';
import type { ParsedRuleFile } from '../../../../core/rules/parse';
import type { QCRule } from '../../../../core/rules/types';

/** A screen reader should hear "3 of 22 rules" once, not per keystroke. */
const COUNT_ANNOUNCE_DELAY_MS = 300;

/** Beyond this many targets the cell is taller than everything beside it. */
const TARGET_CAP = 6;

const COLUMNS = [
  'Rule',
  'Targets',
  'Condition',
  'Update expression',
  'Severity',
  'Comment',
] as const;

/**
 * `rule_id`, with `type · scope` folded under it — the `.q-dd-format`
 * treatment, and the same pairing the Studio grid's `Type · Scope` column
 * makes. `enabled: false` and `external` are row treatment rather than two
 * more columns: both are empty on almost every row, and both change how you
 * read the rule rather than adding a fact beside it.
 */
function idCell(rule: QCRule): HTMLTableCellElement {
  const th = document.createElement('th');
  th.scope = 'row';
  th.className = 'q-rp-id';
  th.append(document.createTextNode(ruleIdLabel(rule)));
  if (!rule.enabled) th.append(createBadge('off', 'neutral'));
  if (rule.ruleType === 'external') th.append(createBadge('external', 'neutral'));
  const typeScope = document.createElement('span');
  typeScope.className = 'q-rp-typescope';
  typeScope.textContent = typeScopeLabel(rule);
  th.append(typeScope);
  return th;
}

function targetsCell(rule: QCRule): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'q-rp-targets';
  // Legal and common on `dataset` scope, where the rule's SELECT names its own
  // columns (qc-rules-format.md §4).
  if (rule.targetVariables.length === 0) {
    td.textContent = '—';
    return td;
  }
  const chip = (name: string): HTMLElement => {
    const span = document.createElement('span');
    span.className = 'q-rp-chip';
    // Soft break opportunities after underscores, the reportPanels.ts:65
    // idiom (a deliberate local copy — that helper is private to the Report
    // view, and this is six lines): the column is ~186px at 1440 and HESP's
    // target names run to 29 characters, so without them
    // `total_household_income_annual` breaks at whatever character lands on
    // the edge. `overflow-wrap: anywhere` stays as the backstop for a segment
    // that still does not fit.
    name.split(/(?<=_)/).forEach((segment, index) => {
      if (index > 0) span.append(document.createElement('wbr'));
      span.append(segment);
    });
    return span;
  };
  const shown = rule.targetVariables.slice(0, TARGET_CAP);
  for (const name of shown) td.append(chip(name));
  const hidden = rule.targetVariables.slice(TARGET_CAP);
  if (hidden.length > 0) {
    td.append(
      overflowDetails(hidden.length, (host) => {
        for (const name of hidden) host.append(chip(name));
      }),
    );
  }
  return td;
}

function exprCell(code: string, lang: ReturnType<typeof conditionLang>): HTMLTableCellElement {
  const td = document.createElement('td');
  td.className = 'q-rp-expr';
  if (code === '') {
    td.textContent = '—';
    return td;
  }
  const host = document.createElement('div');
  host.className = 'q-rp-code';
  renderExpr(host, code, lang);
  td.append(host);
  return td;
}

/** The update expression, plus which language it is written in — the one thing
 *  the highlighting alone cannot say, and the thing that decides how it runs. */
function updateCell(rule: QCRule): HTMLTableCellElement {
  const td = exprCell(rule.updateExpression, updateLang(rule));
  if (rule.updateExpression === '') return td;
  const lang = document.createElement('span');
  lang.className = 'q-rp-lang';
  lang.textContent = updateLang(rule);
  td.append(lang);
  return td;
}

interface RenderedRule {
  tr: HTMLTableRowElement;
  haystack: string;
}

interface RenderedFile {
  section: HTMLDetailsElement;
  count: HTMLElement;
  rules: RenderedRule[];
  /** What the USER last left this open at — restored when a filter clears. */
  userOpen: boolean;
}

export function mountRulesPreview(panel: HTMLElement): void {
  const head = document.createElement('div');
  head.className = 'q-preview-panelhead';
  const title = document.createElement('h3');
  title.className = 'q-preview-paneltitle';
  title.textContent = 'QC rules';
  const meta = document.createElement('span');
  meta.className = 'q-preview-meta';
  head.append(title, meta);

  // Says what the thing below the head IS, in every state. Outside `body`, so
  // the state notes below replace themselves without taking it with them.
  const caption = document.createElement('p');
  caption.className = 'q-preview-panelcaption';
  caption.textContent = 'QC rules files, one table per file';

  const body = document.createElement('div');
  panel.append(head, caption, body);

  const showNote = (text: string): void => {
    meta.textContent = '';
    body.replaceChildren(note(text));
  };
  const EMPTY = 'Load a QC rules file to see it here.';
  showNote(EMPTY);

  // What is currently on screen, BY REFERENCE. rules-store replaces the array
  // on every real change and reuses it when only lint results move, so this is
  // exactly "the rules did not change" — and every load ends with a second
  // publish (the re-lint once the dataset lands, `lintedWithData`) that would
  // otherwise rebuild the panel a beat after it appeared, throwing away the
  // <details> the user had just collapsed and the query they had just typed.
  let renderedFiles: readonly ParsedRuleFile[] | null = null;

  effect(() => {
    const state = rulesState.get();
    if (state.files.length === 0) {
      renderedFiles = null;
      showNote(EMPTY);
      return;
    }
    if (state.phase === 'loading') {
      renderedFiles = null;
      showNote('Reading the rules files…');
      return;
    }
    if (state.files === renderedFiles) return;
    renderedFiles = state.files;
    renderFiles(state.files);
  });

  function renderFiles(files: readonly ParsedRuleFile[]): void {
    // Counted off the FILES, not the lint results: the two agree once lint
    // settles (lint.ts:328 is `file.rules.length`), and the files are what
    // this panel is actually drawing.
    const total = files.reduce((sum, f) => sum + f.file.rules.length, 0);
    if (total === 0) {
      showNote('These rule files contain no rules.');
      return;
    }
    meta.textContent = rulesMetaLine(files.length, total);
    // The chunk starts downloading now rather than at mount: a first-run
    // visitor with no rules loaded must never pay for CodeMirror.
    preloadHighlighter();

    const searchWrap = document.createElement('div');
    searchWrap.className = 'q-rp-head';
    const field = document.createElement('div');
    field.className = 'q-rp-search';
    // A REAL visible <label for>, not aria-label: axe's `label` is critical.
    const label = document.createElement('label');
    label.className = 'q-rp-search-label';
    label.htmlFor = 'q-rp-search';
    label.textContent = 'Search rules';
    const input = document.createElement('input');
    input.id = 'q-rp-search';
    input.className = 'q-rp-search-input';
    input.type = 'search'; // native clear button + Escape-to-clear
    input.autocomplete = 'off';
    input.placeholder = 'Rule ID, target, condition, or comment';
    field.append(label, input);

    // Filled by the file loop below; the control beside the search box and the
    // filter both drive the files through it.
    const rendered: RenderedFile[] = [];
    // DERIVED from what is on screen rather than stored, so the label cannot
    // drift out of step with a file collapsed by hand.
    const anyOpen = (): boolean => rendered.some((f) => !f.section.hidden && f.section.open);
    const toggleAll = document.createElement('button');
    toggleAll.type = 'button';
    toggleAll.className = 'q-btn q-btn--ghost q-btn--small q-rp-toggleall';
    const syncToggleAll = (): void => {
      toggleAll.textContent = anyOpen() ? 'Collapse all' : 'Expand all';
    };
    toggleAll.addEventListener('click', () => {
      const target = !anyOpen();
      for (const file of rendered) {
        file.section.open = target;
        file.userOpen = target;
      }
      syncToggleAll();
    });

    const count = document.createElement('p');
    count.className = 'q-rp-count';
    count.setAttribute('role', 'status');
    count.textContent = rulesCount(total);
    searchWrap.append(field, toggleAll, count);

    const scroll = document.createElement('div');
    scroll.className = 'q-rp-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    // Named distinctly from the tab panel itself.
    scroll.setAttribute('aria-label', 'QC rules by file');

    files.forEach((parsed, index) => {
      // Native <details>, open by default: axe skips unrendered subtrees, so a
      // collapsed default would take every table out of the gate, and both
      // Collapse all and the search override reduce to writing `.open`.
      const section = document.createElement('details');
      section.className = 'q-rp-file';
      section.open = true;
      section.addEventListener('toggle', syncToggleAll);
      const fileHead = document.createElement('summary');
      fileHead.className = 'q-rp-filehead';
      const mark = document.createElement('span');
      mark.className = 'q-rp-filemark';
      mark.setAttribute('aria-hidden', 'true');
      // <summary> takes "phrasing content, optionally intermixed with heading
      // content" (WHATWG), so the <h4> stays a real heading inside it: the
      // h3 → h4 order and the table's aria-labelledby are untouched.
      const fileTitle = document.createElement('h4');
      fileTitle.className = 'q-rp-filetitle';
      // Index-based, so it is always a valid HTML id (axe: duplicate-id-aria).
      fileTitle.id = `q-rp-file-${String(index)}`;
      fileTitle.textContent = parsed.file.name;
      const fileCount = document.createElement('span');
      fileCount.className = 'q-rp-filecount';
      fileCount.textContent = rulesCount(parsed.file.rules.length);
      fileHead.append(mark, fileTitle, fileCount);
      section.append(fileHead);

      const table = document.createElement('table');
      table.className = 'q-rp-table';
      table.setAttribute('aria-labelledby', fileTitle.id);
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const column of COLUMNS) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = column;
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement('tbody');
      const rules: RenderedRule[] = [];
      for (const rule of parsed.file.rules) {
        const tr = document.createElement('tr');
        if (!rule.enabled) tr.className = 'q-rp-row--off';
        const severity = document.createElement('td');
        severity.append(createSeverityLabel(rule.severity));
        const comment = document.createElement('td');
        comment.className = 'q-rp-comment';
        comment.textContent = rule.comment;
        tr.append(
          idCell(rule),
          targetsCell(rule),
          exprCell(rule.condition, conditionLang(rule)),
          updateCell(rule),
          severity,
          comment,
        );
        tbody.append(tr);
        rules.push({ tr, haystack: ruleHaystack(rule) });
      }
      table.append(thead, tbody);
      section.append(table);
      scroll.append(section);
      rendered.push({ section, count: fileCount, rules, userOpen: true });
    });
    syncToggleAll();

    body.replaceChildren(searchWrap, scroll);

    // ---- filtering ----
    // A per-row `hidden` toggle, not a rebuild: a rebuild would destroy every
    // <details> the user just opened, reset the scroll position mid-typing,
    // and re-run the tokenizer on all 22 expressions per keystroke.
    let announce: ReturnType<typeof setTimeout> | undefined;
    // Search wins over a collapsed file — a match you cannot see is a filter
    // that lies — but it must hand back what the user had open. The snapshot
    // is taken on the TRANSITION into filtering rather than by listening for
    // user toggles: `toggle` fires from a queued task and cannot tell a click
    // from a programmatic write.
    let filtering = false;
    const applyFilter = (): void => {
      const tokens = parseQuery(input.value);
      const nowFiltering = tokens.length > 0;
      if (nowFiltering && !filtering) for (const f of rendered) f.userOpen = f.section.open;
      let visible = 0;
      for (const file of rendered) {
        let shown = 0;
        for (const { tr, haystack } of file.rules) {
          const match = ruleMatches(haystack, tokens);
          tr.hidden = !match;
          if (match) shown += 1;
        }
        // The per-file count shows the CURRENTLY VISIBLE number, so it is
        // never a lie while filtered; empty files hide entirely.
        file.count.textContent = rulesCount(shown);
        file.section.hidden = shown === 0;
        file.section.open = nowFiltering ? shown > 0 : file.userOpen;
        visible += shown;
      }
      filtering = nowFiltering;
      syncToggleAll();

      const empty = body.querySelector('.q-rp-empty');
      if (visible === 0) {
        if (empty === null) {
          const p = note(noMatchMessage(input.value));
          p.classList.add('q-rp-empty');
          scroll.after(p);
        } else {
          empty.textContent = noMatchMessage(input.value);
        }
      } else {
        empty?.remove();
      }

      const text = countReadout(visible, total, nowFiltering);
      // The filter runs synchronously; only the role="status" readout is
      // debounced, so a screen reader hears the result once when you stop
      // typing.
      clearTimeout(announce);
      announce = setTimeout(() => {
        count.textContent = text;
      }, COUNT_ANNOUNCE_DELAY_MS);
    };
    input.addEventListener('input', applyFilter);
  }
}
