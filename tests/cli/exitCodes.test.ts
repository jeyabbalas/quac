/**
 * Golden journey 19 (`testing-strategy.md` §2) — headless ergonomics and
 * exits. Codes 1, 2, 3, 5 and 6 are each observed here on a committed
 * fixture, through the BUILT binary.
 *
 * **Not** codes 4 and 130 (corrected in P22 — this header used to claim the
 * whole closed set). 4 is "run failure: prepare-stage error, bridge/DuckDB
 * init failure, any uncaught exception", which no fixture can provoke without
 * breaking the engine on purpose; 130 is SIGINT, which needs a spawn the test
 * interrupts mid-run. Both are recorded as an open gap in P21's deferred notes
 * rather than quietly implied by this docstring. What IS pinned about 4 is the
 * boundary: the exit-5 case below succeeds at the run and fails only at the
 * write, which is the whole reason the two codes are separate.
 *
 * The codes are a public contract: a pipeline branches on them. So each case
 * asserts the code AND the stderr that has to make the code actionable — the
 * sheet names, the root candidates, the plain-language lint diagnosis. The
 * final block generalizes that last part: no refusal may reach a pipeline log
 * as engine text (P22 task 1, CLI leg).
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { designProblems, findEngineText } from '../unit/support/designedMessage';
import { HESP_DATA, HESP_SCHEMA_DIR, TINY, TWO_ROOTS, meaningfulStderr, quac } from './support';

let outDir: string;

beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-cli-exit-'));
});

afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('exit 1 — usage', () => {
  it('refuses a run with no check source, echoing the readiness sentence', async () => {
    const result = await quac([join(TINY, 'people.csv')]);
    expect(result.code).toBe(1);
    // The app's `no-checks` gate, said in the CLI's own vocabulary.
    expect(meaningfulStderr(result.stderr)).toContain(
      'Provide a JSON Schema (--schema) or a QC rules file (--rules) — either is enough.',
    );
  });

  it('refuses an unknown flag and points at --help', async () => {
    const result = await quac([join(TINY, 'people.csv'), '--rules', 'r.csv', '--typo']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--typo');
    expect(result.stderr).toContain('quac --help');
  });

  it('refuses a --schema list that mixes local paths and URLs', async () => {
    const result = await quac([
      join(TINY, 'people.csv'),
      '--schema',
      join(TINY, 'people.schema.json'),
      '--schema',
      'https://example.org/other.schema.json',
    ]);
    expect(result.code).toBe(1);
    expect(meaningfulStderr(result.stderr)).toContain('either a local path or a URL, not a mix');
  });

  it('refuses a --fail-on level it does not have', async () => {
    const result = await quac([
      join(TINY, 'people.csv'),
      '--rules',
      join(TINY, 'people_rules.quac.csv'),
      '--fail-on',
      'loud',
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--fail-on takes error, warning, none');
  });
});

describe('exit 2 — input', () => {
  it('lists the worksheets when a multi-sheet workbook has no --sheet', async () => {
    // The CLI's SheetPickerModal: a pipeline must not guess which sheet.
    const result = await quac([
      join(TINY, 'two_sheets.xlsx'),
      '--schema',
      join(TINY, 'people.schema.json'),
      '--out',
      outDir,
    ]);
    expect(result.code).toBe(2);
    const stderr = meaningfulStderr(result.stderr);
    expect(stderr).toContain('has 2 worksheets — name one with --sheet');
    expect(stderr).toContain('people');
    expect(stderr).toContain('notes');
  });

  it('lists them again when --sheet names one the workbook does not have', async () => {
    const result = await quac([
      join(TINY, 'two_sheets.xlsx'),
      '--sheet',
      'Sheet3',
      '--schema',
      join(TINY, 'people.schema.json'),
      '--out',
      outDir,
    ]);
    expect(result.code).toBe(2);
    const stderr = meaningfulStderr(result.stderr);
    expect(stderr).toContain("has no worksheet named 'Sheet3'");
    expect(stderr).toContain('people');
    expect(stderr).toContain('notes');
  });

  it('reads the named sheet when --sheet is given', async () => {
    const result = await quac([
      join(TINY, 'two_sheets.xlsx'),
      '--sheet',
      'people',
      '--schema',
      join(TINY, 'people.schema.json'),
      '--out',
      outDir,
      '--summary',
      '-',
    ]);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as { dataset: { sheet: string | null } };
    // The RESOLVED sheet, not an echo of the flag.
    expect(summary.dataset.sheet).toBe('people');
  }, 120_000);

  it('refuses a dataset it cannot read', async () => {
    const result = await quac([
      join(TINY, 'not-here.csv'),
      '--schema',
      join(TINY, 'people.schema.json'),
    ]);
    expect(result.code).toBe(2);
    expect(meaningfulStderr(result.stderr)).toContain('Could not read the dataset');
  });

  it('refuses a dataset URL by name — the dataset is a local path', async () => {
    const result = await quac([
      'https://example.org/data.csv',
      '--schema',
      join(TINY, 'people.schema.json'),
    ]);
    expect(result.code).toBe(1);
    expect(meaningfulStderr(result.stderr)).toContain('must be a local file');
  });
});

describe('exit 3 — schema set', () => {
  it('names both candidates when the root is ambiguous', async () => {
    const result = await quac([join(TINY, 'people.csv'), '--schema', TWO_ROOTS, '--out', outDir]);
    expect(result.code).toBe(3);
    const stderr = meaningfulStderr(result.stderr);
    expect(stderr).toContain('name one with --index');
    expect(stderr).toContain('a.schema.json');
    expect(stderr).toContain('b.schema.json');
  });

  it('runs once --index picks one of them', async () => {
    // The recovery the exit-3 message is FOR: paste a candidate back in.
    const result = await quac([
      join(TINY, 'people.csv'),
      '--schema',
      TWO_ROOTS,
      '--index',
      'a.schema.json',
      '--out',
      outDir,
      '--summary',
      '-',
    ]);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as { inputs: { schema: { root: string } | null } };
    expect(summary.inputs.schema?.root).toBe('a.schema.json');
    expect((await readdir(outDir)).filter((f) => f.endsWith('.xlsx'))).toHaveLength(1);
  }, 120_000);
});

describe('exit 5 — report write', () => {
  it('refuses when the report cannot be written where it was asked to go', async () => {
    // The run itself succeeds; only the write fails — which is exactly the
    // distinction between 5 and 4, and why they are separate codes.
    const result = await quac([
      join(TINY, 'people.csv'),
      '--schema',
      join(TINY, 'people.schema.json'),
      '--out',
      join(outDir, 'no', 'such', 'directory', 'report.xlsx'),
    ]);
    expect(result.code).toBe(5);
    expect(meaningfulStderr(result.stderr)).toContain('Could not write the QC report');
  }, 120_000);
});

describe('exit 6 — --fail-on', () => {
  it('exits 6 on errors but writes the report and the summary first', async () => {
    const summaryPath = join(outDir, 'summary.json');
    const result = await quac([
      join(HESP_DATA, 'hesp_dirty_100.csv'),
      '--schema',
      HESP_SCHEMA_DIR,
      '--fail-on',
      'error',
      '--out',
      outDir,
      '--summary',
      summaryPath,
    ]);
    expect(result.code).toBe(6);
    // "The report AND summary were still written first" — §6, literally.
    const written = (await readdir(outDir)).filter((f) => f.endsWith('.xlsx'));
    expect(written).toHaveLength(1);
    expect((await stat(join(outDir, written[0] ?? ''))).size).toBeGreaterThan(10_000);
    // And the summary records the code it is about to exit with.
    const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as {
      exitCode: number;
      severityTotals: { error: number };
    };
    expect(summary.exitCode).toBe(6);
    expect(summary.severityTotals.error).toBeGreaterThan(0);
  }, 300_000);

  it('exits 0 on the same run without --fail-on', async () => {
    // Findings do not affect the exit code unless asked to (§6 row 0).
    const result = await quac([
      join(HESP_DATA, 'hesp_dirty_100.csv'),
      '--schema',
      HESP_SCHEMA_DIR,
      '--out',
      outDir,
    ]);
    expect(result.code).toBe(0);
  }, 300_000);
});

describe('partial inputs run headless too (UIX-6 parity)', () => {
  it('completes with a schema and no rules', async () => {
    const result = await quac([
      join(TINY, 'people.csv'),
      '--schema',
      join(TINY, 'people.schema.json'),
      '--out',
      outDir,
      '--summary',
      '-',
    ]);
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      inputs: { rules: unknown[]; schema: unknown };
    };
    expect(summary.inputs.rules).toEqual([]);
    expect(summary.inputs.schema).not.toBeNull();
  }, 120_000);

  it('completes with rules and no schema, saying WHY rules were excluded', async () => {
    const result = await quac([
      join(TINY, 'people.csv'),
      '--rules',
      join(TINY, 'people_rules.quac.csv'),
      '--out',
      outDir,
      '--summary',
      '-',
    ]);
    expect(result.code).toBe(0);
    const stderr = meaningfulStderr(result.stderr);

    // V23: on the schema-less all-VARCHAR copy DuckDB's binder refuses two of
    // the six rules. UIX-16's contract is that the CLI says so in plain
    // language — never by pasting the binder's own words at the reader.
    expect(stderr).toContain('is stored as text in this dataset');
    expect(stderr).toContain('TRY_CAST(age AS DOUBLE)');
    expect(stderr).not.toContain('Binder Error');
    expect(stderr).not.toContain('INTEGER_LITERAL');

    const summary = JSON.parse(result.stdout) as {
      inputs: { schema: unknown; rules: { rules: number; excludedRuleIds: string[] }[] };
    };
    expect(summary.inputs.schema).toBeNull();
    expect(summary.inputs.rules[0]?.rules).toBe(6);
    expect(summary.inputs.rules[0]?.excludedRuleIds).toEqual(['R003', 'R005']);
  }, 120_000);
});

/**
 * P22 task 1, CLI leg. `headless.md §6` makes the exit codes a contract; the
 * stderr beside them is the other half of it, and a pipeline log is the one
 * place a human reads QuaC's words with no UI around them to soften a leak.
 *
 * `progress.ts` prefixes every refusal `error: ` and every advisory
 * `warning: `, with details indented two spaces. This walks those lines over
 * the same refusals the blocks above make and asserts each payload is a
 * DESIGNED message: a sentence, and free of DuckDB / QuickJS / Ajv vocabulary
 * and of QuaC's internal table names. `pure` throughout — unlike the app's
 * lint panel, nothing the CLI prints is allowed to quote the engine.
 */
