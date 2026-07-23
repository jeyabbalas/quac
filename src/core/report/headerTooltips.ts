/**
 * Column-header tooltip aggregation for the report grid (qc-report-spec.md
 * §3): the schema digest's per-column tooltip (json-schema-subsystem.md §E.2)
 * plus one `QC rules` item listing every loaded rules-file rule that targets
 * the column. Pure and node-testable; the report view feeds the plan to
 * data-table's setColumnHeaderTooltip and recomputes whenever schema, rules,
 * or dataset change.
 */
import { buildTooltip } from '../schema/tooltips';
import type { ColumnHeaderTooltipContent } from '../schema/tooltips';
import type { ColumnDigest } from '../schema/column-meta';
import type { RuleFile } from '../rules/types';

/** §3 caps: 6 rule lines per column, ~80 chars of comment each. */
export const TOOLTIP_RULE_CAP = 6;
const COMMENT_SNIP = 80;

export interface HeaderTooltipPlan {
  /** Only dataset columns with any content appear; others get no tooltip. */
  byColumn: Map<string, ColumnHeaderTooltipContent>;
}

function ruleLine(ruleId: string, comment: string): string {
  const trimmed = comment.trim();
  if (trimmed === '') return ruleId;
  const snip = trimmed.length > COMMENT_SNIP ? `${trimmed.slice(0, COMMENT_SNIP).trimEnd()}…` : trimmed;
  return `${ruleId} — ${snip}`;
}

/** Rule lines per targeted column, file/load order, one line per rule. */
function rulesByColumn(ruleFiles: readonly RuleFile[]): Map<string, string[]> {
  const byColumn = new Map<string, string[]>();
  for (const file of ruleFiles) {
    for (const rule of file.rules) {
      const line = ruleLine(rule.ruleId, rule.comment);
      for (const target of new Set(rule.targetVariables)) {
        const lines = byColumn.get(target);
        if (lines === undefined) byColumn.set(target, [line]);
        else lines.push(line);
      }
    }
  }
  return byColumn;
}

export function buildHeaderTooltips(
  digest: ColumnDigest | null,
  ruleFiles: readonly RuleFile[],
  datasetColumns: readonly string[],
): HeaderTooltipPlan {
  const metaByName = new Map((digest?.meta ?? []).map((m) => [m.name, m]));
  const conditionals = digest?.conditionals ?? [];
  const ruleLines = rulesByColumn(ruleFiles);

  const byColumn = new Map<string, ColumnHeaderTooltipContent>();
  for (const column of datasetColumns) {
    const meta = metaByName.get(column);
    const lines = ruleLines.get(column);
    if (meta === undefined && lines === undefined) continue;

    const base: ColumnHeaderTooltipContent =
      meta === undefined ? { title: column } : buildTooltip(meta, conditionals);
    if (lines !== undefined) {
      const capped =
        lines.length > TOOLTIP_RULE_CAP
          ? [...lines.slice(0, TOOLTIP_RULE_CAP), `+${String(lines.length - TOOLTIP_RULE_CAP)} more`]
          : lines;
      base.items = [...(base.items ?? []), { label: 'QC rules', value: capped }];
    }
    byColumn.set(column, base);
  }
  return { byColumn };
}
