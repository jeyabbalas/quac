// .quac.csv writer (qc-rules-format.md §7). Hand-rolled rather than Papa.unparse:
// the spec's formula guard is a leading SPACE (Papa's escapeFormulae prefixes an
// apostrophe), and minimal quoting must be byte-pinned for the round-trip
// guarantee. Guarantees (tested in parse.test.ts):
//   - model fixpoint: parse(serialize(parse(f))) deep-equals parse(f) for any file
//     without interior empty records (rowNumbers renumber when empties are dropped);
//   - byte idempotence: serialize(parse(x)) === x for any x already produced by
//     this serializer.
import type { QCRule, RuleFile } from './types';
import { CANONICAL_COLUMNS, deriveGroup } from './parse';

// RFC 4180 minimal quoting: quote iff the field contains a quote, comma, CR, or LF.
const QUOTE_TRIGGER = /["\r\n,]/;

// CSV-injection guard (§7): cells that would start with '=', '@', or '+'/'-'
// followed by a non-digit get a leading space (the parser's cell trim removes it).
// Numeric literals like -666 stay bare.
function needsFormulaGuard(field: string): boolean {
  const first = field.charAt(0);
  if (first === '=' || first === '@') return true;
  if (first === '+' || first === '-') return !/[0-9]/.test(field.charAt(1));
  return false;
}

function encodeField(raw: string): string {
  const guarded = needsFormulaGuard(raw) ? ` ${raw}` : raw;
  // Interior newlines of multiline SQL/JS cells pass through byte-for-byte (the
  // CRLF below is the record separator only, never injected into cell bodies).
  return QUOTE_TRIGGER.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function ruleRecord(rule: QCRule, extraColumns: readonly string[]): string[] {
  // Canonical order, defaults written explicitly (§7 "no blank-magic on export"):
  // parse always materializes update_language/severity/enabled, so emitting the
  // model verbatim is exactly that.
  return [
    rule.ruleId,
    rule.ruleType,
    rule.ruleScope,
    rule.targetVariables.join('|'),
    rule.condition,
    rule.updateLanguage,
    rule.updateExpression,
    rule.severity,
    rule.comment,
    rule.enabled ? 'true' : 'false',
    ...extraColumns.map((c) => rule.extras[c] ?? ''),
  ];
}

/**
 * Download filename for an exported rules file (P18 task 3):
 * `<group>.quac.csv`, where group = basename minus `.quac.csv`/`.csv` (§1).
 * A file already named `x.quac.csv` exports under the same name.
 */
export function exportFileName(fileName: string): string {
  return `${deriveGroup(fileName)}.quac.csv`;
}

export function serializeRuleFile(file: RuleFile): string {
  const records: string[][] = [
    [...CANONICAL_COLUMNS, ...file.extraColumns],
    ...file.rules.map((rule) => ruleRecord(rule, file.extraColumns)),
  ];
  // UTF-8 BOM + CRLF separators + exactly ONE trailing CRLF (a second would read
  // back as a phantom empty record and break byte idempotence).
  return '\uFEFF' + records.map((r) => r.map(encodeField).join(',')).join('\r\n') + '\r\n';
}
