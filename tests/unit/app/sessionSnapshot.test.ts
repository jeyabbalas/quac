// P19b: the boot decision table and the corrupt-tolerant snapshot guards.
// decideBoot arbitrates between the URL fragment and a stored session; the
// ordering trap it must survive: an uploads-only session has an EMPTY synced
// config, so "current empty ⇒ restore" must be decided before the equality
// row, or restore would masquerade as an (empty ≟ empty) refresh.
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_VERSION,
  canonicalConfigKey,
  decideBoot,
  guardDatasetRecord,
  guardMetaRecord,
  guardPrefsRecord,
  guardRulesRecord,
  guardSchemaRecord,
  guardStudioRecord,
  readStoredSession,
  toSyncedConfig,
} from '../../../src/app/sessionSnapshot';
import { decodeConfig } from '../../../src/core/share/urlConfig';
import type {
  StoredSession,
  SyncedConfig,
} from '../../../src/app/sessionSnapshot';

const SCHEMA_URL = 'https://ex.test/core.schema.json';
const RULES_URL = 'https://ex.test/rules.quac.csv';
const DATA_URL = 'https://ex.test/people.csv';

function stored(
  synced: SyncedConfig,
  slots: Partial<Pick<StoredSession, 'dataset' | 'schema' | 'rules'>> = {},
): StoredSession {
  return {
    meta: { v: SNAPSHOT_VERSION, savedAt: 1, syncedConfig: synced },
    dataset: slots.dataset ?? null,
    schema: slots.schema ?? null,
    rules: slots.rules ?? null,
    studio: null,
    prefs: null,
  };
}

const uploadDataset = () => ({
  blob: new Blob(['a,b\n1,2\n']),
  name: 'people.csv',
  format: 'csv' as const,
});
const uploadRules = () => ({
  files: [{ name: 'r.quac.csv', text: 'rule_id\nR1\n', sourceUrl: null }],
  dirty: [],
});
const urlSchema = () => ({
  entries: [{ relativePath: SCHEMA_URL, raw: '{}', retrievalUri: SCHEMA_URL }],
  origin: 'url' as const,
  sourceUrls: [SCHEMA_URL],
});

