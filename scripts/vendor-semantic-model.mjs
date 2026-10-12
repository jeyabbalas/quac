/**
 * Self-host the semantic-search model: MongoDB's LEAF-IR (`MongoDB/mdbr-leaf-ir`),
 * the embedding model behind the data dictionary's Semantic search switch.
 * Wired as predev/prebuild, beside copy-duckdb-assets.mjs and for the same
 * reason: after the page loads, QuaC makes no third-party request at all
 * (README → Privacy, network-isolation.spec). json-schema-data-dictionary's
 * semantic search would fetch the weights from huggingface.co at first use;
 * QuaC serves them from its own site instead, from public/models/ (gitignored,
 * derived, ~70 MB), at the path Transformers.js reads a local model from:
 * `models/MongoDB/mdbr-leaf-ir/…`.
 *
 * Only what QuaC runs is vendored: the tokenizer, the config, and the weights
 * at the two precisions json-schema-data-dictionary verified for this model —
 * fp16 on WebGPU (`model_fp16.onnx`, 46 MB) and q8 on WebAssembly
 * (`model_quantized.onnx`, 23 MB). Each `.onnx` file is a small graph whose
 * weights live in the `.onnx_data` file beside it (config.json's
 * `transformers.js_config.use_external_data_format`). The fp32 weights (91 MB),
 * which the library would pick for WebGPU without `shader-f16`, are left out:
 * semanticModel.ts runs such browsers on WebAssembly instead.
 *
 * Like DuckDB's extensions these files come from neither `npm ci` nor
 * `package-lock.json`, so they are pinned twice: by REVISION (a Hugging Face
 * commit, so the URLs cannot move under us) and by SHA-256 per file, checked on
 * freshly downloaded AND on already-cached bytes. Recorded 2026-10-11 at
 * revision 4262131b: the weights' hashes are the LFS object ids Hugging Face's
 * API lists for that commit, matched by a download; the JSON files' are the
 * SHA-256 of downloads whose git blob ids matched the ones the API lists.
 *
 * Updating is deliberate: change REVISION, delete public/models/, run the
 * script, and it fails printing each observed hash. Check those against the
 * LFS ids at https://huggingface.co/api/models/MongoDB/mdbr-leaf-ir/revision/<REVISION>?blobs=true
 * before pasting them in.
 *
 * The model is Apache-2.0. The licence text ships beside the weights (copied
 * from @huggingface/transformers, whose LICENSE is the same Apache-2.0 text),
 * with a NOTICE naming the source, since the Hub repository carries no licence
 * file of its own.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODEL = 'MongoDB/mdbr-leaf-ir';
export const REVISION = '4262131b32c3182bd06e67e92ae69d7bd66e0c5c';

/**
 * Every file served, by its path inside the model directory → SHA-256.
 * @type {Readonly<Record<string, string>>}
 */
export const MODEL_FILES = {
  'config.json': '258407cfa27c7e1e502a9c312abebb4f5241bf226972ffc366287f370a3567f1',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '46ac231e9b955a8af80fc7f23a0ecc65b524f1df84a02c2c82cbca354fb207b4',
  'onnx/model_quantized.onnx': '8c08cb4ecc00bad721b117a85738c537ceb9b85b3eedc52d9c6906fddaa55718',
  'onnx/model_quantized.onnx_data':
    'e77ea96a124230e23e5bac8e26c3ffe5410154973d8635673fa0220b06c13f8b',
  'onnx/model_fp16.onnx': 'fc5500b7995c736f56b12329d38f8efc376a35532cdf359a07f5e5e3b1c1210a',
  'onnx/model_fp16.onnx_data': 'e90acb605423040c7cf94d085a6bd9747af654e44081979a33e9fd3e57e67a9d',
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models', ...MODEL.split('/'));

/** @param {string} message */
function fail(message) {
  console.error(`vendor-semantic-model: FAIL — ${message}`);
  process.exit(1);
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const NOTICE = `This directory holds files of the LEAF-IR text-embedding model,
MongoDB/mdbr-leaf-ir (https://huggingface.co/MongoDB/mdbr-leaf-ir),
revision ${REVISION}, copied unmodified.
They are licensed under the Apache License, Version 2.0 (see LICENSE).

QuaC serves them so that the data dictionary's semantic search runs entirely
in the browser, without any request to a third party.
`;

async function main() {
  mkdirSync(join(outDir, 'onnx'), { recursive: true });
  let written = 0;
  let fresh = 0;

  for (const [file, expected] of Object.entries(MODEL_FILES)) {
    const out = join(outDir, file);
    // Cached bytes get the same check as downloaded ones: a file on disk is
    // not evidence of anything (copy-duckdb-assets.mjs, P22).
    if (existsSync(out)) {
      const actual = sha256(readFileSync(out));
      if (actual !== expected) {
        fail(
          `cached ${file} does not match its pinned SHA-256\n` +
            `  expected ${expected}\n  actual   ${actual}\n` +
            `  delete public/models/ and re-run to refetch`,
        );
      }
      fresh += 1;
      continue;
    }

    const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
    const response = await fetch(url);
    if (!response.ok) fail(`download of ${url} returned HTTP ${String(response.status)}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== expected) {
      // Nothing is written: mismatched bytes must never be served, nor be
      // mistaken for a cache hit by a later run.
      fail(
        `${url} does not match its pinned SHA-256 — NOT written\n` +
          `  expected ${expected}\n  actual   ${actual}\n` +
          `  if this is an intended upgrade, check the new bytes against the ` +
          `revision's LFS ids and update MODEL_FILES`,
      );
    }
    // Write-then-rename, so an interrupted run never leaves a truncated file
    // behind under the real name.
    writeFileSync(`${out}.part`, bytes);
    renameSync(`${out}.part`, out);
    written += 1;
  }

  const license = join(root, 'node_modules', '@huggingface', 'transformers', 'LICENSE');
  if (!existsSync(license)) fail(`${license} not found. Run \`npm ci\` first.`);
  if (!readFileSync(license, 'utf8').includes('Apache License'))
    fail(`${license} is not the Apache-2.0 text`);
  copyFileSync(license, join(outDir, 'LICENSE'));
  writeFileSync(join(outDir, 'NOTICE'), NOTICE);

  console.log(
    `vendor-semantic-model: OK — ${String(written)} downloaded, ${String(fresh)} up to date in public/models/`,
  );
}

// Importable (tests read MODEL_FILES) without downloading anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
