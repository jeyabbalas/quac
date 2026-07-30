/**
 * The `quac` binary (headless.md §5/§6). This is the ONLY file allowed to end
 * the process: everything beneath it throws or returns, so the whole pipeline
 * stays callable as a library.
 *
 * Exit codes are a closed set scripts may depend on:
 *
 *   0  report written        3  schema-set error
 *   1  usage error           4  run failure
 *   2  input/ingest error    5  report or summary write failure
 *   6  --fail-on threshold met — the report AND summary were written first
 *   130 SIGINT
 */
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { APP_VERSION } from '../app/version';
import { IngestError } from '../core/ingest/errors';
import { QuacCliError } from '../headless/errors';
import { runQuac } from '../headless/run';
import { USAGE, parseCliArgs } from './args';
import {
  createReporter,
  reportError,
  reportLint,
  reportRunWarnings,
  reportWritten,
} from './progress';
import { buildSummary } from './summary';
import type { FailOn, ParsedArgs } from './args';
import type { QuacErrorKind } from '../headless/errors';
import type { RunQuacResult } from '../headless/run';
import type { Reporter } from './progress';

/** §6, closed. `run` also absorbs anything unexpected — see `codeFor`. */
const EXIT: Record<QuacErrorKind, number> = {
  usage: 1,
  input: 2,
  schema: 3,
  run: 4,
  report: 5,
};
const EXIT_FAIL_ON = 6;
const EXIT_INTERRUPTED = 130;

/** Below 20 nothing here works; below 24 you are off the declared engines. */
const NODE_HARD_FLOOR = 20;
const NODE_DECLARED_FLOOR = 24;

export async function main(argv: readonly string[]): Promise<number> {
  const write = (text: string): void => void process.stderr.write(text);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < NODE_HARD_FLOOR) {
    write(
      `error: quac needs Node ${String(NODE_HARD_FLOOR)} or newer — this is Node ${process.versions.node}.\n`,
    );
    return EXIT.usage;
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof QuacCliError) {
      reportError(createReporter({ quiet: false, isTTY: false, write }), err);
      return EXIT[err.kind];
    }
    throw err;
  }

  if (parsed.kind === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${APP_VERSION}\n`);
    return 0;
  }

  const args = parsed.args;
  const reporter = createReporter({
    quiet: args.quiet,
    isTTY: process.stderr.isTTY,
    write,
  });

  if (nodeMajor < NODE_DECLARED_FLOOR) {
    reporter.warn(
      `quac is tested on Node ${String(NODE_DECLARED_FLOOR)} and newer — this is Node ${process.versions.node}.`,
    );
  }

  // SIGINT is cooperative: abort the pipeline, then let the promise settle so
  // the bridge's `finally` closes DuckDB and removes its temp directory. A
  // bare process.exit here would leak both.
  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  let result: RunQuacResult;
  try {
    result = await runQuac({
      dataset: args.dataset,
      schema: args.schema,
      rules: args.rules,
      ...(args.index === undefined ? {} : { index: args.index }),
      ...(args.sheet === undefined ? {} : { sheet: args.sheet }),
      ...(args.out === undefined ? {} : { out: args.out }),
      applyCorrections: args.applyCorrections,
      signal: controller.signal,
      onProgress: reporter.onProgress,
    });
  } catch (err) {
    reporter.endProgress();
    if (controller.signal.aborted) {
      reporter.warn('interrupted — no report was written.');
      return EXIT_INTERRUPTED;
    }
    return reportFailure(reporter, err);
  } finally {
    process.off('SIGINT', onSigint);
  }

  reporter.endProgress();
  reportLint(reporter, result.inputs.rules);
  reportRunWarnings(reporter, result);
  reportWritten(reporter, result);

  const exitCode = failOnCode(args.failOn, result);
  if (args.summary !== undefined) {
    try {
      await writeSummary(args.summary, result, exitCode);
    } catch (err) {
      reporter.error(`Could not write the summary to '${args.summary}'.`, [messageOf(err)]);
      return EXIT.report;
    }
  }
  return exitCode;
}

/**
 * The summary reports the exit code the run is ABOUT to produce — including 6,
 * which is why the `--fail-on` verdict is computed before the write rather
 * than after. Writing it is also why 6 never means "no report": both files are
 * on disk before the process ends.
 */
async function writeSummary(
  target: string,
  result: RunQuacResult,
  exitCode: number,
): Promise<void> {
  const json = JSON.stringify(
    buildSummary(result, {
      quacVersion: APP_VERSION,
      exitCode,
      generatedAt: new Date().toISOString(),
    }),
    null,
    2,
  );
  if (target === '-') {
    process.stdout.write(`${json}\n`);
    return;
  }
  await writeFile(target, `${json}\n`, 'utf8');
}

function failOnCode(failOn: FailOn, result: RunQuacResult): number {
  if (failOn === 'none') return 0;
  const { error, warning } = result.artifacts.flagStore.summary().severityTotals;
  const hit = failOn === 'error' ? error > 0 : error + warning > 0;
  return hit ? EXIT_FAIL_ON : 0;
}

/**
 * Typed refusals map by kind; `IngestError` is the one untyped failure with a
 * definite home (§6's row 2 — unreadable, unsupported or oversize input).
 * Everything else is exit 4, the "it did not run" bucket, and prints whatever
 * the thrower said so a bug report has something to quote.
 */
function reportFailure(reporter: Reporter, err: unknown): number {
  if (err instanceof QuacCliError) {
    reportError(reporter, err);
    return EXIT[err.kind];
  }
  if (err instanceof IngestError) {
    reporter.error(err.message, err.hint === undefined ? [] : [err.hint]);
    return EXIT.input;
  }
  reporter.error(messageOf(err));
  return EXIT.run;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The bin entry. `process.exitCode` rather than `process.exit()` so pending
// stdout/stderr writes flush before the process ends.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`error: ${messageOf(err)}\n`);
    process.exitCode = EXIT.run;
  });
