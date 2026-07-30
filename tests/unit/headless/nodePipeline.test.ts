/**
 * The P20 gate (headless.md §10): the whole QC pipeline under Node, asserted
 * against the SAME committed ground truth the browser tier pins.
 *
 * Parity here is by shared manifest, not by cross-tier runtime comparison —
 * `synthetic/mini/mini_expected_flags.json` and `hesp/data/seeded-violations.json`
 * are the contract, so a drift on either engine (duckdb-wasm 1.33.1-dev57 vs
 * native 1.5.5) fails the moment it happens. Divergence budget: none.
 *
 * Three passes:
 *   (a) mini    — schema validation deep-equals the browser-pinned flag manifest
 *   (b) HESP    — the full runQuac on 101×266 with every seeded violation found
 *   (c) tiny    — the two partial-input modes (UIX-6), incl. the V23 exclusions
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createFlagStore } from '../../../src/core/flags/flagStore';
import { ingestDataset } from '../../../src/core/ingest/ingest';
import { columnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import { runSchemaValidation } from '../../../src/core/schema/validation-run';
import { createNodeBridge } from '../../../src/headless/nodeBridge';
import { runQuac } from '../../../src/headless/run';
import { createInProcessValidationWorker } from '../../../src/headless/validationWorker';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { RunQuacResult } from '../../../src/headless/run';

const FIXTURES = resolve(__dirname, '..', '..', 'fixtures');
const HESP_DATA = join(FIXTURES, 'hesp', 'data');
const HESP_SCHEMA_DIR = join(FIXTURES, 'hesp', 'json_schema');
const HESP_RULES = ['hesp_keys_and_structure', 'hesp_consistency', 'hesp_corrections'].map((n) =>
  join(FIXTURES, 'hesp', 'rules', `${n}.quac.csv`),
);
const TINY = join(FIXTURES, 'tiny');

/** DuckDB init + a 101×266 run twice over; vitest's 5 s default is far short. */
const SLOW = 120_000;

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'quac-headless-gate-'));
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- (a) mini

const SCOPE_RANK: Record<QCFlag['scope'], number> = { cell: 0, row: 1, column: 2, dataset: 3 };

/** Verbatim from `tests/browser/validation-worker.browser.test.ts` — the two
 *  tiers must canonicalize identically or "deep-equal" means nothing. */
