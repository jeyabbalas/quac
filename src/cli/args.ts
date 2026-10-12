/**
 * The `quac` command grammar (headless.md §5) — pure. No I/O, no
 * `process.exit`, no printing: this module turns an argv array into a
 * `CliArgs`, or throws the `QuacCliError('usage')` that `main()` maps to
 * exit 1.
 *
 * `node:util`'s parseArgs does the lexing (zero new runtime deps): repeatables
 * via `multiple: true`, the dataset via `allowPositionals`, and `strict: true`
 * so an unknown flag is a refusal rather than a silently ignored typo. There
 * are no subcommands in v1.
 */
import { parseArgs } from 'node:util';
import { QuacCliError } from '../headless/errors';
import type { FindingsFormat } from '../core/report/findings';

export type FailOn = 'error' | 'warning' | 'none';

/**
 * One `--findings` value. Its format comes from the name; a name without an
 * extension may be a directory, which only `main()` can look at (this module
 * does no I/O) — it then gets the default name, in Markdown, or a refusal.
 */
export type FindingsTarget =
  | { kind: 'stdout'; format: 'markdown' }
  | { kind: 'file'; path: string; format: FindingsFormat }
  | { kind: 'directory?'; path: string };

export interface CliArgs {
  dataset: string;
  schema: string[];
  rules: string[];
  index?: string;
  sheet?: string;
  out?: string;
  /** False with `--no-report`: the data-bearing workbook is not written. */
  report: boolean;
  /** `--findings`, in argument order: the findings without data. */
  findings: FindingsTarget[];
  applyCorrections: boolean;
  /** A path, or `-` for stdout. Absent ⇒ no summary is written. */
  summary?: string;
  failOn: FailOn;
  quiet: boolean;
}

/** `--help` and `--version` short-circuit before anything is validated. */
export type ParsedArgs =
  | { kind: 'run'; args: CliArgs }
  | { kind: 'help' }
  | { kind: 'version' };

const FAIL_ON: readonly FailOn[] = ['error', 'warning', 'none'];

export const USAGE = `quac — data quality control for tabular data, headless.

Usage
  quac <dataset> [--schema <file|dir|url>]... [--rules <file|url>]...
       [--index <id>] [--sheet <name>] [--out <path>] [--no-report]
       [--findings <path|->]... [--no-corrections] [--summary <path|->]
       [--fail-on <error|warning|none>] [--quiet]
  quac --version
  quac --help

The dataset is a local .csv, .tsv, .json, .xlsx or .parquet file. You need at
least one source of checks: a JSON Schema, a QC rules file, or both.

Options
  --schema <file|dir|url>  JSON Schema to validate against. Repeatable. A
                           directory is read like a folder drop — every file
                           in it, recursively. All values must be local paths
                           or all URLs, never a mix.
  --rules <file|url>       A .quac.csv QC rules file. Repeatable.
                           ARGUMENT ORDER IS CORRECTION ORDER: rules files are
                           applied in the order you name them, so a correction
                           in the second file sees the first file's output.
  --index <id>             Which schema file is the root, when several could
                           be. Printed for you if the choice is ambiguous.
  --sheet <name>           Worksheet to read from an .xlsx dataset. Required
                           when the workbook has more than one sheet.
  --out <path>             Where to write the .xlsx QC report — a file path, or
                           a directory to write the default name into.
                           Default: the current directory.
  --no-report              Do not write the QC report, the workbook that holds
                           the data. Pair it with --findings, --summary or
                           --fail-on.
  --findings <path|->      Write the findings without data: every check the
                           dataset failed, where the JSON Schema or the QC
                           rules define it, and how many records failed it —
                           no value from the dataset, so it can be shared. The
                           name picks the format: .md (Markdown), .json or
                           .xlsx; a directory gets a Markdown file with the
                           default name. '-' writes Markdown to stdout.
                           Repeatable, one format per value.
  --no-corrections         Report on the data as-is; do not apply correction
                           rules.
  --summary <path|->       Write the machine-readable run summary as JSON.
                           '-' writes it to stdout, which then carries nothing
                           else — progress and warnings always go to stderr.
  --fail-on <level>        Exit 6 when findings reach this level: 'error',
                           'warning' (errors or warnings), or 'none'.
                           Default: none — findings do not affect the exit code.
  --quiet                  Suppress progress and stage lines. Warnings and
                           errors are still printed.
  --version                Print the version and exit.
  --help                   Print this message and exit.

Exit codes
  0  run finished          3  schema-set error
  1  usage error           4  run failure
  2  input/ingest error    5  an output could not be written
  6  --fail-on threshold met (every output was still written)
  130 interrupted

Your data never leaves this machine. The only network requests QuaC makes are
for the --schema and --rules URLs you pass it.

Docs: https://github.com/jeyabbalas/quac#headless--cli`;

