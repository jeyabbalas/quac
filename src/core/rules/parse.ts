// .quac.csv reader (qc-rules-format.md §2/§7). Tolerant by design: Excel-mangled
// files (BOM, CRLF, ';' delimiter, TRUE/True, formula-guard spaces, reordered or
// case-mangled headers) parse cleanly; structural problems surface as lint issues,
// never exceptions.
import Papa from 'papaparse';
import type { QCRule, RuleFile, RuleLintIssue, RuleScope, RuleType, Severity } from './types';

/** Canonical column order (qc-rules-format.md §2) — also the serializer's output order. */
export const CANONICAL_COLUMNS = [
  'rule_id',
  'rule_type',
  'rule_scope',
  'target_variables',
  'condition',
  'update_language',
  'update_expression',
  'severity',
  'comment',
  'enabled',
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/**
 * Headers whose absence is a file-level `missing-header` error — the §2 Required=yes
 * set. The four defaultable columns (update_language, update_expression, severity,
 * enabled) are optional headers; their absence only surfaces per-rule when it matters
 * (e.g. `missing-update` on a correct rule).
 */
export const REQUIRED_HEADERS: readonly CanonicalColumn[] = [
  'rule_id',
  'rule_type',
  'rule_scope',
  'target_variables',
  'condition',
  'comment',
];

export interface ParsedRuleFile {
  file: RuleFile;
  /** Parse-level issues only: missing-header, empty-file, bad-enum. Lint stages 2–3 add the rest. */
  issues: RuleLintIssue[];
  /** Canonical headers actually present — lint suppresses per-row checks for absent columns. */
  presentHeaders: CanonicalColumn[];
}

const RULE_TYPES: readonly string[] = ['validate', 'correct', 'external'];
const RULE_SCOPES: readonly string[] = ['row', 'column', 'dataset', 'longitudinal'];
const SEVERITIES: readonly string[] = ['error', 'warning', 'info'];
const UPDATE_LANGUAGES: readonly string[] = ['sql', 'js'];
const ENABLED_TRUE = new Set(['true', 'yes', '1']);
const ENABLED_FALSE = new Set(['false', 'no', '0']);

/** Group = basename minus `.quac.csv` (preferred) or `.csv`, case-insensitive (§1). */
export function deriveGroup(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  if (/\.quac\.csv$/i.test(base)) return base.slice(0, -'.quac.csv'.length);
  if (/\.csv$/i.test(base)) return base.slice(0, -'.csv'.length);
  return base;
}

export function parseRuleFile(text: string, fileName: string): ParsedRuleFile {
  const name = fileName.split(/[/\\]/).pop() ?? fileName;
  const group = deriveGroup(name);
  const issues: RuleLintIssue[] = [];

  // Excel writes a UTF-8 BOM; strip it before Papa sees it (it would otherwise
  // become part of the first header name).
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;

  // header:false — engine-spec §7 sketches header:true, but raw records are the only
  // way to (a) preserve extra headers verbatim, (b) number rows physically across
  // manually-skipped empty records, and (c) drop Excel's trailing empty columns.
  // '|' is deliberately absent from delimitersToGuess: Papa's default guess list
  // includes it, and pipe-separated target_variables would win the vote on
  // rules-shaped files.
  const parsed = Papa.parse<string[]>(body, {
    header: false,
    skipEmptyLines: false,
    delimiter: '',
    delimitersToGuess: [',', ';', '\t'],
  });
  const records = parsed.data;
  const headerRecord = records[0] ?? [];

  // ---- header mapping ----
  // Canonical columns match by trimmed, case-insensitive name (§2); the first
  // occurrence binds. Anything else with a name is preserved verbatim as an extra
  // column (§2 "unknown extra columns are preserved"). Only *trailing* empty-named
  // columns are spec'd (§7) — interior empty-named headers are ignored entirely
  // (their cells are dropped; documented limitation).
  const canonicalIndex = new Map<CanonicalColumn, number>();
  const extraColumnIndex: { name: string; index: number }[] = [];
  let lastNamed = -1;
  for (let i = 0; i < headerRecord.length; i++) {
    if ((headerRecord[i] ?? '').trim() !== '') lastNamed = i;
  }
  for (let i = 0; i <= lastNamed; i++) {
    const verbatim = headerRecord[i] ?? '';
    const trimmed = verbatim.trim();
    if (trimmed === '') continue;
    const canonical = trimmed.toLowerCase();
    if (
      (CANONICAL_COLUMNS as readonly string[]).includes(canonical) &&
      !canonicalIndex.has(canonical as CanonicalColumn)
    ) {
      canonicalIndex.set(canonical as CanonicalColumn, i);
    } else {
      extraColumnIndex.push({ name: verbatim, index: i });
    }
  }
  const extraColumns = extraColumnIndex.map((e) => e.name);

  for (const required of REQUIRED_HEADERS) {
    if (!canonicalIndex.has(required)) {
      issues.push({
        severity: 'error',
        code: 'missing-header',
        file: name,
        csvColumn: required,
        message: `Required column "${required}" is missing from the header row.`,
      });
    }
  }

  // ---- data rows ----
  const rules: QCRule[] = [];
  for (let r = 1; r < records.length; r++) {
    const record = records[r] ?? [];
    // Physical 1-based data-record ordinal: skipped empty records still count, so
    // rowNumber + 1 = the row the user sees in Excel. One record = one Excel row
    // (multiline cells do not increment it).
    const rowNumber = r;
    if (record.every((c) => c.trim() === '')) continue;

    // Whole-cell trim implements the formula-guard space removal (§7); interior
    // newlines and indentation of multiline SQL/JS cells are preserved.
    const cell = (col: CanonicalColumn): string => {
      const idx = canonicalIndex.get(col);
      return idx === undefined ? '' : (record[idx] ?? '').trim();
    };

    const ruleId = cell('rule_id');
    const badEnum = (csvColumn: CanonicalColumn, raw: string, allowed: string): void => {
      issues.push({
        severity: 'error',
        code: 'bad-enum',
        file: name,
        ...(ruleId === '' ? {} : { ruleId }),
        rowNumber,
        csvColumn,
        message: `${csvColumn} "${raw}" is not one of ${allowed}.`,
      });
    };
    // Invalid enum text is kept (trimmed, lowercased) in the typed field after a
    // bad-enum error — nothing is silently reinterpreted. Invariant: rules carrying
    // an error-severity issue are excluded from execution (engine §7 partial
    // acceptance), so coerced values never drive engine behavior.
    const coerceEnum = <T extends string>(
      csvColumn: CanonicalColumn,
      allowed: readonly string[],
      fallback: T,
      allowedLabel: string,
    ): T => {
      const raw = cell(csvColumn);
      if (raw === '') return fallback;
      const lower = raw.toLowerCase();
      if (allowed.includes(lower)) return lower as T;
      badEnum(csvColumn, raw, allowedLabel);
      return lower as T;
    };

    const ruleType = coerceEnum<RuleType>(
      'rule_type',
      RULE_TYPES,
      '' as RuleType,
      'validate | correct | external',
    );
    const ruleScope = coerceEnum<RuleScope>(
      'rule_scope',
      RULE_SCOPES,
      '' as RuleScope,
      'row | column | dataset | longitudinal',
    );
    const updateLanguage = coerceEnum<'sql' | 'js'>(
      'update_language',
      UPDATE_LANGUAGES,
      'sql',
      'sql | js',
    );
    // Severity default is error except correct→info (§2). external is spec-silent →
    // error, the simpler uniform rule (matches §7's explicit-defaults example).
    const severity = coerceEnum<Severity>(
      'severity',
      SEVERITIES,
      ruleType === 'correct' ? 'info' : 'error',
      'error | warning | info',
    );

    const enabledRaw = cell('enabled');
    let enabled = true;
    if (enabledRaw !== '') {
      const lower = enabledRaw.toLowerCase();
      if (ENABLED_FALSE.has(lower)) enabled = false;
      else if (!ENABLED_TRUE.has(lower))
        badEnum('enabled', enabledRaw, 'true/false/yes/no/1/0 or blank');
    }

    const extras: Record<string, string> = {};
    // Duplicate extra names: last one wins in the record (documented limitation).
    for (const { name: extraName, index } of extraColumnIndex) {
      extras[extraName] = (record[index] ?? '').trim();
    }

    rules.push({
      ruleId,
      ruleType,
      ruleScope,
      targetVariables: cell('target_variables')
        .split('|')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      condition: cell('condition'),
      updateLanguage,
      updateExpression: cell('update_expression'),
      severity,
      comment: cell('comment'),
      enabled,
      sourceFile: group,
      rowNumber,
      extras,
    });
  }

  if (rules.length === 0) {
    issues.push({
      severity: 'error',
      code: 'empty-file',
      file: name,
      message: 'File contains no rules (no data rows below the header).',
    });
  }

  return {
    file: { name, group, rules, extraColumns },
    issues,
    presentHeaders: [...canonicalIndex.keys()],
  };
}
