/**
 * The semantic-search worker's network rule, installed by its FIRST import so
 * it runs before Transformers.js and ONNX Runtime evaluate: both capture
 * `fetch` at load, and from then on every request either goes to this site or
 * fails here. Configuration already keeps them on this site (semantic.worker.ts);
 * this makes a default that names huggingface.co or jsDelivr an error rather
 * than a request.
 */
import { sameOriginFetch } from './semanticModel';

globalThis.fetch = sameOriginFetch(
  globalThis.fetch.bind(globalThis),
  self.location.origin,
  self.location.href,
);
