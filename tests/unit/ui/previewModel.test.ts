/**
 * Load-view Preview model (UIX-4 §3): section visibility, default-tab
 * resolution and its stickiness, the two meta lines, and the input-consistency
 * line the head carries (§E.5).
 */
import { describe, expect, it } from 'vitest';
import { crossCheckInputs } from '../../../src/core/pertinence';
import {
  PREVIEW_TAB_IDS,
  datasetMetaLine,
  isPreviewVisible,
  pertinenceLine,
  resolvePreviewTab,
  rulesMetaLine,
} from '../../../src/ui/views/load/preview/previewModel';
import type { PreviewAvailability } from '../../../src/ui/views/load/preview/previewModel';
import type { CrossCheckInput, PertinenceColumn } from '../../../src/core/pertinence';

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

/* The line is driven through the real cross-check rather than hand-built
   CrossCheck literals: the copy's job is to say what the check found, and a
   fixture that disagrees with the checker would test nothing. */
const required = (...names: string[]): PertinenceColumn[] =>
  names.map((name) => ({ name, required: true }));
const line = (input: CrossCheckInput) => pertinenceLine(crossCheckInputs(input));

describe('pertinenceLine — nothing to say', () => {
  it('is null with no computable edge', () => {
    expect(line({})).toBeNull();
    expect(line({ datasetColumns: ['a'] })).toBeNull();
    expect(line({ schemaColumns: required('a') })).toBeNull();
    expect(line({ ruleTargets: ['a'] })).toBeNull();
  });
});

describe('pertinenceLine — consistent', () => {
  it('names all three inputs when all three agree', () => {
    expect(
      line({
        datasetColumns: ['a', 'b'],
        schemaColumns: required('a', 'b'),
        ruleTargets: ['a', 'b'],
      }),
    ).toEqual({
      tone: 'ok',
      badge: 'OK',
      text:
        'Inputs look consistent — the dataset, JSON Schema, and QC rules all describe ' +
        'the same variables.',
    });
  });

  it('says what consistency MEANS for each two-input pair', () => {
    expect(line({ datasetColumns: ['a', 'b'], schemaColumns: required('a') })?.text).toBe(
      'Inputs look consistent — the dataset matches the JSON Schema.',
    );
    expect(line({ datasetColumns: ['a', 'b'], ruleTargets: ['a'] })?.text).toBe(
      'Inputs look consistent — every rule target is a column in the dataset.',
    );
    expect(line({ schemaColumns: required('a', 'b'), ruleTargets: ['a'] })?.text).toBe(
      'Inputs look consistent — every rule target is declared in the JSON Schema.',
    );
  });

  it('quotes no numbers — the per-panel meta lines already carry them', () => {
    const text = line({ datasetColumns: ['a', 'b'], schemaColumns: required('a', 'b') })?.text;
    expect(text).not.toMatch(/\d/);
  });
});

