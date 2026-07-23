/**
 * Plain HTML preview table for the Load view (ingestion.md §2): the first 50
 * rows of the `data` view, horizontally scrollable — deliberately NOT a
 * data-table instance (the grid lives in the Report view).
 */

export function renderPreviewTable(
  container: HTMLElement,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'q-preview-scroll';

  const table = document.createElement('table');
  table.className = 'q-preview-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const col of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = col;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const col of columns) {
      const td = document.createElement('td');
      const value = row[col];
      if (value === null || value === undefined) {
        td.className = 'q-preview-null';
        td.textContent = '—';
      } else {
        td.textContent = stringifyCell(value);
      }
      tr.append(td);
    }
    tbody.append(tr);
  }

  table.append(thead, tbody);
  wrapper.append(table);
  container.replaceChildren(wrapper);
}

/** Engine rows arrive as strings/numbers/bigints/booleans; anything nested renders as JSON. */
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
