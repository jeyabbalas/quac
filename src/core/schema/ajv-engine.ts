/**
 * Ajv construction, registration, and the `#/items` pointer compile
 * (json-schema-subsystem.md §B.1–§B.3).
 *
 * Imported ONLY by the validation worker and node tests — never from
 * entry-reachable code (Ajv would otherwise land in the entry chunk; the
 * worker chunk and node are the sanctioned homes, §B.1 CSP note).
 *
 * Import style: named classes with explicit .js extensions, matching
 * meta-validate.ts and scripts/record-ajv-errors.mjs — ajv ships CJS without
 * an `exports` map, and the §B.1 default-import spelling is the one avoidable
 * interop risk through the Vite worker bundle (cosmetic deviation from §B.1).
 */
import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type AjvCore from 'ajv/dist/core';
import type { AnySchema, ValidateFunction } from 'ajv';
import type { SchemaDraft } from './types';

/** A schema document ready for Ajv registration (worker init payload shape). */
export interface RegisterableFile {
  /** Registration key: the file's retrievalUri (§B.2 — `quac-set:/…` or URL). */
  uri: string;
  json: unknown;
}

export interface MetaError {
  uri: string;
  message: string;
}

/**
 * §B.1 construction: one instance per set, class chosen by the ROOT file's
 * draft ('unknown' ⇒ 2020-12). QC needs every failure (allErrors) with the
 * failing data/schema attached (verbose — the translator reads titles);
 * user schemas carry x-* annotation keywords (strict off); casting is
 * DuckDB's job (§C — coercion would mask cast findings).
 */
export function buildAjv(draft: SchemaDraft): AjvCore {
  const Ctor = draft === 'draft-07' ? Ajv : draft === '2019-09' ? Ajv2019 : Ajv2020;
  const ajv = new Ctor({
    allErrors: true,
    verbose: true,
    strict: false,
    validateSchema: true,
    coerceTypes: false,
    $data: false,
    code: { optimize: 1 },
  });
  addFormats(ajv);
  return ajv;
}

/** Draft of a schema document from its `$schema` (absent ⇒ 'unknown' ⇒ root draft). */
export function schemaDraftOf(json: unknown): SchemaDraft {
  if (typeof json !== 'object' || json === null) return 'unknown';
  const declared = (json as Record<string, unknown>).$schema;
  if (typeof declared !== 'string') return 'unknown';
  if (declared.includes('2020-12')) return '2020-12';
  if (declared.includes('2019-09')) return '2019-09';
  if (declared.includes('draft-07')) return 'draft-07';
  return 'unknown';
}

/**
 * §B.2 pre-registration guard: `validateSchema` EVERY file and collect all
 * failures before any `addSchema` (which throws on the first). Files
 * declaring a different KNOWN draft are skipped — their meta-schema is
 * absent on this instance and `E_MIXED_DRAFT` already covers the situation
 * (mirrors meta-validate.ts; validating them here would turn a sanctioned
 * warning into a runtime fatal).
 */
export function collectMetaErrors(
  ajv: AjvCore,
  files: readonly RegisterableFile[],
  draft: SchemaDraft,
): MetaError[] {
  const effectiveDraft = draft === 'unknown' ? '2020-12' : draft;
  const errors: MetaError[] = [];
  for (const file of files) {
    const fileDraft = schemaDraftOf(file.json);
    if (fileDraft !== 'unknown' && fileDraft !== effectiveDraft) continue;
    let valid: boolean | Promise<unknown>;
    try {
      valid = ajv.validateSchema(file.json as AnySchema);
    } catch (err) {
      errors.push({ uri: file.uri, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (valid === false) {
      const first = ajv.errors?.[0];
      const where = first?.instancePath ? ` at ${first.instancePath}` : '';
      errors.push({
        uri: file.uri,
        message: `${first?.message ?? 'does not match the meta-schema'}${where}`,
      });
    }
  }
  return errors;
}

/**
 * §B.2 registration under the retrievalUri key (Ajv also indexes the
 * schema's own `$id` — both resolve). Different-known-draft files are
 * skipped for the same reason as in collectMetaErrors.
 */
export function registerSchemaFiles(
  ajv: AjvCore,
  files: readonly RegisterableFile[],
  draft: SchemaDraft,
): void {
  const effectiveDraft = draft === 'unknown' ? '2020-12' : draft;
  for (const file of files) {
    const fileDraft = schemaDraftOf(file.json);
    if (fileDraft !== 'unknown' && fileDraft !== effectiveDraft) continue;
    ajv.addSchema(file.json as AnySchema, file.uri);
  }
}

/**
 * §B.3 row validator: compile the root's `items` subschema in place — the
 * base URI stays the root file's, so relative refs resolve exactly as in
 * whole-document validation, and `unevaluatedProperties` sees all cousin
 * applicators (they live inside the same `items` object).
 */
export function compileRowValidator(ajv: AjvCore, rootBase: string): ValidateFunction {
  const validate = ajv.getSchema(`${rootBase}#/items`);
  if (validate === undefined) {
    throw new Error(`schema engine: '${rootBase}#/items' failed to compile`);
  }
  return validate;
}
