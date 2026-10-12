/**
 * The data dictionary's semantic search (src/ui/views/load/preview/
 * semanticModel.ts): the one model QuaC offers, the weights each browser runs,
 * and the rules that keep every request on this site. The worker and the
 * switch around them are exercised end to end (semanticSearch.spec,
 * network-isolation.spec); what is pinned here is what they decide.
 */
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_EMBEDDING_MODEL, KNOWN_EMBEDDING_MODELS } from 'json-schema-data-dictionary';
import { describe, expect, it, vi } from 'vitest';
import { MODEL, MODEL_FILES, REVISION } from '../../../scripts/vendor-semantic-model.mjs';
import {
  MODEL_DIRECTORY,
  SEMANTIC_MODEL,
  hostedWasmPaths,
  modelHost,
  sameOriginFetch,
  semanticRuntime,
} from '../../../src/ui/views/load/preview/semanticModel';

describe('the model', () => {
  it('is LEAF-IR, the library’s default and one of its verified models', () => {
    expect(SEMANTIC_MODEL).toBe('MongoDB/mdbr-leaf-ir');
    expect(SEMANTIC_MODEL).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(KNOWN_EMBEDDING_MODELS[SEMANTIC_MODEL]).toBeDefined();
  });

  it('is the model the build vendors, pinned to one revision', () => {
    expect(MODEL).toBe(SEMANTIC_MODEL);
    expect(REVISION).toMatch(/^[0-9a-f]{40}$/);
    for (const hash of Object.values(MODEL_FILES)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // Transformers.js names weights by precision: fp16 → model_fp16.onnx,
  // q8 → model_quantized.onnx, each with its .onnx_data beside it
  // (config.json's use_external_data_format). The vendored files must be
  // exactly the two precisions the runtime choice below can ask for.
  it('vendors the weights of both precisions the browser can run, and only those', () => {
    const known = KNOWN_EMBEDDING_MODELS[SEMANTIC_MODEL];
    expect(known?.dtype.webgpu).toBe('fp16');
    expect(known?.dtype.wasm).toBe('q8');
    const weights = Object.keys(MODEL_FILES).filter((file) => file.startsWith('onnx/'));
    expect(weights.sort()).toEqual([
      'onnx/model_fp16.onnx',
      'onnx/model_fp16.onnx_data',
      'onnx/model_quantized.onnx',
      'onnx/model_quantized.onnx_data',
    ]);
    expect(Object.keys(MODEL_FILES)).toEqual(
      expect.arrayContaining(['config.json', 'tokenizer.json', 'tokenizer_config.json']),
    );
  });
});

describe('semanticRuntime', () => {
  it('WebGPU with shader-f16 runs auto: fp16 on the GPU, q8 on WebAssembly if that fails', () => {
    expect(semanticRuntime({ available: true, f16: true })).toEqual({
      device: 'auto',
      dtype: 'auto',
    });
  });

  it('WebGPU without shader-f16 would need the fp32 weights the site does not serve: WebAssembly', () => {
    expect(semanticRuntime({ available: true, f16: false })).toEqual({
      device: 'wasm',
      dtype: 'q8',
    });
  });

  it('no WebGPU: WebAssembly and q8', () => {
    expect(semanticRuntime({ available: false, f16: false })).toEqual({
      device: 'wasm',
      dtype: 'q8',
    });
  });
});

describe('modelHost', () => {
  it('is the site’s models/ directory, as an absolute URL', () => {
    expect(MODEL_DIRECTORY).toBe('models/');
    expect(modelHost('/quac/', 'http://localhost:4173')).toBe('http://localhost:4173/quac/models/');
    expect(modelHost('/quac/', 'https://jeyabbalas.github.io')).toBe(
      'https://jeyabbalas.github.io/quac/models/',
    );
  });
});

describe('hostedWasmPaths', () => {
  const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
  const HOSTED = {
    'ort-wasm-simd-threaded.asyncify.mjs':
      'http://localhost:4173/quac/assets/ort-wasm-simd-threaded.asyncify-A.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm':
      'http://localhost:4173/quac/assets/ort-wasm-simd-threaded.asyncify-B.wasm',
    'ort-wasm-simd-threaded.mjs': 'http://localhost:4173/quac/assets/ort-wasm-simd-threaded-C.mjs',
    'ort-wasm-simd-threaded.wasm':
      'http://localhost:4173/quac/assets/ort-wasm-simd-threaded-D.wasm',
  };

  it('swaps Transformers.js’s CDN choice for the site’s copy of the same file', () => {
    expect(
      hostedWasmPaths(
        {
          mjs: `${CDN}ort-wasm-simd-threaded.asyncify.mjs`,
          wasm: `${CDN}ort-wasm-simd-threaded.asyncify.wasm`,
        },
        HOSTED,
      ),
    ).toEqual({
      mjs: HOSTED['ort-wasm-simd-threaded.asyncify.mjs'],
      wasm: HOSTED['ort-wasm-simd-threaded.asyncify.wasm'],
    });
  });

  it('keeps the choice Transformers.js made: the plain build on Safari before 26', () => {
    expect(
      hostedWasmPaths(
        { mjs: `${CDN}ort-wasm-simd-threaded.mjs`, wasm: `${CDN}ort-wasm-simd-threaded.wasm?v=1` },
        HOSTED,
      ),
    ).toEqual({
      mjs: HOSTED['ort-wasm-simd-threaded.mjs'],
      wasm: HOSTED['ort-wasm-simd-threaded.wasm'],
    });
  });

  it('throws rather than leave a request to the CDN', () => {
    expect(() =>
      hostedWasmPaths(
        {
          mjs: `${CDN}ort-wasm-simd-threaded.jsep.mjs`,
          wasm: `${CDN}ort-wasm-simd-threaded.jsep.wasm`,
        },
        HOSTED,
      ),
    ).toThrow('ort-wasm-simd-threaded.jsep.mjs, which this site does not serve');
    expect(() => hostedWasmPaths(CDN, HOSTED)).toThrow('no mjs file');
    expect(() => hostedWasmPaths(undefined, HOSTED)).toThrow('no mjs file');
  });

  // The page serves ONE copy of ONNX Runtime's WebAssembly build, from the
  // onnxruntime-web QuaC depends on; Transformers.js drives it with the
  // onnxruntime-web IT depends on. They must be one and the same package.
  it('serves the WebAssembly build of the onnxruntime-web Transformers.js runs', () => {
    const packageJson = (
      path: string,
    ): { version: string; dependencies?: Record<string, string> } =>
      JSON.parse(
        readFileSync(
          new URL(`../../../node_modules/${path}/package.json`, import.meta.url),
          'utf8',
        ),
      ) as {
        version: string;
        dependencies?: Record<string, string>;
      };
    const transformers = packageJson('@huggingface/transformers');
    expect(packageJson('onnxruntime-web').version).toBe(
      transformers.dependencies?.['onnxruntime-web'],
    );
    // …and npm did not nest a second copy where Transformers.js would find it first.
    expect(
      existsSync(
        new URL(
          '../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web',
          import.meta.url,
        ),
      ),
    ).toBe(false);
  });
});

describe('sameOriginFetch', () => {
  const ORIGIN = 'http://localhost:4173';
  const BASE = `${ORIGIN}/quac/assets/semantic.worker-X.js`;
  const ok = (): Promise<Response> => Promise.resolve(new Response('ok'));

  it('passes requests to this site through, relative ones included', async () => {
    const real = vi.fn(ok);
    const guarded = sameOriginFetch(real, ORIGIN, BASE);
    await guarded('/quac/models/MongoDB/mdbr-leaf-ir/config.json');
    await guarded(`${ORIGIN}/quac/assets/ort.wasm`, { method: 'GET' });
    await guarded(new URL('../models/x.json', BASE));
    await guarded(new Request(`${ORIGIN}/quac/models/y.json`));
    await guarded('blob:http://localhost:4173/5d1c');
    expect(real).toHaveBeenCalledTimes(5);
    expect(real.mock.calls[1]).toEqual([`${ORIGIN}/quac/assets/ort.wasm`, { method: 'GET' }]);
  });

  it('refuses every other origin without making the request', async () => {
    const real = vi.fn(ok);
    const guarded = sameOriginFetch(real, ORIGIN, BASE);
    await expect(
      guarded('https://huggingface.co/MongoDB/mdbr-leaf-ir/resolve/main/config.json'),
    ).rejects.toThrow("QuaC's semantic search fetches nothing from https://huggingface.co");
    await expect(
      guarded(
        new Request(
          'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
        ),
      ),
    ).rejects.toThrow('https://cdn.jsdelivr.net');
    await expect(guarded('http://localhost:4199/x')).rejects.toThrow('http://localhost:4199');
    expect(real).not.toHaveBeenCalled();
  });
});
