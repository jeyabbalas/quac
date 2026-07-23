import { describe, expect, it } from 'vitest';

import { computed, effect, signal } from '../../../src/app/signals';

describe('signal', () => {
  it('returns the initial value and updates on set', () => {
    const s = signal(1);
    expect(s.get()).toBe(1);
    s.set(2);
    expect(s.get()).toBe(2);
  });

  it('notifies subscribers with the new value on set, not at subscribe time', () => {
    const s = signal('a');
    const seen: string[] = [];
    s.subscribe((v) => seen.push(v));
    expect(seen).toEqual([]);
    s.set('b');
    expect(seen).toEqual(['b']);
  });

  it('skips notification when the value is Object.is-equal (including NaN)', () => {
    const s = signal<number>(0);
    let calls = 0;
    s.subscribe(() => {
      calls += 1;
    });
    s.set(0);
    expect(calls).toBe(0);
    s.set(NaN);
    expect(calls).toBe(1);
    s.set(NaN); // Object.is(NaN, NaN) is true — no notify
    expect(calls).toBe(1);
  });

  it('unsubscribe stops notifications without affecting other subscribers', () => {
    const s = signal(0);
    const a: number[] = [];
    const b: number[] = [];
    const unsubA = s.subscribe((v) => a.push(v));
    s.subscribe((v) => b.push(v));
    s.set(1);
    unsubA();
    s.set(2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });

  it('notifies multiple subscribers in subscription order', () => {
    const s = signal(0);
    const order: string[] = [];
    s.subscribe(() => order.push('first'));
    s.subscribe(() => order.push('second'));
    s.set(1);
    expect(order).toEqual(['first', 'second']);
  });

  it('converges when a subscriber re-entrantly clamps the value', () => {
    const s = signal(0);
    const seen: number[] = [];
    s.subscribe((v) => {
      seen.push(v);
      if (v > 10) s.set(10);
    });
    s.set(50);
    expect(s.get()).toBe(10);
    expect(seen).toEqual([50, 10]);
  });
});

describe('effect', () => {
  it('runs exactly once, synchronously, at creation', () => {
    let runs = 0;
    effect(() => {
      runs += 1;
    });
    expect(runs).toBe(1);
  });

  it('re-runs when a dependency changes and observes the latest values', () => {
    const a = signal(1);
    const b = signal(10);
    const sums: number[] = [];
    effect(() => {
      sums.push(a.get() + b.get());
    });
    a.set(2);
    b.set(20);
    expect(sums).toEqual([11, 12, 22]);
  });

  it('re-tracks dependencies each run: the branch not read stops triggering', () => {
    const flag = signal(true);
    const a = signal('a0');
    const b = signal('b0');
    let runs = 0;
    effect(() => {
      runs += 1;
      if (flag.get()) a.get();
      else b.get();
    });
    expect(runs).toBe(1);
    flag.set(false); // now reads b, not a
    expect(runs).toBe(2);
    a.set('a1'); // stale branch — must NOT re-run
    expect(runs).toBe(2);
    b.set('b1');
    expect(runs).toBe(3);
  });

  it('dispose stops re-runs and is safe to call twice', () => {
    const s = signal(0);
    let runs = 0;
    const dispose = effect(() => {
      runs += 1;
      s.get();
    });
    s.set(1);
    expect(runs).toBe(2);
    dispose();
    dispose();
    s.set(2);
    expect(runs).toBe(2);
  });

  it('nested effects track independently of their parent', () => {
    const a = signal(0);
    const b = signal(0);
    let outerRuns = 0;
    let innerRuns = 0;
    effect(() => {
      outerRuns += 1;
      a.get();
      if (outerRuns === 1) {
        effect(() => {
          innerRuns += 1;
          b.get();
        });
      }
    });
    expect([outerRuns, innerRuns]).toEqual([1, 1]);
    b.set(1); // inner dep — outer must not re-run
    expect([outerRuns, innerRuns]).toEqual([1, 2]);
    a.set(1); // outer dep — inner must not re-run
    expect([outerRuns, innerRuns]).toEqual([2, 2]);
  });
});

describe('computed', () => {
  it('computes eagerly and recomputes when a dependency changes', () => {
    const a = signal(2);
    const doubled = computed(() => a.get() * 2);
    expect(doubled.get()).toBe(4);
    a.set(5);
    expect(doubled.get()).toBe(10);
  });

  it('supports chains, notifying downstream subscribers once per source change', () => {
    const a = signal(1);
    const plusOne = computed(() => a.get() + 1);
    const doubled = computed(() => plusOne.get() * 2);
    const seen: number[] = [];
    doubled.subscribe((v) => seen.push(v));
    expect(doubled.get()).toBe(4);
    a.set(3);
    expect(doubled.get()).toBe(8);
    expect(seen).toEqual([8]);
  });

  it('does not notify subscribers when the computed result is unchanged', () => {
    const a = signal(1);
    const sign = computed(() => Math.sign(a.get()));
    let calls = 0;
    sign.subscribe(() => {
      calls += 1;
    });
    a.set(2); // sign stays 1
    expect(calls).toBe(0);
    a.set(-5);
    expect(calls).toBe(1);
    expect(sign.get()).toBe(-1);
  });
});
