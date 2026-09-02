/**
 * Offenders focus, at the tier where a real DuckDB and a real DataTable are
 * both in the room.
 *
 * Focus is by ROW IDENTITY: the ids a rule flagged, filtered over data-table's
 * own `__rowid__`, which the display export makes equal to QuaC's `__row__`
 * (V7). What that replaced — re-running the rule's SQL condition against the
 * grid's copy — is the UX-03 failure this file was opened for: a condition
 * that parsed, ran, and matched nothing was applied anyway, dropping the grid
 * to `0 / N rows` on the one click whose whole purpose is "show me the rows
 * behind this number". Row ids cannot miss, so the case is gone rather than
 * merely reported; what remains to prove is that the ids land on the rows they
 * name, and that a focus never stacks on the one before it.
 *
 * Driven through the production module (renderGrid → focusRows), so the
 * shared-bridge build path is the one under test. The DataTable instance is
 * reportGrid-private by design, so filter state is read where the user reads
 * it: data-table's own `.dt-filter-chip` bar, whose title is `SQL <label>`.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getBridge, terminateBridge } from '../../src/core/bridge/bridge';
import { QUAC_TYPED, QUAC_WORK, ctas, refreshDataView } from '../../src/core/bridge/tables';
import {
  clearOffenderFilter,
  disposeGrid,
  focusRows,
  renderGrid,
} from '../../src/ui/views/report/reportGrid';
import { waitFor } from './support';

const ROWS = 6;
/** Row 0 carries the sentinel; the rest do not. One rule's flagged rows. */
const FLAGGED = [0];
/** Non-contiguous, so the SQL takes both the IN and the BETWEEN branch. */
const FLAGGED_MANY = [0, 2, 3, 4];

let host: HTMLElement;

/** The filter labels data-table is currently showing, in chip order. */
function chipTitles(): string[] {
  return [...document.querySelectorAll('.q-report-grid .dt-filter-chip')].map(
    (chip) => chip.getAttribute('title') ?? '',
  );
}

/** The `note` value of every row the grid is currently showing. */
function visibleNotes(): string[] {
  return [...document.querySelectorAll('.q-report-grid .dt-cell')]
    .map((cell) => cell.textContent)
    .filter((text) => text === 'bad' || text === 'ok');
}

beforeAll(async () => {
  const bridge = await getBridge();
  await ctas(
    bridge,
    QUAC_TYPED,
    `SELECT r::BIGINT AS __row__, (CASE WHEN r = 0 THEN 'bad' ELSE 'ok' END) AS "note" ` +
      `FROM range(${String(ROWS)}) AS t(r)`,
  );
  await ctas(bridge, QUAC_WORK, `SELECT * FROM ${QUAC_TYPED}`);
  await refreshDataView(bridge);

  host = document.createElement('div');
  host.style.width = '900px';
  host.style.height = '500px';
  document.body.appendChild(host);
  await renderGrid(host, 1);
  await waitFor(() => document.querySelector('.q-report-grid .dt-cell') !== null, 'the grid to paint');
});

afterAll(async () => {
  await disposeGrid();
  terminateBridge();
  host.remove();
});

test('flagged rows are applied, once, and are the rows that show', async () => {
  await expect(focusRows(FLAGGED, 'R001')).resolves.toEqual({ kind: 'applied', shown: 1 });
  expect(chipTitles()).toEqual(['SQL R001']);
  // __rowid__ 0 is QuaC's __row__ 0 — the one row carrying the sentinel. This
  // is the identity the whole feature rests on (and annotations with it).
  await waitFor(() => visibleNotes().length === 1, 'the grid to narrow to one row');
  expect(visibleNotes()).toEqual(['bad']);

  // Re-focusing the same rule replaces its filter rather than stacking one.
  await expect(focusRows(FLAGGED, 'R001')).resolves.toEqual({ kind: 'applied', shown: 1 });
  expect(chipTitles()).toEqual(['SQL R001']);

  clearOffenderFilter();
  await expect(focusRows(FLAGGED, 'R001')).resolves.toEqual({ kind: 'applied', shown: 1 });
  expect(chipTitles()).toEqual(['SQL R001']);
});

test('a mixed run/singleton id set resolves to exactly those rows', async () => {
  await expect(focusRows(FLAGGED_MANY, 'R002')).resolves.toEqual({ kind: 'applied', shown: 4 });
  expect(chipTitles()).toEqual(['SQL R002']);
  await waitFor(() => visibleNotes().length === 4, 'the grid to narrow to four rows');

  clearOffenderFilter();
  await waitFor(() => chipTitles().length === 0, 'the focus to clear');
});

test('a rule that flagged no rows is reported, and clears the stale focus', async () => {
  // Precondition: a previous rule's focus is live — the state in which the
  // review met UX-03, and the reason a refusal must also CLEAR.
  await expect(focusRows(FLAGGED, 'R001')).resolves.toEqual({ kind: 'applied', shown: 1 });
  expect(chipTitles()).toEqual(['SQL R001']);

  // A dataset-scope finding: no row ids, so nothing to focus.
  await expect(focusRows([], 'R003')).resolves.toEqual({ kind: 'no-rows' });
  // Neither R003's filter nor R001's stale one: the grid is back to whole.
  expect(chipTitles()).toEqual([]);
  await waitFor(() => visibleNotes().length === ROWS, 'the grid to come back whole');
});