function canonicalSort(flags: readonly QCFlag[], columns: readonly string[]): QCFlag[] {
  const ordinal = (c: string | undefined): number => {
    const i = c === undefined ? -1 : columns.indexOf(c);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...flags].sort(
    (a, b) =>
      SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
      (a.row ?? -1) - (b.row ?? -1) ||
      ordinal(a.column) - ordinal(b.column) ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function normalize(flag: QCFlag): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flag)) {
    if (key === 'meta' || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

describe('(a) mini: schema flags deep-equal the browser-pinned manifest', () => {
  test(
    'every flag matches mini_expected_flags.json, field for field',
    async () => {
      const mini = join(FIXTURES, 'synthetic', 'mini');
      const { bridge, close } = await createNodeBridge();
      try {
        const csv = await readFile(join(mini, 'mini_invalid.csv'));
        const bytes = new ArrayBuffer(csv.byteLength);
        new Uint8Array(bytes).set(csv);
        const ingest = await ingestDataset(bridge, {
          name: 'mini_invalid.csv',
          bytes,
          format: 'csv',
        });

        const set = await buildSchemaSet(
          [
            {
              relativePath: 'mini.schema.json',
              raw: await readFile(join(mini, 'mini.schema.json'), 'utf8'),
            },
          ],
          { origin: 'upload' },
        );
        const digest = columnDigest(set);
        if (digest === null) throw new Error('mini digest unavailable');

        const flagStore = createFlagStore();
        const summary = await runSchemaValidation({
          runner: bridge,
          set,
          digest,
          datasetColumns: ingest.columns,
          flagStore,
          createWorker: createInProcessValidationWorker,
        });

        const expected = JSON.parse(
          await readFile(join(mini, 'mini_expected_flags.json'), 'utf8'),
        ) as { flags: QCFlag[] };
        const got = canonicalSort(
          flagStore.all().map((e) => e.flag),
          ingest.columns,
        ).map(normalize);
        const want = canonicalSort(expected.flags, ingest.columns).map(normalize);

        expect(got).toEqual(want);
        expect(got).toHaveLength(9);
        expect(summary.rowsTotal).toBe(10);
        expect(summary.aborted).toBe(false);
        expect(summary.flagsTruncated).toBe(false);
      } finally {
        await close();
      }
    },
    SLOW,
  );
});

// ---------------------------------------------------------------- (b) HESP

interface Injection {
  kind: string;
  rows: number[];
  column?: string | null;
  expectedRuleIds: string[];
}
interface SeededManifest {
  dirtyRows: number;
  columns: number;
  injections: Injection[];
}

/** The run's observable identity: what a second run must reproduce exactly. */
function runDigest(result: RunQuacResult): string {
  const summary = result.artifacts.flagStore.summary(result.artifacts.rowsTotal);
  return JSON.stringify({
    counts: [...summary.countsByRuleId.entries()].sort(([a], [b]) => a.localeCompare(b)),
    perRule: (result.artifacts.rules?.perRule ?? [])
      .map((r) => ({
        ruleId: r.ruleId,
        status: r.status,
        violationCount: r.violationCount,
        flagsEmitted: r.flagsEmitted,
      }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
    severity: summary.severityTotals,
    corrected: result.artifacts.rules?.correctedCells,
  });
}

describe('(b) HESP: the full run on the dirty 101×266 fixture', () => {
  let seeded: SeededManifest;
  let result: RunQuacResult;

  beforeAll(async () => {
    seeded = JSON.parse(
      await readFile(join(HESP_DATA, 'seeded-violations.json'), 'utf8'),
    ) as SeededManifest;
    result = await runQuac({
      dataset: join(HESP_DATA, 'hesp_dirty_100.csv'),
      schema: [HESP_SCHEMA_DIR],
      rules: HESP_RULES,
      out: outDir,
    });
  }, SLOW);

  test('ingest matches the manifest dimensions', () => {
    expect(result.inputs.dataset.rows).toBe(seeded.dirtyRows);
    expect(result.inputs.dataset.columns).toBe(seeded.columns);
    expect(result.artifacts.rowsTotal).toBe(seeded.dirtyRows);
  });

  test('the run completed cleanly', () => {
    expect(result.artifacts.cancelled).toBe(false);
    expect(result.artifacts.stageErrors).toEqual([]);
    expect(result.artifacts.schema?.rowsTotal).toBe(seeded.dirtyRows);
    expect(result.artifacts.schema?.aborted).toBe(false);
  });

  test('the typed-sync mirror ran: zero rules excluded by lint', () => {
    // The §4.3 pin. Without the mirror the lint dry-runs hit the all-VARCHAR
    // copy and DuckDB's binder refuses every arithmetic rule (V23) — 12 of
    // these 22 would vanish from the run without a word.
    const errors = result.inputs.rules.flatMap((r) =>
      r.issues.filter((i) => i.severity === 'error'),
    );
    expect(errors).toEqual([]);

    // And every loaded rule reached the engine. `executableRuleFile` drops
    // error-linted rows only, so a run stat per loaded rule is the exclusion
    // count expressed as a number — disabled and inapplicable rules still get
    // one (`skipped-disabled` / `skipped-inapplicable`), which is why this is
    // the honest pin and `RuleFileLintResult.executable` is not: that field
    // also nets out the fixtures' disabled rule.
    const loaded = result.inputs.rules.reduce((n, r) => n + r.ruleCount, 0);
    expect(loaded).toBe(22);
    expect(result.artifacts.rules?.perRule).toHaveLength(loaded);
  });

  test('every seeded violation is flagged at its own cell', () => {
    const { flagStore } = result.artifacts;
    const countsByRuleId = flagStore.summary(result.artifacts.rowsTotal).countsByRuleId;
    for (const injection of seeded.injections) {
      const expectedIds = new Set(injection.expectedRuleIds);
      const label = `${injection.kind} [${injection.rows.join(',')}${
        injection.column === null || injection.column === undefined ? '' : ` ${injection.column}`
      }]`;
      if (injection.column !== null && injection.column !== undefined && injection.rows.length > 0) {
        for (const row of injection.rows) {
          const got = flagStore.byCell(row, injection.column).map((e) => e.flag.ruleId);
          // ANY of the expected ids is a pass: a correction legitimately
          // replaces the schema flag that would otherwise fire on that cell.
          expect(
            got.some((id) => expectedIds.has(id)),
            `${label} row ${String(row)} got [${got.join(', ')}]`,
          ).toBe(true);
        }
      } else if (injection.column !== null && injection.column !== undefined) {
        const got = flagStore.byColumn(injection.column).map((e) => e.flag.ruleId);
        expect(got.some((id) => expectedIds.has(id)), `${label} got [${got.join(', ')}]`).toBe(true);
      } else {
        const got = [...countsByRuleId.keys()];
        expect(got.some((id) => expectedIds.has(id)), `${label} got [${got.join(', ')}]`).toBe(true);
      }
    }
  });

  test('corrections ran, including the QuickJS one', () => {
    const perRule = result.artifacts.rules?.perRule ?? [];
    expect(result.artifacts.rules?.correctedCells ?? 0).toBeGreaterThanOrEqual(3);
    // H006 is the js correction — its status proves QuickJS loaded and ran.
    expect(perRule.find((r) => r.ruleId === 'H006')?.status).toBe('ok');
    // Q044 reads an external source: loaded and listed, never executed (v1).
    expect(perRule.some((r) => r.status === 'skipped-external')).toBe(true);
    expect(perRule.filter((r) => r.status === 'broken')).toEqual([]);
  });

  test('the report was written and the model is whole', async () => {
    expect(result.outPath.startsWith(outDir)).toBe(true);
    expect(result.model.filename).toMatch(/^quac-report_hesp_dirty_100_\d{8}-\d{4}\.xlsx$/);
    const written = await stat(result.outPath);
    expect(written.size).toBeGreaterThan(10_000);
    expect(result.model.data.rowLimit).toBe(seeded.dirtyRows);
    expect(result.model.repeatOffenders.length).toBeGreaterThan(0);
    expect(result.model.runInfo.length).toBeGreaterThan(0);
  });

  test(
    'a second run reproduces the first exactly',
    async () => {
      // Determinism is the contract (architecture §6): a run is a pure
      // function of (bytes, schema set, rule files).
      const second = await runQuac({
        dataset: join(HESP_DATA, 'hesp_dirty_100.csv'),
        schema: [HESP_SCHEMA_DIR],
        rules: HESP_RULES,
        out: outDir,
      });
      expect(runDigest(second)).toBe(runDigest(result));
    },
    SLOW,
  );
});

// ---------------------------------------------------------------- (c) tiny

describe('(c) tiny: the single-check-source modes (UIX-6)', () => {
  test(
    'schema-only runs and flags',
    async () => {
      const result = await runQuac({
        dataset: join(TINY, 'people.csv'),
        schema: [join(TINY, 'people.schema.json')],
        out: outDir,
      });
      expect(result.artifacts.stageErrors).toEqual([]);
      expect(result.artifacts.schema).not.toBeNull();
      expect(result.artifacts.inputs).toEqual({ schemaProvided: true, ruleFileCount: 0 });
      expect(result.artifacts.flagStore.totalCount()).toBeGreaterThan(0);
      expect(result.inputs.rules).toEqual([]);
      await expect(stat(result.outPath)).resolves.toBeTruthy();
    },
    SLOW,
  );

  test(
    'rules-only runs, with the V23 all-VARCHAR exclusions on node-api',
    async () => {
      const result = await runQuac({
        dataset: join(TINY, 'people.csv'),
        rules: [join(TINY, 'people_rules.quac.csv')],
        out: outDir,
      });
      expect(result.artifacts.stageErrors).toEqual([]);
      expect(result.artifacts.schema).toBeNull();
      expect(result.artifacts.inputs).toEqual({ schemaProvided: false, ruleFileCount: 1 });

      // No schema means no cast plan, so `data` is all-VARCHAR and DuckDB's
      // binder refuses numeric comparison/arithmetic. The lint dry-run catches
      // it pre-run and partial acceptance keeps the rest — 4 of 6 here, the
      // same split the browser tier observes on duckdb-wasm.
      const [lint] = result.inputs.rules;
      expect(lint?.ruleCount).toBe(6);
      expect(lint?.executable).toBe(4);
      const excluded = (lint?.issues ?? [])
        .filter((i) => i.severity === 'error')
        .map((i) => i.ruleId);
      expect(excluded.sort()).toEqual(['R003', 'R005']);
      expect(result.artifacts.flagStore.totalCount()).toBeGreaterThan(0);
    },
    SLOW,
  );

  test('a run with neither check source is refused', async () => {
    await expect(runQuac({ dataset: join(TINY, 'people.csv'), out: outDir })).rejects.toThrow(
      /--schema.*--rules|either is enough/,
    );
  });
});
