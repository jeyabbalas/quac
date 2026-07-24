/**
 * CodeMirror 6 wrapper for the Studio editors (P17) — the ONLY module that
 * imports @codemirror/* (bundle gate: `cm-announced` must never reach the
 * entry chunk; this file is part of the lazy studio workspace chunk).
 *
 * Modes: 'sql' (PostgreSQL dialect, lang-sql schema completion over the
 * canonical `data` view, plus the custom feed from completionSource.ts),
 * 'js' (lang-javascript for correction functions), 'text' (bare — external
 * rules are never executed, so nothing completes or highlights).
 *
 * Diagnostics are PUSHED via @codemirror/lint's setDiagnostics — the form's
 * one debounced draft lint owns the schedule, not per-editor linter() pulls.
 * DuckDB reports no offsets, so every issue spans the whole doc; each editor
 * also mirrors its issues into a `<ul class="q-editor-diags">` (aria-live,
 * stable e2e target — CM hover tooltips are not assertable).
 */
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import { buildCompletions, columnOptions } from './completionSource';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { RuleLintIssue } from '../../../core/rules/types';
import type { CompletionFeedContext } from './completionSource';

export type EditorMode = 'sql' | 'js' | 'text';

export interface CodeEditorOptions {
  mode: EditorMode;
  ariaLabel: string;
  onChange?: () => void;
}

export interface CodeEditor {
  readonly el: HTMLElement;
  getValue: () => string;
  setValue: (value: string) => void;
  setMode: (mode: EditorMode) => void;
  setCompletionFeed: (feed: CompletionFeedContext | null) => void;
  setIssues: (issues: readonly RuleLintIssue[]) => void;
  focus: () => void;
  destroy: () => void;
}

export function createCodeEditor(options: CodeEditorOptions): CodeEditor {
  let currentMode = options.mode;
  let currentFeed: CompletionFeedContext | null = null;
  let feedOptions: Completion[] = [];

  // Reads `feedOptions` live — feed changes need no reconfiguration for the
  // custom entries (only the lang-sql schema does, below).
  const feedSource = (ctx: CompletionContext): CompletionResult | null => {
    if (feedOptions.length === 0) return null;
    const word = ctx.matchBefore(/[\w$]+/);
    if (word === null && !ctx.explicit) return null;
    return { from: word?.from ?? ctx.pos, options: feedOptions, validFor: /^[\w$]*$/ };
  };

  const languageCompartment = new Compartment();
  const completionCompartment = new Compartment();

  const languageExt = (mode: EditorMode, feed: CompletionFeedContext | null): Extension => {
    if (mode === 'sql') {
      const support = sql({
        dialect: PostgreSQL,
        schema: { data: columnOptions(feed?.columns ?? []) },
        defaultTable: 'data',
      });
      return [support, support.language.data.of({ autocomplete: feedSource })];
    }
    if (mode === 'js') return javascript();
    return [];
  };
  const completionExt = (mode: EditorMode): Extension =>
    mode === 'text' ? [] : autocompletion();

  const el = document.createElement('div');
  el.className = 'q-editor';
  const mount = document.createElement('div');
  mount.className = 'q-editor-host';
  const diags = document.createElement('ul');
  diags.className = 'q-editor-diags';
  diags.setAttribute('aria-live', 'polite');
  diags.hidden = true;
  el.append(mount, diags);

  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        closeBrackets(),
        bracketMatching(),
        syntaxHighlighting(classHighlighter),
        EditorView.lineWrapping,
        // No Tab binding on purpose: Tab must keep walking the form
        // (keyboard-only pass); indentation is not worth trapping focus for.
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap]),
        EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.();
        }),
        languageCompartment.of(languageExt(currentMode, null)),
        completionCompartment.of(completionExt(currentMode)),
      ],
    }),
    parent: mount,
  });

  const renderMirror = (issues: readonly RuleLintIssue[]): void => {
    diags.replaceChildren();
    diags.hidden = issues.length === 0;
    for (const issue of issues) {
      const item = document.createElement('li');
      item.className = `q-editor-diag q-editor-diag--${issue.severity}`;
      item.textContent = issue.message;
      if (issue.detail !== undefined) item.title = issue.detail;
      diags.append(item);
    }
  };

  return {
    el,
    getValue: () => view.state.doc.toString(),
    setValue: (value) => {
      if (value === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    setMode: (mode) => {
      if (mode === currentMode) return;
      currentMode = mode;
      view.dispatch({
        effects: [
          languageCompartment.reconfigure(languageExt(mode, currentFeed)),
          completionCompartment.reconfigure(completionExt(mode)),
        ],
      });
    },
    setCompletionFeed: (feed) => {
      currentFeed = feed;
      feedOptions = feed === null ? [] : buildCompletions(feed);
      if (currentMode === 'sql') {
        // The schema columns are baked into the sql() config — rebuild it.
        view.dispatch({
          effects: languageCompartment.reconfigure(languageExt('sql', feed)),
        });
      }
    },
    setIssues: (issues) => {
      // DuckDB gives no positions — every diagnostic spans the whole doc.
      const diagnostics: Diagnostic[] = issues.map((issue) => ({
        from: 0,
        to: view.state.doc.length,
        severity: issue.severity,
        message: issue.message,
      }));
      view.dispatch(setDiagnostics(view.state, diagnostics));
      renderMirror(issues);
    },
    focus: () => {
      view.focus();
    },
    destroy: () => {
      view.destroy();
      el.remove();
    },
  };
}
