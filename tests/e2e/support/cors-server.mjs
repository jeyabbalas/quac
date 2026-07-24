/**
 * Local CORS fixture server for the P16 e2e journeys (url-params.md §5/§7).
 * Serves tests/fixtures/ over HTTP on a fixed port with `Access-Control-Allow-
 * Origin: *` on every path EXCEPT `/no-cors/…`, which serves the same file with
 * NO ACAO header so a cross-origin fetch fails with the browser's opaque
 * TypeError (→ FETCH_CORS). Being a different port from the app (4173) makes
 * every request genuinely cross-origin, so real CORS behavior is exercised.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));
const PORT = Number(process.env.CORS_FIXTURE_PORT ?? 4199);

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.tab': 'text/tab-separated-values',
  '.parquet': 'application/octet-stream',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://localhost:${String(PORT)}`);
  let pathname = decodeURIComponent(url.pathname);

  // Playwright polls this for readiness.
  if (pathname === '/' || pathname === '/health') {
    send(res, 200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }, 'ok');
    return;
  }

  // `/no-cors/<rest>` → the same file, no ACAO → cross-origin fetch is blocked.
  let cors = true;
  if (pathname.startsWith('/no-cors/')) {
    cors = false;
    pathname = pathname.slice('/no-cors'.length);
  }

  const resolved = normalize(join(FIXTURES, pathname));
  if (resolved !== FIXTURES && !resolved.startsWith(FIXTURES + sep)) {
    send(res, 403, { 'content-type': 'text/plain' }, 'forbidden');
    return;
  }

  let body;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    body = await readFile(resolved);
  } catch {
    const headers = { 'content-type': 'text/plain' };
    if (cors) headers['access-control-allow-origin'] = '*';
    send(res, 404, headers, 'not found');
    return;
  }

  const headers = { 'content-type': CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream' };
  if (cors) headers['access-control-allow-origin'] = '*';
  send(res, 200, headers, body);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { 'content-type': 'text/plain' }, String(err));
  });
});

server.listen(PORT, () => {
  process.stdout.write(`[cors-fixture-server] tests/fixtures on http://localhost:${String(PORT)}\n`);
});
