/**
 * AppState per architecture.md §7 — state only, no behavior. Later phases fill
 * these signals: P05+ drive the slots, P14 drives pipeline/run.
 * Signals hold immutable snapshots: always `set()` a fresh object.
 *
 * P14 additions beyond §7 (recorded in phase-14 Deferred notes): runArtifacts
 * (the heavy per-run FlagStore/stats object the Report panels read) and
 * applyCorrections (the run-panel toggle; assess-only when false).
 */
import { signal } from './signals';
import type { Signal } from './signals';
import type { RunArtifacts } from '../core/pipeline';

export type SlotId = 'data' | 'schema' | 'rules';

export type SlotStatus = 'empty' | 'loading' | 'valid' | 'warning' | 'error';

export interface SlotState {
  status: SlotStatus;
  /** Human-readable one-liner for the slot card; `''` when empty. */
  detail: string;
}

export const PIPELINE_STAGES = [
  'idle',
  'prepare',
  'corrections',
  'schema',
  'rules',
  'annotate',
  'done',
  'cancelled',
  'failed',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface PipelineProgress {
  done: number;
  total: number;
}

export interface CancelToken {
  readonly cancelled: boolean;
  cancel: () => void;
}

/** Cooperative cancellation flag; checked at chunk/rule boundaries (P14). */
export function createCancelToken(): CancelToken {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel: () => {
      cancelled = true;
    },
  };
}

export interface PipelineState {
  stage: PipelineStage;
  progress: PipelineProgress;
  cancel: CancelToken;
}

const RUNNING_STAGES: ReadonlySet<PipelineStage> = new Set([
  'prepare',
  'corrections',
  'schema',
  'rules',
  'annotate',
]);

/** True while a QC run is in flight — the one shared predicate (run button
 *  gating, progress surfaces, run-aware panel empties). */
export function isRunningStage(stage: PipelineStage): boolean {
  return RUNNING_STAGES.has(stage);
}

export interface FlagsSummary {
  errors: number;
  warnings: number;
  infos: number;
  corrections: number;
}

export interface RunSummary {
  flagsSummary: FlagsSummary;
  /** Epoch ms of the last completed run. */
  lastRunAt: number;
  datasetName: string;
}

/**
 * The ingested dataset (P05+). Source bytes stay in memory for the session
 * (re-ingest on schema change) and are what the P19b write-through persists
 * to IndexedDB — restore replays them through the real ingest path
 * (ingestion.md §6).
 */
export interface DatasetSession {
  name: string;
  format: 'csv' | 'tsv' | 'json' | 'xlsx' | 'parquet';
  byteSize: number;
  rowCount: number;
  columnCount: number;
  /** Final (sanitized) column names, `__row__` excluded, in file order. */
  columns: readonly string[];
  renames: readonly { from: string; to: string; reason: string }[];
  parseWarnings: readonly string[];
  /** Original source bytes, kept for the session (reruns / schema change). */
  source: Blob;
  sheetName?: string;
  /** URL it was fetched from (P16 share provenance); absent for uploads. */
  sourceUrl?: string;
  /** Bumped on every (re)ingest — the Report view rebuilds when it changes. */
  generation: number;
}

export interface AppStore {
  slots: Readonly<Record<SlotId, Signal<SlotState>>>;
  dataset: Signal<DatasetSession | null>;
  pipeline: Signal<PipelineState>;
  run: Signal<RunSummary | null>;
  /** Heavy per-run artifacts (FlagStore + stats) — the Report panels' source. */
  runArtifacts: Signal<RunArtifacts | null>;
  /**
   * Bumped by every EXPLICIT run invalidation (UIX-7 `invalidateRun`: input
   * clears, dataset replacement). `startRun` captures it at start; a moved
   * epoch discards the run's late writes (present/progress/commit), so a
   * doomed run can never repaint state a clear just emptied. Lives here, not
   * in runController — that module is lazy (Run-click import) and a counter
   * there would be unreachable from the always-loaded clear helpers.
   */
  runEpoch: Signal<number>;
  /** "Apply corrections" run toggle (qc-rules-engine.md §2); false = assess-only. */
  applyCorrections: Signal<boolean>;
  /** True once the boot flow loaded any slot from a URL/config= link (P16)
   *  or seeded it from the stored session (P19b restore — set optimistically
   *  from the presence hint before the async IDB read, so the first-run hero
   *  cannot flash, and dropped again if the hint lied). */
  preconfigured: Signal<boolean>;
}

const emptySlot = (): SlotState => ({ status: 'empty', detail: '' });

export function createAppStore(): AppStore {
  return {
    slots: {
      data: signal(emptySlot()),
      schema: signal(emptySlot()),
      rules: signal(emptySlot()),
    },
    dataset: signal<DatasetSession | null>(null),
    pipeline: signal<PipelineState>({
      stage: 'idle',
      progress: { done: 0, total: 0 },
      cancel: createCancelToken(),
    }),
    run: signal<RunSummary | null>(null),
    runArtifacts: signal<RunArtifacts | null>(null),
    runEpoch: signal(0),
    applyCorrections: signal(true),
    preconfigured: signal(false),
  };
}
