// Node-environment test for the run-level progress mapper: monotonicity,
// static segment weights, known/unknown glide selection, reset semantics,
// and the pinned stage labels it forwards from PROGRESS_LABELS.
import { describe, expect, it } from 'vitest';

import {
  KNOWN_GLIDE_MS,
  RUN_SEGMENTS,
  UNKNOWN_GLIDE_MS,
  createRunProgressMapper,
} from '../../../src/ui/views/report/runProgressModel';

describe('createRunProgressMapper', () => {
  it('interpolates a known-total stage inside its segment with the short glide', () => {
    const mapper = createRunProgressMapper();
    const half = mapper.view('schema', 50, 100);
    expect(half.pct).toBeCloseTo(22 + 0.5 * (55 - 22));
    expect(half.glideMs).toBe(KNOWN_GLIDE_MS);
    expect(half.label).toBe('Validating against the schema');
  });

  it('targets just under the segment ceiling with the long glide when total is unknown', () => {
    const mapper = createRunProgressMapper();
    const v = mapper.view('prepare', 0, 0);
    expect(v.pct).toBe(RUN_SEGMENTS.prepare.to - 0.5);
    expect(v.glideMs).toBe(UNKNOWN_GLIDE_MS);
    expect(v.label).toBe('Preparing tables');
  });

  it('never moves backwards across stage transitions or counter resets', () => {
    const mapper = createRunProgressMapper();
    const ticks: [Parameters<typeof mapper.view>[0], number, number][] = [
      ['prepare', 0, 0], // unknown → 7.5
      ['corrections', 1, 4], // 8 + 0.25*14 = 11.5
      ['corrections', 4, 4], // 22
      ['schema', 0, 100], // stage reset to 0/100 → 22 (not backwards)
      ['schema', 10, 100], // 25.3
      ['schema', 0, 0], // flips to unknown → 54.5
      ['schema', 20, 100], // computed 28.6 < prev → stays 54.5
      ['rules', 1, 22], // 56.5
      ['annotate', 0, 0], // 99.5
    ];
    let prev = -1;
    for (const [stage, done, total] of ticks) {
      const v = mapper.view(stage, done, total);
      expect(v.pct).toBeGreaterThanOrEqual(prev);
      prev = v.pct;
    }
    expect(prev).toBe(RUN_SEGMENTS.annotate.to - 0.5);
  });

  it('clamps done > total to the segment ceiling', () => {
    const mapper = createRunProgressMapper();
    const v = mapper.view('rules', 30, 22);
    expect(v.pct).toBe(RUN_SEGMENTS.rules.to);
  });

  it('reset() starts the next run from zero', () => {
    const mapper = createRunProgressMapper();
    mapper.view('annotate', 1, 1);
    mapper.reset();
    const v = mapper.view('prepare', 1, 2);
    expect(v.pct).toBeCloseTo(4);
  });

  it('keeps the last value and a generic label for non-run stages', () => {
    const mapper = createRunProgressMapper();
    mapper.view('schema', 50, 100);
    const v = mapper.view('done', 0, 0);
    expect(v.pct).toBeCloseTo(38.5);
    expect(v.label).toBe('Running QC');
  });

  it('covers 0–100 with contiguous static segments', () => {
    const order = ['prepare', 'corrections', 'schema', 'rules', 'annotate'] as const;
    let edge = 0;
    for (const stage of order) {
      expect(RUN_SEGMENTS[stage].from).toBe(edge);
      expect(RUN_SEGMENTS[stage].to).toBeGreaterThan(edge);
      edge = RUN_SEGMENTS[stage].to;
    }
    expect(edge).toBe(100);
  });
});