describe('decideBoot — the four rows, in order', () => {
  it('row 1: no stored session boots the fragment verbatim', () => {
    expect(decideBoot(decodeConfig(''), null)).toBe('ignore-stored');
    expect(decideBoot(decodeConfig(`schema=${encodeURIComponent(SCHEMA_URL)}`), null)).toBe(
      'ignore-stored',
    );
  });

  it('row 1: a stored session empty of slots is treated as absent', () => {
    // Guards can discard every slot record (corruption) while meta survives.
    const session = stored({ schema: [], rules: [] });
    expect(decideBoot(decodeConfig(''), session)).toBe('ignore-stored');
  });

  it('row 2: an empty fragment restores the stored session', () => {
    const session = stored({ schema: [], rules: [] }, { dataset: uploadDataset() });
    expect(decideBoot(decodeConfig(''), session)).toBe('restore-stored');
  });

  it('row 2 before row 3: an uploads-only session (empty synced config) restores', () => {
    // The trap: empty current equals empty synced. Equality-first would call
    // this a refresh; the table says a bare URL means "resume my session".
    const session = stored(
      { schema: [], rules: [] },
      { dataset: uploadDataset(), rules: uploadRules() },
    );
    expect(decideBoot(decodeConfig(''), session)).toBe('restore-stored');
  });

  it('row 3: an equal config is the normal refresh (URLs reload themselves)', () => {
    const query = `schema=${encodeURIComponent(SCHEMA_URL)}&rules=${encodeURIComponent(RULES_URL)}`;
    const session = stored(
      { schema: [SCHEMA_URL], rules: [RULES_URL] },
      { schema: urlSchema(), dataset: uploadDataset() },
    );
    expect(decideBoot(decodeConfig(query), session)).toBe('refresh-with-upload-restore');
  });

  it('row 3: passthrough params never break equality', () => {
    const query = `schema=${encodeURIComponent(SCHEMA_URL)}&theme=dark&z=1`;
    const session = stored({ schema: [SCHEMA_URL], rules: [] }, { schema: urlSchema() });
    expect(decideBoot(decodeConfig(query), session)).toBe('refresh-with-upload-restore');
  });

  it('row 3: a divergent index= pin never breaks equality', () => {
    // The refetch leg hands the CURRENT link's index= to the schema loader
    // regardless of what was stored, so demoting the refresh over a stale pin
    // would only drop the uploads it protects.
    const query = `schema=${encodeURIComponent(SCHEMA_URL)}&index=other.json`;
    const session = stored(
      { schema: [SCHEMA_URL], rules: [], index: 'core.schema.json' },
      { schema: urlSchema(), dataset: uploadDataset() },
    );
    expect(decideBoot(decodeConfig(query), session)).toBe('refresh-with-upload-restore');
  });

  it('row 4: a different link wins wholesale', () => {
    const session = stored(
      { schema: [SCHEMA_URL], rules: [] },
      { schema: urlSchema(), dataset: uploadDataset() },
    );
    const other = decodeConfig(`schema=${encodeURIComponent('https://other.test/s.json')}`);
    expect(decideBoot(other, session)).toBe('ignore-stored');
  });

  it('row 4: a dataset-URL mismatch is a different link too', () => {
    const session = stored(
      { schema: [], rules: [], data: DATA_URL },
      { dataset: { ...uploadDataset(), sourceUrl: DATA_URL } },
    );
    const other = decodeConfig(`data=${encodeURIComponent('https://other.test/d.csv')}`);
    expect(decideBoot(other, session)).toBe('ignore-stored');
  });

  it('rules order is semantic: a reordered rules= list is a different link', () => {
    const a = 'https://ex.test/a.quac.csv';
    const b = 'https://ex.test/b.quac.csv';
    const session = stored({ schema: [], rules: [a, b] }, { rules: uploadRules() });
    const reordered = decodeConfig(
      `rules=${encodeURIComponent(b)}&rules=${encodeURIComponent(a)}`,
    );
    expect(decideBoot(reordered, session)).toBe('ignore-stored');
  });
});

describe('canonicalConfigKey', () => {
  it('drops passthrough and config=, keeps slot keys and their order', () => {
    const config = decodeConfig(
      `schema=${encodeURIComponent(SCHEMA_URL)}&theme=dark&config=${encodeURIComponent(
        'https://ex.test/manifest.json',
      )}`,
    );
    expect(canonicalConfigKey(config)).toBe(`schema=${encodeURIComponent(SCHEMA_URL)}`);
  });

  it('is the same codec the bar round-trips through', () => {
    const synced: SyncedConfig = {
      schema: [SCHEMA_URL],
      rules: [RULES_URL],
      index: 'core.schema.json',
      data: DATA_URL,
    };
    expect(canonicalConfigKey(synced)).toBe(
      canonicalConfigKey(decodeConfig(canonicalConfigKey(synced))),
    );
  });

  it('toSyncedConfig strips passthrough and config=', () => {
    const config = decodeConfig(`data=${encodeURIComponent(DATA_URL)}&theme=dark`);
    expect(toSyncedConfig(config)).toEqual({ schema: [], rules: [], data: DATA_URL });
  });
});

