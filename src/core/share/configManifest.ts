/**
 * The `config=` manifest (url-params.md §2): a JSON escape hatch for links that
 * would exceed MAX_URL_CHARS. Shape `{ schema[], rules[], index?, data? }`.
 * Pure + node-testable; the fetch port is injectable.
 */
import type { UrlConfig } from './urlConfig';

export interface ConfigManifest {
  schema: string[];
  rules: string[];
  index?: string;
  data?: string;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Config manifest: "${field}" must be an array of URL strings.`);
  }
  return (value as string[]).filter((v) => v !== '');
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Config manifest: "${field}" must be a string.`);
  }
  return value === '' ? undefined : value;
}

/** Validate the manifest shape; throws a friendly Error on any deviation. */
export function parseManifest(json: unknown): ConfigManifest {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Config manifest must be a JSON object with "schema"/"rules" arrays.');
  }
  const record = json as Record<string, unknown>;
  const manifest: ConfigManifest = {
    schema: asStringArray(record.schema, 'schema'),
    rules: asStringArray(record.rules, 'rules'),
  };
  const index = asOptionalString(record.index, 'index');
  if (index !== undefined) manifest.index = index;
  const data = asOptionalString(record.data, 'data');
  if (data !== undefined) manifest.data = data;
  return manifest;
}

/** Manifest → a loadable UrlConfig (no passthrough, no nested config). */
export function manifestToConfig(manifest: ConfigManifest): UrlConfig {
  const config: UrlConfig = {
    schema: [...manifest.schema],
    rules: [...manifest.rules],
    passthrough: [],
  };
  if (manifest.index !== undefined) config.index = manifest.index;
  if (manifest.data !== undefined) config.data = manifest.data;
  return config;
}

/** UrlConfig → manifest JSON (for the >2000-char download path). */
export function configToManifest(config: UrlConfig): ConfigManifest {
  const manifest: ConfigManifest = {
    schema: [...config.schema],
    rules: [...config.rules],
  };
  if (config.index !== undefined) manifest.index = config.index;
  if (config.data !== undefined) manifest.data = config.data;
  return manifest;
}

/**
 * Precedence (§2): `config=` loads first; any inline `schema`/`rules`/`index`/
 * `data` param overrides that key WHOLESALE. Returns the merged config plus the
 * keys the inline params overrode (drives the override toast). `config`'s own
 * key is dropped from the result — it has been consumed.
 */
export function applyPrecedence(
  fromManifest: UrlConfig,
  inline: UrlConfig,
): { merged: UrlConfig; overridden: string[] } {
  const overridden: string[] = [];
  const merged: UrlConfig = {
    schema: [...fromManifest.schema],
    rules: [...fromManifest.rules],
    passthrough: [...inline.passthrough],
  };
  if (fromManifest.index !== undefined) merged.index = fromManifest.index;
  if (fromManifest.data !== undefined) merged.data = fromManifest.data;

  if (inline.schema.length > 0) {
    if (fromManifest.schema.length > 0) overridden.push('schema');
    merged.schema = [...inline.schema];
  }
  if (inline.rules.length > 0) {
    if (fromManifest.rules.length > 0) overridden.push('rules');
    merged.rules = [...inline.rules];
  }
  if (inline.index !== undefined) {
    if (fromManifest.index !== undefined) overridden.push('index');
    merged.index = inline.index;
  }
  if (inline.data !== undefined) {
    if (fromManifest.data !== undefined) overridden.push('data');
    merged.data = inline.data;
  }
  return { merged, overridden };
}

/** Injectable byte fetcher — mirrors fetchArtifact's shape for node tests. */
export type ManifestFetcher = (url: string) => Promise<{ bytes: ArrayBuffer }>;

/**
 * Fetch + validate a manifest. Defaults to fetchArtifact (consistent CORS
 * typing); node tests inject a fetcher. Friendly errors on non-JSON / bad shape.
 */
export async function fetchConfigManifest(
  url: string,
  fetcher?: ManifestFetcher,
): Promise<ConfigManifest> {
  const fetch = fetcher ?? (await import('./fetchArtifact')).fetchArtifact;
  const { bytes } = await fetch(url);
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Config manifest at ${url} is not valid JSON.`, { cause });
  }
  return parseManifest(json);
}
