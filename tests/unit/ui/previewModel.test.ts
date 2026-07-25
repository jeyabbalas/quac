/**
 * Load-view Preview model (UIX-4 §3): section visibility, default-tab
 * resolution and its stickiness, and the two meta lines.
 */
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_TAB_IDS,
  datasetMetaLine,
  isPreviewVisible,
  resolvePreviewTab,
  rulesMetaLine,
} from '../../../src/ui/views/load/preview/previewModel';
import type { PreviewAvailability } from '../../../src/ui/views/load/preview/previewModel';

const avail = (
  dataset: boolean,
  dictionary: boolean,
  rules: boolean,
): PreviewAvailability => ({ dataset, dictionary, rules });

const NONE = avail(false, false, false);

describe('PREVIEW_TAB_IDS', () => {
  it('is the priority order the default resolves in', () => {
    expect(PREVIEW_TAB_IDS).toEqual(['dataset', 'dictionary', 'rules']);
  });
});

describe('isPreviewVisible', () => {
  it('is false only when every slot is empty — first run stays unchanged', () => {
    expect(isPreviewVisible(NONE)).toBe(false);
  });

  it('is true as soon as any ONE slot fills', () => {
    expect(isPreviewVisible(avail(true, false, false))).toBe(true);
    expect(isPreviewVisible(avail(false, true, false))).toBe(true);
    expect(isPreviewVisible(avail(false, false, true))).toBe(true);
    expect(isPreviewVisible(avail(true, true, true))).toBe(true);
  });
});

describe('resolvePreviewTab', () => {
  it('picks the first available tab in dataset → dictionary → rules order', () => {
    expect(resolvePreviewTab('dataset', avail(true, true, true), false)).toBe('dataset');
    expect(resolvePreviewTab('dataset', avail(false, true, true), false)).toBe('dictionary');
    expect(resolvePreviewTab('dataset', avail(false, false, true), false)).toBe('rules');
  });

  it('re-resolves as availability changes, while unpinned', () => {
    // Rules land first, then a dataset arrives and outranks them.
    expect(resolvePreviewTab('rules', avail(true, false, true), false)).toBe('dataset');
  });

  it('holds the current tab once the user has activated one', () => {
    expect(resolvePreviewTab('rules', avail(true, true, true), true)).toBe('rules');
    expect(resolvePreviewTab('dictionary', avail(true, false, false), true)).toBe('dictionary');
  });

  it('leaves a pinned tab put even when ITS OWN slot empties', () => {
    // The panel shows its own note rather than yanking the reader elsewhere.
    expect(resolvePreviewTab('dictionary', avail(true, false, true), true)).toBe('dictionary');
  });

  it('keeps the current tab when nothing at all is available', () => {
    // The section is hidden in this state anyway; it must not throw or jump.
    expect(resolvePreviewTab('rules', NONE, false)).toBe('rules');
  });
});

describe('datasetMetaLine', () => {
  it('says "first N of M" when the preview is truncated', () => {
    expect(datasetMetaLine(50, 101, 266)).toBe('first 50 of 101 rows · 266 columns');
  });

  it('drops the "first N of" when the preview IS the whole dataset', () => {
    // two_sheets.xlsx loads 4 rows — "first 4 of 4 rows" is silly.
    expect(datasetMetaLine(4, 4, 3)).toBe('4 rows · 3 columns');
  });

  it('handles singulars', () => {
    expect(datasetMetaLine(1, 1, 1)).toBe('1 row · 1 column');
    expect(datasetMetaLine(1, 9, 1)).toBe('first 1 of 9 rows · 1 column');
  });

  it('handles an empty result', () => {
    expect(datasetMetaLine(0, 0, 0)).toBe('0 rows · 0 columns');
  });
});

describe('rulesMetaLine', () => {
  it('matches the phrasing the rules slot card already produces', () => {
    expect(rulesMetaLine(3, 22)).toBe('3 files · 22 rules');
  });

  it('handles singulars', () => {
    expect(rulesMetaLine(1, 1)).toBe('1 file · 1 rule');
  });
});