/** The §5 refusal for a run with nothing to check against. */
export const NO_CHECKS_MESSAGE =
  'Provide a JSON Schema (--schema) or a QC rules file (--rules) — either is enough.';

const OPTIONS = {
  schema: { type: 'string', multiple: true },
  rules: { type: 'string', multiple: true },
  index: { type: 'string' },
  sheet: { type: 'string' },
  out: { type: 'string' },
  'no-report': { type: 'boolean' },
  findings: { type: 'string', multiple: true },
  'no-corrections': { type: 'boolean' },
  summary: { type: 'string' },
  'fail-on': { type: 'string' },
  quiet: { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
} as const;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let values: Partial<{
    schema: string[];
    rules: string[];
    index: string;
    sheet: string;
    out: string;
    'no-report': boolean;
    findings: string[];
    'no-corrections': boolean;
    summary: string;
    'fail-on': string;
    quiet: boolean;
    version: boolean;
    help: boolean;
  }>;
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    // parseArgs' own message names the offending flag; the hint is ours.
    throw new QuacCliError('usage', messageOf(err), { detail: ['Run `quac --help` for usage.'] });
  }

  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const dataset = positionals[0];
  if (dataset === undefined) {
    throw new QuacCliError('usage', 'Name the dataset to check: quac <dataset> [options].', {
      detail: ['Run `quac --help` for usage.'],
    });
  }
  if (positionals.length > 1) {
    throw new QuacCliError(
      'usage',
      'Only one dataset can be checked per run — the extra arguments below look misplaced.',
      { detail: positionals.slice(1) },
    );
  }

  const schema = values.schema ?? [];
  const rules = values.rules ?? [];
  if (schema.length === 0 && rules.length === 0) {
    throw new QuacCliError('usage', NO_CHECKS_MESSAGE);
  }

  const failOn = values['fail-on'];
  if (failOn !== undefined && !isFailOn(failOn)) {
    throw new QuacCliError('usage', `--fail-on takes ${FAIL_ON.join(', ')} — not '${failOn}'.`);
  }

  const report = values['no-report'] !== true;
  if (!report && values.out !== undefined) {
    throw new QuacCliError(
      'usage',
      '--out names where the QC report goes, and --no-report says not to write one — ' +
        'use one or the other.',
    );
  }
  const findings = (values.findings ?? []).map(findingsTarget);
  const stdout = [
    ...findings.filter((t) => t.kind === 'stdout').map(() => '--findings -'),
    ...(values.summary === '-' ? ['--summary -'] : []),
  ];
  if (stdout.length > 1) {
    throw new QuacCliError(
      'usage',
      `Only one output can go to stdout, and ${stdout.join(' and ')} both ask for it.`,
      { detail: ['Write the others to files.'] },
    );
  }

  return {
    kind: 'run',
    args: {
      dataset,
      schema,
      rules,
      ...optional('index', values.index),
      ...optional('sheet', values.sheet),
      ...optional('out', values.out),
      ...optional('summary', values.summary),
      report,
      findings,
      applyCorrections: values['no-corrections'] !== true,
      failOn: failOn ?? 'none',
      quiet: values.quiet === true,
    },
  };
}

const FINDINGS_FORMATS: Readonly<Record<string, FindingsFormat>> = {
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  xlsx: 'xlsx',
};

/** A `--findings` value: stdout, a file named for its format, or possibly a directory. */
function findingsTarget(value: string): FindingsTarget {
  if (value === '-') return { kind: 'stdout', format: 'markdown' };
  const name = value.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || /[/\\]$/.test(value)) return { kind: 'directory?', path: value };
  const format = FINDINGS_FORMATS[name.slice(dot + 1).toLowerCase()];
  if (format === undefined) {
    throw new QuacCliError(
      'usage',
      `--findings writes .md, .json or .xlsx — '${value}' is none of them.`,
      { detail: ['Name the file with one of those extensions, or pass a directory.'] },
    );
  }
  return { kind: 'file', path: value, format };
}

/** Optional-property spread: an absent flag stays absent, never `undefined`. */
function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function isFailOn(value: string): value is FailOn {
  return (FAIL_ON as readonly string[]).includes(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
