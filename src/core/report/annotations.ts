/**
 * Flag → data-table annotation plan (qc-report-spec.md §2). Pure and
 * node-testable: the report view applies the plan via annotations.addMany
 * after every loadData (annotations do not survive a reload). Every cell, row
 * and column flag the store holds is painted; dataset-scope flags are never
 * annotations — they belong to the panels / Sheet 3.
 *
 * There is no paint cap. Up to data-table 0.9 the grid scanned every
 * annotation on each lookup and repainted every visible cell on each change,
 * so QuaC painted at most 20,000 cells. 0.10 indexes the store and renders
 * from O(1) per-row, per-column and per-cell summaries, holding a million;
 * the FlagStore's own materialization cap (FLAG_CAP_DEFAULT, 200,000) is the
 * only bound left, and it is well inside that.
 */
import { renderFlagMessage } from '../flags/messages';
import type { QCFlag } from '../flags/flag';
import type { FlagStore } from '../flags/flagStore';

/**
 * Structural subset of data-table's NewAnnotation (kept local so this module
 * stays node-testable). rowId = flag.row is valid because the display export
 * orders by __row__ with __row__ excluded → __rowid__ === __row__ (V7).
 */
export interface PlannedAnnotation {
  scope: 'cell' | 'row' | 'column';
  severity: QCFlag['severity'];
  message: string;
  rowId?: number;
  column?: string;
  /**
   * Rule-id provenance (data-table `code`). The popover renders `code · source`
   * beneath every entry, which is why `message` must NOT repeat the id: it used
   * to print `schema:prop:reference_year:value` twice, one row apart (UX-09).
   */
  code: string;
  source: QCFlag['source'];
  metadata: { scope: QCFlag['scope']; correction?: QCFlag['correction'] };
}

export interface AnnotationPlan {
  /** Every non-dataset flag the store holds, in the store's entry order. */
  items: PlannedAnnotation[];
}

function toAnnotation(flag: QCFlag): PlannedAnnotation | null {
  const base = {
    severity: flag.severity,
    message: renderFlagMessage(flag),
    code: flag.ruleId,
    source: flag.source,
    metadata: {
      scope: flag.scope,
      ...(flag.correction === undefined ? {} : { correction: flag.correction }),
    },
  };
  switch (flag.scope) {
    case 'cell':
      if (flag.row === undefined || flag.column === undefined) return null;
      return { ...base, scope: 'cell', rowId: flag.row, column: flag.column };
    case 'row':
      if (flag.row === undefined) return null;
      return { ...base, scope: 'row', rowId: flag.row };
    case 'column':
      if (flag.column === undefined) return null;
      return { ...base, scope: 'column', column: flag.column };
    case 'dataset':
      return null;
  }
}

/**
 * Build the paint plan from the store's deterministic entry order (row →
 * pipeline category → ruleId). Dedupe entries paint once regardless of count.
 */
export function buildAnnotationPlan(flagStore: FlagStore): AnnotationPlan {
  const items: PlannedAnnotation[] = [];
  for (const entry of flagStore.all()) {
    const annotation = toAnnotation(entry.flag);
    if (annotation !== null) items.push(annotation);
  }
  return { items };
}
