/**
 * `$schema` → draft (src/core/schema/drafts.ts): every spelling of a known
 * meta-schema URI — https or http, with or without the empty fragment — maps
 * to its draft; draft-04/03 are recognised so the loader can refuse them; a
 * custom meta-schema reads as 2020-12, unrecognised.
 */
import { describe, expect, it } from 'vitest';
import { canonicalMetaSchemaUri, effectiveDraft, readDraft } from '../../../src/core/schema/drafts';

describe('readDraft', () => {
  it('reads every spelling of the known meta-schemas', () => {
    const cases: [string, string][] = [
      ['https://json-schema.org/draft/2020-12/schema', '2020-12'],
      ['http://json-schema.org/draft/2020-12/schema#', '2020-12'],
      ['https://json-schema.org/draft/2020-12/hyper-schema', '2020-12'],
      ['https://json-schema.org/draft/2019-09/schema', '2019-09'],
      ['http://json-schema.org/draft-07/schema#', 'draft-07'],
      ['https://json-schema.org/draft-07/schema', 'draft-07'],
      ['http://json-schema.org/draft-07/schema', 'draft-07'],
      ['http://json-schema.org/draft-06/schema#', 'draft-06'],
      ['http://json-schema.org/draft-04/schema#', 'draft-04'],
      ['http://json-schema.org/draft-03/schema#', 'draft-04'],
      ['http://json-schema.org/schema#', 'unknown'],
    ];
    for (const [uri, draft] of cases) {
      expect(readDraft({ $schema: uri }), uri).toEqual({ draft, declared: uri, recognized: true });
    }
  });

  it('no $schema is 2020-12, recognised; a custom one is 2020-12, unrecognised', () => {
    expect(readDraft({ type: 'object' })).toEqual({ draft: 'unknown', recognized: true });
    expect(readDraft({ $schema: 'https://example.org/meta' })).toEqual({
      draft: 'unknown',
      declared: 'https://example.org/meta',
      recognized: false,
    });
    // The old substring match took any URI mentioning "2020-12".
    expect(readDraft({ $schema: 'https://example.org/my-2020-12-meta' }).recognized).toBe(false);
    expect(readDraft(null)).toEqual({ draft: 'unknown', recognized: true });
  });

  it('canonical URIs are the spellings Ajv registers', () => {
    expect(canonicalMetaSchemaUri('2020-12')).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(canonicalMetaSchemaUri('unknown')).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(canonicalMetaSchemaUri('draft-07')).toBe('http://json-schema.org/draft-07/schema#');
    expect(canonicalMetaSchemaUri('draft-06')).toBe('http://json-schema.org/draft-06/schema#');
    expect(canonicalMetaSchemaUri('draft-04')).toBeUndefined();
    expect(effectiveDraft('unknown')).toBe('2020-12');
  });
});
