// Pipeline stage machine (phase-14 §Verification) — mocked executors via the
// injectable PipelineExecutors seam (house style: DI, not module mocks). The
// real engine contracts these fakes emulate (betweenPhases position, abort
// short-circuits) are pinned by the P14 block in tests/unit/rules/engine.test.ts.
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../../../src/core/pipeline';
import type {
  PipelineDeps,
  PipelineExecutors,
  PresentPayload,
  RunStage,
  SchemaRunInput,
} from '../../../src/core/pipeline';
import type { CastPlan } from '../../../src/core/schema/casting';
import type { ValidationSummary } from '../../../src/core/schema/worker-protocol';
import type { QCFlag } from '../../../src/core/flags/flag';
import type { EngineOptions, QCRule, RuleFile } from '../../../src/core/rules/types';
import type { WorkerBridge } from '@jeyabbalas/data-table';

const BRIDGE = {} as unknown as WorkerBridge; // inert token — only executors touch it

/** Function boundary defeats TS's closure narrowing of signal.aborted. */
const sigAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;

const DATASET = { name: 'people.csv', columns: ['a', 'b'], rowCount: 10 };

const FAKE_PLAN = { columns: [], sql: 'CTAS' } as unknown as CastPlan;

const SCHEMA: SchemaRunInput = {
  set: {} as SchemaRunInput['set'],
  digest: { meta: [], conditionals: [] },
};

const rule = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'R1',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['a'],
  condition: 'TRUE',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'Test.',
  enabled: true,
  sourceFile: 'inline.quac.csv',
  rowNumber: 1,
  extras: {},
  ...overrides,
});

const RULE_FILES: RuleFile[] = [
  {
    name: 'inline.quac.csv',
    group: 'inline',
    rules: [
      rule({ ruleId: 'C1', ruleType: 'correct', updateExpression: '1', severity: 'info' }),
      rule({ ruleId: 'V1' }),
    ],
    extraColumns: [],
  },
];

const rulesFlag = (): QCFlag => ({
  source: 'rules',
  ruleId: 'V1',
  scope: 'cell',
  row: 0,
  column: 'a',
  severity: 'error',
  message: 'rules flag',
});

const schemaFlag = (): QCFlag => ({
  source: 'schema',
  ruleId: 'schema:prop:a:value',
  scope: 'cell',
  row: 1,
  column: 'a',
  severity: 'warning',
  message: 'schema flag',
});

const summary = (over: Partial<ValidationSummary> = {}): ValidationSummary => ({
  rowsTotal: 10,
  rowsWithErrors: 1,
  flagsEmitted: 1,
  flagsTruncated: false,
  countsByRuleId: { 'schema:prop:a:value': 1 },
  elapsedMs: 5,
  aborted: false,
  ...over,
});

interface Harness {
  calls: string[];
  stages: RunStage[];
  presented: PresentPayload[];
  engineOpts: () => EngineOptions | undefined;
  schemaDeps: () => Parameters<PipelineExecutors['runSchemaValidation']>[0] | undefined;
  deps: (extra?: Partial<PipelineDeps>) => PipelineDeps;
}

