/**
 * Offender focus predicate (qc-report-spec.md §4): the WHERE fragment that
 * narrows the report grid to the rows one rule flagged.
 *
 * Focus is by ROW IDENTITY, not by re-running the rule. Every flag carries
 * `flag.row` (`__row__`), and the display export makes data-table's own
 * `__rowid__` equal to it — `SELECT * EXCLUDE (__row__) FROM data ORDER BY
 * __row__` (bridge/tables.ts, Verified fact V7), the same identity the
 * annotation layer already keys on. Re-evaluating the rule's condition against
 * the grid's copy — what this replaced — could not express a schema rule at
 * all, was illegal in a WHERE clause for window rules, and disagreed with the
 * run wherever the grid typed a column differently (UX-03).
 *
 * Framework-free and DOM-free: the row-id column NAME is a parameter, so the
 * library's `ROWID_COLUMN` stays the single source of truth at the call site
 * and `core/` keeps its data-table-free dependency graph (sql-identifier.ts).
 */
import { quoteIdentifier } from '../sql-identifier';

/** A run this short is cheaper to list than to write as a BETWEEN. */
const MIN_RUN = 3;

/**
 * `"__rowid__" BETWEEN 4 AND 9 OR "__rowid__" IN (1, 12)` — consecutive runs
 * collapse, the rest ride one IN list.
 *
 * The dense case is the reason: a rule firing on most of a 10k-row dataset (the
 * engine's `rowCapPerRule`) is one BETWEEN rather than a 60 KB literal list.
 *
 * @param column - Row-id column name, quoted here.
 * @param rows - Flagged rows; any order, duplicates tolerated.
 * @returns The fragment, or `''` when `rows` is empty — nothing to focus.
 */
export function rowFocusSQL(column: string, rows: readonly number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const col = quoteIdentifier(column);
  const ranges: [number, number][] = [];
  const singles: number[] = [];
  // A run is consecutive by construction, so its members enumerate from its
  // bounds — which keeps this off indexed access entirely.
  const closeRun = (lo: number, hi: number): void => {
    if (hi - lo + 1 >= MIN_RUN) ranges.push([lo, hi]);
    else for (let v = lo; v <= hi; v++) singles.push(v);
  };

  let runStart: number | null = null;
  let runEnd: number | null = null;
  for (const row of sorted) {
    if (runStart === null || runEnd === null) {
      runStart = row;
    } else if (row === runEnd + 1) {
      runEnd = row;
      continue;
    } else {
      closeRun(runStart, runEnd);
      runStart = row;
    }
    runEnd = row;
  }
  if (runStart !== null && runEnd !== null) closeRun(runStart, runEnd);

  const terms = ranges.map(([lo, hi]) => `${col} BETWEEN ${String(lo)} AND ${String(hi)}`);
  if (singles.length > 0) terms.push(`${col} IN (${singles.map(String).join(', ')})`);
  return terms.join(' OR ');
}
