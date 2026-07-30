/**
 * Self-host DuckDB WASM (architecture.md §8 item 4, data-table-api.md §8):
 * stage everything DuckDB needs at runtime into public/duckdb/ so the deployed
 * site makes zero third-party requests and works on locked-down networks.
 * Wired as predev/prebuild/pretest:browser; public/duckdb/ is gitignored
 * (derived, ~90 MB). The coi bundle is skipped: it needs COOP/COEP headers
 * GitHub Pages can't set. Three parts (Verified facts V6/V8):
 *
 * 1. wasm binaries — copied from @duckdb/duckdb-wasm/dist.
 * 2. worker scripts — written as `quac-<name>` with a hardening prelude
 *    prepended (below). Untrusted rule SQL executes inside that worker, and
 *    every SQL-level gate proved unusable in duckdb-wasm
 *    (`enable_external_access=false` is one-way and kills the COPY/loadData
 *    round trip; `lock_configuration` breaks data-table's per-load
 *    `SET TimeZone`; `disabled_filesystems` does not govern its XHR path) —
 *    so the network is removed at the platform level instead: the prelude
 *    stubs XHR dead and restricts fetch to same-origin .wasm files.
 * 3. extensions — duckdb-wasm 1.33.1-dev57.0 does NOT link parquet/icu/json
 *    statically; it autoloads them from extensions.duckdb.org at first use
 *    (parquet: any COPY TO parquet; icu: data-table's SET TimeZone on every
 *    loadData). They are vendored here at build time and served same-origin;
 *    the bridge points custom_extension_repository at this directory.
 *
 *    These six files are the ONE input to the deployed site that does not
 *    come from `npm ci` and is therefore not covered by `package-lock.json`'s
 *    integrity hashes: a plain `fetch` over the public internet whose bytes
 *    then execute inside the worker that runs untrusted rule SQL. So they are
 *    pinned by SHA-256 below (P22), and the check applies to BOTH freshly
 *    downloaded and already-cached bytes — the previous freshness test was
 *    `size > 0`, which accepts any 20 MB of anything that happens to be
 *    sitting at the path. Hashing all six costs ~20 ms per build (measured).
 *
 *    Updating them is deliberate: bump `DUCKDB_CORE_VERSION`, delete
 *    `public/duckdb/extensions/`, run the script, and it will fail printing
 *    the observed hashes — verify those against the release before pasting
 *    them in. Two independent downloads agreeing is the minimum evidence.
 *
 * Bundle URLs are built in src/core/bridge/bridge.ts.
 *
 * ---
 * **Deferred (P22): a GitHub Actions cache for the ~20 MB cold download.**
 * Phase-03 bundled this with the hash pinning above; they deserve opposite
 * answers. The pinning is a supply-chain fix that changes what runs; a cache
 * is CI-only wall-clock on a step that costs a few seconds, and it is exactly
 * the kind of unasked-for change the no-scope-creep rule exists for. Recorded
 * here rather than argued about later, and now SAFE to add because the hash
 * check above runs on cache hits too:
 *
 *     - uses: actions/cache@v4
 *       with:
 *         path: public/duckdb/extensions
 *         key: duckdb-ext-${{ hashFiles('scripts/copy-duckdb-assets.mjs') }}
 *
 * Keying on the script's own hash is what makes it correct: both
 * `DUCKDB_CORE_VERSION` and `EXTENSION_SHA256` live in this file, so any
 * change to either invalidates the cache. Restore it before `npm ci` in each
 * job that runs a `pre*` hook (`build`, `test:browser`, `test:e2e`).
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM_FILES = ['duckdb-mvp.wasm', 'duckdb-eh.wasm'];
const WORKER_FILES = ['duckdb-browser-mvp.worker.js', 'duckdb-browser-eh.worker.js'];

/**
 * DuckDB core version inside the pinned duckdb-wasm build — the extension
 * repository path component. Verified below against the eh binary so a
 * duckdb-wasm bump that forgets to update this constant fails loudly.
 */
const DUCKDB_CORE_VERSION = 'v1.5.4';
const EXTENSION_REPO = 'https://extensions.duckdb.org';
const EXTENSIONS = ['parquet', 'icu', 'json'];
const EXTENSION_PLATFORMS = ['wasm_eh', 'wasm_mvp'];

