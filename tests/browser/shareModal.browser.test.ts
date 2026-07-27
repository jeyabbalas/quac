/**
 * UX-07 regression: an over-length share link keeps its link and its Copy button.
 *
 * `renderLinkSection` treated `url-params.md` §4's "offer a config manifest" as
 * REPLACE rather than ADD — an early `return` past `MAX_URL_CHARS` skipped the
 * readonly input, the Copy button, the char count and the `index=` callout
 * built below it, leaving a modal whose only two controls were `×` and
 * `Download config manifest (JSON)`. Measured live at 2032 chars before the
 * fix; the bundled example's own link hits 2062 on the deployed origin, so the
 * flagship "Load example files → Share" path landed there by default.
 *
 * Driven through the production module against the production store, because
 * the modal computes its model on demand from the authoritative slot states
 * (`collectShareModel`) — there is no denormalized list to fake. No DuckDB and
 * no network: the link's LENGTH is the only variable the branch reads, so a
 * dataset session carrying a long `sourceUrl` moves it across the threshold in
 * one signal write. The real user path is covered by `shareLink.spec.ts`.
 */
import { afterEach, beforeAll, expect, test } from 'vitest';
import { createAppStore } from '../../src/app/store';
import { resetRulesSlot } from '../../src/core/rules/rules-store';
import { resetSchemaSlot } from '../../src/core/schema/schema-store';
import { MAX_URL_CHARS } from '../../src/core/share/urlConfig';
import { openShareModal } from '../../src/ui/components/shareModal';
import type { AppStore, DatasetSession } from '../../src/app/store';

let store: AppStore;

/** A dataset session whose only interesting property is its source URL. */
function datasetLoadedFrom(sourceUrl: string): DatasetSession {
  return {
    name: 'hesp_dirty_100.csv',
    format: 'csv',
    byteSize: 1024,
    rowCount: 101,
    columnCount: 266,
    columns: ['record_id'],
    renames: [],
    parseWarnings: [],
    source: new Blob(['record_id\n1\n']),
    sourceUrl,
    generation: 1,
  };
}

/**
 * Load the dataset by a URL padded to put the assembled link `delta` characters
 * either side of the limit. The padding rides a query string, which is what a
 * real long URL looks like (a signed download link, a CMS export).
 */
function loadDatasetAtLimitPlus(delta: number): void {
  const stem = 'https://example.org/data/hesp_dirty_100.csv?token=';
  store.dataset.set(datasetLoadedFrom(stem));
  const measured = link().value.length;
  store.dataset.set(datasetLoadedFrom(stem + 'x'.repeat(MAX_URL_CHARS + delta - measured)));
  close();
}

const dialog = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error('the share modal is not open');
  return el;
};

/** Open the modal fresh and return its readonly link input. */
function link(): HTMLInputElement {
  close();
  openShareModal(store);
  const input = dialog().querySelector<HTMLInputElement>('.q-share-link-input');
  if (input === null) throw new Error('the share modal rendered no link input');
  return input;
}

function close(): void {
  document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')?.click();
}

const manifestButton = (): HTMLButtonElement | null =>
  [...dialog().querySelectorAll('button')].find(
    (b) => b.textContent === 'Download config manifest (JSON)',
  ) ?? null;

beforeAll(() => {
  store = createAppStore();
  resetSchemaSlot();
  resetRulesSlot();
});

afterEach(() => {
  close();
});

test('under the limit: the link, Copy and the char count, with no manifest offer', () => {
  loadDatasetAtLimitPlus(-1);

  const input = link();
  expect(input.value).toHaveLength(MAX_URL_CHARS - 1);
  expect(input.readOnly).toBe(true);
  expect(dialog().querySelector('.q-share-copy')?.textContent).toBe('Copy');
  expect(dialog().querySelector('.q-share-count')?.textContent).toBe(
    `${String(MAX_URL_CHARS - 1)} characters`,
  );
  // The offer is what's conditional — not the link.
  expect(dialog().querySelector('.q-share-overlimit')).toBeNull();
  expect(manifestButton()).toBeNull();
});

test('OVER the limit: the link and Copy survive, and the manifest is offered alongside', () => {
  loadDatasetAtLimitPlus(1);

  const input = link();
  // The exact regression: before the fix, this input did not exist at all.
  expect(input.value).toHaveLength(MAX_URL_CHARS + 1);
  expect(dialog().querySelector('.q-share-copy')?.textContent).toBe('Copy');
  expect(dialog().querySelector('.q-share-count')?.textContent).toBe(
    `${String(MAX_URL_CHARS + 1)} characters`,
  );

  // ...and the offer is ADDED, not substituted.
  const advice = dialog().querySelector('.q-share-overlimit');
  expect(advice?.textContent).toContain(`This link is ${String(MAX_URL_CHARS + 1)} characters`);
  expect(manifestButton()).not.toBeNull();

  // Copy stays the modal's one primary; the manifest is the secondary offer.
  expect(dialog().querySelector('.q-share-copy')?.className).toContain('q-btn--primary');
  expect(manifestButton()?.className).not.toContain('q-btn--primary');
});

test('a link measuring exactly the limit is within it', () => {
  loadDatasetAtLimitPlus(0);

  expect(link().value).toHaveLength(MAX_URL_CHARS);
  expect(dialog().querySelector('.q-share-overlimit')).toBeNull();
  expect(manifestButton()).toBeNull();
});

test('the link is the FIRST control in the body in both states, not the manifest', () => {
  // `openModal` focuses the dialog's own `×` first (it precedes body content),
  // so what the over-limit state cost a keyboard user was the first control
  // they reached AFTER it: the Download button, with the link nowhere at all.
  const firstBodyControl = (): string => {
    const el = dialog().querySelector<HTMLElement>('.q-share input, .q-share button');
    return el?.className ?? '';
  };

  loadDatasetAtLimitPlus(1);
  openShareModal(store);
  expect(firstBodyControl()).toContain('q-share-link-input');

  loadDatasetAtLimitPlus(-1);
  openShareModal(store);
  expect(firstBodyControl()).toContain('q-share-link-input');
});
