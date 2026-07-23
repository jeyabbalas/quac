// Static lint — stages 1–3 of qc-rules-engine.md §7. Stage 1 (parse) issues come
// in with ParsedRuleFile; this module adds stage 2 (row structural checks) and
// stage 3 (assertion grammar / SELECT-in-row-scope). Stages 4–6 (sql-error,
// js-error, unknown-target, pertinence, pending-data) need a dataset/sandbox and
// arrive in P12+ — their LintCodes exist but are never emitted here.
//
// External rules: condition may be free text, so SQL/JS-shaped checks are
// skipped entirely (semicolon, smart-quotes, select-in-row-scope, bad-assertion,
// value-token-misuse, update presence, blank targets — engine §1 sanctions [] for
// external). Still checked: id presence/pattern/uniqueness, enums, blank
// condition, the (type,scope) matrix, empty-comment, extras.
//
// Policy: partial acceptance — rules with error-severity issues are excluded
// from execution; the file still loads and the rest run (engine §7).
import { parseAssertion } from './assertions';
import type { CanonicalColumn, ParsedRuleFile } from './parse';
import { analyzeSemicolons, containsValueToken } from './sql';
import type { QCRule, RuleFileLintResult, RuleLintIssue } from './types';

export type { LintCode, RuleFileLintResult, RuleLintIssue } from './types';

const RULE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SMART_QUOTES_RE = /[‘’“”]/;
const VALID_TYPES = ['validate', 'correct', 'external'];
const VALID_SCOPES = ['row', 'column', 'dataset', 'longitudinal'];

/** Deterministic order: file-level first, then by row, then code, then column. */
function sortIssues(issues: RuleLintIssue[]): RuleLintIssue[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => {
      const rowDiff = (a.issue.rowNumber ?? 0) - (b.issue.rowNumber ?? 0);
      if (rowDiff !== 0) return rowDiff;
      const codeDiff = a.issue.code.localeCompare(b.issue.code);
      if (codeDiff !== 0) return codeDiff;
      const colDiff = (a.issue.csvColumn ?? '').localeCompare(b.issue.csvColumn ?? '');
      if (colDiff !== 0) return colDiff;
      return a.i - b.i;
    })
    .map((e) => e.issue);
}

/**
 * Lint all loaded files together (rule_id uniqueness is cross-file; the LATER
 * occurrence gets the error). Input order = load order.
 */
