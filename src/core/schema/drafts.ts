/**
 * Which JSON Schema draft a file declares, read off its `$schema`.
 *
 * Ajv finds a meta-schema by the EXACT text of `$schema`, and registers each
 * under one spelling: `https://json-schema.org/draft/2020-12/schema`,
 * `http://json-schema.org/draft-07/schema#`, and so on. People write the same
 * URI several ways — `https://json-schema.org/draft-07/schema`, with or
 * without the `#`, `http:` for a 2020-12 URI — and every one of those used to
 * reach the user as Ajv's `no schema with key or ref …`. Here each spelling
 * of a known meta-schema maps to its draft, and `canonicalMetaSchemaUri` gives
 * the spelling Ajv knows, so the copy handed to Ajv can carry that instead.
 *
 * A `$schema` QuaC does not recognise (a custom meta-schema) reads as
 * `'unknown'` — 2020-12 — with `recognized: false`, so the loader can say so
 * (`W_UNKNOWN_DRAFT`). draft-04 and draft-03 read as `'draft-04'`, which the
 * loader refuses (`E_UNSUPPORTED_DRAFT`): their `exclusiveMaximum: true` and
 * `id` mean something else in every draft QuaC validates with.
 *
 * Pure and dependency-free — imported by the loader at intake, which is
 * entry-reachable, so nothing here may pull in Ajv.
 */
import type { SchemaDraft } from './types';

export interface DraftDeclaration {
  draft: SchemaDraft;
  /** The `$schema` text, when the file has one. */
  declared?: string;
  /** False for a `$schema` that names no meta-schema QuaC knows. */
  recognized: boolean;
}

/** The meta-schema URIs, as Ajv registers them. */
const CANONICAL: Readonly<Record<'2020-12' | '2019-09' | 'draft-07' | 'draft-06', string>> = {
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
  '2019-09': 'https://json-schema.org/draft/2019-09/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
  'draft-06': 'http://json-schema.org/draft-06/schema#',
};

/**
 * Every spelling of a known meta-schema: http or https, with or without an
 * empty fragment. The hyper-schema of a draft extends its validation
 * vocabulary, so it validates as that draft. `…/schema` with no draft is the
 * old "latest" alias — read as 2020-12, the latest QuaC validates.
 */
const KNOWN: readonly (readonly [RegExp, SchemaDraft])[] = [
  [/^https?:\/\/json-schema\.org\/draft\/2020-12\/(?:hyper-)?schema#?$/, '2020-12'],
  [/^https?:\/\/json-schema\.org\/draft\/2019-09\/(?:hyper-)?schema#?$/, '2019-09'],
  [/^https?:\/\/json-schema\.org\/draft-07\/(?:hyper-)?schema#?$/, 'draft-07'],
  [/^https?:\/\/json-schema\.org\/draft-06\/(?:hyper-)?schema#?$/, 'draft-06'],
  [/^https?:\/\/json-schema\.org\/draft-0[34]\/(?:hyper-)?schema#?$/, 'draft-04'],
  [/^https?:\/\/json-schema\.org\/(?:hyper-)?schema#?$/, 'unknown'],
];

/** The draft a parsed schema file declares. Never throws. */
export function readDraft(json: unknown): DraftDeclaration {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { draft: 'unknown', recognized: true };
  }
  const declared = (json as Record<string, unknown>).$schema;
  if (typeof declared !== 'string') return { draft: 'unknown', recognized: true };
  const uri = declared.trim();
  for (const [pattern, draft] of KNOWN) {
    if (pattern.test(uri)) return { draft, declared, recognized: true };
  }
  return { draft: 'unknown', declared, recognized: false };
}

/** The draft a set validates with: `'unknown'` is 2020-12. */
export function effectiveDraft(draft: SchemaDraft): Exclude<SchemaDraft, 'unknown'> {
  return draft === 'unknown' ? '2020-12' : draft;
}

/** The `$schema` spelling Ajv registers for a draft it validates (undefined for draft-04). */
export function canonicalMetaSchemaUri(draft: SchemaDraft): string | undefined {
  const effective = effectiveDraft(draft);
  return effective === 'draft-04' ? undefined : CANONICAL[effective];
}

/** The drafts QuaC validates, as the refusal message lists them. */
export const SUPPORTED_DRAFTS = ['draft-06', 'draft-07', '2019-09', '2020-12'] as const;
