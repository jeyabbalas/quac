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
 * Correction values render like message values do: strings quoted, everything
 * else via String(). SQL NULL corrections arrive as null → rendered `null`
 * (spec shows bare numbers: "Q047: <comment> (corrected: 999 → -999)").
 */
function formatCorrectionValue(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
}

/** `" (corrected: {before} → {after})"`, or `''` — the one copy of the suffix. */
function correctionSuffix(flag: QCFlag): string {
  if (flag.correction === undefined) return '';
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
