/**
 * Pure completion-feed composition for the Studio editors (P17; engine-spec
 * §8). Node-safe on purpose — @codemirror/autocomplete's `snippetCompletion`
 * has no DOM dependency — so the feed logic is unit-tested in the node
 * project. Column completion itself is NOT built here: lang-sql's
 * `schemaCompletionSource({ schema: { data: columnOptions(...) } })` handles
 * columns natively (top-level and `data.` dotted); this module supplies only
 * what lang-sql cannot know — DuckDB functions, the engine tokens, and the
 * assertion-vocabulary snippets.
 */
import { snippetCompletion } from '@codemirror/autocomplete';
import type { Completion } from '@codemirror/autocomplete';
import type { AssertionName } from '../../../core/rules/assertions';
import type { RuleScope, RuleType } from '../../../core/rules/types';

export interface ColumnFeedEntry {
  name: string;
  /** DuckDB type from DESCRIBE (parameters stripped); shown as the detail. */
  type?: string;
}

export interface CompletionFeedContext {
  columns: readonly ColumnFeedEntry[];
  /** duckdb_functions() names, already session-cached by the caller. */
  functions: readonly string[];
  ruleType: RuleType;
  ruleScope: RuleScope;
  field: 'condition' | 'update_expression';
}

/**
 * Assertion snippets (qc-rules-format.md §4.1) — TS-exhaustive against the
 * core AssertionName union, so adding a vocabulary entry breaks this build
 * until the snippet exists.
 */
export const ASSERTION_SNIPPETS: Record<AssertionName, { template: string; info: string }> = {
  unique: {
    template: 'unique',
    info: 'Flag every row whose value appears more than once in the column.',
  },
  no_nulls: {
    template: 'no_nulls',
    info: 'Flag rows where the column is NULL.',
  },
  not_blank: {
    template: 'not_blank',
    info: 'Flag rows where the column is NULL or whitespace-only.',
  },
  in_range: {
    template: 'in_range(${lo}, ${hi})',
    info: 'Flag non-NULL values outside [lo, hi].',
  },
  in_enum: {
    template: "in_enum(${'v1'}, ${'v2'})",
    info: 'Flag non-NULL values not in the list (numbers or quoted strings).',
  },
  match_regex: {
    template: "match_regex('${re}')",
    info: 'Flag non-NULL values that do not fully match the regex.',
  },
  monotonic: {
    template: 'monotonic(${increasing})',
    info:
      'Flag order violations. dir ∈ increasing | strict_increasing | decreasing | ' +
      'strict_decreasing; optional order_by=col, partition_by=col (default order: __row__).',
  },
  count_distinct_in_range: {
    template: 'count_distinct_in_range(${lo}, ${hi})',
    info: 'Flag the whole column when COUNT(DISTINCT) falls outside [lo, hi].',
  },
};

/** Dataset columns → lang-sql schema entries (`schema: { data: [...] }`). */
export function columnOptions(columns: readonly ColumnFeedEntry[]): Completion[] {
  return columns.map((c) => ({
    label: c.name,
    type: 'property',
    ...(c.type === undefined ? {} : { detail: c.type }),
  }));
}

/** duckdb_functions() returns operator glyphs and internal names too; only
 *  plain identifiers are useful as typed completions. */
const FUNCTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The custom feed merged into the SQL editors alongside lang-sql's schema and
 * keyword sources: DuckDB functions + `__row__` (always) + `__value__`
 * (correct rules only, both fields) + boosted assertion snippets
 * (validate×column×condition only — that cell of the matrix is assertion DSL,
 * not SQL). External rules complete nothing: they are never executed.
 */
export function buildCompletions(feed: CompletionFeedContext): Completion[] {
  if (feed.ruleType === 'external') return [];
  const out: Completion[] = [];

  for (const name of feed.functions) {
    if (!FUNCTION_NAME_RE.test(name)) continue;
    out.push({ label: name, type: 'function' });
  }

  out.push({
    label: '__row__',
    type: 'variable',
    info: 'Injected 0-based ingestion row number (BIGINT) — stable across corrections.',
  });
  if (feed.ruleType === 'correct') {
    out.push({
      label: '__value__',
      type: 'variable',
      info: 'Stands for each target column in turn — write one expression for many targets.',
    });
  }

  if (feed.ruleType === 'validate' && feed.ruleScope === 'column' && feed.field === 'condition') {
    for (const [name, snippet] of Object.entries(ASSERTION_SNIPPETS)) {
      out.push(
        snippetCompletion(snippet.template, {
          label: name,
          detail: 'assertion',
          info: snippet.info,
          type: 'function',
          boost: 2, // assertion DSL is the point of this mode — float above functions
        }),
      );
    }
  }

  return out;
}
