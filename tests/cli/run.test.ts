/**
 * Golden journey 18 (`testing-strategy.md` §2) — the headless full run,
 * executed as a user executes it: `node dist-cli/quac.mjs` over the committed
 * HESP fixtures, with everything asserted from the outside.
 *
 * This tier owns the SKIN — argv, stdio, exit code, the file on disk. What the
 * pipeline computes is `unit/headless/nodePipeline.test.ts`'s job and is not
 * re-litigated here; what IS re-checked is that the numbers the CLI reports
 * and the numbers in the workbook are the same numbers.
 */
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  HESP_DATA,
  REPO,
  HESP_RULES,
  HESP_SCHEMA_DIR,
  TINY,
  meaningfulStderr,
  quac,
  startFixtureServer,
} from './support';
import type { CliRun, FixtureServer } from './support';

const execFileAsync = promisify(execFile);

/**
 * An exceljs cell value is a union — string, number, Date, formula object,
 * rich text — so it is narrowed rather than blindly stringified. Everything
 * this file reads is plain text or a number; anything else reads as '' and
 * fails its assertion loudly rather than matching '[object Object]'.
 */
function cellText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

let outDir: string;
let run: CliRun;
let workbook: ExcelJS.Workbook;

/** Seeded ground truth — the same manifest the browser and node tiers pin. */
interface Injection {
  kind: string;
  rows: number[];
  column?: string;
  expectedRuleIds: string[];
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-cli-run-'));
  run = await quac([
    join(HESP_DATA, 'hesp_dirty_100.csv'),
    '--schema',
    HESP_SCHEMA_DIR,
    ...HESP_RULES.flatMap((r) => ['--rules', r]),
    '--out',
    outDir,
    '--summary',
    '-',
  ]);
  const written = (await readdir(outDir)).filter((f) => f.endsWith('.xlsx'));
  workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(outDir, written[0] ?? ''));
}, 300_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('journey 18 — a full headless run', () => {
  it('exits 0 and writes exactly one workbook', async () => {
    expect(run.code).toBe(0);
    expect((await readdir(outDir)).filter((f) => f.endsWith('.xlsx'))).toHaveLength(1);
  });

  it('puts the summary JSON on stdout and NOTHING else', () => {
    // `quac … --summary - | jq` has to work. Anything chatty on stdout, ever,
    // breaks every pipeline built on this.
    const parsed: unknown = JSON.parse(run.stdout);
    expect(parsed).toMatchObject({ summarySchemaVersion: 1, exitCode: 0 });
    expect(run.stdout.trimStart().startsWith('{')).toBe(true);
  });

  it('puts the stage lines and the closing counts on stderr', () => {
    const stderr = meaningfulStderr(run.stderr);
    for (const stage of [
      'Preparing tables',
      'Applying corrections',
      'Validating against the schema',
      'Running QC rules',
      'Painting the report',
    ]) {
      expect(stderr).toContain(stage);
    }
    expect(stderr).toContain('quac: report written → ');
    expect(stderr).toMatch(/\d+ error · \d+ warning · \d+ info across [\d,]+ rows of 101/);
  });

  it('names the report for the dataset and the minute it ran', async () => {
    const [written] = (await readdir(outDir)).filter((f) => f.endsWith('.xlsx'));
    expect(written).toMatch(/^quac-report_hesp_dirty_100_\d{8}-\d{4}\.xlsx$/);
    const summary = JSON.parse(run.stdout) as { report: { path: string } };
    expect(summary.report.path).toBe(join(outDir, written ?? ''));
  });

  it('writes all five sheets', () => {
    expect(workbook.worksheets.map((s) => s.name)).toEqual([
      'Data',
      'Missing Variables',
      'Dataset Findings',
      'Repeat Offenders',
      'Run Info',
    ]);
  });

  it('carries a seeded violation into its own __review cell', async () => {
    // The pattern break at row 10 of record_id — the first injection in the
    // manifest, and one both engines are expected to flag.
    const manifest = JSON.parse(
      await readFile(join(HESP_DATA, 'seeded-violations.json'), 'utf8'),
    ) as { injections: Injection[] };
    const injection = manifest.injections.find(
      (i) => i.column === 'record_id' && i.kind === 'pattern-break',
    );
    expect(injection).toBeDefined();

    const data = workbook.getWorksheet('Data');
    const headers = (data?.getRow(1).values ?? []) as unknown[];
    const reviewCol = headers.findIndex((h) => h === 'record_id__review');
    expect(reviewCol).toBeGreaterThan(0);

    // Sheet row = header + 0-based data row + 1.
    const row = data?.getRow((injection?.rows[0] ?? 0) + 2);
    expect(cellText(row?.getCell(reviewCol).value)).toContain('schema:prop:record_id:value');
  });

  it('marks a corrected cell in the sheet the summary counted', () => {
    const summary = JSON.parse(run.stdout) as { correctedCells: number };
    expect(summary.correctedCells).toBeGreaterThan(0);

    const data = workbook.getWorksheet('Data');
    let corrected = 0;
    data?.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cellText(cell.value).includes('corrected')) corrected += 1;
      });
    });
    expect(corrected).toBeGreaterThan(0);
  });

  it('agrees with the workbook about what it found', () => {
    const summary = JSON.parse(run.stdout) as {
      severityTotals: { error: number; warning: number; info: number };
      perRule: { ruleId: string; violationCount: number; status: string }[];
      dataset: { rows: number; columns: number };
    };
    // Sheet 4 lists rules by exact violation count; the summary quotes the
    // same RuleRunStat. If the two ever disagree, one of them is lying.
    const offenders = workbook.getWorksheet('Repeat Offenders');
    const rows: { ruleId: string; count: number }[] = [];
    offenders?.eachRow({ includeEmpty: false }, (row, n) => {
      if (n === 1) return;
      const values = row.values as unknown[];
      const ruleId = cellText(values[1]);
      const count = values.find((v) => typeof v === 'number');
      if (ruleId !== '' && count !== undefined) rows.push({ ruleId, count });
    });
    expect(rows.length).toBeGreaterThan(0);

    for (const offender of rows) {
      const stat = summary.perRule.find((s) => s.ruleId === offender.ruleId);
      if (stat === undefined) continue; // schema rules are not RuleRunStats
      expect(stat.violationCount).toBe(offender.count);
    }
    expect(summary.dataset).toMatchObject({ rows: 101, columns: 266 });
    expect(summary.severityTotals.error).toBeGreaterThan(0);
  });

  it('reports zero lint exclusions on the typed HESP set', () => {
    // The §4.3 typed-sync mirror, observed from outside: without it DuckDB's
    // binder refuses 12 of the 22 rules on the all-VARCHAR copy.
    const summary = JSON.parse(run.stdout) as {
      inputs: { rules: { lintErrors: number; excludedRuleIds: string[] }[] };
      perRule: unknown[];
    };
    for (const file of summary.inputs.rules) {
      expect(file.lintErrors).toBe(0);
      expect(file.excludedRuleIds).toEqual([]);
    }
    expect(summary.perRule).toHaveLength(22);
    expect(meaningfulStderr(run.stderr)).not.toContain('warning:');
  });
});

