/**
 * Draft-rule lint for the Studio editor (P17): wrap the in-progress rule in a
 * synthetic one-rule ParsedRuleFile and hand it to the engine's own
 * `lintRuleFilesWithDataset`, so the draft gets stages 2–6 VERBATIM — the
 * same EXPLAIN wrappers, the same messages, zero re-implementation. The one
 * check the synthetic file cannot see is cross-file rule_id uniqueness; that
 * is re-derived here against the loaded files (lint's exact wording), with
 * the rule being edited excluded — its own id is not a duplicate of itself.
 *
 * Pure async module: no DOM, no signals — node-tested against a real DuckDB.
 */
import { lintRuleFilesWithDataset } from '../../../core/rules/lint';
import { CANONICAL_COLUMNS, deriveGroup } from '../../../core/rules/parse';
import type { DatasetLintContext } from '../../../core/rules/lint';
import type { CanonicalColumn, ParsedRuleFile } from '../../../core/rules/parse';
import type { JSSandbox, QCRule, RuleLintIssue } from '../../../core/rules/types';

export interface DraftLintDeps {
  /** Current dataset lint context (rules-store's getLintContext()); null = pending. */
  ctx: DatasetLintContext | null;
  /** All loaded files — the duplicate-id universe. */
  files: readonly ParsedRuleFile[];
  /** Lazy QuickJS source for js correction drafts (sandbox-loader). */
  loadSandbox?: () => Promise<JSSandbox>;
}

export interface DraftLintResult {
  /** True iff no error-severity issue (info/warning drafts still save). */
  ok: boolean;
  /** All issues in lint's deterministic order — feeds the mirrored list. */
  issues: RuleLintIssue[];
  /** Issues carrying a canonical csvColumn, bucketed for per-field display. */
  byField: Partial<Record<CanonicalColumn, RuleLintIssue[]>>;
  /** File-level / column-less issues (pending-data, pertinence banner). */
  general: RuleLintIssue[];
}

// lint.ts's private RULE_ID_RE — the duplicate check only applies to
// pattern-valid ids there, so the mirror gates identically.
const RULE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** lint.ts's private sortIssues ordering, re-applied after the duplicate-id
 *  append (file-level first, then row, code, column, stable). */
function sortDraftIssues(issues: RuleLintIssue[]): RuleLintIssue[] {
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

export async function runDraftLint(
  draft: QCRule,
  fileName: string,
  editing: { fileName: string; index: number } | null,
  deps: DraftLintDeps,
): Promise<DraftLintResult> {
  const group = deriveGroup(fileName);
  const synthetic: ParsedRuleFile = {
    file: {
      name: fileName,
      group,
      rules: [{ ...draft, sourceFile: group, rowNumber: 1 }],
      extraColumns: [],
    },
    issues: [],
    presentHeaders: [...CANONICAL_COLUMNS],
  };
  const [result] = await lintRuleFilesWithDataset(
    [synthetic],
    deps.ctx,
    deps.loadSandbox === undefined ? undefined : { loadSandbox: deps.loadSandbox },
  );
  const issues = result === undefined ? [] : [...result.issues];

  if (RULE_ID_RE.test(draft.ruleId)) {
    outer: for (const parsed of deps.files) {
      for (let i = 0; i < parsed.file.rules.length; i++) {
        if (editing !== null && parsed.file.name === editing.fileName && i === editing.index) {
          continue;
        }
        const rule = parsed.file.rules[i];
        if (rule?.ruleId !== draft.ruleId) continue;
        issues.push({
          severity: 'error',
          code: 'duplicate-id',
          file: fileName,
          ruleId: draft.ruleId,
          rowNumber: 1,
          csvColumn: 'rule_id',
          message:
            `rule_id "${draft.ruleId}" is already defined in ${parsed.file.name} ` +
            `(row ${String(rule.rowNumber)}).`,
        });
        break outer;
      }
    }
  }

  const sorted = sortDraftIssues(issues);
  const byField: Partial<Record<CanonicalColumn, RuleLintIssue[]>> = {};
  const general: RuleLintIssue[] = [];
  for (const issue of sorted) {
    const col = issue.csvColumn;
    if (col !== undefined && (CANONICAL_COLUMNS as readonly string[]).includes(col)) {
      (byField[col as CanonicalColumn] ??= []).push(issue);
    } else {
      general.push(issue);
    }
  }
  return { ok: !sorted.some((i) => i.severity === 'error'), issues: sorted, byField, general };
}
