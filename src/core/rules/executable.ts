// The run-side view of a linted rule file, extracted from lint.ts so gating
// code (run button / startRun) can import it without dragging the lint module
// (and its engine/sql/data-table graph) into the entry chunk. Type-only
// imports keep this module weightless.
import type { ParsedRuleFile } from './parse';
import type { RuleFile, RuleFileLintResult } from './types';

/**
 * The file as the RUN sees it (engine-spec §7 partial acceptance, wired by
 * P14's run controller): rules whose CSV row carries an error-severity lint
 * issue are excluded — they surface in the loader panel, never in run stats.
 * A file-level structural error (no rowNumber) excludes the whole file
 * (null). Disabled / external / inapplicable rules are KEPT: the engine owns
 * their skipped-* stats, which the Dataset-findings panel lists.
 */
export function executableRuleFile(
  parsed: ParsedRuleFile,
  result: RuleFileLintResult,
): RuleFile | null {
  if (result.issues.some((i) => i.severity === 'error' && i.rowNumber === undefined)) return null;
  const errorRows = new Set(
    result.issues
      .filter((i) => i.severity === 'error' && i.rowNumber !== undefined)
      .map((i) => i.rowNumber),
  );
  if (errorRows.size === 0) return parsed.file;
  return { ...parsed.file, rules: parsed.file.rules.filter((r) => !errorRows.has(r.rowNumber)) };
}
