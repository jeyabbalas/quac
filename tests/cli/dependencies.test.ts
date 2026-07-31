/**
 * The packaging gate (P22): `dependencies` is exactly what the built binary
 * imports — no more, no less.
 *
 * **Why "no more" matters.** `npm i -g @jeyabbalas/quac` installs the transitive closure
 * of `dependencies`. Before this commit that closure included duckdb-wasm,
 * eight CodeMirror packages, three webfonts and a browser data grid: ~100 MB
 * of browser assets downloaded onto a machine running a Node program that
 * renders nothing. Every one of them was a real import somewhere in `src/`,
 * just never on a path `vite.cli.config.ts` reaches.
 *
 * **Why "no less" matters more.** The CLI build is an SSR build, so every bare
 * specifier stays external and is resolved at RUN time from the user's
 * `node_modules`. A package that is imported but not declared does not fail
 * the build, does not fail `npm pack`, and does not fail any test that runs in
 * this repo — it fails on a stranger's laptop, on first use, with
 * `ERR_MODULE_NOT_FOUND`. Set equality in BOTH directions is the only check
 * that catches that, which is why this test parses the emitted bytes rather
 * than trusting the import graph in source.
 *
 * It reads `dist-cli/*.mjs`, which `pretest:cli` has just rebuilt — the same
 * artifact `npm pack` ships, not a re-derivation of it. Static and dynamic
 * imports both count: `exceljs`, `xlsx` and the three `ajv` entries are
 * reached only through `import()`, and a runtime dependency is a runtime
 * dependency whether or not it is on the startup path.
 */
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO } from './support';

interface PackageJson {
  name?: string;
  bin?: Record<string, string>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
}

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/**
 * `ajv/dist/2019.js` is a deep import into the `ajv` package, and `npm` only
 * knows about the package. Fold every specifier down to its installable name:
 * `@scope/name/sub` → `@scope/name`, `name/sub` → `name`.
 */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

let pkg: PackageJson;
let imported: Set<string>;
/** Kept for the failure message: which file each package came from. */
let sources: Map<string, string[]>;

beforeAll(async () => {
  pkg = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')) as PackageJson;

  await init;
  imported = new Set();
  sources = new Map();

  const distCli = join(REPO, 'dist-cli');
  const files = (await readdir(distCli)).filter((f) => f.endsWith('.mjs')).sort();
  // If the build ever stopped emitting, an empty scan would pass the
  // "nothing undeclared" half trivially.
  expect(files.length, 'dist-cli/ has no .mjs — did pretest:cli run?').toBeGreaterThanOrEqual(2);

  for (const file of files) {
    const source = await readFile(join(distCli, file), 'utf8');
    const [imports] = parse(source, file);
    for (const spec of imports) {
      // `n` is undefined for a computed dynamic specifier — `import(x + y)` —
      // which the SSR build does not emit, and which this test would have no
      // way to resolve if it did.
      if (spec.n === undefined) continue;
      // Relative specifiers are the build's own chunks; builtins ship with Node.
      if (spec.n.startsWith('.') || spec.n.startsWith('/')) continue;
      if (NODE_BUILTINS.has(spec.n)) continue;
      const name = packageNameOf(spec.n);
      imported.add(name);
      sources.set(name, [...new Set([...(sources.get(name) ?? []), file])]);
    }
  }
});

describe('dependencies match the built binary', () => {
  it('declares every package dist-cli imports', () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const undeclared = [...imported].filter((name) => !declared.has(name)).sort();
    expect(
      undeclared,
      `imported by dist-cli but missing from dependencies — these would be ` +
        `ERR_MODULE_NOT_FOUND on a user's machine: ` +
        undeclared.map((n) => `${n} (${(sources.get(n) ?? []).join(', ')})`).join('; '),
    ).toEqual([]);
  });

  it('declares nothing dist-cli does not import', () => {
    const declared = Object.keys(pkg.dependencies ?? {}).sort();
    const unused = declared.filter((name) => !imported.has(name));
    expect(
      unused,
      'declared in dependencies but never imported by dist-cli — every ' +
        'installer of `quac` downloads these for nothing',
    ).toEqual([]);
  });

  it('is the expected eight, named explicitly', () => {
    // Set equality above is the invariant; this is the readable statement of
    // it, so a diff that changes the shipped surface has to say so out loud.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@duckdb/node-api',
      '@jitl/quickjs-wasmfile-release-sync',
      'ajv',
      'ajv-formats',
      'exceljs',
      'papaparse',
      'quickjs-emscripten-core',
      'xlsx',
    ]);
  });

  it('keeps the browser-only packages out of the install', () => {
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
    // The expensive ones, by name: duckdb-wasm is ~100 MB installed and the
    // grid pulls CodeMirror behind it. None of this belongs on a CLI user's
    // disk, and `@jeyabbalas/data-table` staying here is what keeps
    // `tests/unit/core/sql-identifier.test.ts` able to run at all.
    for (const name of ['@duckdb/duckdb-wasm', '@jeyabbalas/data-table', '@codemirror/view']) {
      expect(dev.has(name), `${name} should be a devDependency`).toBe(true);
      expect(imported.has(name), `${name} must not reach dist-cli`).toBe(false);
    }
  });
});

describe('a scoped package publishes publicly, and still installs `quac`', () => {
  it('declares publishConfig.access = public', () => {
    // The registry refused the unscoped name `quac` at publish time — "too
    // similar to existing package cac" — which `npm view quac` (a 404) does
    // not predict, because the similarity check runs on PUT. Scoping is the
    // fix, and it drags a second rule in with it: a scoped package defaults
    // to RESTRICTED, so without this field `npm publish` either fails on a
    // free account or quietly publishes a private package. Declared here
    // rather than passed as `--access=public`, so the release workflow gets
    // it too and no invocation can forget.
    expect(pkg.name).toBe('@jeyabbalas/quac');
    expect(pkg.publishConfig?.access).toBe('public');
  });

  it('keeps the command itself unscoped', () => {
    // `bin` names the command, not the package. The README promises that
    // installing `@jeyabbalas/quac` gives you `quac`, and this is that promise.
    expect(Object.keys(pkg.bin ?? {})).toEqual(['quac']);
  });
});

describe('no dependency field npm would install behind our back', () => {
  it('declares neither optionalDependencies nor peerDependencies', () => {
    // npm's `omit` default is `[]` — `optionalDependencies` are INSTALLED by
    // default, exactly like `dependencies`, and only skipped under
    // `--omit=optional`. So an "optional" browser package would ship to every
    // CLI user anyway, and the two assertions above would not see it.
    // `peerDependencies` auto-install too (npm 7+). Neither field is used
    // today; this fails the moment one appears, so the check above stays the
    // whole story about what an install pulls down.
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });
});
