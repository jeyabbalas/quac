/**
 * In-process stand-in for the Ajv validation Web Worker (headless.md §3).
 *
 * `runSchemaValidation` builds its channel from a `Worker` — five members:
 * `onmessage`, `onerror`, `onmessageerror`, `postMessage`, `terminate`
 * (`validation-run.ts` → `createChannel`). Node has no `Worker` global, so this
 * factory returns a duck-typed object with that surface, driving the real
 * engine from `core/schema/validation-core.ts`. No logic is duplicated: the
 * browser worker shell and this wrap the same `createValidationEngine`.
 *
 * Each call builds a FRESH engine, so two runs in one process cannot see each
 * other's state — the reason the planning spike's `globalThis.self` import
 * trick (one module-singleton engine) did not graduate.
 *
 * Both hops go through `queueMicrotask`, preserving the real worker's
 * asynchrony: the orchestrator's `expect()` loop parks on a promise between
 * messages, and a synchronous reply would deliver before it is listening.
 * Unlike a real worker, messages are passed by REFERENCE rather than
 * structured-cloned; the engine builds a fresh flags array per batch and never
 * mutates the rows it is handed, so nothing depends on the copy.
 */
import { createValidationEngine } from '../core/schema/validation-core';
import type { MainToWorker, WorkerToMain } from '../core/schema/worker-protocol';

/** Exactly what `createChannel` and the row loop touch — no more. */
interface WorkerFacade {
  onmessage: ((event: { data: WorkerToMain }) => void) | null;
  onerror: ((event: { message: string }) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: (msg: MainToWorker) => void;
  terminate: () => void;
}

export function createInProcessValidationWorker(): Worker {
  let live = true;
  const facade: WorkerFacade = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg: MainToWorker): void {
      if (!live) return;
      queueMicrotask(() => {
        if (!live) return;
        engine.handle(msg);
      });
    },
    terminate(): void {
      // A real worker stops delivering the moment it is terminated; the
      // orchestrator terminates in a `finally`, including on the abort path.
      live = false;
    },
  };
  const engine = createValidationEngine((msg) => {
    queueMicrotask(() => {
      if (!live) return;
      facade.onmessage?.({ data: msg });
    });
  });
  return facade as unknown as Worker;
}
