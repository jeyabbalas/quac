/**
 * Typed failures for the headless runtime (headless.md §4/§6).
 *
 * `runQuac` never calls `process.exit` — it throws these, and P21's `main()`
 * maps `kind` onto the closed exit-code set scripts may depend on:
 *
 *   usage  → 1   bad invocation: no usable check source, an input form we
 *                do not accept
 *   input  → 2   the dataset or a rules file could not be read or ingested
 *   schema → 3   the schema set is unusable: fatal load errors, or a root
 *                that stayed ambiguous
 *   run    → 4   the run could not execute (prepare failed, engine init died)
 *   report → 5   the report could not be built or written
 *
 * `detail` carries the lines the CLI prints under the message — a workbook's
 * sheet names, a set's root candidates — so the copy lives in P21 and the
 * facts live here.
 */
export type QuacErrorKind = 'usage' | 'input' | 'schema' | 'run' | 'report';

export class QuacCliError extends Error {
  readonly kind: QuacErrorKind;
  readonly detail: readonly string[];

  constructor(
    kind: QuacErrorKind,
    message: string,
    options: { detail?: readonly string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'QuacCliError';
    this.kind = kind;
    this.detail = options.detail ?? [];
  }
}
