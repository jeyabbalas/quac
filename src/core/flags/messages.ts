/**
 * The flag-text renderers (architecture.md §5, qc-report-spec.md §1). Two of
 * them over the same parts: `renderFlag` prefixes the ruleId, `renderFlagMessage`
 * does not. Which one a surface calls is decided by whether it has somewhere
 * ELSE to put the id — a `<col>__review` cell has one cell and one string, so it
 * takes the prefix; the grid popover (data-table prints `code · source` under
 * every entry) and the Findings panel (its own muted id line) do not, and used
 * to print the id twice (UX-09). No other module formats flag text.
 */
import type { QCFlag } from './flag';

/**
 * A nested value's JSON is cut past this many code points in the suffix: a
 * corrected list of 10,000 items would otherwise be printed twice over.
 */
const NESTED_VALUE_CAP = 80;

function clip(text: string): string {
  if (text.length <= NESTED_VALUE_CAP) return text;
  const points = Array.from(text);
  return points.length <= NESTED_VALUE_CAP ? text : `${points.slice(0, NESTED_VALUE_CAP - 1).join('')}…`;
}

/**
 * Correction values render like message values do: strings quoted, everything
 * else via String(). SQL NULL corrections arrive as null → rendered `null`
 * (spec shows bare numbers: "Q047: <comment> (corrected: 999 → -999)"). A
 * nested value renders as its JSON, cut at 80 characters.
 */
function formatCorrectionValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return clip(JSON.stringify(v));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Parts of a nested correction worth naming apart: at most this many. */
const CHANGED_PARTS_CAP = 3;

/**
 * What changed inside a corrected nested value, when that is a few of its
 * parts: `country: 'us' → 'US'` for a struct, `[1]: 'e11.9' → 'E11.9'` for a
 * list (items counted from 1, as the value inspector counts them). Null when
 * the whole value is the clearer story.
 */
function changedParts(before: unknown, after: unknown): string | null {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const changed = keys.filter((k) => !same(before[k], after[k]));
    if (changed.length === 0 || changed.length > CHANGED_PARTS_CAP || changed.length === keys.length) {
      return null;
    }
    return changed
      .map((k) => `${k}: ${formatCorrectionValue(before[k])} → ${formatCorrectionValue(after[k])}`)
      .join(', ');
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    const changed = before.flatMap((item, i) => (same(item, after[i]) ? [] : [i]));
    if (changed.length === 0 || changed.length > CHANGED_PARTS_CAP || changed.length === before.length) {
      return null;
    }
    return changed
      .map((i) => `[${String(i + 1)}]: ${formatCorrectionValue(before[i])} → ${formatCorrectionValue(after[i])}`)
      .join(', ');
  }
  return null;
}

/** `" (corrected: {before} → {after})"`, or `''` — the one copy of the suffix. */
function correctionSuffix(flag: QCFlag): string {
  if (flag.correction === undefined) return '';
  const parts = changedParts(flag.correction.before, flag.correction.after);
  if (parts !== null) return ` (corrected: ${parts})`;
  const before = formatCorrectionValue(flag.correction.before);
  const after = formatCorrectionValue(flag.correction.after);
  return ` (corrected: ${before} → ${after})`;
}

/**
 * `"{message}"` + the correction suffix — the ruleId OMITTED, for surfaces that
 * display it themselves. Schema ruleIds embed the source file id (a full URL for
 * URL-loaded sets, 106 chars in the bundled example), which buried the sentence
 * and named the file twice over.
 */
export function renderFlagMessage(flag: QCFlag): string {
  return `${flag.message}${correctionSuffix(flag)}`;
}

/** `"{ruleId}: {message}"` + `" (corrected: {before} → {after})"` when corrected. */
export function renderFlag(flag: QCFlag): string {
  return `${flag.ruleId}: ${renderFlagMessage(flag)}`;
}
