/**
 * QuickJS-WASM JSSandbox (qc-rules-engine.md §1, architecture.md §8.3): js
 * correction rules execute here with zero ambient authority — no fetch/DOM/
 * timers exist inside QuickJS by construction. This module statically imports
 * the QuickJS packages and therefore MUST only ever be reached through
 * `sandbox-loader.ts`'s dynamic import (it IS the lazy chunk; the wasm ships
 * as a same-origin Vite asset).
 *
 * Kill-switches, all proven by tests: per-call interrupt deadline (uncatchable
 * `InternalError: interrupted`), memory limit (`InternalError: out of memory`
 * — catchable by guest try/catch, so the driver RETHROWS InternalError to keep
 * it fatal), max stack size. A fresh runtime+context per call (per chunk /
 * per compile) caps guest garbage and satisfies §6's fresh-context-per-rule.
 *
 * Values cross the boundary as JSON (§8.3): the batch must be JSON-safe (the
 * engine normalizes BigInt/Date first); a returned value that JSON cannot
 * represent (function/symbol) surfaces as `value: undefined` and the engine
 * treats it as unchanged.
 */
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten-core';
import type { QuickJSContext, QuickJSWASMModule } from 'quickjs-emscripten-core';
import releaseSyncVariant from '@jitl/quickjs-wasmfile-release-sync';
import type { JSCorrectionResult, JSSandbox } from './types';

export interface QuickJSSandboxOptions {
  /** Guest heap cap; the allocation-bomb kill switch. Default 128 MiB. */
  memoryLimitBytes?: number;
  /** Guest stack cap (runaway recursion). Default 1 MiB. */
  maxStackSizeBytes?: number;
  /** Interrupt deadline for compileCheck evals (they execute expression code). */
  compileDeadlineMs?: number;
}

const MEMORY_LIMIT_DEFAULT = 128 * 1024 * 1024;
const MAX_STACK_SIZE_DEFAULT = 1024 * 1024;
const COMPILE_DEADLINE_MS_DEFAULT = 1000;

let modulePromise: Promise<QuickJSWASMModule> | undefined;

/** Memoized wasm boot — one QuickJS module serves every sandbox instance. */
function getQuickJSModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSyncVariant);
  return modulePromise;
}

/** `{name}: {message}` for dumped guest Error objects; String() otherwise. */
function formatGuestError(dumped: unknown): string {
  if (typeof dumped === 'object' && dumped !== null) {
    const { name, message } = dumped as { name?: unknown; message?: unknown };
    if (typeof name === 'string' && typeof message === 'string') return `${name}: ${message}`;
  }
  return String(dumped);
}

/**
 * Evaluate `code` in a throwaway runtime+context with all kill-switches armed.
 * Returns the successful result mapped through `map`; a guest-level error
 * (including uncatchable interrupt/OOM InternalErrors) is returned as a
 * message string via the `err` channel — callers decide throw vs report.
 */
async function evalIsolated<T>(
  opts: { memoryLimitBytes: number; maxStackSizeBytes: number; deadlineMs: number },
  code: string,
  map: (ctx: QuickJSContext, valueJson: string) => T,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  const quickjs = await getQuickJSModule();
  const runtime = quickjs.newRuntime();
  try {
    runtime.setMemoryLimit(opts.memoryLimitBytes);
    runtime.setMaxStackSize(opts.maxStackSizeBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.deadlineMs));
    const ctx = runtime.newContext();
    try {
      const evaluated = ctx.evalCode(code);
      if ('error' in evaluated && evaluated.error !== undefined) {
        const dumped: unknown = ctx.dump(evaluated.error);
        evaluated.error.dispose();
        return { ok: false, error: formatGuestError(dumped) };
      }
      const handle = evaluated.value;
      try {
        return { ok: true, result: map(ctx, ctx.getString(handle)) };
      } finally {
        handle.dispose();
      }
    } finally {
      ctx.dispose();
    }
  } finally {
    runtime.dispose();
  }
}

/**
 * The per-chunk guest program: compile the user fn, run it over the JSON
 * batch with a per-row try/catch, JSON the results back. InternalError
 * (interrupt deadline / memory cap) is RETHROWN so it stays fatal — guest
 * user code must not be able to swallow a kill-switch (spike-verified: OOM is
 * otherwise catchable). `undefined` return ⇒ changed:false (format §6).
 */
function buildChunkDriver(fnSource: string, batchJson: string): string {
  return (
    `const __fn = (\n${fnSource}\n);\n` +
    `const __batch = ${JSON.stringify(batchJson)};\n` +
    'JSON.stringify(JSON.parse(__batch).map((item) => {\n' +
    '  try {\n' +
    '    const out = __fn(item.value, Object.freeze(item.rowData));\n' +
    '    if (out === undefined) return { row: item.row, value: null, changed: false };\n' +
    '    return { row: item.row, value: out, changed: true };\n' +
    '  } catch (e) {\n' +
    '    if (e instanceof InternalError) throw e;\n' +
    '    return { row: item.row, value: null, changed: false,\n' +
    '      error: e instanceof Error ? e.name + ": " + e.message : String(e) };\n' +
    '  }\n' +
    '}));'
  );
}

/**
 * Create the QuickJS-backed JSSandbox. The first call (transitively) boots the
 * wasm module; construction itself is synchronous state — every method awaits
 * the shared module promise.
 */
export function createQuickJSSandbox(opts: QuickJSSandboxOptions = {}): JSSandbox {
  const memoryLimitBytes = opts.memoryLimitBytes ?? MEMORY_LIMIT_DEFAULT;
  const maxStackSizeBytes = opts.maxStackSizeBytes ?? MAX_STACK_SIZE_DEFAULT;
  const compileDeadlineMs = opts.compileDeadlineMs ?? COMPILE_DEADLINE_MS_DEFAULT;

  return {
    async compileCheck(fnSource: string): Promise<{ ok: boolean; error?: string }> {
      // The newline wrap keeps a trailing `// comment` from eating the paren.
      const outcome = await evalIsolated(
        { memoryLimitBytes, maxStackSizeBytes, deadlineMs: compileDeadlineMs },
        `JSON.stringify(typeof (\n${fnSource}\n) === 'function');`,
        (_ctx, json) => json === 'true',
      );
      if (!outcome.ok) return { ok: false, error: outcome.error };
      if (!outcome.result) {
        return { ok: false, error: 'update_expression must evaluate to a function (value, row) => …' };
      }
      return { ok: true };
    },

    async runCorrection(
      fnSource: string,
      batch: { row: number; value: unknown; rowData: Record<string, unknown> }[],
      budget: { timeoutMs: number },
    ): Promise<JSCorrectionResult[]> {
      if (batch.length === 0) return [];
      const outcome = await evalIsolated(
        { memoryLimitBytes, maxStackSizeBytes, deadlineMs: budget.timeoutMs },
        buildChunkDriver(fnSource, JSON.stringify(batch)),
        (_ctx, json) => JSON.parse(json) as JSCorrectionResult[],
      );
      if (!outcome.ok) throw new Error(outcome.error);
      return outcome.result;
    },
  };
}
