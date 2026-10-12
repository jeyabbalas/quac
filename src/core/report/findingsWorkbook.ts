/**
 * The findings without data as an Excel workbook (qc-report-spec.md §7) — the
 * same document as the JSON and the Markdown, as four sheets to sort and
 * filter: Summary · Schema checks · QC rules · Notes. Styled like the QC
 * report it accompanies (excelWriter.ts), and like it, exceljs is imported
 * only when a workbook is written.
 *
 * It renders a `QcFindings` and reads nothing else, so it can hold nothing
 * the JSON does not.
 */
import { FILL_ARGB, XLSX_MIME, addTableSheet, fitCell, solidFill } from './excelWriter';
import type { CellValue } from './excelWriter';
import type {
  FindingSeverity,
  QcFindings,
  RuleFinding,
  RuleOutcome,
  SchemaCheckFinding,
} from './findings';

const OUTCOME_LABEL: Record<RuleOutcome, string> = {
  failed: 'found problems',
  passed: 'passed',
  corrected: 'corrected values',
  unchanged: 'changed nothing',
  error: 'failed to execute',
  'not-evaluated': 'not evaluated',
  disabled: 'disabled',
  skipped: 'skipped',
  excluded: 'excluded',
  'not-applied': 'not applied',
  'not-run': 'not run',
};

const LEVEL_LABEL: Record<SchemaCheckFinding['level'], string> = {
  dataset: 'dataset',
  variable: 'variable',
  value: 'value',
};

const text = (value: string | null | undefined): CellValue =>
  value === null || value === undefined ? null : fitCell(value);

/** A share of the records as Excel's fraction — the exact ratio, shown by the column's `0.0%` format. */
const fraction = (records: number | null, total: number): CellValue =>
  records === null || total <= 0 ? null : records / total;

