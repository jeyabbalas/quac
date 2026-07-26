/**
 * The ONE run-readiness predicate (UIX-6). The Run QC button (Load view) and
 * `startRun` (run controller) both consume this assessment, so the button can
 * never enable a run that startRun would refuse, and vice versa. It reads the
 * REAL run inputs — `schemaState`'s digest and the lint-filtered executable
 * rule files — not the coarse slot statuses, which approximate them (a schema
 * awaiting its index pick shows Warning but has no digest; a structurally
 * broken rules file shows Error while its siblings still run).
 *
 * Contract (ingestion.md §1): a run needs the Dataset plus at least one usable
 * source of checks — JSON Schema or QC rules. A Warning dataset is runnable;
 * a slot error with a stale `store.dataset` is not (the failed re-ingest wins).
 *
 * Entry-chunk discipline: imports here are stores, signals, and the pure
 * `executable.ts` predicate — no lint/engine/sql graph.
 */
import { isRunningStage } from './store';
import { executableRuleFile } from '../core/rules/executable';
import { rulesState } from '../core/rules/rules-store';
import { columnDigest } from '../core/schema/column-meta';
import { needsRootChoice, schemaState } from '../core/schema/schema-store';
import type { AppStore } from './store';
import type { RuleFile } from '../core/rules/types';
import type { SchemaRunInput } from '../core/pipeline';

export type ReadinessCode =
  | 'running'
  | 'data-loading'
  | 'no-dataset'
  | 'dataset-error'
  | 'schema-index-pending'
  | 'schema-unusable'
  | 'rules-blocked'
  | 'no-checks';

export interface RunReadiness {
  ready: boolean;
  /** Null when ready. */
  code: ReadinessCode | null;
  /** User-facing sentence for the run bar / refusal toast; `''` when ready. */
  reason: string;
  hint?: string;
  /** Non-blocking: the run can start, but a loaded input won't participate. */
  note?: string;
  /** The exact schema input startRun hands the pipeline (null = none). */
  schema: SchemaRunInput | null;
  /** The exact lint-filtered rule files startRun hands the pipeline. */
  ruleFiles: RuleFile[];
}

const notReady = (
  code: ReadinessCode,
  reason: string,
  hint?: string,
): RunReadiness => ({
  ready: false,
  code,
  reason,
  ...(hint === undefined ? {} : { hint }),
  schema: null,
  ruleFiles: [],
});

/**
 * Assess whether a QC run can start right now, and with which inputs.
 * Reads signals, never writes — safe inside effects (all five signals are
 * read unconditionally up front, so an effect stays subscribed to each of
 * them no matter which branch returns).
 */
export function assessRunReadiness(store: AppStore): RunReadiness {
  const pipeline = store.pipeline.get();
  const dataSlot = store.slots.data.get();
  const dataset = store.dataset.get();
  const schemaSlot = schemaState.get();
  const rules = rulesState.get();

  // ---- schema leg: only a resolved, digestible set participates ----
  const set = schemaSlot.phase === 'ready' ? schemaSlot.set : null;
  const schema: SchemaRunInput | null = (() => {
    if (set === null) return null;
    const digest = columnDigest(set);
    return digest === null ? null : { set, digest };
  })();
  // Index-pending only describes a set the index choice would actually fix —
  // with fatal load errors the digest stays null no matter what is chosen.
  const schemaFatal = set?.errors.some((e) => e.severity === 'fatal') ?? false;
  const indexPending = set !== null && !schemaFatal && needsRootChoice(set);

  // ---- rules leg: lint-error rows excluded, structurally broken files out ----
  const resultByFile = new Map(rules.results.map((r) => [r.file, r]));
  const ruleFiles: RuleFile[] = [];
  for (const parsed of rules.files) {
    const result = resultByFile.get(parsed.file.name);
    if (result === undefined) continue;
    const file = executableRuleFile(parsed, result);
    if (file !== null) ruleFiles.push(file);
  }

  if (isRunningStage(pipeline.stage)) {
    return notReady('running', 'A QC run is in progress…');
  }
  if (dataSlot.status === 'loading') {
    return notReady('data-loading', 'The dataset is still loading…');
  }
  if (dataset === null) {
    return notReady('no-dataset', 'Load a dataset to run QC.');
  }
  if (dataSlot.status === 'error') {
    // A failed (re)ingest leaves `store.dataset` holding the previous good
    // session — running would silently QC stale data.
    return notReady(
      'dataset-error',
      'The dataset failed to load — fix it or load another to run QC.',
    );
  }

  if (schema !== null || ruleFiles.length > 0) {
    const idleParts: string[] = [];
    if (schema === null && set !== null) {
      idleParts.push(
        indexPending
          ? "The JSON Schema is waiting on an index choice and won't be checked this run."
          : "The JSON Schema has blocking errors and won't be checked this run.",
      );
    }
    if (ruleFiles.length === 0 && rules.files.length > 0) {
      idleParts.push("The QC rules all have blocking lint errors and won't run this time.");
    }
    return {
      ready: true,
      code: null,
      reason: '',
      ...(idleParts.length === 0 ? {} : { note: idleParts.join(' ') }),
      schema,
      ruleFiles,
    };
  }

  // Neither leg is usable — say why, most actionable cause first.
  if (indexPending) {
    return notReady(
      'schema-index-pending',
      'Choose the index schema on the JSON Schema card to run QC.',
      'Or load a QC rules file — either input is enough to run.',
    );
  }
  if (set !== null) {
    return notReady(
      'schema-unusable',
      'The JSON Schema has errors that block validation — fix it or load a QC rules file to run QC.',
    );
  }
  if (rules.files.length > 0) {
    return notReady(
      'rules-blocked',
      'Every QC rules file has blocking lint errors — fix them or load a JSON Schema to run QC.',
    );
  }
  return notReady('no-checks', 'Load a JSON Schema or a QC rules file to run QC.');
}
