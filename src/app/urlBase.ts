/**
 * Base-aware URL helpers. import.meta.env.BASE_URL is '/quac/' in dev/build
 * (from the vite `base` option) but '/' under the Vitest 4 node environment
 * (https://github.com/vitest-dev/vitest/issues/8895), so joinBase() takes the
 * base explicitly and assetUrl() applies the runtime default.
 */
export function joinBase(base: string, path: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return b + path.replace(/^\/+/, '');
}

export function assetUrl(path: string): string {
  return joinBase(import.meta.env.BASE_URL, path);
}