/**
 * SHA-256 of each vendored extension at `DUCKDB_CORE_VERSION`, keyed
 * `<platform>/<name>`. Recorded 2026-07-30 from two independent downloads of
 * `extensions.duckdb.org/v1.5.4/…` that agreed byte for byte. Every entry must
 * change when `DUCKDB_CORE_VERSION` does — that is the point.
 * @type {Readonly<Record<string, string>>}
 */
const EXTENSION_SHA256 = {
  'wasm_eh/parquet': '4845705bbd69fc9ad52878d96a505c73cae4a6c509822079cc2413e5eb437f95',
  'wasm_eh/icu': 'ecdbbb29331f72103b8eb227db5792f186b191a4f7a359db8dda9919b0a736de',
  'wasm_eh/json': '993b19f7929cc305b2529c548f2842e8e7a5b112d1c88f31c84798b51901ca16',
  'wasm_mvp/parquet': 'b64c255a7f7d06cc234535b2f0ecab345fda91bffff5509d3179004bc13aa19a',
  'wasm_mvp/icu': 'e12652f2953fbf0183c5354443c8e7547ec620958baa9ad303db23f46bdd6eac',
  'wasm_mvp/json': '15a89d3fd0fa3449c0d8981e6cb1ca6be8df4bcaf0dfdd6660c17bcc3bdf0af8',
};

const PRELUDE = `/* QuaC hardening prelude — generated by scripts/copy-duckdb-assets.mjs.
   Untrusted rule SQL executes in this worker (architecture.md §8, Verified
   facts V6). SQL-level gates are unusable in duckdb-wasm, so the network is
   removed at the platform level: only same-origin requests for the exact
   vendored files (boot binary + extensions) may leave this worker, via fetch
   (boot) or sync XHR (the extension installer). Everything else is refused
   locally — no request is made, and the XHR subclass synthesizes an HTTP 404
   so the glue's 'if (status >= 400) return 0' guards fail soft.
   XMLHttpRequest must stay a constructor ('typeof XMLHttpRequest' is
   duckdb-wasm's browser-vs-node probe) and send() must not throw — a JS
   exception inside a wasm-called import trips the EH machinery.
   Data never leaves the browser. */
(function () {
  'use strict';
  var realFetch = typeof fetch === 'function' ? fetch.bind(self) : null;
  var RealXHR = self.XMLHttpRequest;
  var ALLOWED_PATH =
    /\\/duckdb\\/(?:duckdb-(?:mvp|eh)\\.wasm|extensions\\/.+\\/(?:${EXTENSIONS.join('|')})\\.duckdb_extension\\.wasm)$/;
  function blocked(what) {
    return new Error('QuaC: ' + what + ' is disabled inside the DuckDB worker');
  }
  function allowedUrl(raw) {
    try {
      var url = new URL(String(raw), self.location.href);
      return url.origin === self.origin && ALLOWED_PATH.test(url.pathname);
    } catch (e) {
      return false;
    }
  }
  self.fetch = function (input) {
    var raw = typeof Request !== 'undefined' && input instanceof Request ? input.url : input;
    if (realFetch && allowedUrl(raw)) {
      return realFetch.apply(self, arguments);
    }
    return Promise.reject(blocked('fetch of ' + String(raw)));
  };
  if (typeof RealXHR === 'function') {
    class GuardedXHR extends RealXHR {
      open(method, url, isAsync, user, password) {
        this.__quacBlocked = !allowedUrl(url);
        if (this.__quacBlocked) {
          return;
        }
        if (arguments.length < 3) {
          return super.open(method, url);
        }
        return super.open(method, url, isAsync, user, password);
      }
      setRequestHeader(name, value) {
        if (this.__quacBlocked) {
          return;
        }
        return super.setRequestHeader(name, value);
      }
      abort() {
        if (this.__quacBlocked) {
          return;
        }
        return super.abort();
      }
      getAllResponseHeaders() {
        return this.__quacBlocked ? '' : super.getAllResponseHeaders();
      }
      getResponseHeader(name) {
        return this.__quacBlocked ? null : super.getResponseHeader(name);
      }
      send(body) {
        if (this.__quacBlocked) {
          if (typeof this.onreadystatechange === 'function') {
            this.onreadystatechange();
          }
          if (typeof this.onerror === 'function') {
            this.onerror(blocked('XMLHttpRequest'));
          }
          return;
        }
        return super.send(body);
      }
      get status() {
        return this.__quacBlocked ? 404 : super.status;
      }
      get statusText() {
        return this.__quacBlocked ? 'QuaC: network access is disabled' : super.statusText;
      }
      get readyState() {
        return this.__quacBlocked ? 4 : super.readyState;
      }
      get response() {
        return this.__quacBlocked ? null : super.response;
      }
      get responseText() {
        return this.__quacBlocked ? '' : super.responseText;
      }
    }
    self.XMLHttpRequest = GuardedXHR;
  }
  self.WebSocket = undefined;
  self.EventSource = undefined;
  self.importScripts = function () {
    throw blocked('importScripts');
  };
})();
`;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
const outDir = join(root, 'public', 'duckdb');

