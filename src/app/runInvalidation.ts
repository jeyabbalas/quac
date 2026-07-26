/**
 * The one path every EXPLICIT run invalidation routes through (UIX-7):
 * clearing an input — or replacing the dataset — discards the previous run
 * outright (pill dark, panels empty, in-flight run cancelled). Replacing a
 * check input or editing rules in Studio deliberately does NOT come here:
 * the report persists so it can be consulted while iterating.
 *
 * Entry-safe: imports store only. `startRun` (lazy) captures `runEpoch` at
 * start and discards its own late writes when the epoch moved — see
 * runController.ts for the race inventory.
 */
import { createCancelToken } from './store';
import type { AppStore } from './store';

export function invalidateRun(store: AppStore): void {
  store.runEpoch.set(store.runEpoch.get() + 1);
  store.pipeline.get().cancel.cancel(); // best-effort stop for an in-flight run
  store.run.set(null);
  store.runArtifacts.set(null);
  // A PRE-CANCELLED idle token: reportView's completion effect only announces
  // 'QC run complete.' for a non-cancelled token, so collapsing a doomed run's
  // progress surface stays silent; everything else reads idle as idle. The
  // user Cancel button never lands here — its partial-results path keeps a
  // fresh token (runQc.spec pins it).
  const idle = createCancelToken();
  idle.cancel();
  store.pipeline.set({ stage: 'idle', progress: { done: 0, total: 0 }, cancel: idle });
}