function harness(overrides: Partial<PipelineExecutors> = {}): Harness {
  const calls: string[] = [];
  const stages: RunStage[] = [];
  const presented: PresentPayload[] = [];
  let engineOpts: EngineOptions | undefined;
  let schemaDeps: Parameters<PipelineExecutors['runSchemaValidation']>[0] | undefined;

  const executors: PipelineExecutors = {
    harden: () => {
      calls.push('harden');
      return Promise.resolve();
    },
    rebuildTyped: (_bridge, schema) => {
      calls.push('rebuildTyped');
      return Promise.resolve(schema === null ? null : FAKE_PLAN);
    },
    // Contract-faithful runQC fake: corrections → hook → validations, with
    // the engine's abort short-circuits (pinned by the engine unit tests).
    runQC: async (_runner, _files, opts?) => {
      const o = opts ?? {};
      engineOpts = o;
      calls.push('runQC:start');
      o.onFlags?.([rulesFlag()]);
      if (sigAborted(o.signal)) {
        return { flags: [], perRule: [], correctedCells: 0, aborted: true };
      }
      await o.betweenPhases?.();
      if (sigAborted(o.signal)) {
        return { flags: [], perRule: [], correctedCells: 0, aborted: true };
      }
      o.onProgress?.({ ruleId: 'V1', index: 0, total: 1, phase: 'validate' });
      calls.push('runQC:resume');
      return {
        flags: [],
        perRule: [
          {
            ruleId: 'V1',
            status: 'ok',
            violationCount: 1,
            flagsEmitted: 1,
            truncated: false,
            durationMs: 1,
          },
        ],
        correctedCells: 2,
        aborted: false,
      };
    },
    runSchemaValidation: (deps) => {
      schemaDeps = deps;
      calls.push('schema');
      deps.flagStore.add([schemaFlag()]);
      return Promise.resolve(summary());
    },
    exportDisplay: () => {
      calls.push('export');
      return Promise.resolve(new Uint8Array([1]));
    },
    ...overrides,
  };

  return {
    calls,
    stages,
    presented,
    engineOpts: () => engineOpts,
    schemaDeps: () => schemaDeps,
    deps: (extra = {}) => ({
      bridge: BRIDGE,
      dataset: DATASET,
      schema: SCHEMA,
      ruleFiles: RULE_FILES,
      applyCorrections: true,
      executors,
      onProgress: (p) => {
        if (stages.at(-1) !== p.stage) stages.push(p.stage);
      },
      present: (payload) => {
        presented.push(payload);
        return Promise.resolve();
      },
      ...extra,
    }),
  };
}

