/**
 * AppState per architecture.md §7 — state only, no behavior. Later phases fill
 * these signals: P05+ drive the slots, P14 drives pipeline/run, P16 shareables.
 * Signals hold immutable snapshots: always `set()` a fresh object.
 */
import { signal } from './signals';
import type { Signal } from './signals';

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

/** Per artifact: an upload (never shareable) or the URL it was fetched from. */
export type ArtifactProvenance = 'upload' | { url: string };

/**
 * The ingested dataset (P05+). Source bytes stay in memory for the session
 * only (re-ingest on schema change; never persisted — ingestion.md §6).
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
  /** Bumped on every (re)ingest — the Report view rebuilds when it changes. */
  generation: number;
}

export interface AppStore {
  slots: Readonly<Record<SlotId, Signal<SlotState>>>;
  dataset: Signal<DatasetSession | null>;
  pipeline: Signal<PipelineState>;
  run: Signal<RunSummary | null>;
  shareables: Signal<readonly ArtifactProvenance[]>;
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
    shareables: signal<readonly ArtifactProvenance[]>([]),
  };
}
