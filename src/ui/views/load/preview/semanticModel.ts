/**
 * Semantic search in the data dictionary — the decisions QuaC makes around
 * json-schema-data-dictionary's opt-in semantic search, kept pure so node tests
 * pin them. The worker (semantic.worker.ts) and the panel (semanticSearch.ts)
 * both read them.
 *
 * - **One model.** MongoDB's LEAF-IR (`MongoDB/mdbr-leaf-ir`), the library's
 *   default and the best of its verified models under 100M parameters. QuaC
 *   users do not choose a model.
 * - **Served from this site.** scripts/vendor-semantic-model.mjs puts the
 *   weights under `models/`, and Vite emits ONNX Runtime's WebAssembly build
 *   from onnxruntime-web, so turning semantic search on makes no third-party
 *   request (README → Privacy, network-isolation.spec). The worker points
 *   Transformers.js at this site exactly as one points it at a model mirror
 *   (`remoteHost`, `remotePathTemplate`) and refuses every other origin.
 */
import type { WebGpuSupport } from 'json-schema-data-dictionary';

/** The one model QuaC offers. */
export const SEMANTIC_MODEL = 'MongoDB/mdbr-leaf-ir';

/** Its files, under the site's base (scripts/vendor-semantic-model.mjs). */
export const MODEL_DIRECTORY = 'models/';

/** What json-schema-data-dictionary's Transformers.js adapter is asked to run. */
export interface SemanticRuntime {
  device: 'auto' | 'wasm';
  dtype: 'auto' | 'q8';
}

/**
 * Which weights this browser runs. The site serves the two precisions the
 * library verified for LEAF-IR: fp16 for WebGPU and q8 for WebAssembly.
 *
 * WebGPU with `shader-f16` runs `auto`: the library resolves that to WebGPU and
 * fp16, and falls back to WebAssembly and q8 if the GPU session fails. Without
 * `shader-f16` the library would choose fp32 weights, which the site does not
 * serve (91 MB), so such a browser runs on WebAssembly — as does one without
 * WebGPU at all.
 */
export function semanticRuntime(gpu: WebGpuSupport): SemanticRuntime {
  return gpu.available && gpu.f16
    ? { device: 'auto', dtype: 'auto' }
    : { device: 'wasm', dtype: 'q8' };
}

/** The model host as Transformers.js wants it: an absolute URL, `…/quac/models/`. */
export function modelHost(baseUrl: string, origin: string): string {
  return new URL(`${baseUrl}${MODEL_DIRECTORY}`, origin).href;
}

export interface WasmFilePaths {
  mjs: string;
  wasm: string;
}

const fileName = (url: string): string =>
  url.slice(url.lastIndexOf('/') + 1).replace(/[?#].*$/, '');

/**
 * Transformers.js points ONNX Runtime at jsDelivr for its WebAssembly build:
 * `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`, or the plain build on Safari
 * before 26 without WebGPU. The site serves the same files (`hosted`, by file
 * name → URL), so this swaps each URL for the site's copy and leaves the
 * choice itself to Transformers.js. A file the site does not serve throws: the
 * alternative would be a request to the CDN.
 */
export function hostedWasmPaths(
  chosen: unknown,
  hosted: Readonly<Record<string, string>>,
): WasmFilePaths {
  const paths = (typeof chosen === 'object' && chosen !== null ? chosen : {}) as Partial<
    Record<keyof WasmFilePaths, unknown>
  >;
  const local = (key: keyof WasmFilePaths): string => {
    const url = paths[key];
    const name = typeof url === 'string' ? fileName(url) : '';
    const copy = hosted[name];
    if (copy === undefined) {
      throw new Error(
        `ONNX Runtime asked for ${name === '' ? `no ${key} file` : name}, which this site does not serve`,
      );
    }
    return copy;
  };
  return { mjs: local('mjs'), wasm: local('wasm') };
}

/**
 * `fetch`, refusing every request off `origin`. The worker installs it before
 * Transformers.js and ONNX Runtime load, so a default that names another host
 * fails here, with a message, instead of reaching the network.
 */
export function sameOriginFetch(
  realFetch: typeof fetch,
  origin: string,
  base: string,
): typeof fetch {
  return (input, init) => {
    const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    let url: URL;
    try {
      url = new URL(raw, base);
    } catch {
      return Promise.reject(new TypeError(`Not a URL: ${raw}`));
    }
    // blob: URLs are this page's own memory; their origin is the page's.
    const local = url.protocol === 'blob:' || url.protocol === 'data:' || url.origin === origin;
    if (!local) {
      return Promise.reject(
        new TypeError(`QuaC's semantic search fetches nothing from ${url.origin}`),
      );
    }
    return realFetch(input, init);
  };
}
