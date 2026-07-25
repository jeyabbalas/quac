/**
 * Pure model behind the Load view's Preview section (UIX-4 §3): tab ids,
 * section visibility, default-tab resolution, and the meta-line copy.
 *
 * DOM-free so it is node-tested under the `environment: 'node'` unit project —
 * the runProgressModel.ts / headerTooltips.ts / completionSource.ts precedent.
 */

export const PREVIEW_TAB_IDS = ['dataset', 'dictionary', 'rules'] as const;
export type PreviewTabId = (typeof PREVIEW_TAB_IDS)[number];

export interface PreviewAvailability {
  dataset: boolean;
  dictionary: boolean;
  rules: boolean;
}

/**
 * The SECTION hides until at least one slot fills, so first run is unchanged.
 * The three TABS are always present once it shows — an empty panel carries a
 * quiet note saying what would fill it, which is what the Report panel column
 * already does and what ui-design.md:201 mandates for in-panel empties. It
 * also removes both roving-tabindex hazards: a `disabled` button cannot take
 * focus, so if it held tabindex="0" the whole tablist would drop out of the
 * tab order, and a `hidden` tab makes the arrow-key index math run over a
 * changing subset.
 */
export function isPreviewVisible(a: PreviewAvailability): boolean {
  return a.dataset || a.dictionary || a.rules;
}

/**
 * First available tab in dataset → dictionary → rules order, re-resolved on
 * every availability change UNTIL the user activates a tab (`pinned`).
 *
 * After that, never move them: if the selected tab's slot empties, that panel
 * shows its own note rather than yanking the user somewhere else mid-read.
 */
export function resolvePreviewTab(
  current: PreviewTabId,
  a: PreviewAvailability,
  pinned: boolean,
): PreviewTabId {
  if (pinned) return current;
  return PREVIEW_TAB_IDS.find((id) => a[id]) ?? current;
}

const plural = (n: number, noun: string): string =>
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

/**
 * `first 50 of 101 rows · 266 columns`, or `4 rows · 3 columns` when the
 * preview is the whole dataset — the two_sheets.xlsx e2e loads 4 rows, and
 * "first 4 of 4 rows" is silly. Singulars handled the way rules-store.ts:353
 * does.
 */
export function datasetMetaLine(shown: number, rowCount: number, columnCount: number): string {
  const rows =
    shown >= rowCount
      ? plural(rowCount, 'row')
      : `first ${String(shown)} of ${plural(rowCount, 'row')}`;
  return `${rows} · ${plural(columnCount, 'column')}`;
}

/** `3 files · 22 rules`, matching the phrasing rules-store.ts:353 produces. */
export function rulesMetaLine(fileCount: number, ruleCount: number): string {
  return `${plural(fileCount, 'file')} · ${plural(ruleCount, 'rule')}`;
}
