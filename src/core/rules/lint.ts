// Rules lint — qc-rules-engine.md §7. Stage 1 (parse) issues come in with
// ParsedRuleFile; `lintRuleFiles` adds stage 2 (row structural checks) and
// stage 3 (assertion grammar / SELECT-in-row-scope) — static, synchronous.
// `lintRuleFilesWithDataset` (P12) layers the dataset-dependent stages on top:
// stage 4 (EXPLAIN dry-run of the EXACT engine wrappers → `sql-error`),
// stage 5 placeholder (js compile check arrives with the P13 sandbox →
// `pending-data` info), stage 6 (pertinence: `unknown-target` per rule,
// `pertinence` file banner, `RuleFileLintResult.pertinence`). With no dataset
// context it reports one `pending-data` info per SQL-bearing file, upgraded
// automatically when the caller re-lints with a context.
//
// External rules: condition may be free text, so SQL/JS-shaped checks are
// skipped entirely (semicolon, smart-quotes, select-in-row-scope, bad-assertion,
// value-token-misuse, update presence, blank targets — engine §1 sanctions [] for
// external). Stage 4/6 exempt them too: they never execute, so missing targets
// are not noise-worthy and they keep counting in `executable` as before.
// Still checked: id presence/pattern/uniqueness, enums, blank condition, the
// (type,scope) matrix, empty-comment, extras.
//
// Policy: partial acceptance — rules with error-severity issues are excluded
// from execution; the file still loads and the rest run (engine §7).
import { expandAssertion, parseAssertion } from './assertions';
import { DATASET_ROW_CAP_DEFAULT, ROW_CAP_PER_RULE_DEFAULT } from './engine';
import type { CanonicalColumn, ParsedRuleFile } from './parse';
import {
  analyzeSemicolons,
  containsValueToken,
  datasetFetchSQL,
  expandValueToken,
  rebuildSelectSQL,
  violCountSQL,
  violFetchSQL,
} from './sql';
import type { QCRule, RuleFileLintResult, RuleLintIssue, SQLRunner } from './types';
import { computePertinence } from '../pertinence';

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

/** Per-file unsorted issue collection — stages 1–3, shared by both entries. */
function collectStaticIssues(
  files: ParsedRuleFile[],
): { parsed: ParsedRuleFile; issues: RuleLintIssue[] }[] {
  const seenIds = new Map<string, { file: string; rowNumber: number }>();
  const collected: { parsed: ParsedRuleFile; issues: RuleLintIssue[] }[] = [];

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

    collected.push({ parsed, issues });
  }

  return collected;
}

/**
 * Sort, compute `ok`/`executable`, and assemble the result. executable =
 * enabled ∧ no error-severity issue ∧ (stage 6) applicable; a file-level
 * structural error blocks everything.
 */
function finalizeResult(
  parsed: ParsedRuleFile,
  issues: RuleLintIssue[],
  opts: {
    inapplicableRows?: ReadonlySet<number>;
    pertinence?: RuleFileLintResult['pertinence'];
  } = {},
): RuleFileLintResult {
  const { file } = parsed;
  const sorted = sortIssues(issues);
  const fileLevelError = sorted.some((i) => i.severity === 'error' && i.rowNumber === undefined);
  const errorRows = new Set(
    sorted.filter((i) => i.severity === 'error' && i.rowNumber !== undefined).map((i) => i.rowNumber),
  );
  const executable = fileLevelError
    ? 0
    : file.rules.filter(
        (r: QCRule) =>
          r.enabled &&
          !errorRows.has(r.rowNumber) &&
          !(opts.inapplicableRows?.has(r.rowNumber) ?? false),
      ).length;

  return {
    file: file.name,
    ok: !sorted.some((i) => i.severity === 'error'),
    ruleCount: file.rules.length,
    executable,
    issues: sorted,
    ...(opts.pertinence === undefined ? {} : { pertinence: opts.pertinence }),
  };
}

