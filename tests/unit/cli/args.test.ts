/**
 * The §5 grammar (`src/cli/args.ts`) — every flag, both repeatables, every
 * refusal, and the two short-circuits.
 *
 * `parseCliArgs` is pure, so this tier can cover the whole surface without a
 * build or a subprocess; the CLI tier only has to prove the built binary maps
 * these refusals onto the right exit codes.
 */
import { describe, expect, it } from 'vitest';
import { NO_CHECKS_MESSAGE, USAGE, parseCliArgs } from '../../../src/cli/args';
import { QuacCliError } from '../../../src/headless/errors';
import type { CliArgs } from '../../../src/cli/args';

/** Every refusal here is a usage error — the CLI turns `kind` into exit 1. */
function refusal(argv: readonly string[]): QuacCliError {
  try {
    parseCliArgs(argv);
  } catch (err) {
    if (err instanceof QuacCliError) return err;
    throw err;
  }
  throw new Error(`expected a refusal for: ${argv.join(' ')}`);
}

function run(argv: readonly string[]): CliArgs {
  const parsed = parseCliArgs(argv);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
  return parsed.args;
}

describe('parseCliArgs — the happy grammar', () => {
  it('takes the dataset positionally and defaults everything else', () => {
    expect(run(['data.csv', '--schema', 's.json'])).toEqual({
      dataset: 'data.csv',
      schema: ['s.json'],
      rules: [],
      report: true,
      findings: [],
      applyCorrections: true,
      failOn: 'none',
      quiet: false,
    });
  });

  it('accepts every flag at once and keeps repeatables in argument order', () => {
    // Rules order is the cross-file CORRECTION order, so it must not be sorted.
    expect(
      run([
        'data.xlsx',
        '--schema',
        'b/',
        '--schema',
        'a.json',
        '--rules',
        'z.quac.csv',
        '--rules',
        'a.quac.csv',
        '--index',
        'core.schema.json',
        '--sheet',
        'Sheet2',
        '--out',
        'reports/',
        '--findings',
        'shared/findings.md',
        '--findings',
        'findings.JSON',
        '--no-corrections',
        '--summary',
        '-',
        '--fail-on',
        'warning',
        '--quiet',
      ]),
    ).toEqual({
      dataset: 'data.xlsx',
      schema: ['b/', 'a.json'],
      rules: ['z.quac.csv', 'a.quac.csv'],
      index: 'core.schema.json',
      sheet: 'Sheet2',
      out: 'reports/',
      summary: '-',
      report: true,
      findings: [
        { kind: 'file', path: 'shared/findings.md', format: 'markdown' },
        { kind: 'file', path: 'findings.JSON', format: 'json' },
      ],
      applyCorrections: false,
      failOn: 'warning',
      quiet: true,
    });
  });

  it('reads --no-corrections as the toggle being OFF, and its absence as on', () => {
    expect(run(['d.csv', '--rules', 'r.csv']).applyCorrections).toBe(true);
    expect(run(['d.csv', '--rules', 'r.csv', '--no-corrections']).applyCorrections).toBe(false);
  });

  it('takes each --fail-on level, and a --summary path as well as -', () => {
    expect(run(['d.csv', '--rules', 'r.csv', '--fail-on', 'error']).failOn).toBe('error');
    expect(run(['d.csv', '--rules', 'r.csv', '--fail-on', 'none']).failOn).toBe('none');
    expect(run(['d.csv', '--rules', 'r.csv', '--summary', 'out.json']).summary).toBe('out.json');
  });

  it('leaves absent optionals absent rather than undefined-valued', () => {
    // runQuac spreads these conditionally; a present-but-undefined key would
    // defeat that and reach the pipeline as an explicit "no value".
    const args = run(['d.csv', '--rules', 'r.csv']);
    expect(Object.keys(args).sort()).toEqual([
      'applyCorrections',
      'dataset',
      'failOn',
      'findings',
      'quiet',
      'report',
      'rules',
      'schema',
    ]);
  });

  it('lets a dataset named like a flag through after --', () => {
    expect(run(['--rules', 'r.csv', '--', '--weird-name.csv']).dataset).toBe('--weird-name.csv');
  });
});

