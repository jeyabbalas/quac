/**
 * The findings without data as Markdown (qc-report-spec.md §7) — the format
 * for reading in a terminal, pasting into an issue or an email, committing
 * beside a pipeline's other outputs, and diffing run against run. It renders
 * a `QcFindings` and reads nothing else, so it holds exactly what the JSON
 * holds.
 *
 * GitHub-flavoured: pipe tables, fenced SQL. Deterministic — the same run
 * renders the same text but for the generated-at line — and plain enough to
 * read unrendered: schema literals sit in code spans, where Markdown takes
 * them literally, and prose is escaped only where Markdown would misread it.
 */
import type {
  FindingsNote,
  QcFindings,
  RuleFinding,
  RuleOutcome,
  SchemaCheckFinding,
} from './findings';

const num = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, noun: string, nouns = `${noun}s`): string =>
  `${num(n)} ${n === 1 ? noun : nouns}`;
const pct = (p: number | null): string => (p === null ? '' : `${p.toFixed(1)}%`);

/** A code span that survives any content: a fence longer than the longest backtick run inside. */
export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Escape only what Markdown would misread, so the text still reads cleanly
 * unrendered: an asterisk, an underscore at a word's edge (`_W`, never the one
 * in `household_id`), the `<` of a tag, the `[` of a link, a backslash before
 * punctuation, a stray backtick, and a block marker at the very start.
 */
function escapeProse(text: string): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\')
    .replace(/[*`]/g, '\\$&')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, '\\_')
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/\[(?=[^\]]*\]\()/g, '\\[');
}

/** Prose: Markdown-safe, with its paired backtick spans kept as code. */
export function prose(text: string): string {
  const escaped = text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : escapeProse(part)))
    .join('');
  return escaped.replace(/^(#{1,6}|[>+-]|\d{1,9}[.)])(?=\s|$)/, '\\$1');
}

/** A table cell: one line, and no pipe left to end the cell early (GFM: `\|`, even inside code). */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
}

function table(
  head: readonly string[],
  align: readonly ('l' | 'r')[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(' | ')} |`;
  const rule = `|${align.map((a) => (a === 'r' ? ' --: ' : ' :-- ')).join('|')}|`;
  return [line(head), rule, ...rows.map(line)].join('\n');
}

const capital = (text: string): string =>
  text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1);

function location(check: SchemaCheckFinding): string {
  return check.location === null ? '—' : code(`${check.location.file}#${check.location.pointer}`);
}

function recordsCell(records: number | null, percent: number | null): string {
  if (records === null) return '—';
  return percent === null || records === 0 ? num(records) : `${num(records)} (${pct(percent)})`;
}

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

/** "4 records (4.0%)", "1 result row", "1 of 2 variables out of range". */
function ruleResult(rule: RuleFinding): string {
  if (rule.resultRows !== null) return plural(rule.resultRows, 'result row');
  if (rule.records === null && rule.byVariable !== null) {
    const failed = rule.byVariable.filter((v) => v.failed).length;
    return `${num(failed)} of ${plural(rule.byVariable.length, 'variable')} out of range`;
  }
  if (rule.records === null) return '—';
  const records = `${plural(rule.records, 'record')}${rule.recordsExact ? '' : ' or more'}`;
  return rule.percentOfRecords === null ? records : `${records} (${pct(rule.percentOfRecords)})`;
}

function variablesList(names: readonly string[]): string {
  return names.length === 0 ? '—' : names.map(code).join(', ');
}