/** @param {string} message */
function fail(message) {
  console.error(`copy-duckdb-assets: FAIL — ${message}`);
  process.exit(1);
}

if (!existsSync(srcDir)) {
  fail(`${srcDir} not found. Run \`npm ci\` first.`);
}

mkdirSync(outDir, { recursive: true });

/** @param {string} file */
function mustStat(file) {
  const src = join(srcDir, file);
  if (!existsSync(src)) {
    fail(`${file} missing from @duckdb/duckdb-wasm/dist (layout changed?)`);
  }
  return { src, stat: statSync(src) };
}

let written = 0;
let fresh = 0;

for (const file of WASM_FILES) {
  const { src, stat } = mustStat(file);
  const out = join(outDir, file);
  if (existsSync(out)) {
    const outStat = statSync(out);
    if (outStat.size === stat.size && outStat.mtimeMs >= stat.mtimeMs) {
      fresh += 1;
      continue;
    }
  }
  copyFileSync(src, out);
  written += 1;
}

// A duckdb-wasm bump changes the core version → extension URLs must move too.
if (!readFileSync(join(outDir, 'duckdb-eh.wasm')).includes(DUCKDB_CORE_VERSION)) {
  fail(
    `duckdb-eh.wasm does not contain "${DUCKDB_CORE_VERSION}" — update DUCKDB_CORE_VERSION to match the installed @duckdb/duckdb-wasm`,
  );
}

for (const file of WORKER_FILES) {
  const { src } = mustStat(file);
  const out = join(outDir, `quac-${file}`);
  const content = PRELUDE + readFileSync(src, 'utf8');
  if (existsSync(out) && readFileSync(out, 'utf8') === content) {
    fresh += 1;
    continue;
  }
  writeFileSync(out, content);
  written += 1;
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

for (const platform of EXTENSION_PLATFORMS) {
  const extDir = join(outDir, 'extensions', DUCKDB_CORE_VERSION, platform);
  mkdirSync(extDir, { recursive: true });
  for (const name of EXTENSIONS) {
    const file = `${name}.duckdb_extension.wasm`;
    const key = `${platform}/${name}`;
    const out = join(extDir, file);
    const expected = EXTENSION_SHA256[key];
    if (expected === undefined) {
      fail(`no pinned SHA-256 for ${key} — add one to EXTENSION_SHA256`);
      break;
    }

    // Cached bytes get the same check as downloaded ones. A file on disk is
    // not evidence of anything: it was written by an earlier run of this
    // script, or by whatever else can reach a gitignored directory.
    if (existsSync(out) && statSync(out).size > 0) {
      const actual = sha256(readFileSync(out));
      if (actual !== expected) {
        fail(
          `cached ${key} does not match its pinned SHA-256\n` +
            `  expected ${expected}\n  actual   ${actual}\n` +
            `  delete public/duckdb/extensions/ and re-run to refetch`,
        );
      }
      fresh += 1;
      continue;
    }

    const url = `${EXTENSION_REPO}/${DUCKDB_CORE_VERSION}/${platform}/${file}`;
    const response = await fetch(url);
    if (!response.ok) {
      fail(`download of ${url} returned HTTP ${String(response.status)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expected) {
      // Nothing is written: the mismatched bytes must not land somewhere a
      // later run could mistake for a cache hit, and must never be served.
      fail(
        `${url} does not match its pinned SHA-256 — NOT written\n` +
          `  expected ${expected}\n  actual   ${actual}\n` +
          `  if this is an intended upgrade, verify the new bytes against the ` +
          `DuckDB release and update EXTENSION_SHA256`,
      );
    }
    writeFileSync(out, bytes);
    written += 1;
  }
}

console.log(`copy-duckdb-assets: OK — ${written} written, ${fresh} up to date in public/duckdb/`);
