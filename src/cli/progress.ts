/**
 * Everything the CLI says to a human (headless.md §5).
 *
 * ONE rule governs the whole file: **stdout is data, stderr is human.** stdout
 * carries the summary JSON and nothing else, so `quac … --summary - | jq` is
 * always safe; stage lines, lint findings, warnings and the closing report line
 * all go to stderr. Progress rewrites its line in place only when stderr is a
 * TTY; piped, it prints one line per stage transition. No spinners, ever —
 * they are noise in a CI log.
 *
 * `--quiet` silences progress and stage lines. It never silences a warning or
 * an error: a run whose rules were half-excluded must say so however quietly
 * it was asked to work.
 */
import { RULE_STATUS_LABELS, ruleStatusMessage } from '../core/report/reportModel';
import type { CrossCheck, PertinenceSuspect } from '../core/pertinence';
import type { RunProgress, RunStage } from '../core/pipeline';
import type { RuleFileLintResult, RuleRunStat } from '../core/rules/types';
import type { QuacCliError } from '../headless/errors';
import type { RunQuacResult } from '../headless/run';

/**
 * Mirrors `PROGRESS_LABELS` (`ui/components/duckProgress.ts`) for the five run
 * stages. Copied rather than imported: that module builds DOM, and the CLI
 * must not drag a browser component into a Node bundle.
 */
const STAGE_LABELS: Record<RunStage, string> = {
  prepare: 'Preparing tables',
  corrections: 'Applying corrections',
  schema: 'Validating against the schema',
  rules: 'Running QC rules',
  annotate: 'Painting the report',
};

/** The §E.5 accusation, verbatim from the Load view's `previewModel.ts`. */
const SUSPECT_COPY: Record<PertinenceSuspect, string> = {
  dataset: "The dataset doesn't look like it belongs",
  schema: "The JSON Schema doesn't look like it belongs",
  rules: "The QC rules don't look like they belong",
};

export interface ReporterOptions {
  quiet: boolean;
  /** Injected so tests can drive both the TTY and the piped shape. */
  isTTY: boolean;
  write: (text: string) => void;
}

export interface Reporter {
  onProgress: (p: RunProgress) => void;
  note: (line: string) => void;
  warn: (line: string, detail?: readonly string[]) => void;
  error: (line: string, detail?: readonly string[]) => void;
  /** Close any in-place progress line before other output lands on it. */
  endProgress: () => void;
}

export function createReporter(options: ReporterOptions): Reporter {
  let lastStage: RunStage | null = null;
  let openLine = false;

  const clear = (): void => {
    if (!openLine) return;
    // \r + erase-to-end-of-line: leaves the cursor at column 0 on a clean row.
    options.write('\r\x1b[2K');
    openLine = false;
  };

  const emit = (line: string): void => {
    clear();
    options.write(`${line}\n`);
  };

  return {
    onProgress(p) {
      if (options.quiet) return;
      const label = STAGE_LABELS[p.stage];
      if (options.isTTY) {
        clear();
        options.write(`\r${label}${countOf(p)}`);
        openLine = true;
        return;
      }
      // Piped: one line per transition, so a CI log stays readable.
      if (p.stage === lastStage) return;
      lastStage = p.stage;
      options.write(`${label}…\n`);
    },
    note(line) {
      if (options.quiet) return;
      emit(line);
    },
    warn(line, detail) {
      emit(`warning: ${line}`);
      for (const d of detail ?? []) emit(`  ${d}`);
    },
    error(line, detail) {
      emit(`error: ${line}`);
      for (const d of detail ?? []) emit(`  ${d}`);
    },
    endProgress: clear,
  };
}

/** `12,340 rows · 87 findings` — only what the stage actually knows. */
function countOf(p: RunProgress): string {
  const parts: string[] = [];
  if (p.total > 0) parts.push(`${format(p.done)}/${format(p.total)}`);
  if (p.detail !== undefined && p.detail !== '') parts.push(p.detail);
  if (p.flagCount > 0) parts.push(`${format(p.flagCount)} findings`);
  return parts.length === 0 ? '…' : ` — ${parts.join(' · ')}`;
}

const format = (n: number): string => n.toLocaleString('en-US');

/**
 * Lint findings, before the run. One summary line per file, then one warning
 * per excluded rule carrying `issue.message` — the plain-language diagnosis
 * (UIX-16). NEVER `issue.detail`: that is the raw binder text, kept for depth
 * in the app's disclosure, and a pipeline log is not the place to meet
 * `No function matches '*(VARCHAR, INTEGER_LITERAL)'`.
 */
