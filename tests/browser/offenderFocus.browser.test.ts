/**
 * UX-03 regression: an Offenders focus click must never empty the grid.
 *
 * `validateSQLFilter` answers two questions at once — is the condition
 * parseable against the display table, and how many of its rows does it
 * match. QuaC used to read only the first, so a condition that parsed, ran,
 * and matched nothing was applied anyway: the grid dropped to `0 / N rows`
 * with no explanation, on the one click whose whole purpose is "show me the
 * rows behind this number". `tryFilterByCondition` now reports which of the
 * three things happened, and applies a filter only for the first.
 *
 * Driven through the production module (renderGrid → tryFilterByCondition),
 * so the shared-bridge build path is the one under test. The DataTable
 * instance is reportGrid-private by design, so the filter state is read where
 * the user reads it: data-table's own `.dt-filter-chip` bar, whose title is
 * `SQL <label>`.
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { getBridge, terminateBridge } from '../../src/core/bridge/bridge';
import { QUAC_TYPED, QUAC_WORK, ctas, refreshDataView } from '../../src/core/bridge/tables';
import {
  clearOffenderFilter,
  disposeGrid,
  renderGrid,
  tryFilterByCondition,
} from '../../src/ui/views/report/reportGrid';
import { waitFor } from './support';

const ROWS = 6;
/** One row (r = 0) carries the sentinel; the rest do not. */
const MATCHING = "note = 'bad'";
/** Parses and runs against the same table — and matches nothing. */
const NO_MATCH = "note = 'nothing here matches this'";
/** `__row__` is EXCLUDED from the display export, so this cannot bind. */
const UNPARSEABLE = '__row__ > 0 AND no_such_column IS NULL';

let host: HTMLElement;

/** The filter labels data-table is currently showing, in chip order. */
function chipTitles(): string[] {
  return [...document.querySelectorAll('.q-report-grid .dt-filter-chip')].map(
    (chip) => chip.getAttribute('title') ?? '',
  );
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

test('a condition that matches rows is applied, once', async () => {
  await expect(tryFilterByCondition(MATCHING, 'R001')).resolves.toBe('applied');
  expect(chipTitles()).toEqual(['SQL R001']);

  // Re-focusing the same rule replaces its filter rather than stacking one.
  await expect(tryFilterByCondition(MATCHING, 'R001')).resolves.toBe('applied');
  expect(chipTitles()).toEqual(['SQL R001']);

  clearOffenderFilter();
  await expect(tryFilterByCondition(MATCHING, 'R001')).resolves.toBe('applied');
  expect(chipTitles()).toEqual(['SQL R001']);
});

test('a condition that matches nothing is reported, not applied', async () => {
  // Precondition: a previous rule's focus is live — the state in which the
  // review met this, and the reason the failure must also CLEAR.
  await expect(tryFilterByCondition(MATCHING, 'R001')).resolves.toBe('applied');
  expect(chipTitles()).toEqual(['SQL R001']);

  await expect(tryFilterByCondition(NO_MATCH, 'R002')).resolves.toBe('no-match');
  // Neither R002's filter nor R001's stale one: the grid is back to whole.
  expect(chipTitles()).toEqual([]);
});

test('a condition that cannot bind is reported, not applied', async () => {
  await expect(tryFilterByCondition(MATCHING, 'R001')).resolves.toBe('applied');
  expect(chipTitles()).toEqual(['SQL R001']);

  await expect(tryFilterByCondition(UNPARSEABLE, 'R003')).resolves.toBe('unfilterable');
  expect(chipTitles()).toEqual([]);
});
