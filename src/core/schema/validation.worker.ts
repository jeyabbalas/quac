/**
 * QC validation worker (json-schema-subsystem.md §F) — the browser shell.
 *
 * All the engine logic lives in `validation-core.ts` (extracted in P20 so the
 * headless Node runtime drives the same code in-process rather than a copy —
 * headless.md §3). This file is only the `self` binding: messages in, replies
 * out. Nothing else belongs here; anything added below would exist in the
 * browser and not in Node.
 */
import { createValidationEngine } from './validation-core';
import type { MainToWorker, WorkerToMain } from './worker-protocol';

/** Minimal structural view of the dedicated-worker scope (no WebWorker lib — it conflicts with DOM). */
interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: WorkerToMain) => void;
}

const scope = self as unknown as WorkerScope;

const engine = createValidationEngine((msg) => {
  scope.postMessage(msg);
});

scope.onmessage = (event: MessageEvent): void => {
  engine.handle(event.data as MainToWorker);
};