function schemaValueText(value: unknown): CellValue {
  if (value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return fitCell(JSON.stringify(value));
}

function byVariableText(rule: RuleFinding): CellValue {
  if (rule.byVariable === null) return null;
  return rule.byVariable
    .map((v) =>
      v.distinctValues !== undefined
        ? `${v.variable}: ${String(v.distinctValues)} distinct${v.failed ? ' (out of range)' : ''}`
        : `${v.variable}: ${String(v.records ?? 0)}`,
    )
    .join('; ');
}

/** Tint one column's cells by severity, as the QC report tints flagged cells; null rows stay plain. */
function tintSeverity(
  ws: import('exceljs').Worksheet,
  column: number,
  severities: readonly (FindingSeverity | null)[],
): void {
  severities.forEach((severity, i) => {
    if (severity === null) return;
    const cell = ws.getRow(i + 2).getCell(column);
    cell.fill = solidFill(FILL_ARGB[severity].bg);
    cell.font = { color: { argb: FILL_ARGB[severity].fg } };
  });
}

function formatColumns(
  ws: import('exceljs').Worksheet,
  formats: Readonly<Record<number, string>>,
): void {
  for (const [column, numFmt] of Object.entries(formats))
    ws.getColumn(Number(column)).numFmt = numFmt;
}

function summaryRows(f: QcFindings): CellValue[][] {
  const o = f.overview;
  const rows: CellValue[][] = [
    [
      'About',
      'Every check the dataset failed, where the JSON Schema or the QC rules define it, and how many records ' +
        'failed it. Contains no data: no value from any record — only the column names, the checks as the ' +
        'schema and the rules files state them, and counts.',
    ],
    ['Dataset', f.dataset.name],
    ['Format', f.dataset.format.toUpperCase()],
    ...(f.dataset.sheet === null ? [] : [['Worksheet', f.dataset.sheet] as CellValue[]]),
    ['Records', f.dataset.records],
    ['Variables', f.dataset.variables],
  ];
  const schema = f.inputs.schema;
  if (schema === null) {
    rows.push(['JSON Schema', 'none loaded']);
  } else {
    if (schema.title !== null) rows.push(['JSON Schema', schema.title]);
    rows.push(['Schema root', schema.root]);
    if (schema.baseUrl !== null) rows.push(['Schema files from', schema.baseUrl]);
    if (schema.id !== null) rows.push(['Schema $id', schema.id]);
    rows.push(['Schema files', schema.files.length]);
    rows.push(['Schema set id', schema.setId]);
  }
  if (f.inputs.rules.length === 0) rows.push(['QC rules files', 'none loaded']);
  for (const file of f.inputs.rules) {
    rows.push([
      'QC rules file',
      `${file.source ?? file.file} — ${String(file.rules)} rule${file.rules === 1 ? '' : 's'}`,
    ]);
  }
  rows.push([
    'Corrections',
    f.inputs.correctionsApplied ? 'applied before the checks' : 'not applied',
  ]);
  rows.push(['', '']);
  rows.push(['Records failing an error-level check', o.recordsWithErrors]);
  rows.push(['Records failing a warning-level check', o.recordsWithWarnings]);
  rows.push(['Record counts exact', o.recordsExact ? 'yes' : 'no — lower bounds (see Notes)']);
  if (schema !== null) {
    rows.push(['JSON Schema checks failed', o.schemaChecksFailed]);
    rows.push(['Required variables missing', o.missingVariables.required]);
    rows.push(['Optional variables missing', o.missingVariables.optional]);
    rows.push(['Columns the schema does not describe', o.columnsNotInSchema]);
  }
  if (f.inputs.rules.length > 0) {
    rows.push(['QC rules', o.rules.total]);
    rows.push(['QC rules that found problems', o.rules.failed]);
    rows.push(['QC rules that passed', o.rules.passed]);
    rows.push(['Correction rules that changed values', o.rules.corrected]);
    rows.push(['QC rules that failed to execute', o.rules.errored]);
    rows.push(['QC rules that did not run', o.rules.notRun]);
    rows.push(['Values corrected', o.valuesCorrected]);
  }
  rows.push(['', '']);
  rows.push(['Generated', f.generatedAt]);
  rows.push(['Generated by', `QuaC ${f.generator.version} — ${f.generator.homepage}`]);
  rows.push(['Findings schema version', f.findingsSchemaVersion]);
  return rows;
}

export async function writeFindingsWorkbook(f: QcFindings): Promise<Blob> {
  // exceljs is UMD: its API sits under the interop `default` (excelWriter.ts).
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();

  const summary = addTableSheet(
    workbook,
    'Summary',
    ['Field', 'Value'],
    summaryRows(f),
    undefined,
    {
      maxWidth: 100,
    },
  );
  summary.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

  const checks = f.schemaChecks;
  const schemaSheet = addTableSheet(
    workbook,
    'Schema checks',
    [
      'Level',
      'Variable',
      'Title',
      'Path',
      'Check',
      'Keyword',
      'Schema value',
      'Severity',
      'Records',
      '% of records',
      'Failures',
      'Schema file',
      'JSON Pointer',
      'Rule ID',
    ],
    checks.map((c) => [
      LEVEL_LABEL[c.level],
      text(c.variable),
      text(c.variableTitle),
      text(c.path),
      text(c.requirement),
      text(c.keyword),
      schemaValueText(c.schemaValue),
      c.severity,
      c.records,
      fraction(c.records, f.dataset.records),
      c.failures,
      text(c.location?.file),
      text(c.location?.pointer),
      c.ruleId,
    ]),
    f.inputs.schema === null
      ? 'No JSON Schema was loaded for this run.'
      : checks.length === 0
        ? 'No JSON Schema check failed.'
        : undefined,
    { autoFilter: true },
  );
  formatColumns(schemaSheet, { 9: '#,##0', 10: '0.0%', 11: '#,##0' });
  tintSeverity(
    schemaSheet,
    8,
    checks.map((c) => c.severity),
  );

  const rulesSheet = addTableSheet(
    workbook,
    'QC rules',
    [
      'Rule ID',
      'Rules file',
      'Row',
      'Type',
      'Scope',
      'Severity',
      'Outcome',
      'Records',
      '% of records',
      'Records exact',
      'Result rows',
      'Values changed',
      'By variable',
      'Variables',
      'Description',
      'Condition',
      'Reason',
    ],
    f.rules.map((r) => [
      r.ruleId,
      text(r.file),
      r.row,
      r.type,
      r.scope,
      r.severity,
      OUTCOME_LABEL[r.outcome],
      r.records,
      fraction(r.records, f.dataset.records),
      r.records === null ? null : r.recordsExact ? 'yes' : 'no — lower bound',
      r.resultRows,
      r.valuesChanged,
      byVariableText(r),
      text(r.variables.join(', ')),
      text(r.description),
      text(r.condition),
      text(r.reason),
    ]),
    f.inputs.rules.length === 0 ? 'No QC rules were loaded for this run.' : undefined,
    { autoFilter: true },
  );
  formatColumns(rulesSheet, { 8: '#,##0', 9: '0.0%', 11: '#,##0', 12: '#,##0' });
  // Only a rule that found problems wears its severity: a passing error-level rule is not an error.
  tintSeverity(
    rulesSheet,
    6,
    f.rules.map((r) => (r.outcome === 'failed' ? r.severity : null)),
  );

  addTableSheet(
    workbook,
    'Notes',
    ['Kind', 'Note'],
    f.notes.map((n) => [n.kind, text(n.text)]),
    f.notes.length === 0 ? 'No notes.' : undefined,
    { maxWidth: 120 },
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}
