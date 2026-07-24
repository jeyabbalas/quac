/**
 * Hash router: `#/load` (default) | `#/report` | `#/studio`.
 *
 * The fragment carries both the route and the share-config params
 * (`#/load?schema=…&schema=…`, see url-params.md §2). The route is the part
 * before the FIRST `?`; everything after it is an opaque query string owned by
 * P16 — repeated keys and their order are semantic, so it is preserved
 * byte-for-byte (never parsed with URLSearchParams, never decoded) and carried
 * unchanged across navigation.
 */
import { signal } from './signals';
import type { ReadonlySignal } from './signals';

export const ROUTE_IDS = ['load', 'report', 'studio'] as const;
export type RouteId = (typeof ROUTE_IDS)[number];
export const DEFAULT_ROUTE: RouteId = 'load';

export interface ParsedHash {
  route: RouteId;
  /** Raw bytes after the first `?`, verbatim; `''` when absent. */
  query: string;
}

export function parseHash(hash: string): ParsedHash {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const qIndex = fragment.indexOf('?');
  const path = qIndex === -1 ? fragment : fragment.slice(0, qIndex);
  const query = qIndex === -1 ? '' : fragment.slice(qIndex + 1);
  const segment = path.replace(/^\/+|\/+$/g, '');
  const route = ROUTE_IDS.find((r) => r === segment) ?? DEFAULT_ROUTE;
  return { route, query };
}

export function formatHash(route: RouteId, query: string): string {
  return query === '' ? `#/${route}` : `#/${route}?${query}`;
}

export interface Router {
  readonly route: ReadonlySignal<RouteId>;
  /** Go to a route, carrying the current raw query along unchanged. */
  navigate: (route: RouteId) => void;
  dispose: () => void;
}

/** Fragment from `href`, not `location.hash` — the latter percent-decodes in Firefox. */
export function readRawHash(): string {
  const href = window.location.href;
  const i = href.indexOf('#');
  return i === -1 ? '' : href.slice(i);
}

/**
 * Wire the router to the window. The `hashchange` listener only reads (an
 * unknown route renders as `load` without rewriting the address bar — P16 may
 * canonicalize once it owns params), so normalization loops cannot happen;
 * `navigate()` is the only writer and each write is a history entry.
 */
export function startRouter(): Router {
  const route = signal(parseHash(readRawHash()).route);
  const onHashChange = (): void => {
    route.set(parseHash(readRawHash()).route);
  };
  window.addEventListener('hashchange', onHashChange);
  return {
    route,
    navigate: (next) => {
      const target = formatHash(next, parseHash(readRawHash()).query);
      if (readRawHash() !== target) window.location.hash = target;
    },
    dispose: () => {
      window.removeEventListener('hashchange', onHashChange);
    },
  };
}
