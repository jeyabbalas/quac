/**
 * Plain HTML preview table (ingestion.md §2): a capped, scrollable slice of a
 * DuckDB result — deliberately NOT a data-table instance (the grid lives in
 * the Report view). Two consumers: the Load view's Preview panel and the
 * Studio's rule-test sample.
 *
 * Given `columnTypes`, it grows a second header row carrying each column's
 * DuckDB storage type, and right-aligns numeric columns whole.
 */
import { duckTypeBase, readsAsJson } from '../../core/duckdb-type';
import './plainPreviewTable.css';

export interface PreviewTableOptions {
  /** DuckDB storage type per column (describeColumns). Presence adds the type row. */
  columnTypes?: ReadonlyMap<string, string>;
  /** Accessible name for the scroll region. */
  regionLabel?: string;
  /** Visually-hidden <caption> — the table's canonical accessible name. */
  caption?: string;
}

/**
 * DuckDB types that read as numbers, so the whole column right-aligns —
 * compared by base name, so `DECIMAL(18,3)` counts and `DECIMAL(10,2)[]`, a
 * list, does not.
 */
export const NUMERIC_STORAGE_TYPES: ReadonlySet<string> = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'FLOAT',
  'REAL',
  'DOUBLE',
  'DECIMAL',
]);

export function isNumericStorageType(type: string): boolean {
  return NUMERIC_STORAGE_TYPES.has(duckTypeBase(type));
}

/**
 * A nested or JSON cell is its JSON text, which runs to tens of kilobytes (a
 * list of 10,000 items): the cell shows the start of it, the tooltip more.
 */
const NESTED_CELL_CHARS = 120;
const NESTED_TITLE_CHARS = 2_000;
/** A STRUCT's type runs as long as its field list. */
const TYPE_LABEL_CHARS = 48;

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const points = Array.from(text);
  return points.length <= cap ? text : `${points.slice(0, cap - 1).join('')}…`;
}

export function renderPreviewTable(
  container: HTMLElement,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  options: PreviewTableOptions = {},
): void {
  const { columnTypes, regionLabel = 'Dataset preview', caption } = options;

  // Scrolls in both axes (266 HESP columns, 50 rows) — a scroll container with
  // no focusable descendant is unreachable by keyboard, so it takes its own tab
  // stop and a name (axe: scrollable-region-focusable).
  const wrapper = document.createElement('div');
  wrapper.className = 'q-preview-scroll';
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', regionLabel);

  const table = document.createElement('table');
  table.className = 'q-preview-table';

  if (caption !== undefined) {
    // One canonical accessible name for the table, and the place to explain
    // the two-row header ONCE instead of per cell.
    const cap = document.createElement('caption');
    cap.className = 'q-sr-only';
    cap.textContent = caption;
    table.append(cap);
  }

  // Alignment is decided per COLUMN, never per cell: a VARCHAR column holding
  // "12" on some rows and "n/a" on others would flip alignment mid-column,
  // every NULL em-dash has no type to sniff, and a header can only be aligned
  // one way anyway.
  const numeric = new Set(
    columnTypes === undefined
      ? []
      : columns.filter((col) => {
          const type = columnTypes.get(col);
          return type !== undefined && isNumericStorageType(type);
        }),
  );

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col;
    if (numeric.has(col)) th.className = 'q-num';
    headRow.append(th);
  }
  thead.append(headRow);

  // The type row is <td> WITHOUT scope, inside <thead> — not a second <th>,
  // and not a second line stacked inside the existing <th>. A storage type is
  // data ABOUT the column, not a header for the body rows: either alternative
  // folds "VARCHAR" into every body cell's header chain, so a screen reader
  // navigating the grid announces "record_id VARCHAR 10042" on every one of
  // the 13,300 HESP cells. <td> in <thead> is valid HTML, reads as a cell you
  // visit deliberately, and may legitimately be empty when a lookup misses
  // (axe's empty-table-header only fires on <th>).
  if (columnTypes !== undefined) {
    const typeRow = document.createElement('tr');
    typeRow.className = 'q-preview-typerow';
    for (const col of columns) {
      const td = document.createElement('td');
      const type = columnTypes.get(col) ?? '';
      td.textContent = clipText(type, TYPE_LABEL_CHARS);
      if (td.textContent !== type) td.title = type;
      if (numeric.has(col)) td.className = 'q-num';
      typeRow.append(td);
    }
    thead.append(typeRow);
  }
  const nested = new Set(
    columnTypes === undefined
      ? []
      : columns.filter((col) => {
          const type = columnTypes.get(col);
          return type !== undefined && readsAsJson(type);
        }),
  );

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const value = row[col];
      const classes = numeric.has(col) ? ['q-num'] : [];
      if (value === null || value === undefined) {
        classes.push('q-preview-null');
        td.textContent = '—';
      } else if (nested.has(col)) {
        const text = stringifyCell(value);
        classes.push('q-preview-nested');
        td.textContent = clipText(text, NESTED_CELL_CHARS);
        if (td.textContent !== text) td.title = clipText(text, NESTED_TITLE_CHARS);
      } else {
        td.textContent = stringifyCell(value);
      }
      if (classes.length > 0) td.className = classes.join(' ');
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  container.replaceChildren(wrapper);
}

/**
 * Engine rows arrive as strings/numbers/bigints/booleans — a nested column as
 * its JSON text already (core/nested-json.ts); anything else nested renders
 * as JSON.
 */
function stringifyCell(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      // Bridge rows only nest plain data (MAP/STRUCT values) — JSON renders them.
      return JSON.stringify(value);
  }
}