describe('journey 18 — --summary to a file, and URL intake', () => {
  it('writes the summary to a path when given one, leaving stdout empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quac-cli-summary-'));
    try {
      const result = await quac([
        join(TINY, 'people.csv'),
        '--rules',
        join(TINY, 'people_rules.quac.csv'),
        '--out',
        dir,
        '--summary',
        join(dir, 'summary.json'),
        '--quiet',
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      const written = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as {
        summarySchemaVersion: number;
        dataset: { name: string };
      };
      expect(written.summarySchemaVersion).toBe(1);
      expect(written.dataset.name).toBe('people.csv');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('fetches a schema and a rules file over http', async () => {
    // No CORS headers are served — headless intake neither sends nor needs
    // them, which is the point of running this over a bare node:http server.
    let server: FixtureServer | undefined;
    const dir = await mkdtemp(join(tmpdir(), 'quac-cli-url-'));
    try {
      server = await startFixtureServer();
      const result = await quac([
        join(TINY, 'people.csv'),
        '--schema',
        `${server.origin}/tiny/people.schema.json`,
        '--rules',
        `${server.origin}/tiny/people_rules.quac.csv`,
        '--out',
        dir,
        '--summary',
        '-',
      ]);
      expect(meaningfulStderr(result.stderr)).toContain('report written');
      expect(result.code).toBe(0);
      const summary = JSON.parse(result.stdout) as {
        inputs: {
          schema: { files: string[]; root: string | null; index: string | null } | null;
          rules: { name: string; rules: number; lintErrors: number }[];
        };
      };
      // Display paths are relativized for URL sets exactly as in the browser,
      // so the fetch URL is not what comes back out — the proof that the fetch
      // happened is that a run naming NO local schema resolved a root at all,
      // and that its $id (which only the fetched bytes carry) is on the set.
      expect(summary.inputs.schema?.files).toEqual(['people.schema.json']);
      expect(summary.inputs.schema?.root).toBe('people.schema.json');
      expect(summary.inputs.schema?.index).toContain('people.schema.json');
      // The rules file keeps the basename off its URL.
      expect(summary.inputs.rules[0]?.name).toBe('people_rules.quac.csv');
      // And the fetched schema really typed the columns: untyped, DuckDB's
      // binder refuses two of these six rules (V23).
      expect(summary.inputs.rules[0]).toMatchObject({ rules: 6, lintErrors: 0 });
    } finally {
      await server?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('exits 2 when a schema URL does not resolve', async () => {
    let server: FixtureServer | undefined;
    try {
      server = await startFixtureServer();
      const result = await quac([
        join(TINY, 'people.csv'),
        '--schema',
        `${server.origin}/tiny/does-not-exist.json`,
      ]);
      expect(result.code).toBe(2);
      expect(meaningfulStderr(result.stderr)).toContain('Could not fetch the schema');
      // CORS is a browser concept; the advice must never appear headless.
      expect(result.stderr).not.toContain('CORS');
    } finally {
      await server?.close();
    }
  }, 120_000);
});

describe('journey 18 — the package installs and runs', () => {
  it('packs exactly the published files, and the packed binary runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quac-cli-pack-'));
    try {
      // `npm pack` works while private:true. prepack rebuilds dist-cli.
      const { stdout } = await execFileAsync(
        'npm',
        ['pack', '--json', '--pack-destination', dir],
        { cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 },
      );
      // prepack's build output precedes the JSON on stdout (and contains its
      // own brackets), so start at the line that IS the opening bracket.
      const lines = stdout.split('\n');
      const start = lines.findIndex((line) => line.trim() === '[');
      const packed = JSON.parse(lines.slice(start).join('\n')) as {
        filename: string;
        files: { path: string }[];
      }[];
      const entry = packed[0];
      expect(entry).toBeDefined();

      const paths = (entry?.files ?? []).map((f) => f.path).sort();
      // The fixed members, exactly. `publicDir: false` in vite.cli.config.ts is
      // what keeps the web app's 100 MB of duckdb-wasm out of this list.
      expect(paths).toEqual(
        expect.arrayContaining([
          'LICENSE',
          'README.md',
          'dist-cli/index.mjs',
          'dist-cli/quac.mjs',
          'package.json',
          'types/quac.d.ts',
        ]),
      );
      for (const path of paths) {
        expect(path).toMatch(/^(LICENSE|README\.md|package\.json|dist-cli\/.+\.mjs|types\/quac\.d\.ts)$/);
      }

      // Unpack and run the packed bytes — proof the shipped bin is complete.
      // A real `npm install <tgz>` would refetch the native duckdb binding and
      // the SheetJS CDN tarball on every CI run; §9 assigns that clean-env
      // verification to P22's publish check.
      await execFileAsync('tar', ['-xzf', join(dir, entry?.filename ?? ''), '-C', dir]);
      const packedBin = join(dir, 'package', 'dist-cli', 'quac.mjs');
      const shebang = (await readFile(packedBin, 'utf8')).slice(0, 19);
      expect(shebang).toBe('#!/usr/bin/env node');

      // Node resolves bare specifiers from the IMPORTING file, not the cwd, so
      // the unpacked tree needs its dependencies beside it. Symlinking the
      // repo's node_modules stands in for the install: it proves the shipped
      // bytes are complete and correctly externalized without refetching the
      // native duckdb binding and the SheetJS CDN tarball on every CI run.
      await symlink(join(REPO, 'node_modules'), join(dir, 'package', 'node_modules'), 'dir');
      const { stdout: version } = await execFileAsync(process.execPath, [packedBin, '--version']);
      expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