describe('runPipeline stage machine', () => {
  it('stage order: prepare → corrections → schema (in the hook) → rules → annotate', async () => {
    const h = harness();
    const artifacts = await runPipeline(h.deps());

    expect(h.calls).toEqual(['harden', 'rebuildTyped', 'runQC:start', 'schema', 'runQC:resume', 'export']);
    expect(h.stages).toEqual(['prepare', 'corrections', 'schema', 'rules', 'annotate']);
    expect(h.presented).toHaveLength(1);

    // The schema stage reads the corrected view and receives prepare's plan.
    expect(h.schemaDeps()?.sourceTable).toBe('data');
    expect(h.schemaDeps()?.castPlan).toBe(FAKE_PLAN);

    // Both engines' flags landed in ONE store; counts exact.
    expect(artifacts.flagStore.summary().totalCount).toBe(2);
    expect(artifacts.rules?.correctedCells).toBe(2);
    expect(artifacts.schema).toEqual(summary());
    expect(artifacts.cancelled).toBe(false);
    expect(artifacts.stageErrors).toEqual([]);
    expect(h.presented[0]?.partial).toBe(false);
    expect(h.presented[0]?.annotations.items).toHaveLength(2);
  });

  it('corrections toggle off: assess-only flows through; no corrections stage marker', async () => {
    const h = harness();
    await runPipeline(h.deps({ applyCorrections: false }));

    expect(h.engineOpts()?.applyCorrections).toBe(false);
    expect(h.calls).toContain('runQC:start'); // still the vehicle for CTAS + validations
    expect(h.stages).toEqual(['prepare', 'schema', 'rules', 'annotate']);
  });

  it('no schema: hook absent, plain-copy rebuild, schema executor never runs', async () => {
    const h = harness();
    const artifacts = await runPipeline(h.deps({ schema: null }));

    expect(h.calls).toEqual(['harden', 'rebuildTyped', 'runQC:start', 'runQC:resume', 'export']);
    expect(h.engineOpts()?.betweenPhases).toBeUndefined();
    expect(artifacts.schema).toBeNull();
  });

  it('cancel during the schema stage: rules never resume, annotate still presents partial', async () => {
    const controller = new AbortController();
    const h = harness({
      runSchemaValidation: (deps) => {
        h.calls.push('schema');
        deps.flagStore.add([schemaFlag()]);
        controller.abort();
        return Promise.resolve(summary({ aborted: true }));
      },
    });
    const artifacts = await runPipeline(h.deps({ signal: controller.signal }));

    expect(h.calls).not.toContain('runQC:resume');
    expect(artifacts.cancelled).toBe(true);
    expect(artifacts.rules?.aborted).toBe(true);
    expect(h.presented).toHaveLength(1);
    expect(h.presented[0]?.partial).toBe(true);
    // Partial flags survive: rules flag from before + schema flags.
    expect(artifacts.flagStore.summary().totalCount).toBe(2);
  });

  it('pre-aborted signal: no executors run except the always-on annotate', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();
    const artifacts = await runPipeline(h.deps({ signal: controller.signal }));

    expect(h.calls).toEqual(['export']);
    expect(artifacts.cancelled).toBe(true);
    expect(artifacts.rules).toBeNull();
    expect(h.presented[0]?.partial).toBe(true);
    expect(h.presented[0]?.annotations.items).toEqual([]);
  });

  it('rerun invalidation: each run gets a fresh FlagStore', async () => {
    const h = harness();
    const first = await runPipeline(h.deps());
    const second = await runPipeline(h.deps());

    expect(second.flagStore).not.toBe(first.flagStore);
    // Run 2 holds ONLY run 2's flags — one rules + one schema, not four.
    expect(second.flagStore.summary().totalCount).toBe(2);
  });

  it('error containment: schema failure is recorded, rules still ran', async () => {
    const h = harness({
      runSchemaValidation: () => {
        h.calls.push('schema');
        return Promise.reject(new Error('worker exploded'));
      },
    });
    const artifacts = await runPipeline(h.deps());

    expect(artifacts.stageErrors).toEqual([
      expect.objectContaining({ stage: 'schema', message: 'worker exploded' }),
    ]);
    expect(h.calls).toContain('runQC:resume'); // validations still ran
    expect(artifacts.rules?.perRule).toHaveLength(1);
    expect(h.presented).toHaveLength(1);
  });

  it('error containment: runQC rejecting before its hook → schema fallback still runs', async () => {
    const h = harness({
      runQC: () => {
        h.calls.push('runQC:start');
        return Promise.reject(new Error('CTAS failed'));
      },
    });
    const artifacts = await runPipeline(h.deps());

    expect(artifacts.stageErrors).toEqual([
      expect.objectContaining({ stage: 'corrections', message: 'CTAS failed' }),
    ]);
    expect(h.calls).toContain('schema'); // containment fallback
    expect(artifacts.rules).toBeNull();
    expect(artifacts.schema).toEqual(summary());
    expect(h.presented).toHaveLength(1);
  });

  it('prepare failure: engine skipped, error recorded, annotate still presents', async () => {
    const h = harness({
      harden: () => {
        h.calls.push('harden');
        return Promise.reject(new Error('no bridge'));
      },
    });
    const artifacts = await runPipeline(h.deps());

    expect(artifacts.stageErrors).toEqual([
      expect.objectContaining({ stage: 'prepare', message: 'no bridge' }),
    ]);
    expect(h.calls).toEqual(['harden', 'export']);
    expect(artifacts.rules).toBeNull();
    expect(h.presented).toHaveLength(1);
  });

  it('annotate failure (present rejects) is contained in stageErrors', async () => {
    const h = harness();
    const artifacts = await runPipeline(
      h.deps({
        present: () => Promise.reject(new Error('loadData failed')),
      }),
    );

    expect(artifacts.stageErrors).toEqual([
      expect.objectContaining({ stage: 'annotate', message: 'loadData failed' }),
    ]);
    expect(artifacts.rules?.perRule).toHaveLength(1); // run itself completed
  });
});