/**
 * Lint all loaded files together (rule_id uniqueness is cross-file; the LATER
 * occurrence gets the error). Input order = load order. Static stages 1–3 only.
 */
export function lintRuleFiles(files: ParsedRuleFile[]): RuleFileLintResult[] {
  return collectStaticIssues(files).map(({ parsed, issues }) => finalizeResult(parsed, issues));
}

// ---- stages 4–6: dataset-dependent lint (P12) ------------------------------

export interface DatasetLintContext {
  /** EXPLAIN dry-runs execute here, against the canonical view `data`. */
  runner: SQLRunner;
  /** Dataset column names (DatasetSession.columns — no re-query needed). */
  datasetColumns: readonly string[];
  /** Wrapper caps — defaults mirror the engine so the dry-run SQL is EXACT. */
  rowCapPerRule?: number;
  datasetRowCap?: number;
}

const sqlLikeRule = (rule: QCRule): boolean =>
  rule.ruleType === 'validate' || rule.ruleType === 'correct';

/**
 * Stages 4–6 layered over the static lint. `ctx === null` (no dataset yet) →
 * one `pending-data` info per SQL-bearing file; callers re-invoke with a
 * context when the dataset arrives/changes (ingestion.md §4 lifecycle).
 */
export async function lintRuleFilesWithDataset(
  files: ParsedRuleFile[],
  ctx: DatasetLintContext | null,
): Promise<RuleFileLintResult[]> {
  const collected = collectStaticIssues(files);
  const results: RuleFileLintResult[] = [];

  for (const { parsed, issues } of collected) {
    const { file } = parsed;
    const sqlRules = file.rules.filter(sqlLikeRule);

    if (ctx === null) {
      if (sqlRules.length > 0) {
        issues.push({
          severity: 'info',
          code: 'pending-data',
          file: file.name,
          message: 'SQL checks are pending until a dataset is loaded.',
        });
      }
      results.push(finalizeResult(parsed, issues));
      continue;
    }

    const datasetColumns = new Set(ctx.datasetColumns);
    const rowCap = ctx.rowCapPerRule ?? ROW_CAP_PER_RULE_DEFAULT;
    const datasetCap = ctx.datasetRowCap ?? DATASET_ROW_CAP_DEFAULT;
    const errorRows = new Set(
      issues.filter((i) => i.severity === 'error' && i.rowNumber !== undefined).map((i) => i.rowNumber),
    );

    // ---- stage 6: pertinence (before stage 4 — inapplicable rules are not
    // dry-run: their binder errors would duplicate unknown-target as noise) ----
    const inapplicableRows = new Set<number>();
    const fileTargets = new Set<string>();
    for (const rule of sqlRules) {
      const targets = [...new Set(rule.targetVariables)];
      if (targets.length === 0) continue;
      for (const t of targets) fileTargets.add(t);
      const pertinence = computePertinence({
        schemaColumns: targets.map((name) => ({ name, required: true })),
        datasetColumns: ctx.datasetColumns,
      });
      if (pertinence === null || pertinence.missingRequired.length === 0) continue;
      inapplicableRows.add(rule.rowNumber);
      const caseHints = pertinence.caseMismatches.map((m) => m.dataset);
      issues.push({
        severity: 'warning',
        code: 'unknown-target',
        file: file.name,
        ruleId: rule.ruleId,
        rowNumber: rule.rowNumber,
        csvColumn: 'target_variables',
        message:
          `target columns missing from the dataset: ${pertinence.missingRequired.join(', ')} — ` +
          'rule is inapplicable and will be skipped at run' +
          (caseHints.length > 0
            ? ` (case mismatch? dataset has: ${caseHints.join(', ')})`
            : '') +
          '.',
      });
    }
    const targetsTotal = fileTargets.size;
    const missingTargets = [...fileTargets].filter((t) => !datasetColumns.has(t));
    const pertinenceSummary =
      targetsTotal === 0
        ? undefined
        : {
            targetsFound: targetsTotal - missingTargets.length,
            targetsTotal,
            missing: missingTargets,
          };
    if (pertinenceSummary !== undefined && pertinenceSummary.targetsFound / targetsTotal < 0.5) {
      issues.push({
        severity: 'warning',
        code: 'pertinence',
        file: file.name,
        message:
          `only ${String(pertinenceSummary.targetsFound)} of ${String(targetsTotal)} rule target ` +
          'columns are present in the dataset — is this the right rules file for this dataset?',
      });
    }

    // ---- stages 4 + 5: EXPLAIN dry-run of the EXACT engine wrappers --------
    for (const rule of sqlRules) {
      if (errorRows.has(rule.rowNumber)) continue; // already broken in 1–3
      if (inapplicableRows.has(rule.rowNumber)) continue; // skipped at run
      if (rule.condition === '') continue;
      const targets = [...new Set(rule.targetVariables)];

      const dryRun = async (sql: string, csvColumn: string, text: string): Promise<boolean> => {
        try {
          await ctx.runner.query(`EXPLAIN ${sql}`);
          return true;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const firstLine = detail.split('\n', 1)[0] ?? detail;
          issues.push({
            severity: 'error',
            code: 'sql-error',
            file: file.name,
            ruleId: rule.ruleId,
            rowNumber: rule.rowNumber,
            csvColumn,
            message:
              `${csvColumn} failed the SQL dry-run: ${firstLine}` +
              (SMART_QUOTES_RE.test(text)
                ? ' (the SQL contains smart quotes — did you paste from a word processor?)'
                : ''),
            detail,
          });
          return false;
        }
      };

      if (rule.ruleScope === 'dataset') {
        if (rule.ruleType === 'validate') {
          await dryRun(datasetFetchSQL(rule.condition, datasetCap + 1), 'condition', rule.condition);
        }
        continue;
      }
      if (rule.ruleScope === 'column') {
        const assertion = parseAssertion(rule.condition);
        if (!assertion.ok) continue; // stage 3 already reported
        for (const target of targets) {
          const exp = expandAssertion(assertion.assertion, target);
          const sql =
            exp.kind === 'row-condition' ? violFetchSQL(exp.sql, [target], rowCap) : exp.countSql;
          if (!(await dryRun(sql, 'condition', rule.condition))) break;
        }
        continue;
      }
      // row / longitudinal
      if (rule.ruleType === 'validate') {
        await dryRun(violFetchSQL(rule.condition, targets, rowCap), 'condition', rule.condition);
        continue;
      }
      // correct: condition first (attribution), then the exact rebuild SELECT.
      // __value__ must be substituted before any SQL is valid — dry-run the
      // FIRST expanded pair's condition (pairs differ only in the substituted
      // identifier, and every target is present here — stage 6 gated).
      const pairs = expandValueToken(rule);
      const conditionOk = await dryRun(
        violCountSQL(pairs[0]?.condition ?? rule.condition),
        'condition',
        rule.condition,
      );
      if (rule.updateLanguage === 'js') {
        // Stage 5 placeholder — the QuickJS compileCheck arrives in P13. This
        // pending does NOT resolve when a dataset loads, only when P13 lands.
        issues.push({
          severity: 'info',
          code: 'pending-data',
          file: file.name,
          ruleId: rule.ruleId,
          rowNumber: rule.rowNumber,
          csvColumn: 'update_expression',
          message: 'JS compile check pending — the QuickJS sandbox arrives in a later phase.',
        });
        continue;
      }
      if (conditionOk && rule.updateExpression !== '') {
        await dryRun(rebuildSelectSQL(pairs), 'update_expression', rule.updateExpression);
      }
    }

    results.push(
      finalizeResult(parsed, issues, { inapplicableRows, pertinence: pertinenceSummary }),
    );
  }

  return results;
}
