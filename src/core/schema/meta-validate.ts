/**
 * Ajv meta-validation (`E_META`, §A.5): every schema file is checked against
 * its meta-schema before P09 ever calls `addSchema` (which throws on first).
 * One instance per set, class chosen by the ROOT file's draft (§B.1); files of
 * a different KNOWN draft are skipped — their meta-schema is absent on this
 * instance and `E_MIXED_DRAFT` already covers the situation. Ajv is imported
 * dynamically to stay out of the entry chunk (`ajv-engine.ts` is P09's).
 */
import { loadError, metaMessage } from './messages';
import type { SchemaDraft, SchemaFile, SchemaLoadError } from './types';

interface AjvLike {
  validateSchema: (schema: unknown) => boolean | Promise<unknown>;
  errors?: { instancePath: string; message?: string }[] | null;
}

async function loadAjv(draft: Exclude<SchemaDraft, 'unknown'>): Promise<AjvLike> {
  const options = { allErrors: true, strict: false, validateSchema: true };
  if (draft === 'draft-07') {
    const { Ajv } = await import('ajv');
    return new Ajv(options) as unknown as AjvLike;
  }
  if (draft === '2019-09') {
    const { Ajv2019 } = await import('ajv/dist/2019.js');
    return new Ajv2019(options) as unknown as AjvLike;
  }
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  return new Ajv2020(options) as unknown as AjvLike;
}

/**
 * Collect ALL `E_META` findings for the given schema files. `rootDraft`
 * 'unknown' is treated as 2020-12 (§A.1); files declaring another draft are
 * skipped, files without `$schema` are validated under the root draft.
 */
export async function metaValidate(
  files: readonly SchemaFile[],
  rootDraft: SchemaDraft,
): Promise<SchemaLoadError[]> {
  const effectiveDraft = rootDraft === 'unknown' ? '2020-12' : rootDraft;
  const errors: SchemaLoadError[] = [];
  let ajv: AjvLike | undefined;

  for (const file of files) {
    if (file.classification === 'invalid-json') continue;
    if (file.draft !== 'unknown' && file.draft !== effectiveDraft) continue;
    ajv ??= await loadAjv(effectiveDraft);
    let valid: boolean | Promise<unknown>;
    try {
      valid = ajv.validateSchema(file.json);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push(
        loadError('E_META', metaMessage(file.relativePath, effectiveDraft, reason, ''), {
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
            effectiveDraft,
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
