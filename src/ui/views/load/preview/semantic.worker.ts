/**
 * The semantic-search worker: MongoDB's LEAF-IR behind json-schema-data-
 * dictionary's embedder port (`serveEmbedder`), off the main thread so
 * embedding a dictionary never janks the page. The panel starts one when the
 * switch goes on and terminates it when the switch goes off
 * (semanticSearch.ts).
 *
 * Everything it loads comes from this site (semanticModel.ts):
 * - the model from `models/` — Transformers.js reads it the way it reads a
 *   model mirror: `remoteHost` is this site, `remotePathTemplate` the model id;
 * - ONNX Runtime's WebAssembly build from the copies Vite emits out of
 *   onnxruntime-web (the `?url` imports below);
 * - and Transformers.js keeps no copy of its own (`useBrowserCache: false`):
 *   the browser's HTTP cache holds these files like the site's other assets,
 *   so there is no store of QuaC's to account for.
 *
 * semanticGuard.ts, imported first, makes any other origin an error.
 */
import './semanticGuard';
import { AutoModel, AutoTokenizer, env } from '@huggingface/transformers';
import {
  createTransformersEmbedder,
  detectWebGpu,
  serveEmbedder,
} from 'json-schema-data-dictionary';
import type { Embedder } from 'json-schema-data-dictionary';
import asyncifyMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import asyncifyWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import plainMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import plainWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { SEMANTIC_MODEL, hostedWasmPaths, modelHost, semanticRuntime } from './semanticModel';

const transformers = { AutoModel, AutoTokenizer };

/** Point Transformers.js and ONNX Runtime at this site. Throws if ONNX Runtime wants a file it does not serve. */
function configure(): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.remoteHost = modelHost(import.meta.env.BASE_URL, self.location.origin);
  env.remotePathTemplate = '{model}/';
  env.useBrowserCache = false;
  const wasm = env.backends.onnx.wasm;
  if (wasm === undefined) {
    throw new Error('ONNX Runtime has no WebAssembly backend in this browser');
  }
  const at = (url: string): string => new URL(url, self.location.href).href;
  wasm.wasmPaths = hostedWasmPaths(wasm.wasmPaths, {
    'ort-wasm-simd-threaded.asyncify.mjs': at(asyncifyMjs),
    'ort-wasm-simd-threaded.asyncify.wasm': at(asyncifyWasm),
    'ort-wasm-simd-threaded.mjs': at(plainMjs),
    'ort-wasm-simd-threaded.wasm': at(plainWasm),
  });
}

/**
 * The embedder that knows its device only after a WebGPU probe, which is
 * asynchronous, while `serveEmbedder` has to be called at once. So the port
 * serves a stand-in: its identity is the model's (the vector space does not
 * depend on the device), and its first `load` or `embed` probes, configures
 * and creates the real one. A configuration error rejects that call, which the
 * dictionary shows as "Semantic search unavailable".
 */
const identity = createTransformersEmbedder(transformers, { model: SEMANTIC_MODEL });
let created: Promise<Embedder> | undefined;
let current: Embedder | undefined;

function embedder(): Promise<Embedder> {
  created ??= (async () => {
    configure();
    const runtime = semanticRuntime(await detectWebGpu());
    current = createTransformersEmbedder(transformers, { model: SEMANTIC_MODEL, ...runtime });
    return current;
  })();
  return created;
}

serveEmbedder({
  get id() {
    return (current ?? identity).id;
  },
  get spaceId() {
    return identity.spaceId;
  },
  minScore: identity.minScore,
  get info() {
    return (current ?? identity).info;
  },
  async load(onProgress) {
    await (await embedder()).load?.(onProgress);
  },
  async embed(texts, kind) {
    return (await embedder()).embed(texts, kind);
  },
  async dispose() {
    await current?.dispose?.();
  },
});
