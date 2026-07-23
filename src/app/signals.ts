/**
 * Minimal push-based reactive signals. Zero dependencies.
 *
 * - `signal(v)` — readable/writable value; `set()` skips `Object.is`-equal values.
 * - `computed(fn)` — derived read-only signal, recomputed eagerly when its
 *   dependencies change, result-deduped; lives for the app lifetime (no dispose).
 * - `effect(fn)` — runs immediately, re-runs when any signal read during the last
 *   run changes; dependencies are re-tracked on every run; returns a dispose.
 *
 * Limits, fine at app scale: no batching (a diamond-shaped graph may re-run an
 * effect once per intermediate update); writes inside listeners must converge
 * (the equality skip terminates clamp-style loops).
 */

interface Subscriber {
  notify: () => void;
  deps: Set<Set<Subscriber>>;
}

let active: Subscriber | null = null;

export interface ReadonlySignal<T> {
  get: () => T;
  /** Not called at subscribe time; fires on each change. Returns unsubscribe. */
  subscribe: (fn: (value: T) => void) => () => void;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set: (value: T) => void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subs = new Set<Subscriber>();
  return {
    get: () => {
      if (active) {
        subs.add(active);
        active.deps.add(subs);
      }
      return value;
    },
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const sub of [...subs]) sub.notify(); // snapshot: listeners may (un)subscribe mid-notify
    },
    subscribe: (fn) => {
      const sub: Subscriber = {
        notify: () => {
          fn(value);
        },
        deps: new Set(),
      };
      subs.add(sub);
      return () => {
        subs.delete(sub);
      };
    },
  };
}

export function effect(fn: () => void): () => void {
  const sub: Subscriber = { notify: run, deps: new Set() };
  function run(): void {
    unlink(sub); // drop stale links so branches not read this run stop triggering
    const prev = active;
    active = sub;
    try {
      fn();
    } finally {
      active = prev;
    }
  }
  run();
  return () => {
    unlink(sub);
  };
}

function unlink(sub: Subscriber): void {
  for (const depSubs of sub.deps) depSubs.delete(sub);
  sub.deps.clear();
}

export function computed<T>(fn: () => T): ReadonlySignal<T> {
  const box: { inner?: Signal<T> } = {};
  effect(() => {
    const next = fn();
    if (box.inner) box.inner.set(next); // Object.is skip dedupes unchanged results
    else box.inner = signal(next);
  });
  const inner = box.inner;
  if (!inner) throw new Error('computed: initial evaluation did not run');
  return {
    get: () => inner.get(),
    subscribe: (fn2) => inner.subscribe(fn2),
  };
}
