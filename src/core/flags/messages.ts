/**
 * The single flag-text renderer (architecture.md §5, qc-report-spec.md §1).
 * Annotations, `<col>__review` cells, and findings lists all call `renderFlag`;
 * no other module formats flag text.
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

/** `"{ruleId}: {message}"` + `" (corrected: {before} → {after})"` when corrected. */
export function renderFlag(flag: QCFlag): string {
  const base = `${flag.ruleId}: ${flag.message}`;
  if (flag.correction === undefined) return base;
  const before = formatCorrectionValue(flag.correction.before);
  const after = formatCorrectionValue(flag.correction.after);
  return `${base} (corrected: ${before} → ${after})`;
}
