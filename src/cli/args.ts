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

export type FailOn = 'error' | 'warning' | 'none';

export interface CliArgs {
  dataset: string;
  schema: string[];
  rules: string[];
  index?: string;
  sheet?: string;
  out?: string;
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
       [--index <id>] [--sheet <name>] [--out <path>] [--no-corrections]
       [--summary <path|->] [--fail-on <error|warning|none>] [--quiet]
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
  --out <path>             Where to write the .xlsx report — a file path, or a
                           directory to write the default name into.
                           Default: the current directory.
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
  0  report written        3  schema-set error
  1  usage error           4  run failure
  2  input/ingest error    5  report or summary write failure
  6  --fail-on threshold met (the report was still written)
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
      applyCorrections: values['no-corrections'] !== true,
      failOn: failOn ?? 'none',
      quiet: values.quiet === true,
    },
  };
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