describe('stderr copy quality — a pipeline log never meets the engine', () => {
  /** `error:`/`warning:` payloads, then indented detail lines. */
  const split = (stderr: string): { messages: string[]; details: string[] } => {
    const messages: string[] = [];
    const details: string[] = [];
    for (const line of meaningfulStderr(stderr).split('\n')) {
      const refusal = /^(?:error|warning): (.+)$/.exec(line);
      if (refusal?.[1] !== undefined) {
        messages.push(refusal[1]);
        continue;
      }
      if (/^ {2}\S/.test(line)) details.push(line.trim());
    }
    return { messages, details };
  };

  const REFUSALS: readonly { what: string; argv: readonly string[] }[] = [
    { what: 'no check source', argv: [join(TINY, 'people.csv')] },
    {
      what: 'unknown flag',
      argv: [join(TINY, 'people.csv'), '--rules', 'r.csv', '--typo'],
    },
    {
      what: 'mixed --schema kinds',
      argv: [
        join(TINY, 'people.csv'),
        '--schema',
        join(TINY, 'people.schema.json'),
        '--schema',
        'https://example.org/other.schema.json',
      ],
    },
    {
      what: 'bad --fail-on',
      argv: [
        join(TINY, 'people.csv'),
        '--rules',
        join(TINY, 'people_rules.quac.csv'),
        '--fail-on',
        'loud',
      ],
    },
    {
      what: 'unreadable dataset',
      argv: [join(TINY, 'not-here.csv'), '--schema', join(TINY, 'people.schema.json')],
    },
    {
      what: 'a URL where a local dataset belongs',
      argv: ['https://example.org/data.csv', '--schema', join(TINY, 'people.schema.json')],
    },
    {
      what: 'a multi-sheet workbook with no --sheet',
      argv: [join(TINY, 'two_sheets.xlsx'), '--schema', join(TINY, 'people.schema.json')],
    },
    { what: 'an ambiguous schema root', argv: [join(TINY, 'people.csv'), '--schema', TWO_ROOTS] },
  ];

  it.each(REFUSALS)('$what refuses in QuaC’s own words', async ({ argv }) => {
    const result = await quac([...argv]);
    expect(result.code).toBeGreaterThan(0);

    const { messages, details } = split(result.stderr);
    expect(messages.length, 'a nonzero exit with nothing on stderr').toBeGreaterThan(0);

    const problems: string[] = [];
    for (const message of messages) {
      for (const problem of designProblems(message, 'pure'))
        problems.push(`${message} — ${problem}`);
    }
    // Details are lists (sheet names, root candidates), not sentences, so they
    // answer only the question that matters here.
    for (const detail of details) {
      for (const hit of findEngineText(detail)) problems.push(`detail leaked ${hit}: ${detail}`);
    }
    expect(problems).toEqual([]);
  });

  it('the V23 lint diagnosis reaches stderr as advice, not as binder text', async () => {
    // The one warning path that has real engine text behind it. `progress.ts`
    // prints `issue.message` and never `issue.detail`; this is that promise,
    // asserted through the marker list rather than two hand-picked strings.
    const result = await quac([
      join(TINY, 'people.csv'),
      '--rules',
      join(TINY, 'people_rules.quac.csv'),
      '--out',
      outDir,
    ]);
    expect(result.code).toBe(0);
    const stderr = meaningfulStderr(result.stderr);
    expect(stderr).toContain('is stored as text in this dataset');
    expect(findEngineText(stderr)).toEqual([]);
  }, 120_000);
});
