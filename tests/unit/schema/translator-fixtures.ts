/**
 * Shared plumbing for the P08 translator suites: loads the recorded Ajv error
 * arrays (scripts/record-ajv-errors.mjs snapshots — no Ajv at test time) and
 * builds TranslateCtx inputs from the real HESP / mini schema digests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnDigest } from '../../../src/core/schema/column-meta';
import type { ColumnDigest } from '../../../src/core/schema/column-meta';
import { buildSchemaSet } from '../../../src/core/schema/schema-set';
import type { AjvErrorLike } from '../../../src/core/schema/translator';
import { entriesFromDir, fixtureDir } from './helpers';

export interface RecordedScenario {
  scenario: string;
  description: string;
  row: number;
  errors: AjvErrorLike[];
}

export function loadRecorded(name: 'mini' | 'hesp' | 'oneof-multimatch'): Map<string, RecordedScenario> {
  const path = join(fixtureDir('synthetic', 'ajv-errors'), `${name}.errors.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { scenarios: RecordedScenario[] };
  return new Map(parsed.scenarios.map((s) => [s.scenario, s]));
}

export function scenario(recorded: Map<string, RecordedScenario>, name: string): RecordedScenario {
  const s = recorded.get(name);
  if (s === undefined) throw new Error(`recorded scenario missing: ${name}`);
  return s;
}

async function digestFor(dir: string, rootFileId: string): Promise<ColumnDigest> {
  const set = await buildSchemaSet(entriesFromDir(dir), { origin: 'upload' });
  if (set.root.rootFileId !== rootFileId) {
    throw new Error(`unexpected root ${String(set.root.rootFileId)} for ${dir}`);
  }
  const digest = columnDigest(set);
  if (digest === null) throw new Error(`digest unavailable for ${dir}`);
  return digest;
}

let hespPromise: Promise<ColumnDigest> | undefined;
export function hespDigest(): Promise<ColumnDigest> {
  hespPromise ??= digestFor(fixtureDir('hesp', 'json_schema'), 'core/core.schema.json');
  return hespPromise;
}

let miniPromise: Promise<ColumnDigest> | undefined;
export function miniDigest(): Promise<ColumnDigest> {
  miniPromise ??= digestFor(fixtureDir('synthetic', 'mini'), 'mini.schema.json');
  return miniPromise;
}

/** mulberry32-seeded Fisher–Yates for the determinism property test. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = out[i] as T;
    out[i] = out[j] as T;
    out[j] = swap;
  }
  return out;
}
