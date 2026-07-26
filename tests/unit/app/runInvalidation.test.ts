// UIX-7: invalidateRun is the one path every explicit input clear (and the
// dataset-replacement effect) routes through. Contract: bump the epoch, cancel
// the in-flight token, null run+artifacts, and idle the pipeline behind a
// PRE-CANCELLED token — that last detail keeps reportView's 'QC run complete.'
// announcement silent when a doomed run's progress surface collapses.
// (startRun's own epoch guards drag the engine graph — e2e journeys pin them.)
import { describe, expect, it } from 'vitest';
import { invalidateRun } from '../../../src/app/runInvalidation';
import { createAppStore } from '../../../src/app/store';
import type { RunArtifacts } from '../../../src/core/pipeline';

describe('invalidateRun', () => {
  it('bumps the epoch every call', () => {
    const store = createAppStore();
    expect(store.runEpoch.get()).toBe(0);
    invalidateRun(store);
    invalidateRun(store);
    expect(store.runEpoch.get()).toBe(2);
  });

  it('cancels the in-flight token and idles behind a pre-cancelled one', () => {
    const store = createAppStore();
    const inFlight = store.pipeline.get().cancel;
    store.pipeline.set({ stage: 'rules', progress: { done: 3, total: 9 }, cancel: inFlight });
    expect(inFlight.cancelled).toBe(false);
    invalidateRun(store);
    expect(inFlight.cancelled).toBe(true);
    const pipeline = store.pipeline.get();
    expect(pipeline.stage).toBe('idle');
    expect(pipeline.progress).toEqual({ done: 0, total: 0 });
    expect(pipeline.cancel).not.toBe(inFlight);
    expect(pipeline.cancel.cancelled).toBe(true);
  });

  it('nulls the run summary and artifacts', () => {
    const store = createAppStore();
    store.run.set({
      flagsSummary: { errors: 1, warnings: 2, infos: 3, corrections: 0 },
      lastRunAt: 12345,
      datasetName: 'people.csv',
    });
    store.runArtifacts.set({} as RunArtifacts);
    invalidateRun(store);
    expect(store.run.get()).toBeNull();
    expect(store.runArtifacts.get()).toBeNull();
  });

  it('repeated calls stay stable — state identical, epoch still counting', () => {
    const store = createAppStore();
    invalidateRun(store);
    const afterFirst = store.pipeline.get();
    invalidateRun(store);
    expect(store.runEpoch.get()).toBe(2);
    expect(store.run.get()).toBeNull();
    expect(store.runArtifacts.get()).toBeNull();
    const afterSecond = store.pipeline.get();
    expect(afterSecond.stage).toBe('idle');
    expect(afterSecond.cancel.cancelled).toBe(true);
    expect(afterSecond).not.toBe(afterFirst); // fresh snapshot each time
  });
});
