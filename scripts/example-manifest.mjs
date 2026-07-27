/**
 * The shape of public/examples/index.json, shared by the generator
 * (copy-example-assets.mjs) and the length pin (tests/unit/core/share/
 * exampleLink.test.ts) so the two cannot drift.
 *
 * UX-07: `schema` carries the ROOT ONLY, not all 14 files. Every other schema
 * file is `$ref`-reachable from it, so `loadSchemaUrls` crawls to the same
 * 14-file set from one crawl base — while the share link the session writes
 * costs one `schema=` param instead of fourteen. With all fourteen inline the
 * bundled example's own link measured 2062 chars at
 * https://jeyabbalas.github.io/quac/ — over the 2,000-char portability limit on
 * the very site QuaC ships to, though only 1965 (under) at a localhost preview,
 * which is why local testing never saw it.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const DATASET = 'data/hesp_dirty_100.csv';
export const SCHEMA_ROOT = 'json_schema/core/core.schema.json';

/**
 * Recursively list files under dir, repo-relative to `base`.
 * @param {string} dir
 * @param {string} base
 * @returns {string[]}
 */
export function listFiles(dir, base) {
  /** @type {string[]} */
  const entries = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) entries.push(...listFiles(full, base));
    else entries.push(relative(base, full));
  }
  return entries.sort();
}

/**
 * Everything the demo stages, plus the index.json the Load view fetches.
 * `schemaFiles` is what gets COPIED; `index.schema` is what gets LOADED.
 * @param {string} fixtures Path to tests/fixtures/hesp.
 * @returns {{ schemaFiles: string[], rulesFiles: string[], index: {
 *   title: string, dataset: string, schema: string[], rules: string[] } }}
 */
export function buildExampleIndex(fixtures) {
  const schemaFiles = listFiles(join(fixtures, 'json_schema'), fixtures).filter(
    (p) => p.endsWith('.json') && !p.endsWith('manifest.json'),
  );
  const rulesFiles = listFiles(join(fixtures, 'rules'), fixtures).filter((p) =>
    p.endsWith('.quac.csv'),
  );

  // A fixture rename must fail here, loudly, rather than ship a demo whose one
  // crawl base 404s and whose schema slot silently comes back empty.
  if (!schemaFiles.includes(SCHEMA_ROOT)) {
    throw new Error(
      `example-manifest: schema root ${SCHEMA_ROOT} is not among the staged schema files ` +
        `(found ${String(schemaFiles.length)}). Update SCHEMA_ROOT if the fixtures moved.`,
    );
  }

  return {
    schemaFiles,
    rulesFiles,
    index: {
      title: `HESP example — dirty mock dataset, ${String(schemaFiles.length)}-file JSON Schema, ${String(rulesFiles.length)} QC rules files`,
      dataset: DATASET,
      // The root alone — the $ref crawl finds the rest. See the header note.
      schema: [SCHEMA_ROOT],
      rules: rulesFiles,
    },
  };
}