describe('pertinenceLine — warning', () => {
  it('reports the shortfall and the names behind it', () => {
    expect(
      line({ datasetColumns: ['a', 'b', 'c'], schemaColumns: required('a', 'b', 'c', 'd') }),
    ).toEqual({
      tone: 'warn',
      badge: 'Warning',
      text: '3 of 4 schema variables found in the dataset — missing d.',
    });
  });

  it('caps the examples at three and says so with an ellipsis', () => {
    expect(
      line({
        datasetColumns: ['a', 'b', 'c', 'd', 'e', 'f'],
        schemaColumns: required('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
      })?.text,
    ).toBe('6 of 10 schema variables found in the dataset — missing g, h, i…');
  });

  it('lists a short tail in full, with no ellipsis promising more', () => {
    expect(
      line({
        datasetColumns: ['a', 'b', 'c'],
        schemaColumns: required('a', 'b', 'c', 'd', 'e', 'f'),
      })?.text,
    ).toBe('3 of 6 schema variables found in the dataset — missing d, e, f.');
  });

  it('names the JSON Schema as the universe on the schema-rules edge', () => {
    expect(
      line({ schemaColumns: required('a', 'b', 'c'), ruleTargets: ['a', 'b', 'z'] })?.text,
    ).toBe('2 of 3 rule targets found in the JSON Schema — missing z.');
  });
});

describe('pertinenceLine — mismatch', () => {
  const MINE = { columns: ['a', 'b', 'c'], targets: ['a', 'b'] };
  const THEIRS = { columns: ['x', 'y', 'z'], targets: ['x', 'y'] };

  it('names the dataset', () => {
    expect(
      line({
        datasetColumns: THEIRS.columns,
        schemaColumns: required(...MINE.columns),
        ruleTargets: MINE.targets,
      }),
    ).toEqual({
      tone: 'alert',
      badge: 'Mismatch',
      text:
        "The dataset doesn't look like it belongs with the other two inputs — only 0 of 3 " +
        'schema variables match. Check you loaded the right file.',
    });
  });

  it('names the JSON Schema', () => {
    expect(
      line({
        datasetColumns: MINE.columns,
        schemaColumns: required(...THEIRS.columns),
        ruleTargets: MINE.targets,
      })?.text,
    ).toBe(
      "The JSON Schema doesn't look like it belongs with the other two inputs — only 0 of 3 " +
        'schema variables match. Check you loaded the right file.',
    );
  });

  it('names the QC rules, in the plural the slot actually takes', () => {
    expect(
      line({
        datasetColumns: MINE.columns,
        schemaColumns: required(...MINE.columns),
        ruleTargets: THEIRS.targets,
      })?.text,
    ).toBe(
      "The QC rules don't look like they belong with the other two inputs — only 0 of 2 " +
        'rule targets match. Check you loaded the right file.',
    );
  });

  it('falls back to the weakest edge when nobody can be singled out', () => {
    // Two inputs is not enough to triangulate: the pair disagrees and there is
    // no third opinion to say which of the two is wrong.
    expect(line({ datasetColumns: MINE.columns, schemaColumns: required(...THEIRS.columns) })).toEqual(
      {
        tone: 'alert',
        badge: 'Mismatch',
        text:
          'Only 0 of 3 schema variables found in the dataset. ' +
          'One of these inputs may be from a different project.',
      },
    );
  });

  it('falls back the same way when all three are mutually foreign', () => {
    expect(
      line({
        datasetColumns: ['a', 'b'],
        schemaColumns: required('m', 'n'),
        ruleTargets: ['x', 'y'],
      })?.text,
    ).toContain('One of these inputs may be from a different project.');
  });
});

describe('pertinenceLine — case near-miss', () => {
  it('appends the spelling clause to a warning', () => {
    expect(line({ datasetColumns: ['AGE', 'name'], schemaColumns: required('age', 'name') })).toEqual(
      {
        tone: 'warn',
        badge: 'Warning',
        text:
          '1 of 2 schema variables found in the dataset — missing age. ' +
          "Close match: 'AGE' vs 'age' — check for a spelling difference.",
      },
    );
  });

  it('appends it to a clean set too — 1.0 can still hide a rename', () => {
    // `age` is required and present; `age_group` is optional, and the column
    // that would satisfy it is capitalised.
    const text = line({
      datasetColumns: ['age', 'AGE_GROUP'],
      schemaColumns: [...required('age'), { name: 'age_group', required: false }],
    })?.text;
    expect(text).toBe(
      'Inputs look consistent — the dataset matches the JSON Schema. ' +
        "Close match: 'AGE_GROUP' vs 'age_group' — check for a spelling difference.",
    );
  });

  it('appends it to a mismatch', () => {
    expect(
      line({ datasetColumns: ['AGE', 'x', 'y'], schemaColumns: required('age', 'b', 'c') })?.text,
    ).toContain("Close match: 'AGE' vs 'age' — check for a spelling difference.");
  });
});
