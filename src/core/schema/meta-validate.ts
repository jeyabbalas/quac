/**
 * The loader's engine checks, behind one dynamic import so Ajv stays out of
 * the entry chunk (`ajv-engine.ts` is the worker's; here it is a lazy chunk):
 *
 * - `metaValidate` (`E_META`, §A.5): every schema file checked against its
 *   meta-schema before validation ever calls `addSchema` (which throws on
 *   the first failure). One instance per set, built exactly as the
 *   validation worker builds it (`buildAjv`), class chosen by the ROOT file's
 *   draft (§B.1); files of a different KNOWN draft are skipped — their
 *   meta-schema is absent on this instance and `E_MIXED_DRAFT` already covers
 *   the situation. A `$schema` spelled other than Ajv registers it (https
 *   for draft-07, a missing `#`) is read as the draft it names.
 * - `engineChecks`: `loadTimeChecks` — the record schema compiled once at
 *   load (`E_COMPILE`), and the warnings about checks QuaC will not make
 *   (`W_UNCHECKED_FORMAT`, `W_EMPTY_ENUM`, `W_REF_SIBLINGS`).
 */
import { effectiveDraft } from './drafts';
import { loadError, metaMessage } from './messages';
import type { SchemaDraft, SchemaFile, SchemaLoadError, SchemaSet } from './types';

/**
 * Collect ALL `E_META` findings for the given schema files. `rootDraft`
 * 'unknown' is treated as 2020-12 (§A.1); files declaring another draft are
 * skipped, files without `$schema` are validated under the root draft, and a
 * draft-04 file is left to `E_UNSUPPORTED_DRAFT`.
 */
export async function metaValidate(
  files: readonly SchemaFile[],
  rootDraft: SchemaDraft,
): Promise<SchemaLoadError[]> {
  const effective = effectiveDraft(rootDraft);
  if (effective === 'draft-04') return [];
  const candidates = files.filter(
    (f) =>
      f.classification !== 'invalid-json' &&
      f.draft !== 'draft-04' &&
      (f.draft === 'unknown' || f.draft === effective),
  );
  if (candidates.length === 0) return [];
  const engine = await import('./ajv-engine');
  const ajv = engine.buildAjv(effective);
  const errors: SchemaLoadError[] = [];
  for (const file of candidates) {
    let valid: boolean | Promise<unknown>;
    try {
      valid = ajv.validateSchema(engine.metaSchemaInput(file.json, effective) as object);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(
        loadError('E_META', metaMessage(file.relativePath, effective, reason, ''), {
          fileId: file.fileId,
        }),
      );
      continue;
    }
    if (valid === false) {
      const first = ajv.errors?.[0];
      errors.push(
        loadError(
          'E_META',
          metaMessage(
            file.relativePath,
            effective,
            first?.message ?? 'does not match the meta-schema',
            first?.instancePath ?? '',
          ),
          { fileId: file.fileId, meta: { errors: ajv.errors ?? [] } },
        ),
      );
    }
  }
  return errors;
}

/** The engine's load-time checks for a built set (see `loadTimeChecks`). */
export async function engineChecks(set: SchemaSet): Promise<SchemaLoadError[]> {
  const engine = await import('./ajv-engine');
  return engine.loadTimeChecks(set);
}
