/**
 * Assemble the shareable-link model from the loaded slot states (pure,
 * node-testable). Only URL-loaded artifacts travel in a link (url-params.md
 * §1/§4); uploads are listed as excluded. Schema contributes its user-provided
 * crawl bases (in order) as `schema=` and its resolved root as `index=`.
 */
import type { UrlConfig } from './urlConfig';

export type ShareSlot = 'data' | 'schema' | 'rules';

export interface ShareArtifact {
  slot: ShareSlot;
  /** Display name (filename / root path / URL basename). */
  label: string;
  /** URL-loaded ⇒ shareable ✓; uploaded ⇒ excluded ✗. */
  shareable: boolean;
  /** Present iff shareable — the URL that goes in the link. */
  url?: string;
}

export interface DatasetShareInput {
  name: string;
  sourceUrl?: string;
}

export interface SchemaShareInput {
  origin: 'upload' | 'url';
  /** Crawl-base URLs the user provided (URL mode). */
  sourceUrls: readonly string[];
  /** Root file's relativePath, for the upload-mode label. */
  rootLabel?: string;
  /** Resolved share id (§A.4) — only meaningful in URL mode. */
  indexFileId?: string;
}

export interface ShareModelInput {
  dataset: DatasetShareInput | null;
  schema: SchemaShareInput | null;
  /** Per rule file, in load order; `sourceUrl` null ⇒ uploaded. */
  rules: readonly { name: string; sourceUrl: string | null }[];
}

export interface ShareModel {
  /** Every loaded artifact, in slot order (Dataset, Schema, Rules). */
  artifacts: ShareArtifact[];
  /** The assembled config (URL-loaded artifacts only). */
  config: UrlConfig;
  /** Schema root index id, when a URL-loaded root resolved. */
  index?: string;
  /** True when nothing is loaded at all. */
  empty: boolean;
  /** True when at least one artifact can travel in a link. */
  hasShareable: boolean;
}

function basename(url: string): string {
  try {
    const path = new URL(url).pathname.split('/').filter((s) => s !== '');
    return decodeURIComponent(path[path.length - 1] ?? '') || url;
  } catch {
    return url;
  }
}

export function buildShareModel(input: ShareModelInput): ShareModel {
  const artifacts: ShareArtifact[] = [];
  const config: UrlConfig = { schema: [], rules: [], passthrough: [] };

  if (input.dataset !== null) {
    const url = input.dataset.sourceUrl;
    artifacts.push({
      slot: 'data',
      label: input.dataset.name,
      shareable: url !== undefined,
      ...(url !== undefined ? { url } : {}),
    });
    if (url !== undefined) config.data = url;
  }

  if (input.schema !== null) {
    const shareable = input.schema.origin === 'url' && input.schema.sourceUrls.length > 0;
    if (shareable) {
      // One row per crawl base so each URL's provenance is visible.
      for (const url of input.schema.sourceUrls) {
        artifacts.push({ slot: 'schema', label: basename(url), shareable: true, url });
        config.schema.push(url);
      }
      if (input.schema.indexFileId !== undefined) config.index = input.schema.indexFileId;
    } else {
      artifacts.push({
        slot: 'schema',
        label: input.schema.rootLabel ?? 'Schema files',
        shareable: false,
      });
    }
  }

  for (const file of input.rules) {
    const shareable = file.sourceUrl !== null;
    artifacts.push({
      slot: 'rules',
      label: file.name,
      shareable,
      ...(file.sourceUrl !== null ? { url: file.sourceUrl } : {}),
    });
    if (file.sourceUrl !== null) config.rules.push(file.sourceUrl);
  }

  const model: ShareModel = {
    artifacts,
    config,
    empty: artifacts.length === 0,
    hasShareable: artifacts.some((a) => a.shareable),
  };
  if (config.index !== undefined) model.index = config.index;
  return model;
}
