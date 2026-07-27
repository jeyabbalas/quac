/**
 * Stage the HESP example inputs into public/examples/ (P14 demo affordance,
 * user-approved scope): the dirty dataset, the 14-file schema network
 * (manifest.json/README.md excluded — the demo loads a clean set), and the
 * three rules files, plus an index.json manifest the Load view's
 * "Load example files" button fetches. Single source of truth stays
 * tests/fixtures/hesp/ — public/examples/ is generated (gitignored) at
 * predev/prebuild, so the deployed site serves the same bytes the tests pin.
 *
 * All 14 schema files are COPIED; index.json lists only the root as a crawl
 * base (UX-07 — see example-manifest.mjs for why).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASET, buildExampleIndex } from './example-manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures', 'hesp');
const out = join(root, 'public', 'examples');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { schemaFiles, rulesFiles, index } = buildExampleIndex(fixtures);

cpSync(join(fixtures, DATASET), join(out, DATASET));
for (const file of schemaFiles) cpSync(join(fixtures, file), join(out, file));
for (const file of rulesFiles) cpSync(join(fixtures, file), join(out, file));

writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log(
  `copy-example-assets: staged ${String(1 + schemaFiles.length + rulesFiles.length)} files → public/examples/ ` +
    `(${String(index.schema.length)} schema crawl base)`,
);
