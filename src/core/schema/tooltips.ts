/**
 * Column-header tooltip content (json-schema-subsystem.md §E.2) and the §E.4
 * per-column rule summaries. Pure projections over ColumnMeta + the
 * conditional digest; P14 feeds the result to data-table's
 * `setColumnHeaderTooltip`. The report appendix and Studio column browser
 * reuse `summarizeColumnRules` verbatim.
 */
import { conditionalOneLiner } from './conditionals';
import type { ConditionalRule } from './conditionals';
import { renderExpectation, renderValue } from './value-spec';
import type { Sentinel } from './value-spec';
import type { ColumnMeta } from './column-meta';

/**
 * Structural copy of data-table v0.5.1's tooltip content type
 * (data-table-api.md §5) — kept local so this module stays node-testable
 * with no runtime dependency on the library.
 */
export interface ColumnHeaderTooltipContent {
  title?: string;
  description?: string;
  /** `string[]` values render as chips. */
  items?: { label: string; value: string | string[] }[];
}

/** §E.2 caps: 12 code chips, 5 conditional one-liners. */
const CODE_CAP = 12;
const CONDITIONAL_CAP = 5;

const JSON_TYPE_ORDER = ['integer', 'number', 'string', 'boolean', 'null'] as const;

function typeText(meta: ColumnMeta): string {
  const names = JSON_TYPE_ORDER.filter((t) => meta.jsonTypes.has(t));
  return names.length === 0 ? 'unknown' : names.join(' | ');
}

function chip(entry: Sentinel): string {
  const value = renderValue(entry.value);
  return entry.label === undefined ? value : `${value} — ${entry.label}`;
}

function capped(entries: readonly string[], cap: number): string[] {
  if (entries.length <= cap) return [...entries];
  return [...entries.slice(0, cap), `+${String(entries.length - cap)} more`];
}

/** Every "when {cond}, {target}" line targeting this column, in rule order. */
function targetOneLiners(meta: ColumnMeta, conditionals: readonly ConditionalRule[]): string[] {
  const lines: string[] = [];
  for (const position of meta.conditionals.asTarget) {
    const rule = conditionals[position];
    if (rule === undefined) continue;
    for (const target of rule.targets) {
      if (target.column === meta.name) lines.push(conditionalOneLiner(rule, target));
    }
  }
  return lines;
}

export function buildTooltip(
  meta: ColumnMeta,
  conditionals: readonly ConditionalRule[],
): ColumnHeaderTooltipContent {
  const items: { label: string; value: string | string[] }[] = [];
  const push = (label: string, value: string | string[] | undefined): void => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return;
    items.push({ label, value });
  };

  push('Type', typeText(meta));
  const spec = meta.valueSpec;
  if (spec.kind === 'codes') {
    push('Allowed', capped(spec.codes.map(chip), CODE_CAP));
  } else {
    push('Allowed', renderExpectation(spec));
  }
  if (spec.kind !== 'mixed' && spec.kind !== 'opaque') {
    push('Missing-value codes', spec.sentinels.map(chip));
  }
  push('Unit', meta.unit);
  push('Universe', meta.universe);
  push('Role', meta.role);
  push('Group', meta.group);
  push('Conditional rules', capped(targetOneLiners(meta, conditionals), CONDITIONAL_CAP));
  push('Note', meta.comment);
  if (meta.required) push('Required', 'yes');

  return {
    title: meta.title ?? meta.name,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    ...(items.length === 0 ? {} : { items }),
  };
}

/**
 * §E.4 rule summary lines: expectation, "required", conditional one-liners,
 * property $comment — in that order, empty entries omitted.
 */
export function summarizeColumnRules(
  meta: ColumnMeta,
  conditionals: readonly ConditionalRule[],
): string[] {
  const lines: string[] = [renderExpectation(meta.valueSpec)];
  if (meta.required) lines.push('required');
  lines.push(...targetOneLiners(meta, conditionals));
  if (meta.comment !== undefined) lines.push(meta.comment);
  return lines;
}