describe('parseCliArgs — the findings without data', () => {
  it('reads each --findings format from its extension, case aside, in argument order', () => {
    expect(
      run([
        'd.csv',
        '--rules',
        'r.csv',
        '--findings',
        'a.md',
        '--findings',
        'b.markdown',
        '--findings',
        'c.Json',
        '--findings',
        'out/d.xlsx',
      ]).findings,
    ).toEqual([
      { kind: 'file', path: 'a.md', format: 'markdown' },
      { kind: 'file', path: 'b.markdown', format: 'markdown' },
      { kind: 'file', path: 'c.Json', format: 'json' },
      { kind: 'file', path: 'out/d.xlsx', format: 'xlsx' },
    ]);
  });

  it("takes '-' as Markdown on stdout", () => {
    expect(run(['d.csv', '--rules', 'r.csv', '--findings', '-']).findings).toEqual([
      { kind: 'stdout', format: 'markdown' },
    ]);
  });

  it('leaves a name without an extension for main() to look at — it may be a directory', () => {
    expect(
      run(['d.csv', '--rules', 'r.csv', '--findings', 'reports', '--findings', 'out/']).findings,
    ).toEqual([
      { kind: 'directory?', path: 'reports' },
      { kind: 'directory?', path: 'out/' },
    ]);
  });

  it('reads --no-report as the report being OFF, and its absence as on', () => {
    expect(run(['d.csv', '--rules', 'r.csv']).report).toBe(true);
    expect(run(['d.csv', '--rules', 'r.csv', '--no-report']).report).toBe(false);
  });

  it('refuses an extension it cannot write, naming the three it can', () => {
    const err = refusal(['d.csv', '--rules', 'r.csv', '--findings', 'findings.txt']);
    expect(err.kind).toBe('usage');
    expect(err.message).toContain('.md, .json or .xlsx');
    expect(err.message).toContain('findings.txt');
  });

  it('refuses --out with --no-report: one names the report, the other declines it', () => {
    const err = refusal(['d.csv', '--rules', 'r.csv', '--no-report', '--out', 'r.xlsx']);
    expect(err.kind).toBe('usage');
    expect(err.message).toContain('--no-report');
  });

  it('refuses two outputs on stdout', () => {
    expect(
      refusal(['d.csv', '--rules', 'r.csv', '--findings', '-', '--summary', '-']).message,
    ).toContain('stdout');
    expect(
      refusal(['d.csv', '--rules', 'r.csv', '--findings', '-', '--findings', '-']).message,
    ).toContain('stdout');
  });

  it('documents --findings and --no-report in --help', () => {
    expect(USAGE).toContain('--findings <path|->');
    expect(USAGE).toContain('--no-report');
    expect(USAGE).toContain('no value from the dataset');
  });
});

describe('parseCliArgs — short circuits', () => {
  it('answers --help and --version without a dataset or a check source', () => {
    // Both semantic refusals sit after this branch, which is the whole point:
    // `quac --help` must work when you do not yet know what to type.
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseCliArgs(['data.csv', '--help'])).toEqual({ kind: 'help' });
  });

  it('still refuses a malformed argv, since lexing precedes both', () => {
    // parseArgs cannot get as far as seeing --help in an argv it cannot read.
    expect(refusal(['--help', '--bogus']).message).toContain('--bogus');
  });

  it('documents the contracts a pipeline author has to know', () => {
    expect(USAGE).toContain('ARGUMENT ORDER IS CORRECTION ORDER');
    expect(USAGE).toContain('--fail-on');
    expect(USAGE).toContain('130');
    // The privacy promise is the headline feature; it belongs in --help.
    expect(USAGE).toContain('never leaves this machine');
    // A URL, not a repo-relative path: `docs/` is not in the published
    // tarball, so the path this line used to print resolved to nothing on the
    // machine of every single person who installed the package (P22).
    expect(USAGE).toMatch(/Docs: https:\/\//);
  });
});

describe('parseCliArgs — refusals', () => {
  it('refuses an unknown flag by name, with a pointer to --help', () => {
    const err = refusal(['d.csv', '--rules', 'r.csv', '--bogus']);
    expect(err.kind).toBe('usage');
    expect(err.message).toContain('--bogus');
    expect(err.detail).toEqual(['Run `quac --help` for usage.']);
  });

  it('refuses a run with no dataset', () => {
    expect(refusal(['--schema', 's.json']).message).toContain('quac <dataset>');
  });

  it('refuses a second positional rather than silently ignoring it', () => {
    const err = refusal(['a.csv', 'b.csv', 'c.csv', '--rules', 'r.csv']);
    expect(err.message).toContain('Only one dataset');
    expect(err.detail).toEqual(['b.csv', 'c.csv']);
  });

  it('refuses a run with no check source, echoing the readiness sentence', () => {
    expect(refusal(['d.csv']).message).toBe(NO_CHECKS_MESSAGE);
    expect(NO_CHECKS_MESSAGE).toContain('--schema');
    expect(NO_CHECKS_MESSAGE).toContain('--rules');
  });

  it('refuses a --fail-on level it does not have, listing the ones it does', () => {
    const err = refusal(['d.csv', '--rules', 'r.csv', '--fail-on', 'loud']);
    expect(err.message).toContain("not 'loud'");
    for (const level of ['error', 'warning', 'none']) expect(err.message).toContain(level);
  });

  it('refuses a flag that needs a value and did not get one', () => {
    expect(refusal(['d.csv', '--schema']).kind).toBe('usage');
  });
});
