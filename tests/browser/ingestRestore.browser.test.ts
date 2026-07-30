/**
 * ingestFromRestore (P19b): the session-restore ingest entry point replays
 * persisted bytes through the REAL ingest path against a live DuckDB. The
 * pinned sheet must skip the SheetPicker outright — the modal's promise only
 * settles on user input, so a regression here does not fail an assertion, it
 * hangs the test — and the persisted sourceUrl must survive onto the dataset
 * session (hashSync provenance). The full boot/restore orchestration is e2e
 * territory; this tier pins the entry point itself.
 */
import { afterAll, expect, test } from 'vitest';
import { terminateBridge } from '../../src/core/bridge/bridge';
import { createAppStore } from '../../src/app/store';
import { signal } from '../../src/app/signals';
import { ingestFromRestore } from '../../src/ui/views/load/ingestController';
import { fetchFixtureBytes, peopleCsvUrl } from './fixtures';
import twoSheetsUrl from '../fixtures/tiny/two_sheets.xlsx?url';
import type { IngestUi } from '../../src/ui/views/load/ingestController';
import type { RouteId, Router } from '../../src/app/router';
import type { ShellContext } from '../../src/app/shell';

// ingestFromRestore reaches DuckDB through the app's getBridge() singleton
// (the restore path is the real card path, not a test harness) — drop it when
// the file is done.
afterAll(() => {
  terminateBridge();
});

function makeCtx(): ShellContext {
  const router: Router = {
    route: signal<RouteId>('load'),
    navigate: () => undefined,
    dispose: () => undefined,
  };
  return { store: createAppStore(), router };
}

const ui: IngestUi = {
  setProgress: () => undefined,
  detailHost: document.createElement('div'),
};

test('pinned sheet restores the chosen sheet without opening the SheetPicker', async () => {
  const ctx = makeCtx();
  const source = new Blob([await fetchFixtureBytes(twoSheetsUrl)]);

  // Would hang on pickSheet() if the pin failed — the modal resolves only on
  // user input. Finishing at all is the core assertion; the DOM check below
  // pins that no picker even flashed.
  await ingestFromRestore(
    ctx,
    { source, name: 'two_sheets.xlsx', sheetName: 'people' },
    ui,
  );

  expect(document.querySelector('.q-modal-overlay')).toBeNull();
  const dataset = ctx.store.dataset.get();
  expect(dataset).not.toBeNull();
  expect(dataset?.sheetName).toBe('people');
  expect(dataset?.rowCount).toBe(4);
  expect(dataset?.columnCount).toBe(3);
  expect(dataset?.generation).toBe(1);
  expect(dataset?.sourceUrl).toBeUndefined(); // no provenance persisted ⇒ none restored
  expect(ctx.store.slots.data.get()).toEqual({
    status: 'valid',
    detail: 'two_sheets.xlsx · 4 rows × 3 cols',
  });
});

test('persisted sourceUrl lands back on the dataset session', async () => {
  const ctx = makeCtx();
  const source = new Blob([await fetchFixtureBytes(peopleCsvUrl)]);
  const sourceUrl = 'https://example.test/tiny/people.csv';

  await ingestFromRestore(ctx, { source, name: 'people.csv', sourceUrl }, ui);

  const dataset = ctx.store.dataset.get();
  expect(dataset?.sourceUrl).toBe(sourceUrl);
  expect(dataset?.sheetName).toBeUndefined();
  expect(ctx.store.slots.data.get().status).toBe('valid');
});
