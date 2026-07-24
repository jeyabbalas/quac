/**
 * Pure encode/decode of the QuaC share-fragment grammar (url-params.md §2).
 *
 * The fragment is `#/<route>?<query>`; the router owns the split and hands this
 * module the raw `<query>` only. Everything here operates on that query string.
 *
 * - Repeated `schema=` / `rules=` keys preserve order (`getAll`) — order is
 *   semantic (rules run in load order; schema URLs are the crawl bases).
 * - Values are absolute `https:` URLs. We emit them `encodeURIComponent`-encoded
 *   (the spec's contract) and decode with `URLSearchParams` (tolerant of both
 *   `%20` and `+`), so `decodeConfig(encodeConfig(x))` is a fixpoint per field.
 * - Unknown params are preserved verbatim (in order) so the app never eats a
 *   param a future version added.
 */

export interface UrlConfig {
  /** Schema crawl-base URLs, in order. */
  schema: string[];
  /** Rules-file URLs, in order (= the cross-file correction order). */
  rules: string[];
  /** Disambiguated root schema id (§A.4). */
  index?: string;
  /** Dataset URL. */
  data?: string;
  /** Manifest escape-hatch URL (§2) — expanded before the other keys load. */
  config?: string;
  /** Any other params, preserved on re-encode. */
  passthrough: [string, string][];
}

const KNOWN_KEYS = new Set(['schema', 'rules', 'index', 'data', 'config']);

/** Longest link assembled inline before users are pushed to `config=` (§2). */
export const MAX_URL_CHARS = 2000;

/** Parse a raw query string (no leading `?`) into a UrlConfig. */
export function decodeConfig(query: string): UrlConfig {
  const params = new URLSearchParams(query);
  const config: UrlConfig = {
    schema: params.getAll('schema').filter((v) => v !== ''),
    rules: params.getAll('rules').filter((v) => v !== ''),
    passthrough: [],
  };
  const index = params.get('index');
  if (index !== null && index !== '') config.index = index;
  const data = params.get('data');
  if (data !== null && data !== '') config.data = data;
  const configUrl = params.get('config');
  if (configUrl !== null && configUrl !== '') config.config = configUrl;
  for (const [key, value] of params) {
    if (!KNOWN_KEYS.has(key)) config.passthrough.push([key, value]);
  }
  return config;
}

function pair(key: string, value: string): string {
  return `${key}=${encodeURIComponent(value)}`;
}

/** Serialize a UrlConfig back to a query string (no leading `?`). */
export function encodeConfig(config: UrlConfig): string {
  const parts: string[] = [];
  for (const url of config.schema) parts.push(pair('schema', url));
  for (const url of config.rules) parts.push(pair('rules', url));
  if (config.index !== undefined) parts.push(pair('index', config.index));
  if (config.data !== undefined) parts.push(pair('data', config.data));
  if (config.config !== undefined) parts.push(pair('config', config.config));
  for (const [key, value] of config.passthrough) parts.push(pair(key, value));
  return parts.join('&');
}

/** Full fragment `#/<route>?<query>` (or `#/<route>` when the config is empty). */
export function assembleFragment(config: UrlConfig, route = 'load'): string {
  const query = encodeConfig(config);
  return query === '' ? `#/${route}` : `#/${route}?${query}`;
}

/** True when the config carries nothing loadable (used to skip the boot flow). */
export function isEmptyConfig(config: UrlConfig): boolean {
  return (
    config.schema.length === 0 &&
    config.rules.length === 0 &&
    config.index === undefined &&
    config.data === undefined &&
    config.config === undefined
  );
}
