/**
 * Stage the HESP example inputs into public/examples/ (P14 demo affordance,
 * user-approved scope): the dirty dataset, the 14-file schema network
 * (manifest.json/README.md excluded — the demo loads a clean set), and the
 * three rules files, plus an index.json manifest the Load view's
 * "Load example files" button fetches. Single source of truth stays
 * tests/fixtures/hesp/ — public/examples/ is generated (gitignored) at
 * predev/prebuild, so the deployed site serves the same bytes the tests pin.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures', 'hesp');
const out = join(root, 'public', 'examples');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

/**
 * Recursively list files under dir, repo-relative to `base`.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
function listFiles(dir, base) {
  /** @type {string[]} */
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...listFiles(full, base));
    else entries.push(relative(base, full));
  }
  return entries.sort();
}

const dataset = 'data/hesp_dirty_100.csv';
cpSync(join(fixtures, dataset), join(out, dataset));

const schemaFiles = listFiles(join(fixtures, 'json_schema'), fixtures).filter(
  (p) => p.endsWith('.json') && !p.endsWith('manifest.json'),
);
for (const file of schemaFiles) cpSync(join(fixtures, file), join(out, file));

const rulesFiles = listFiles(join(fixtures, 'rules'), fixtures).filter((p) =>
  p.endsWith('.quac.csv'),
);
for (const file of rulesFiles) cpSync(join(fixtures, file), join(out, file));

const index = {
  title: 'HESP example — dirty mock dataset, 14-file JSON Schema, 3 QC rules files',
  dataset,
  schema: schemaFiles,
  rules: rulesFiles,
};
writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

console.log(
  `copy-example-assets: staged ${String(1 + schemaFiles.length + rulesFiles.length)} files → public/examples/`,
);