describe('snapshot guards — storage is untrusted input', () => {
  const meta = { v: SNAPSHOT_VERSION, savedAt: 42, syncedConfig: { schema: [], rules: [] } };

  it('admits a well-formed meta and rejects a foreign version', () => {
    expect(guardMetaRecord(meta)).toEqual(meta);
    expect(guardMetaRecord({ ...meta, v: 2 })).toBeNull();
    expect(guardMetaRecord({ ...meta, syncedConfig: { schema: 'nope', rules: [] } })).toBeNull();
    expect(guardMetaRecord(undefined)).toBeNull();
  });

  it('dataset: requires a Blob, a name, and a known format', () => {
    expect(guardDatasetRecord(uploadDataset())).not.toBeNull();
    expect(guardDatasetRecord({ ...uploadDataset(), blob: 'bytes' })).toBeNull();
    expect(guardDatasetRecord({ ...uploadDataset(), format: 'xls' })).toBeNull();
    expect(guardDatasetRecord({ ...uploadDataset(), name: '' })).toBeNull();
    const full = { ...uploadDataset(), sheetName: 'S2', sourceUrl: DATA_URL };
    expect(guardDatasetRecord(full)).toEqual(full);
  });

  it('schema: a torn entry poisons the record; extras survive intact', () => {
    expect(guardSchemaRecord(urlSchema())).toEqual(urlSchema());
    expect(guardSchemaRecord({ ...urlSchema(), entries: [] })).toBeNull();
    expect(
      guardSchemaRecord({ ...urlSchema(), entries: [{ relativePath: 'a.json' }] }),
    ).toBeNull();
    expect(guardSchemaRecord({ ...urlSchema(), origin: 'disk' })).toBeNull();
    const pinned = { ...urlSchema(), chosenIndexFileId: SCHEMA_URL };
    expect(guardSchemaRecord(pinned)).toEqual(pinned);
  });

  it('rules: sourceUrl must be a string or null, dirty a string list', () => {
    expect(guardRulesRecord(uploadRules())).toEqual(uploadRules());
    expect(
      guardRulesRecord({ files: [{ name: 'r.csv', text: '', sourceUrl: 7 }], dirty: [] }),
    ).toBeNull();
    expect(guardRulesRecord({ files: [], dirty: [] })).toBeNull();
    expect(guardRulesRecord({ ...uploadRules(), dirty: [3] })).toBeNull();
  });

  it('studio: an edit drawer needs an index; a malformed draft rejects the record', () => {
    expect(guardStudioRecord({ selectedFile: null, drawer: null })).toEqual({
      selectedFile: null,
      drawer: null,
    });
    expect(
      guardStudioRecord({
        selectedFile: 'r.quac.csv',
        drawer: { kind: 'edit', fileName: 'r.quac.csv', draftDirty: true },
      }),
    ).toBeNull();
    const draft = {
      ruleId: 'R1',
      ruleType: 'validate',
      ruleScope: 'row',
      targetVariables: ['age'],
      condition: 'age IS NULL',
      updateLanguage: 'sql',
      updateExpression: '',
      severity: 'error',
      comment: '',
      enabled: true,
      sourceFile: 'r',
      rowNumber: 2,
      extras: {},
    };
    const record = {
      selectedFile: 'r.quac.csv',
      drawer: { kind: 'edit', fileName: 'r.quac.csv', index: 0, draft, draftDirty: true },
    };
    expect(guardStudioRecord(record)).toEqual(record);
    expect(
      guardStudioRecord({
        ...record,
        drawer: { ...record.drawer, draft: { ...draft, severity: 'fatal' } },
      }),
    ).toBeNull();
  });

  it('prefs: applyCorrections must be a boolean', () => {
    expect(guardPrefsRecord({ applyCorrections: false })).toEqual({ applyCorrections: false });
    expect(guardPrefsRecord({ applyCorrections: 'no' })).toBeNull();
  });

  it('readStoredSession: a bad meta voids the snapshot; a bad slot voids only itself', () => {
    expect(readStoredSession({})).toBeNull();
    expect(readStoredSession({ meta: { ...meta, v: 99 }, rules: uploadRules() })).toBeNull();
    const session = readStoredSession({
      meta,
      dataset: { blob: 'not-a-blob', name: 'x.csv', format: 'csv' },
      rules: uploadRules(),
    });
    expect(session).not.toBeNull();
    expect(session?.dataset).toBeNull(); // discarded alone
    expect(session?.rules).toEqual(uploadRules());
  });
});