export function lintRuleFiles(files: ParsedRuleFile[]): RuleFileLintResult[] {
  const seenIds = new Map<string, { file: string; rowNumber: number }>();
  const results: RuleFileLintResult[] = [];

  for (const parsed of files) {
    const { file, presentHeaders } = parsed;
    const issues: RuleLintIssue[] = [...parsed.issues];
    const has = (col: CanonicalColumn): boolean => presentHeaders.includes(col);

    for (const rule of file.rules) {
      const at = (issue: Omit<RuleLintIssue, 'file' | 'ruleId' | 'rowNumber'>): void => {
        issues.push({
          ...issue,
          file: file.name,
          ...(rule.ruleId === '' ? {} : { ruleId: rule.ruleId }),
          rowNumber: rule.rowNumber,
        });
      };
      const err = (code: RuleLintIssue['code'], csvColumn: string, message: string): void => {
        at({ severity: 'error', code, csvColumn, message });
      };

      const type = VALID_TYPES.includes(rule.ruleType) ? rule.ruleType : null;
      const scope = VALID_SCOPES.includes(rule.ruleScope) ? rule.ruleScope : null;
      // Every SQL-shaped check below gates on sqlLike, which is what exempts
      // external rules (and rows with an unrecognized rule_type) wholesale.
      const sqlLike = type === 'validate' || type === 'correct';

      // ---- identity ----
      if (rule.ruleId === '') {
        if (has('rule_id')) err('missing-field', 'rule_id', 'rule_id is required.');
      } else if (!RULE_ID_RE.test(rule.ruleId)) {
        err('bad-id', 'rule_id', `rule_id "${rule.ruleId}" must match [A-Za-z][A-Za-z0-9_-]*.`);
      } else {
        const prior = seenIds.get(rule.ruleId);
        if (prior) {
          err(
            'duplicate-id',
            'rule_id',
            `rule_id "${rule.ruleId}" is already defined in ${prior.file} (row ${String(prior.rowNumber)}).`,
          );
        } else {
          seenIds.set(rule.ruleId, { file: file.name, rowNumber: rule.rowNumber });
        }
      }

      // ---- required fields ----
      if (has('condition') && rule.condition === '') {
        err(
          'missing-field',
          'condition',
          'condition must not be blank — write TRUE for an always-apply correction.',
        );
      }
      if (
        has('target_variables') &&
        sqlLike &&
        (scope === 'row' || scope === 'column' || scope === 'longitudinal') &&
        rule.targetVariables.length === 0
      ) {
        err(
          'missing-field',
          'target_variables',
          `target_variables is required for rule_scope=${scope}.`,
        );
      }
      if (has('comment') && rule.comment === '') {
        at({
          severity: 'warning',
          code: 'empty-comment',
          csvColumn: 'comment',
          message: 'comment is blank — a generic fallback text will be generated for the report.',
        });
      }

      // ---- (type, scope) matrix ----
      if (type === 'correct' && scope === 'column') {
        err(
          'bad-scope-combo',
          'rule_scope',
          'correct rules cannot use rule_scope=column — use rule_scope=row with __value__.',
        );
      } else if (type === 'correct' && scope === 'dataset') {
        err('bad-scope-combo', 'rule_scope', 'correct rules cannot use rule_scope=dataset.');
      }

      // ---- update_expression presence ----
      if (type === 'validate' && rule.updateExpression !== '') {
        err(
          'update-on-validate',
          'update_expression',
          'validate rules must leave update_expression blank — did you mean rule_type=correct?',
        );
      }
      if (type === 'correct' && rule.updateExpression === '') {
        err(
          'missing-update',
          'update_expression',
          'correct rules require an update_expression — did you mean rule_type=validate?',
        );
      }

      // ---- __value__ usage ----
      if (type === 'validate' && containsValueToken(rule.condition)) {
        err('value-token-misuse', 'condition', '__value__ is only available in correct rules.');
      }
      if (type === 'correct' && rule.targetVariables.length > 1) {
        const hasToken =
          containsValueToken(rule.condition) ||
          (rule.updateLanguage === 'sql' && containsValueToken(rule.updateExpression));
        if (!hasToken) {
          at({
            severity: 'info',
            code: 'value-token-misuse',
            csvColumn: 'update_expression',
            message:
              `all ${String(rule.targetVariables.length)} targets receive the same expression ` +
              'value — use __value__ to reference each target column.',
          });
        }
      }

      // ---- SQL-cell scans (never for external / js / column-scope conditions) ----
      const sqlCells: { csvColumn: string; text: string; dataset: boolean }[] = [];
      if (sqlLike && rule.condition !== '' && scope !== null && scope !== 'column') {
        sqlCells.push({
          csvColumn: 'condition',
          text: rule.condition,
          dataset: scope === 'dataset',
        });
      }
      if (type === 'correct' && rule.updateLanguage === 'sql' && rule.updateExpression !== '') {
        sqlCells.push({
          csvColumn: 'update_expression',
          text: rule.updateExpression,
          dataset: false,
        });
      }
      for (const cell of sqlCells) {
        const { positions, trailing } = analyzeSemicolons(cell.text);
        if (
          cell.dataset
            ? positions.length > 1 || (positions.length === 1 && !trailing)
            : positions.length > 0
        ) {
          err(
            'semicolon',
            cell.csvColumn,
            cell.dataset
              ? `${cell.csvColumn} may end with at most one trailing ";" — rule SQL must be a single statement.`
              : `${cell.csvColumn} must be a single SQL expression — top-level ";" is not allowed.`,
          );
        }
      }
      // Smart quotes: same cells, plus column-scope assertion text (the grammar
      // would reject it anyway, but the word-processor hint is the better message).
      const smartCells =
        sqlLike && scope === 'column' && rule.condition !== ''
          ? [...sqlCells, { csvColumn: 'condition', text: rule.condition }]
          : sqlCells;
      for (const cell of smartCells) {
        if (SMART_QUOTES_RE.test(cell.text)) {
          at({
            severity: 'warning',
            code: 'smart-quotes',
            csvColumn: cell.csvColumn,
            message: `${cell.csvColumn} contains smart quotes (‘ ’ “ ”) — did you paste from a word processor?`,
          });
        }
      }

      // ---- stage 3: column assertions & SELECT in row scope ----
      if (type === 'validate' && scope === 'column' && rule.condition !== '') {
        const result = parseAssertion(rule.condition);
        if (!result.ok) {
          err('bad-assertion', 'condition', `invalid column assertion: ${result.error}`);
        }
      }
      if (
        sqlLike &&
        (scope === 'row' || scope === 'longitudinal') &&
        /^select\b/i.test(rule.condition)
      ) {
        err(
          'select-in-row-scope',
          'condition',
          'condition is a SELECT statement — use rule_scope=dataset for queries.',
        );
      }
    }

    if (file.extraColumns.length > 0) {
      issues.push({
        severity: 'info',
        code: 'extra-columns',
        file: file.name,
        message: `Unknown columns preserved for round-trip: ${file.extraColumns.join(', ')}.`,
      });
    }

    const sorted = sortIssues(issues);
    const fileLevelError = sorted.some((i) => i.severity === 'error' && i.rowNumber === undefined);
    const errorRows = new Set(
      sorted
        .filter((i) => i.severity === 'error' && i.rowNumber !== undefined)
        .map((i) => i.rowNumber),
    );
    // P10 semantics: executable = enabled ∧ no error-severity issue for the rule
    // (a file-level structural error blocks everything); stage 6 adds the
    // applicability dimension in P12.
    const executable = fileLevelError
      ? 0
      : file.rules.filter((r: QCRule) => r.enabled && !errorRows.has(r.rowNumber)).length;

    results.push({
      file: file.name,
      ok: !sorted.some((i) => i.severity === 'error'),
      ruleCount: file.rules.length,
      executable,
      issues: sorted,
    });
  }

  return results;
}
