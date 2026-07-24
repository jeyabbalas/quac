/**
 * Verified CORS reality (url-params.md §5; re-verified live by the P16
 * corsFallback e2e). Pure data — the "which hosts work?" popover renders it.
 */
export interface CorsHost {
  host: string;
  allowed: boolean;
  note: string;
}

export const CORS_HOSTS: readonly CorsHost[] = [
  {
    host: 'raw.githubusercontent.com',
    allowed: true,
    note: 'GitHub raw file URLs — Access-Control-Allow-Origin: *',
  },
  { host: 'gist.githubusercontent.com', allowed: true, note: 'GitHub gist raw URLs — *' },
  { host: 'cdn.jsdelivr.net', allowed: true, note: 'jsDelivr, incl. /gh/ GitHub mirror — *' },
  { host: 'api.github.com', allowed: true, note: 'GitHub API — *' },
  {
    host: 'OSF',
    allowed: false,
    note: 'ACAO limited to its own origin — download and upload the file instead',
  },
  {
    host: 'Zenodo',
    allowed: false,
    note: 'File server unreliable for browser access — treat as blocked',
  },
];
