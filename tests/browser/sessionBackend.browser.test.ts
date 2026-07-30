/**
 * P19b: the raw-IndexedDB session adapter against a REAL browser IDB —
 * deliberately not faked in node. The risky behavior is structured-clone of
 * Blob (the dataset's original bytes), which is exactly where a node fake
 * diverges from the engine that will actually run it — the same reasoning
 * that keeps the SQLRunner spikes in this tier.
 *
 * All tests share ONE browser origin and therefore one `quac-session`
 * database, so every test awaits a clean slate in beforeEach rather than
 * assuming one.
 */
import { beforeEach, expect, test } from 'vitest';
import { openSessionBackend } from '../../src/app/sessionBackend';
import { initSessionPersistence } from '../../src/app/sessionPersistence';
import { SNAPSHOT_VERSION, readStoredSession } from '../../src/app/sessionSnapshot';
import type { SessionBackend } from '../../src/app/sessionBackend';
import type {
  DatasetRecord,
  MetaRecord,
  PrefsRecord,
  RulesRecord,
  SchemaRecord,
  StudioRecord,
} from '../../src/app/sessionSnapshot';
import type { QCRule } from '../../src/core/rules/types';

const BYTES = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0x00, 0xff, 0x0a, 0x7f]);

const DRAFT: QCRule = {
  ruleId: 'R1',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['age'],
  condition: 'age IS NULL',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'restored draft',
  enabled: true,
  sourceFile: 'people_rules',
  rowNumber: 2,
  extras: { note: 'kept' },
};

function fullRecords(): {
  meta: MetaRecord;
  dataset: DatasetRecord;
  schema: SchemaRecord;
  rules: RulesRecord;
  studio: StudioRecord;
  prefs: PrefsRecord;
} {
  return {
    meta: {
      v: SNAPSHOT_VERSION,
      savedAt: 1_722_000_000_000,
      syncedConfig: { schema: ['https://ex.test/s.json'], rules: [], index: 's.json' },
    },
    dataset: {
      blob: new Blob([BYTES]),
      name: 'people.parquet',
      format: 'parquet',
      sheetName: 'S2',
      sourceUrl: 'https://ex.test/people.parquet',
    },
    schema: {
      entries: [
        { relativePath: 'people.schema.json', raw: '{"type":"array","items":{}}' },
        {
          relativePath: 'https://ex.test/s.json',
          raw: '{}',
          retrievalUri: 'https://ex.test/s.json',
        },
      ],
      origin: 'upload',
      sourceUrls: ['https://ex.test/s.json'],
      chosenIndexFileId: 'people.schema.json',
    },
    rules: {
      files: [
        { name: 'a.quac.csv', text: 'rule_id\nR1\n', sourceUrl: null },
        { name: 'b.quac.csv', text: 'rule_id\nR2\n', sourceUrl: 'https://ex.test/b.quac.csv' },
      ],
      dirty: ['a.quac.csv'],
    },
    studio: {
      selectedFile: 'a.quac.csv',
      drawer: {
        kind: 'edit',
        fileName: 'a.quac.csv',
        index: 0,
        draft: DRAFT,
        draftDirty: true,
      },
    },
    prefs: { applyCorrections: false },
  };
}

async function open(): Promise<SessionBackend> {
  const backend = await openSessionBackend();
  if (backend === null) throw new Error('IndexedDB unavailable in the test browser');
  return backend;
}

beforeEach(async () => {
  await (await open()).clear();
});

test('every record shape round-trips through a fresh connection, Blob byte-identical', async () => {
  const records = fullRecords();
  const writer = await open();
  expect(await writer.write(records)).toBe(true);

  // A SECOND connection: what a reload actually does.
  const reader = await open();
  const back = await reader.readAll();
  expect(Object.keys(back).sort()).toEqual([
    'dataset',
    'meta',
    'prefs',
    'rules',
    'schema',
    'studio',
  ]);

  const session = readStoredSession(back);
  expect(session).not.toBeNull();
  expect(session?.meta).toEqual(records.meta);
  expect(session?.schema).toEqual(records.schema);
  expect(session?.rules).toEqual(records.rules);
  expect(session?.studio).toEqual(records.studio);
  expect(session?.prefs).toEqual(records.prefs);

  // The whole point of this tier: the blob survives structured clone with
  // its exact bytes (including NUL and high bytes).
  const dataset = session?.dataset;
  if (dataset === null || dataset === undefined) throw new Error('dataset record missing');
  expect(dataset.name).toBe('people.parquet');
  expect(dataset.sheetName).toBe('S2');
  const bytes = new Uint8Array(await dataset.blob.arrayBuffer());
  expect([...bytes]).toEqual([...BYTES]);
});

test('an empty store reads as {} and initSessionPersistence reports no session', async () => {
  const backend = await open();
  expect(await backend.readAll()).toEqual({});
  expect(await initSessionPersistence()).toBeNull();
});

test('a null value deletes its key; a rewrite replaces', async () => {
  const backend = await open();
  const records = fullRecords();
  await backend.write({ meta: records.meta, prefs: { applyCorrections: false } });
  await backend.write({ prefs: null });
  expect(Object.keys(await backend.readAll())).toEqual(['meta']);

  await backend.write({ meta: { ...records.meta, savedAt: 2 } });
  expect((await backend.readAll()).meta).toEqual({ ...records.meta, savedAt: 2 });
});

test('clear() empties everything', async () => {
  const backend = await open();
  await backend.write(fullRecords());
  await backend.clear();
  expect(await backend.readAll()).toEqual({});
});

test('corrupt records never throw: a bad slot drops alone, a bad meta voids and purges', async () => {
  const backend = await open();
  const records = fullRecords();

  // Torn slot record with a healthy meta: only the slot is discarded.
  await backend.write({ meta: records.meta, dataset: 'not-a-record', rules: records.rules });
  const partial = readStoredSession(await backend.readAll());
  expect(partial).not.toBeNull();
  expect(partial?.dataset).toBeNull();
  expect(partial?.rules).toEqual(records.rules);

  // Foreign snapshot version: the whole session is absent, and
  // initSessionPersistence best-effort purges what it cannot read.
  await backend.write({ meta: { v: 99 }, rules: records.rules });
  expect(readStoredSession(await backend.readAll())).toBeNull();
  expect(await initSessionPersistence()).toBeNull();
  await expect.poll(async () => Object.keys(await backend.readAll()).length).toBe(0);
});

test('two concurrent opens both resolve working backends on the same DB', async () => {
  const [a, b] = await Promise.all([openSessionBackend(), openSessionBackend()]);
  if (a === null || b === null) throw new Error('a concurrent open failed');
  await a.write({ prefs: { applyCorrections: true } });
  expect((await b.readAll()).prefs).toEqual({ applyCorrections: true });
});
