/**
 * Pure model behind the Preview → QC rules panel: the derived labels, the
 * search corpus and its matcher, the language each expression is written in,
 * and the line-splitting the cell cap rests on.
 *
 * DOM-free so it runs under the `environment: 'node'` unit project — the
 * previewModel.ts / runProgressModel.ts precedent — and dependency-free so the
 * node test never reaches the rules engine or CodeMirror. `TokenRun` and
 * `ExprLang` are declared HERE rather than in exprTokens.ts for the same
 * reason: the model owns the shapes it manipulates, and exprTokens.ts (the one
 * module that pulls @codemirror/*) is the adapter that conforms to them.
 */
import type { QCRule } from '../../../../core/rules/types';

/** Which parser colours an expression. `text` = never highlighted at all. */
export type ExprLang = 'sql' | 'js';

export interface TokenRun {
  /** Verbatim source slice; concatenating every run reproduces the input. */
  text: string;
  /** Space-separated `tok-*` classes, `''` when unstyled. */
  classes: string;
}

// ---------------------------------------------------------------------------
// Labels and copy
// ---------------------------------------------------------------------------

/** `correct · row`. One idea, so one line — the format's own matrix (§4) pairs
 *  them, and the Studio grid's `Type · Scope` column already reads this way. */
export function typeScopeLabel(rule: QCRule): string {
  return `${rule.ruleType} · ${rule.ruleScope}`;
}

/** `(blank)` byte-identical to studioWorkspace.ts:845 — an id-less rule is a
 *  lint error the slot card reports, not something for this panel to restate. */
export function ruleIdLabel(rule: QCRule): string {
  return rule.ruleId === '' ? '(blank)' : rule.ruleId;
}

export function rulesCount(n: number): string {
  return `${String(n)} rule${n === 1 ? '' : 's'}`;
}

/** The live filter readout: `22 rules`, or `3 of 22 rules` while filtering. */
export function countReadout(visible: number, total: number, filtering: boolean): string {
  return filtering ? `${String(visible)} of ${rulesCount(total)}` : rulesCount(total);
}

/** Mirrors the dictionary's `No variables match '…'.` */
export function noMatchMessage(query: string): string {
  return `No rules match '${query.trim()}'.`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Trim, lowercase, split on whitespace. `''` → `[]` (matches everything).
 *
 * A deliberate four-line copy of `core/schema/data-dictionary.ts:316,326`
 * rather than an import: those two live in the SCHEMA subsystem, and the rules
 * preview has no business depending on it for a whitespace split. The
 * behaviour is pinned by both test suites independently.
 */
export function parseQuery(raw: string): string[] {
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

/** Token-AND substring over a precomputed haystack, case-insensitive. */
export function ruleMatches(haystack: string, tokens: readonly string[]): boolean {
  return tokens.every((token) => haystack.includes(token));
}

/**
 * Everything a reader can see in the row, lowercased once at build time —
 * the `DictionaryRow.haystack` pattern. Searching the condition and update
 * expression is the point: `LAG` finds the two carry-forward rules, `-666`
 * finds every structural-skip recode.
 */
export function ruleHaystack(rule: QCRule): string {
  return [
    rule.ruleId,
    rule.targetVariables.join(' '),
    rule.condition,
    rule.updateExpression,
    rule.comment,
    rule.ruleType,
    rule.ruleScope,
    rule.severity,
  ]
    .join(' ')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Which language an expression is written in (qc-rules-format.md §3/§4)
// ---------------------------------------------------------------------------

/**
 * `external` rules carry free prose in `condition` — never executed, never
 * lint-checked (§3), so highlighting it as SQL would dress prose up as code.
 * Everything else is SQL, `column` scope included: its assertion DSL (§4.1) is
 * `name(arg, …)` with numeric and single-quoted string arguments, which the
 * SQL parser reads correctly — `match_regex('^HH[0-9]{8}$')` comes out as an
 * identifier, parens and a string, and the bare `unique` as a keyword.
 */
export function conditionLang(rule: QCRule): ExprLang | 'text' {
  return rule.ruleType === 'external' ? 'text' : 'sql';
}

/** `update_expression` follows the rule's declared `update_language` (§5/§6). */
export function updateLang(rule: QCRule): ExprLang | 'text' {
  return rule.ruleType === 'external' ? 'text' : rule.updateLanguage;
}

// ---------------------------------------------------------------------------
// Line splitting (the cell cap)
// ---------------------------------------------------------------------------

/**
 * HESP ships an 11-line condition (Q021) and a 4-line arrow function (H006).
 * Uncapped, one rule owns the viewport; the rest goes behind a `+N more`.
 */
export const EXPR_LINE_CAP = 6;

/**
 * Partition token runs at the line breaks. Exact, not heuristic:
 * `highlightCode` calls `putBreak` at every `\n` and never emits a text run
 * spanning one (verified against multi-line strings, block comments and
 * template literals), and exprTokens.ts renders that callback as a run of
 * exactly `'\n'` with no classes. Always returns at least one line, so an
 * empty expression is one empty line rather than nothing.
 */
export function splitLines(runs: readonly TokenRun[]): TokenRun[][] {
  const lines: TokenRun[][] = [[]];
  for (const run of runs) {
    if (run.text === '\n' && run.classes === '') {
      lines.push([]);
      continue;
    }
    lines[lines.length - 1]?.push(run);
  }
  return lines;
}
