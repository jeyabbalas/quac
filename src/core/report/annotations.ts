/**
 * Flag → data-table annotation plan (qc-report-spec.md §2). Pure and
 * node-testable: the report view applies the plan via annotations.addMany
 * after every loadData (annotations do not survive a reload). Cap policy: at
 * most `cap` CELL annotations, filled errors → warnings → info; row/column
 * scope are always included (cheap); dataset-scope flags are never
 * annotations — they belong to the panels / Sheet 3.
 */
import { renderFlag } from '../flags/messages';
import type { QCFlag } from '../flags/flag';
import type { FlagStore } from '../flags/flagStore';

export const ANNOTATION_CAP = 20_000;

/**
 * Structural subset of data-table v0.5.1's NewAnnotation (kept local so this
 * module stays node-testable). rowId = flag.row is valid because the display
 * export orders by __row__ with __row__ excluded → __rowid__ === __row__ (V7).
 */
export interface PlannedAnnotation {
  scope: 'cell' | 'row' | 'column';
  severity: QCFlag['severity'];
  message: string;
  rowId?: number;
  column?: string;
  /** Rule-id provenance (data-table `code`). */
  code: string;
  source: QCFlag['source'];
  metadata: { scope: QCFlag['scope']; correction?: QCFlag['correction'] };
}

export interface AnnotationPlan {
  /** Row/column-scope first, then capped cells in errors→warnings→info order. */
  items: PlannedAnnotation[];
  /** Cell-scope candidates before the cap. */
  cellTotal: number;
  cellPainted: number;
  capped: boolean;
}

const SEVERITY_ORDER: readonly QCFlag['severity'][] = ['error', 'warning', 'info'];

function toAnnotation(flag: QCFlag): PlannedAnnotation | null {
  const base = {
    severity: flag.severity,
    message: renderFlag(flag),
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
export function buildAnnotationPlan(
  flagStore: FlagStore,
  opts: { cap?: number } = {},
): AnnotationPlan {
  const cap = opts.cap ?? ANNOTATION_CAP;
  const rowCol: PlannedAnnotation[] = [];
  const cellsBySeverity: Record<QCFlag['severity'], PlannedAnnotation[]> = {
    error: [],
    warning: [],
    info: [],
  };

  for (const entry of flagStore.all()) {
    const annotation = toAnnotation(entry.flag);
    if (annotation === null) continue;
    if (annotation.scope === 'cell') cellsBySeverity[annotation.severity].push(annotation);
    else rowCol.push(annotation);
  }

  const cellTotal =
    cellsBySeverity.error.length + cellsBySeverity.warning.length + cellsBySeverity.info.length;
  const cells: PlannedAnnotation[] = [];
  for (const severity of SEVERITY_ORDER) {
    const room = cap - cells.length;
    if (room <= 0) break;
    cells.push(...cellsBySeverity[severity].slice(0, room));
  }

  return {
    items: [...rowCol, ...cells],
    cellTotal,
    cellPainted: cells.length,
    capped: cellTotal > cells.length,
  };
}