function sqlBlock(condition: string): string {
  const longest = Math.max(2, ...[...condition.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}sql\n${condition.trim()}\n${fence}`;
}

// ---- sections ---------------------------------------------------------------

function header(f: QcFindings): string {
  const lines: string[] = [];
  lines.push(`# QC findings: ${prose(f.dataset.name)}`);
  lines.push('');
  lines.push(
    'These findings list every check the dataset failed, where the JSON Schema or the QC rules define it, ' +
      'and how many records failed it. **They contain no data:** no value from any record appears here — only ' +
      'the dataset’s column names, the checks as the JSON Schema and the QC rules files state them, and counts.',
  );
  lines.push('');
  const datasetFacts = [
    f.dataset.format.toUpperCase(),
    ...(f.dataset.sheet === null ? [] : [`sheet ${code(f.dataset.sheet)}`]),
    plural(f.dataset.records, 'record'),
    plural(f.dataset.variables, 'variable'),
  ].join(', ');
  const rows: string[][] = [['Dataset', `${code(f.dataset.name)} — ${datasetFacts}`]];
  const schema = f.inputs.schema;
  if (schema === null) {
    rows.push(['JSON Schema', 'none loaded']);
  } else {
    const others = schema.files.length - 1;
    rows.push([
      'JSON Schema',
      `${schema.title === null ? '' : `${prose(schema.title)}: `}${code(schema.root)}` +
        `${others > 0 ? ` and ${plural(others, 'more file')}` : ''} (set ${code(schema.setId)})`,
    ]);
    if (schema.baseUrl !== null) rows.push(['Schema files from', code(schema.baseUrl)]);
    if (schema.id !== null) rows.push(['Schema $id', code(schema.id)]);
  }
  rows.push([
    'QC rules',
    f.inputs.rules.length === 0
      ? 'none loaded'
      : f.inputs.rules
          .map(
            (r, i) =>
              `${code(r.source ?? r.file)} (${i === 0 ? plural(r.rules, 'rule') : num(r.rules)})`,
          )
          .join(', '),
  ]);
  const correctionRules = f.rules.filter((r) => r.type === 'correct');
  if (correctionRules.length > 0) {
    const changed = correctionRules.filter((r) => r.outcome === 'corrected').length;
    rows.push([
      'Corrections',
      f.inputs.correctionsApplied
        ? `applied before the checks: ${plural(changed, 'rule')} changed ${plural(f.overview.valuesCorrected, 'value')}`
        : 'not applied — the checks read the data as loaded',
    ]);
  }
  const at = f.generatedAt.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
  rows.push(['Generated', `${at} by QuaC ${f.generator.version} — ${f.generator.homepage}`]);
  lines.push(table(['', ''], ['l', 'l'], rows));
  return lines.join('\n');
}

function summary(f: QcFindings): string {
  const o = f.overview;
  const bound = o.recordsExact ? '' : ' or more';
  const withShare = (n: number): string => {
    const p = share(n, o.records);
    return `${num(n)}${bound}${p === null ? '' : ` (${pct(p)})`}`;
  };
  const rows: string[][] = [
    ['Records checked', num(o.records)],
    ['Records failing an error-level check', withShare(o.recordsWithErrors)],
    ['Records failing a warning-level check', withShare(o.recordsWithWarnings)],
  ];
  if (f.inputs.schema !== null) {
    rows.push(['JSON Schema checks failed', num(o.schemaChecksFailed)]);
    rows.push([
      'Variables missing from the dataset',
      `${num(o.missingVariables.required)} required, ${num(o.missingVariables.optional)} optional`,
    ]);
    rows.push(['Columns the schema does not describe', num(o.columnsNotInSchema)]);
  }
  if (f.inputs.rules.length > 0) {
    rows.push(['QC rules that found problems', `${num(o.rules.failed)} of ${num(o.rules.total)}`]);
    if (o.rules.errored > 0) rows.push(['QC rules that failed to execute', num(o.rules.errored)]);
    if (f.inputs.correctionsApplied && f.rules.some((r) => r.type === 'correct')) {
      rows.push(['Values corrected', num(o.valuesCorrected)]);
    }
  }
  return ['## Summary', '', table(['', 'Count'], ['l', 'r'], rows)].join('\n');
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 100 : null;
}

function schemaSection(f: QcFindings): string {
  const lines = ['## JSON Schema checks that failed', ''];
  if (f.inputs.schema === null) {
    lines.push('No JSON Schema was loaded for this run.');
    return lines.join('\n');
  }
  const failed = f.schemaChecks;
  if (failed.length === 0) {
    lines.push('None — the dataset passed every check the schema makes.');
    return lines.join('\n');
  }
  lines.push(
    'Each row is one check: one keyword at one place in the schema. *Defined at* is the schema file and ' +
      'the JSON Pointer to the keyword (or, for a whole variable, to its declaration).',
  );

  const dataset = failed.filter((c) => c.level === 'dataset');
  if (dataset.length > 0) {
    lines.push('', '### The dataset as a whole', '');
    lines.push(
      table(
        ['Check', 'Failed', 'Defined at'],
        ['l', 'r', 'l'],
        dataset.map((c) => [
          prose(capital(c.requirement)),
          c.records === null ? plural(c.failures, 'time') : plural(c.records, 'record'),
          location(c),
        ]),
      ),
    );
  }

  const variables = failed.filter((c) => c.level === 'variable');
  if (variables.length > 0) {
    lines.push('', '### Variables', '');
    lines.push(
      table(
        ['Variable', 'Severity', 'Check', 'Defined at'],
        ['l', 'l', 'l', 'l'],
        variables.map((c) => [
          code(c.variable ?? ''),
          c.severity,
          prose(capital(c.requirement)),
          location(c),
        ]),
      ),
    );
  }

  const values = failed.filter((c) => c.level === 'value');
  if (values.length > 0) {
    const mixed = values.some((c) => c.severity !== 'error');
    const showFailures = values.some((c) => c.records !== null && c.failures !== c.records);
    lines.push('', '### Values', '');
    lines.push(
      'A value check names the variable it reads; a path below it (`visits[].date`) points inside a list or ' +
        'an object, `[]` meaning any item and `.*` any field.',
      '',
    );
    const head = [
      'Variable',
      ...(mixed ? ['Severity'] : []),
      'Check',
      'Records',
      ...(showFailures ? ['Failures'] : []),
      'Defined at',
    ];
    const align: ('l' | 'r')[] = [
      'l',
      ...(mixed ? (['l'] as const) : []),
      'l',
      'r',
      ...(showFailures ? (['r'] as const) : []),
      'l',
    ];
    lines.push(
      table(
        head,
        align,
        values.map((c) => [
          c.variable === null ? '(each record)' : code(c.path ?? c.variable),
          ...(mixed ? [c.severity] : []),
          prose(capital(c.requirement)),
          recordsCell(c.records, c.percentOfRecords),
          ...(showFailures ? [num(c.failures)] : []),
          location(c),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

function ruleBlock(rule: RuleFinding): string {
  const lines: string[] = [];
  lines.push(`##### ${code(rule.ruleId)} · ${rule.severity} · ${ruleResult(rule)}`);
  lines.push('');
  const where = `${code(rule.file)}, row ${num(rule.row)}`;
  const kind = `${rule.type}, ${rule.scope} scope`;
  lines.push(`${where} · ${kind} · variables ${variablesList(rule.variables)}`);
  if (rule.byVariable !== null && rule.byVariable.length > 1) {
    const parts = rule.byVariable.map((v) =>
      v.distinctValues !== undefined
        ? `${code(v.variable)} ${plural(v.distinctValues, 'distinct value')}${v.failed ? ' (out of range)' : ''}`
        : `${code(v.variable)} ${plural(v.records ?? 0, 'record')}`,
    );
    lines.push('', `By variable: ${parts.join('; ')}.`);
  } else if (rule.byVariable?.length === 1 && rule.byVariable[0]?.distinctValues !== undefined) {
    const only = rule.byVariable[0];
    lines.push(
      '',
      `${code(only.variable)} holds ${plural(only.distinctValues ?? 0, 'distinct value')}.`,
    );
  }
  if (rule.condition.trim() !== '') lines.push('', sqlBlock(rule.condition));
  return lines.join('\n');
}

function rulesSection(f: QcFindings): string {
  const lines = ['## QC rules', ''];
  if (f.inputs.rules.length === 0) {
    lines.push('No QC rules were loaded for this run.');
    return lines.join('\n');
  }
  const o = f.overview.rules;
  const tally = [
    `${num(o.failed)} found problems`,
    `${num(o.passed)} passed`,
    ...(o.corrected > 0 ? [`${num(o.corrected)} corrected values`] : []),
    ...(o.errored > 0 ? [`${num(o.errored)} failed to execute`] : []),
    ...(o.notRun > 0 ? [`${num(o.notRun)} did not run`] : []),
  ];
  lines.push(
    `${plural(o.total, 'rule')} in ${plural(f.inputs.rules.length, 'file')}: ${tally.join(', ')}.`,
  );

  const failed = f.rules
    .filter((r) => r.outcome === 'failed')
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        (b.records ?? b.resultRows ?? 0) - (a.records ?? a.resultRows ?? 0),
    );
  if (failed.length > 0) {
    lines.push('', '### Rules that found problems', '');
    lines.push(
      table(
        ['Rule', 'Severity', 'Failed', 'Description'],
        ['l', 'l', 'r', 'l'],
        failed.map((r) => [code(r.ruleId), r.severity, ruleResult(r), prose(r.description.trim())]),
      ),
    );
    lines.push('', '#### Their definitions', '');
    lines.push(failed.map(ruleBlock).join('\n\n'));
  }

  const corrections = f.rules.filter((r) => r.outcome === 'corrected' || r.outcome === 'unchanged');
  if (corrections.length > 0) {
    lines.push('', '### Corrections', '');
    lines.push(
      'Correction rules change values before the checks run. The counts are of values changed; the values ' +
        'themselves are in the full QC report only.',
      '',
    );
    lines.push(
      table(
        ['Rule', 'Values changed', 'Records', 'Variables', 'Description'],
        ['l', 'r', 'r', 'l', 'l'],
        corrections.map((r) => [
          code(r.ruleId),
          num(r.valuesChanged ?? 0),
          recordsCell(r.records, r.percentOfRecords),
          variablesList(r.variables),
          prose(r.description.trim()),
        ]),
      ),
    );
  }

  const notRun = f.rules.filter((r) =>
    [
      'error',
      'not-evaluated',
      'disabled',
      'skipped',
      'excluded',
      'not-applied',
      'not-run',
    ].includes(r.outcome),
  );
  if (notRun.length > 0) {
    lines.push('', '### Rules that did not run', '');
    lines.push(
      table(
        ['Rule', 'Outcome', 'Why', 'Rules file'],
        ['l', 'l', 'l', 'l'],
        notRun.map((r) => [
          code(r.ruleId),
          OUTCOME_LABEL[r.outcome],
          prose(capital(r.reason ?? '')),
          `${code(r.file)}, row ${num(r.row)}`,
        ]),
      ),
    );
  }

  const passed = f.rules.filter((r) => r.outcome === 'passed');
  if (passed.length > 0) {
    lines.push('', '### Rules that passed', '');
    lines.push(passed.map((r) => code(r.ruleId)).join(', '));
  }
  return lines.join('\n');
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

const NOTE_HEADINGS: Partial<Record<FindingsNote['kind'], string>> = {
  'schema-comment': 'Notes the schema files carry',
};

function notesSection(f: QcFindings): string {
  if (f.notes.length === 0) return '';
  const lines = ['## Notes', ''];
  const general = f.notes.filter((n) => NOTE_HEADINGS[n.kind] === undefined);
  for (const note of general) lines.push(`- ${prose(note.text)}`);
  for (const [kind, heading] of Object.entries(NOTE_HEADINGS)) {
    const notes = f.notes.filter((n) => n.kind === kind);
    if (notes.length === 0) continue;
    if (general.length > 0 || lines.length > 2) lines.push('');
    lines.push(`${heading}:`, '');
    for (const note of notes) lines.push(`- ${prose(note.text)}`);
  }
  return lines.join('\n');
}

function about(f: QcFindings): string {
  return [
    '## Reading these findings',
    '',
    `- *Records* counts the records that failed a check, out of ${plural(f.dataset.records, 'record')}; a ` +
      'record that fails several checks counts once in each.',
    '- *Severity* is the level the schema or the rule assigns; the schema’s is *error* for any value it rejects.',
    '- *Defined at* is a schema file and a JSON Pointer into it; a rule’s *row* counts its rules file’s data ' +
      'rows from 1, the header not being one.',
    '- The failing values themselves are only in the full QC report, an Excel workbook that holds the data. ' +
      `The same findings are also available as JSON (\`findingsSchemaVersion\` ${String(f.findingsSchemaVersion)}) ` +
      'and as an Excel workbook.',
  ].join('\n');
}

/** The whole document, newline-terminated. */
export function renderFindingsMarkdown(findings: QcFindings): string {
  return `${[
    header(findings),
    summary(findings),
    schemaSection(findings),
    rulesSection(findings),
    notesSection(findings),
    about(findings),
  ]
    .filter((s) => s !== '')
    .join('\n\n')}\n`;
}
