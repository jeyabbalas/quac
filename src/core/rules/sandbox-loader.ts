/**
 * The code-split boundary for the QuickJS sandbox (phase-13 task 1): the
 * `import('./sandbox')` below is the ONLY app-code path to sandbox.ts, so the
 * quickjs chunk (+ wasm asset) downloads exactly when something actually needs
 * a sandbox — lint stage 5 or the engine, and each only when a loaded rules
 * file contains js correction rules. Memoized ⇒ at most one load; the memo
 * resets on rejection so a transient load failure can retry.
 *
 * Node tests import sandbox.ts directly (no laziness needed off the bundle).
 */
import type { JSSandbox } from './types';

let sandboxPromise: Promise<JSSandbox> | undefined;
let loads = 0;

export function loadJSSandbox(): Promise<JSSandbox> {
  sandboxPromise ??= (async () => {
    loads += 1;
    try {
      const { createQuickJSSandbox } = await import('./sandbox');
      return createQuickJSSandbox();
    } catch (err) {
      sandboxPromise = undefined;
      throw err instanceof Error ? err : new Error(String(err));
    }
  })();
  return sandboxPromise;
}

/** Test hook: how many times the lazy import was actually started. */
export function sandboxLoadCount(): number {
  return loads;
}
