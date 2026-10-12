/**
 * The findings without data, from the outside (headless.md §5, `--findings`
 * and `--no-report`): the built binary over the HESP fixtures, writing all
 * three formats and a directory's default name, no workbook, and a summary
 * that says so — then the stdout form, the refusals, and the write failure.
 *
 * What the findings say is the unit tier's (tests/unit/report/findings*.ts);
 * this tier owns the skin: argv, files on disk, stdio, exit codes. It also
 * re-checks the one promise worth checking twice: none of the values the
 * fixture seeded reaches any findings file.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HESP_DATA, HESP_RULES, HESP_SCHEMA_DIR, TINY, meaningfulStderr, quac } from './support';
import type { CliRun } from './support';

/** Values seeded into hesp_dirty_100.csv that the QC report quotes back. */
const SEEDED = ['HH1234_W01', 'twelve hundred', '412.75', '2150', '-555', 'n_rows='];

const HESP = [
  join(HESP_DATA, 'hesp_dirty_100.csv'),
  '--schema',
  HESP_SCHEMA_DIR,
  ...HESP_RULES.flatMap((r) => ['--rules', r]),
];

let outDir: string;
let run: CliRun;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-cli-findings-'));
  run = await quac([
    ...HESP,
    '--no-report',
    '--findings',
    join(outDir, 'findings.md'),
    '--findings',
    join(outDir, 'findings.json'),
    '--findings',
    join(outDir, 'findings.xlsx'),
    '--findings',
    outDir,
    '--summary',
    join(outDir, 'summary.json'),
  ]);
}, 300_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('--findings and --no-report — a headless run that shares no data', () => {
  it('exits 0, writes every findings file asked for, and no QC report', async () => {
    expect(run.code).toBe(0);
    const files = (await readdir(outDir)).sort();
    expect(files.filter((f) => f.startsWith('quac-report_'))).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining(['findings.json', 'findings.md', 'findings.xlsx', 'summary.json']),
    );
    // A directory gets the default name, in Markdown.
    expect(
      files.filter((f) => /^quac-findings_hesp_dirty_100_\d{8}-\d{4}\.md$/.test(f)),
    ).toHaveLength(1);
  });

  it('closes with one line per findings file, and says no report was written', () => {
    const stderr = meaningfulStderr(run.stderr);
    expect(stderr).not.toContain('report written');
    expect(stderr.match(/quac: findings written → /g)).toHaveLength(4);
    expect(stderr).toContain(`quac: findings written → ${join(outDir, 'findings.json')}`);
  });

  it('records the outputs in the summary: no report, four findings', async () => {
    const summary = JSON.parse(await readFile(join(outDir, 'summary.json'), 'utf8')) as {
      report: unknown;
      findings: { path: string; format: string }[];
    };
    expect(summary.report).toBeNull();
    expect(summary.findings.map((f) => f.format)).toEqual(['markdown', 'json', 'xlsx', 'markdown']);
    expect(summary.findings[1]).toEqual({ path: join(outDir, 'findings.json'), format: 'json' });
  });

  it('writes the same findings in each format, and none of the seeded values', async () => {
    const markdown = await readFile(join(outDir, 'findings.md'), 'utf8');
    const json = await readFile(join(outDir, 'findings.json'), 'utf8');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(join(outDir, 'findings.xlsx'));
    const sheets = workbook.worksheets.map((w) => JSON.stringify(w.getSheetValues())).join('\n');

    const findings = JSON.parse(json) as {
      findingsSchemaVersion: number;
      containsData: boolean;
      schemaChecks: unknown[];
      rules: unknown[];
    };
    expect(findings).toMatchObject({ findingsSchemaVersion: 1, containsData: false });
    expect(markdown.startsWith('# QC findings: hesp_dirty_100.csv\n')).toBe(true);
    expect(workbook.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'Schema checks',
      'QC rules',
      'Notes',
    ]);
    expect(workbook.getWorksheet('Schema checks')?.rowCount).toBe(1 + findings.schemaChecks.length);
    expect(workbook.getWorksheet('QC rules')?.rowCount).toBe(1 + findings.rules.length);
    for (const value of SEEDED) {
      expect(markdown).not.toContain(value);
      expect(json).not.toContain(value);
      expect(sheets).not.toContain(value);
    }
  });
});

describe('--findings - — Markdown on stdout', () => {
  it('puts the findings on stdout and nothing else', async () => {
    const result = await quac([
      join(TINY, 'people.csv'),
      '--schema',
      join(TINY, 'people.schema.json'),
      '--no-report',
      '--findings',
      '-',
      '--quiet',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout.startsWith('# QC findings: people.csv\n')).toBe(true);
    expect(result.stdout).toContain('## Reading these findings');
    expect(meaningfulStderr(result.stderr)).not.toContain('findings written');
  }, 120_000);
});

describe('--findings refusals and failures', () => {
  const tiny = [join(TINY, 'people.csv'), '--schema', join(TINY, 'people.schema.json')];

  it('exits 1 for a format it cannot write', async () => {
    const result = await quac([...tiny, '--findings', 'findings.txt']);
    expect(result.code).toBe(1);
    expect(meaningfulStderr(result.stderr)).toContain('.md, .json or .xlsx');
  });

  it('exits 1 for a name with no extension that is no directory', async () => {
    const result = await quac([...tiny, '--findings', join(outDir, 'no-such-directory')]);
    expect(result.code).toBe(1);
    expect(meaningfulStderr(result.stderr)).toContain('or an existing directory');
  });

  it('exits 1 for --out with --no-report, and for two outputs on stdout', async () => {
    expect((await quac([...tiny, '--no-report', '--out', 'x.xlsx'])).code).toBe(1);
    const both = await quac([...tiny, '--findings', '-', '--summary', '-']);
    expect(both.code).toBe(1);
    expect(meaningfulStderr(both.stderr)).toContain('stdout');
  });

  it('exits 5 when a findings file cannot be written', async () => {
    const result = await quac([
      ...tiny,
      '--no-report',
      '--findings',
      join(outDir, 'missing', 'directory', 'findings.json'),
    ]);
    expect(result.code).toBe(5);
    expect(meaningfulStderr(result.stderr)).toContain('Could not write the findings');
  }, 120_000);
});