export function reportLint(reporter: Reporter, results: readonly RuleFileLintResult[]): void {
  for (const file of results) {
    const errors = file.issues.filter((i) => i.severity === 'error');
    reporter.note(
      `${file.file}: ${plural(file.ruleCount, 'rule')}, ` +
        `${format(file.executable)} executable` +
        (errors.length === 0 ? '' : `, ${plural(errors.length, 'lint error')}`),
    );
    for (const issue of errors) {
      reporter.warn(
        issue.ruleId === undefined ? issue.message : `${issue.ruleId}: ${issue.message}`,
      );
    }
  }
}

/**
 * Everything worth saying about a completed run that is not the report path.
 * All of it is app parity: the surfaces the Load cards and report panels show,
 * said once, in the order a reader wants them.
 */
export function reportRunWarnings(reporter: Reporter, result: RunQuacResult): void {
  const { artifacts, inputs, model } = result;

  if (inputs.dataset.sizeVerdict === 'warn') {
    reporter.warn(
      `${inputs.dataset.name} is large — the run may be slow. Parquet is much smaller than CSV.`,
    );
  }

  // A schema index matched only by file name is a guess that happened to work.
  for (const err of inputs.schema?.set.errors ?? []) {
    if (err.code === 'W_INDEX_BASENAME') reporter.warn(err.message);
  }

  for (const stat of artifacts.rules?.perRule ?? []) {
    if (stat.status === 'broken') reporter.warn(`${stat.ruleId}: ${ruleStatusMessage(stat)}`);
  }
  const skipped = countSkipped(artifacts.rules?.perRule ?? []);
  for (const [status, count] of skipped) {
    reporter.note(`${plural(count, 'rule')} ${RULE_STATUS_LABELS[status]}.`);
  }

  // Non-prepare stage errors are not fatal — the app presents partials, and so
  // do we; they are surfaced rather than swallowed (§6).
  for (const stage of artifacts.stageErrors) {
    reporter.warn(`the ${stage.stage} stage did not finish: ${stage.message}`);
  }

  if (model.missingVariables.length > 0) {
    reporter.note(
      `${plural(model.missingVariables.length, 'schema variable')} missing from the dataset ` +
        '(listed on the report’s Missing Variables sheet).',
    );
  }

  const suspect = pertinenceWarning(inputs.pertinence);
  if (suspect !== null) reporter.warn(suspect);
}

/**
 * §E.5 names a suspect only when exactly two of the three edges are bad and
 * they share exactly one vertex. One bad edge names a disagreeing PAIR with no
 * third opinion; three means everything is foreign to everything. So this
 * prints when — and only when — there is somebody to name.
 */
export function pertinenceWarning(check: CrossCheck): string | null {
  if (check.suspect === null) return null;
  return `${SUSPECT_COPY[check.suspect]} with the other inputs — check you loaded the right files.`;
}

function countSkipped(stats: readonly RuleRunStat[]): [RuleRunStat['status'], number][] {
  const counts = new Map<RuleRunStat['status'], number>();
  for (const stat of stats) {
    if (stat.status === 'ok' || stat.status === 'broken') continue;
    counts.set(stat.status, (counts.get(stat.status) ?? 0) + 1);
  }
  return [...counts.entries()];
}

/**
 * The closing line: where the report went, and what is in it. `--quiet` takes
 * it — every number in it is in the summary JSON, which is what a quiet run
 * asked for.
 */
export function reportWritten(reporter: Reporter, result: RunQuacResult): void {
  const flags = result.artifacts.flagStore.summary(result.artifacts.rowsTotal);
  const { error, warning, info } = flags.severityTotals;
  reporter.note(
    `quac: report written → ${result.outPath}\n` +
      `      ${format(error)} error · ${format(warning)} warning · ${format(info)} info ` +
      `across ${plural(flags.rowsAffected, 'row')} of ${format(result.inputs.dataset.rows)}` +
      (flags.truncated ? ' (flag cap reached — per-rule counts are still exact)' : ''),
  );
}

/** How the CLI renders a typed refusal: the message, then its facts. */
export function reportError(reporter: Reporter, err: QuacCliError): void {
  reporter.error(err.message, err.detail);
}

function plural(n: number, noun: string): string {
  return `${format(n)} ${noun}${n === 1 ? '' : 's'}`;
}
