/**
 * Monotonic run-level progress (view-layer; the pipeline's per-stage
 * {done,total} counters are untouched). Each stage owns a fixed segment of
 * one 0–100 bar, so the duck never teleports backwards when a stage resets
 * its counters or flips between known and unknown totals.
 *
 * Known totals interpolate inside the stage segment with a short glide;
 * unknown totals (total === 0) target just under the segment ceiling with a
 * LONG glide — the CSS transition itself is the asymptotic crawl, no JS
 * ticker, and a retarget resumes from the current computed value.
 *
 * Weights are static: a skipped stage simply reads as a fast stage (no
 * per-run renormalization — ui-design.md §6).
 */
import { PROGRESS_LABELS } from '../../components/duckProgress';
import type { PipelineStage } from '../../../app/store';

export type RunStage = 'prepare' | 'corrections' | 'schema' | 'rules' | 'annotate';

export interface RunProgressView {
  /** Monotonic 0–100 target for the run bar. */
  pct: number;
  /** Transition length for this move (ms). */
  glideMs: number;
  label: string;
}

/** Stage → [from, to) share of the run bar. Rough real-run cost shares. */
export const RUN_SEGMENTS: Readonly<Record<RunStage, { from: number; to: number }>> = {
  prepare: { from: 0, to: 8 },
  corrections: { from: 8, to: 22 },
  schema: { from: 22, to: 55 },
  rules: { from: 55, to: 88 },
  annotate: { from: 88, to: 100 },
};

export const KNOWN_GLIDE_MS = 300;
export const UNKNOWN_GLIDE_MS = 8000;

const isRunStage = (stage: PipelineStage): stage is RunStage => stage in RUN_SEGMENTS;

export interface RunProgressMapper {
  view: (stage: PipelineStage, done: number, total: number) => RunProgressView;
  /** Start of a new run: the bar snaps back to 0. */
  reset: () => void;
}

export function createRunProgressMapper(): RunProgressMapper {
  let prev = 0;
  return {
    view: (stage, done, total) => {
      if (!isRunStage(stage)) {
        return { pct: prev, glideMs: KNOWN_GLIDE_MS, label: 'Running QC' };
      }
      const seg = RUN_SEGMENTS[stage];
      let target: number;
      let glideMs: number;
      if (total > 0) {
        const frac = Math.min(1, Math.max(0, done / total));
        target = seg.from + frac * (seg.to - seg.from);
        glideMs = KNOWN_GLIDE_MS;
      } else {
        // Unknown workload: aim just under the ceiling and let the long
        // transition crawl toward it until the next stage arrives.
        target = seg.to - 0.5;
        glideMs = UNKNOWN_GLIDE_MS;
      }
      prev = Math.max(prev, target);
      return { pct: prev, glideMs, label: PROGRESS_LABELS[stage] };
    },
    reset: () => {
      prev = 0;
    },
  };
}
