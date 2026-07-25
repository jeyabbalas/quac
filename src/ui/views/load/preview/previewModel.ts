/**
 * Pure model behind the Load view's Preview section (UIX-4 §3): tab ids,
 * section visibility, default-tab resolution, and the meta-line copy.
 *
 * DOM-free so it is node-tested under the `environment: 'node'` unit project —
 * the runProgressModel.ts / headerTooltips.ts / completionSource.ts precedent.
 */

import type {
  CrossCheck,
  PertinenceEdge,
  PertinenceEdgeId,
  PertinenceSuspect,
} from '../../../../core/pertinence';

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

/* ---- Input consistency (json-schema-subsystem.md §E.5) -------------------
   One line in the Preview head saying whether the three inputs belong
   together, and when they don't, which one looks out of place. It is a
   caution, not a gate — nothing here blocks Run QC, so there is no "Blocked".

   Numbers appear only when something is wrong. When all is well the user wants
   reassurance, and the per-panel meta lines (`12 categories · 265 variables`,
   `3 files · 22 rules`) already carry the counts. ----------------------- */

export interface PertinenceLine {
  tone: 'ok' | 'warn' | 'alert';
  badge: string;
  text: string;
}

/** What the edge's expected names ARE, in the user's words. */
const EXPECTED: Record<PertinenceEdgeId, string> = {
  'data-schema': 'schema variables',
  'data-rules': 'rule targets',
  'schema-rules': 'rule targets',
};

/** Where the edge looked for them. */
const UNIVERSE: Record<PertinenceEdgeId, string> = {
  'data-schema': 'dataset',
  'data-rules': 'dataset',
  'schema-rules': 'JSON Schema',
};

/**
 * The accusation, whole. It carries its own verb because "The QC rules doesn't
 * look like it belongs" is the one of the three that a shared template gets
 * wrong — the slot holds a list of files and takes a plural.
 */
const SUSPECT: Record<PertinenceSuspect, string> = {
  dataset: "The dataset doesn't look like it belongs",
  schema: "The JSON Schema doesn't look like it belongs",
  rules: "The QC rules don't look like they belong",
};

/** What "consistent" MEANS for a single edge — the three-input case is below. */
const CONSISTENT: Record<PertinenceEdgeId, string> = {
  'data-schema': 'the dataset matches the JSON Schema',
  'data-rules': 'every rule target is a column in the dataset',
  'schema-rules': 'every rule target is declared in the JSON Schema',
};

/** Three examples, then the ellipsis that says there are more. */
const MISSING_EXAMPLES = 3;

/**
 * Ends the sentence as well as listing: `…` only when the list is genuinely
 * truncated, a full stop when it is complete. An ellipsis after every list
 * would promise names that are not there, and the near-miss clause below needs
 * something to follow.
 */
function missingClause(edge: PertinenceEdge): string {
  if (edge.missing.length === 0) return '.';
  const shown = edge.missing.slice(0, MISSING_EXAMPLES).join(', ');
  return edge.missing.length > MISSING_EXAMPLES
    ? ` — missing ${shown}…`
    : ` — missing ${shown}.`;
}

/**
 * The near-miss the hygiene pass and a stray capital both produce. Appended to
 * any tone: a set can score a clean 1.0 and still hold an `AGE_GROUP` where
 * the schema says `age_group`.
 */
function nearMissClause(edge: PertinenceEdge): string {
  const near = edge.caseMismatches[0];
  if (near === undefined) return '';
  return ` Close match: '${near.dataset}' vs '${near.schema}' — check for a spelling difference.`;
}

/**
 * Null ⇒ nothing to say: fewer than two inputs are loaded, so there is no pair
 * to check and the line stays off the screen entirely.
 *
 * The edge the copy REPORTS is the weakest one — the strongest evidence that
 * something is wrong, and with everything green, simply the first.
 */
export function pertinenceLine(check: CrossCheck): PertinenceLine | null {
  const edge = check.weakest;
  if (edge === null) return null;

  const near = nearMissClause(edge);
  const counts = `${String(edge.found)} of ${String(edge.total)} ${EXPECTED[edge.id]}`;

  if (check.verdict === 'ok') {
    const because =
      check.edges.length === 3
        ? 'the dataset, JSON Schema, and QC rules all describe the same variables'
        : CONSISTENT[edge.id];
    return { tone: 'ok', badge: 'OK', text: `Inputs look consistent — ${because}.${near}` };
  }

  if (check.verdict === 'warn') {
    return {
      tone: 'warn',
      badge: 'Warning',
      text: `${counts} found in the ${UNIVERSE[edge.id]}${missingClause(edge)}${near}`,
    };
  }

  if (check.suspect !== null) {
    return {
      tone: 'alert',
      badge: 'Mismatch',
      text:
        `${SUSPECT[check.suspect]} with the other two inputs — only ${counts} match. ` +
        `Check you loaded the right file.${near}`,
    };
  }

  return {
    tone: 'alert',
    badge: 'Mismatch',
    text:
      `Only ${counts} found in the ${UNIVERSE[edge.id]}. ` +
      `One of these inputs may be from a different project.${near}`,
  };
}
