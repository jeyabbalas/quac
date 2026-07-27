// P17 in-session rule mutations: every mutator round-trips the mutated file
// through serialize→parse, so rowNumbers renumber, untouched rows survive
// byte-identically, and parse-level issues re-derive (remove-to-zero re-acquires
// `empty-file`; createRuleFile is the sanctioned pristine exception). Also the
// dirty-file lifecycle (set on edit, cleared on same-name re-add / reset) and
// duplicate-id generation unique across ALL loaded files.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRuleFiles,
  addRuleUrls,
  clearRuleFiles,
  createRuleFile,
  duplicateRule,
  getLintContext,
  insertRule,
  moveRule,
  removeRule,
  removeRuleFile,
  resetRulesSlot,
  rulesState,
  setLintContext,
  summarizeSlot,
  updateRule,
} from '../../../src/core/rules/rules-store';
import type { QCRule } from '../../../src/core/rules/types';

const FULL_HEADER =
  'rule_id,rule_type,rule_scope,target_variables,condition,update_language,update_expression,severity,comment,enabled\n';

const THREE_RULES =
  FULL_HEADER +
  'R1,validate,row,a,a > 1,sql,,error,first,true\n' +
  'R2,validate,row,b,b > 2,sql,,warning,second,true\n' +
  'R3,correct,row,c,c < 0,sql,ABS(c),info,third,false\n';

const load = async (name = 'test.quac.csv', text = THREE_RULES): Promise<void> => {
  await addRuleFiles([{ name, text }]);
};

const fileRules = (name = 'test.quac.csv'): readonly QCRule[] => {
  const parsed = rulesState.get().files.find((f) => f.file.name === name);
  if (!parsed) throw new Error(`file ${name} not loaded`);
  return parsed.file.rules;
};

const draft = (overrides: Partial<QCRule>): QCRule => ({
  ruleId: 'NEW1',
  ruleType: 'validate',
  ruleScope: 'row',
  targetVariables: ['a'],
  condition: 'a IS NULL',
  updateLanguage: 'sql',
  updateExpression: '',
  severity: 'error',
  comment: 'draft',
  enabled: true,
  sourceFile: '', // placeholder — the round-trip recomputes it
  rowNumber: 0, // placeholder — the round-trip recomputes it
  extras: {},
  ...overrides,
});

beforeEach(() => {
  resetRulesSlot();
});

describe('updateRule', () => {
  it('replaces the target row and leaves the others deep-equal', async () => {
    await load();
    const before = fileRules();
    const ok = await updateRule('test.quac.csv', 1, draft({ ruleId: 'R2', comment: 'edited' }));
    expect(ok).toBe(true);
    const after = fileRules();
    expect(after).toHaveLength(3);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(after[1]?.comment).toBe('edited');
    expect(after[1]?.condition).toBe('a IS NULL');
  });

  it('recomputes rowNumber and sourceFile from the round-trip', async () => {
    await load();
    await updateRule('test.quac.csv', 2, draft({ ruleId: 'R3x', rowNumber: 99, sourceFile: 'junk' }));
    const rule = fileRules()[2];
    expect(rule?.rowNumber).toBe(3);
    expect(rule?.sourceFile).toBe('test');
  });

  it('returns false for a missing file or out-of-range index', async () => {
    await load();
    expect(await updateRule('nope.quac.csv', 0, draft({}))).toBe(false);
    expect(await updateRule('test.quac.csv', 3, draft({}))).toBe(false);
    expect(await updateRule('test.quac.csv', -1, draft({}))).toBe(false);
  });
});

describe('insertRule', () => {
  it('appends (row order = correction order) and returns the new index', async () => {
    await load();
    const index = await insertRule('test.quac.csv', draft({}));
    expect(index).toBe(3);
    const rules = fileRules();
    expect(rules).toHaveLength(4);
    expect(rules[3]?.ruleId).toBe('NEW1');
    expect(rules[3]?.rowNumber).toBe(4);
  });

  it('returns null when the file does not exist', async () => {
    expect(await insertRule('nope.quac.csv', draft({}))).toBeNull();
  });
});

describe('removeRule', () => {
  it('deletes the row and renumbers the remainder', async () => {
    await load();
    expect(await removeRule('test.quac.csv', 0)).toBe(true);
    const rules = fileRules();
    expect(rules.map((r) => r.ruleId)).toEqual(['R2', 'R3']);
    expect(rules.map((r) => r.rowNumber)).toEqual([1, 2]);
  });

  it('removing the last rule re-acquires the empty-file error', async () => {
    await load('solo.quac.csv', `${FULL_HEADER}R1,validate,row,a,a > 1,sql,,error,c,true\n`);
    expect(await removeRule('solo.quac.csv', 0)).toBe(true);
    const state = rulesState.get();
    expect(state.files[0]?.file.rules).toHaveLength(0);
    expect(state.results[0]?.issues).toEqual([
      {
        severity: 'error',
        code: 'empty-file',
        file: 'solo.quac.csv',
        message: 'File contains no rules (no data rows below the header).',
      },
    ]);
  });
});

describe('moveRule', () => {
  it('swaps with the neighbour, renumbers, and returns the new index', async () => {
    await load();
    expect(await moveRule('test.quac.csv', 2, 'up')).toBe(1);
    const rules = fileRules();
    expect(rules.map((r) => r.ruleId)).toEqual(['R1', 'R3', 'R2']);
    expect(rules.map((r) => r.rowNumber)).toEqual([1, 2, 3]);
  });

  it('returns null at the edges', async () => {
    await load();
    expect(await moveRule('test.quac.csv', 0, 'up')).toBeNull();
    expect(await moveRule('test.quac.csv', 2, 'down')).toBeNull();
    expect(fileRules().map((r) => r.ruleId)).toEqual(['R1', 'R2', 'R3']);
  });
});

describe('duplicateRule', () => {
  it('inserts the copy after the original with a _copy id', async () => {
    await load();
    expect(await duplicateRule('test.quac.csv', 0)).toBe(1);
    const rules = fileRules();
    expect(rules.map((r) => r.ruleId)).toEqual(['R1', 'R1_copy', 'R2', 'R3']);
    expect(rules[1]?.condition).toBe('a > 1');
  });

  it('id stays unique across ALL loaded files (_copy2, _copy3, …)', async () => {
    await load();
    await load(
      'other.quac.csv',
      `${FULL_HEADER}R1_copy,validate,row,x,x > 1,sql,,error,taken elsewhere,true\n`,
    );
    expect(await duplicateRule('test.quac.csv', 0)).toBe(1);
    expect(fileRules().map((r) => r.ruleId)).toEqual(['R1', 'R1_copy2', 'R2', 'R3']);
    expect(await duplicateRule('test.quac.csv', 0)).toBe(1);
    expect(fileRules().map((r) => r.ruleId)).toEqual(['R1', 'R1_copy3', 'R1_copy2', 'R2', 'R3']);
  });
});

describe('extras round-trip', () => {
  it('unknown columns survive mutations on untouched rows', async () => {
    const text =
      'rule_id,rule_type,rule_scope,target_variables,condition,comment,owner\n' +
      'R1,validate,row,a,a > 1,first,alice\n' +
      'R2,validate,row,b,b > 2,second,bob\n';
    await load('extras.quac.csv', text);
    await updateRule('extras.quac.csv', 0, draft({ ruleId: 'R1' }));
    const rules = fileRules('extras.quac.csv');
    expect(rules[1]?.extras).toEqual({ owner: 'bob' });
    // The edited rule's extras follow what the caller supplied (empty here).
    expect(rules[0]?.extras).toEqual({ owner: '' });
  });
});

describe('createRuleFile', () => {
  it('creates a pristine file — 0 rules, all headers, NO empty-file error', async () => {
    const result = await createRuleFile('my_rules');
    expect(result).toEqual({ ok: true, fileName: 'my_rules.quac.csv' });
    const state = rulesState.get();
    expect(state.phase).toBe('ready');
    expect(state.files[0]?.file.group).toBe('my_rules');
    expect(state.files[0]?.file.rules).toHaveLength(0);
    expect(state.results[0]?.issues).toEqual([]);
    expect(state.sources).toEqual([null]);
    expect(state.dirtyFiles.has('my_rules.quac.csv')).toBe(true);
  });

  it('keeps an explicit .csv name verbatim', async () => {
    const result = await createRuleFile('checks.quac.csv');
    expect(result).toEqual({ ok: true, fileName: 'checks.quac.csv' });
  });

  it('rejects blank and duplicate names', async () => {
    expect(await createRuleFile('   ')).toEqual({ ok: false, reason: 'empty-name' });
    await load('taken.quac.csv');
    expect(await createRuleFile('taken')).toEqual({ ok: false, reason: 'duplicate' });
    expect(rulesState.get().files).toHaveLength(1);
  });

  it('a rule inserted then removed re-acquires empty-file (asymmetry documented)', async () => {
    await createRuleFile('my_rules');
    await insertRule('my_rules.quac.csv', draft({}));
    // No dataset context in this test → the SQL-bearing file gets the pending
    // info; the point is that no error-severity issue exists yet.
    expect(rulesState.get().results[0]?.issues.map((i) => i.code)).toEqual(['pending-data']);
    await removeRule('my_rules.quac.csv', 0);
    expect(rulesState.get().results[0]?.issues.map((i) => i.code)).toEqual(['empty-file']);
  });
});

describe('dirty lifecycle', () => {
  it('set on edit, cleared by a same-name re-add, cleared by reset', async () => {
    await load();
    expect(rulesState.get().dirtyFiles.size).toBe(0);
    await updateRule('test.quac.csv', 0, draft({ ruleId: 'R1' }));
    expect(rulesState.get().dirtyFiles.has('test.quac.csv')).toBe(true);
    await load(); // same-name re-upload supersedes session edits
    expect(rulesState.get().dirtyFiles.has('test.quac.csv')).toBe(false);
    await updateRule('test.quac.csv', 0, draft({ ruleId: 'R1' }));
    resetRulesSlot();
    expect(rulesState.get().dirtyFiles.size).toBe(0);
  });

  it('re-adding a DIFFERENT file leaves another file dirty', async () => {
    await load();
    await updateRule('test.quac.csv', 0, draft({ ruleId: 'R1' }));
    await load('other.quac.csv', `${FULL_HEADER}X1,validate,row,x,x > 1,sql,,error,c,true\n`);
    expect(rulesState.get().dirtyFiles.has('test.quac.csv')).toBe(true);
  });
});

describe('getLintContext', () => {
  it('exposes the installed context and resets with the slot', async () => {
    expect(getLintContext()).toBeNull();
    const ctx = { runner: { query: () => Promise.resolve([]) }, datasetColumns: ['a'] };
    await setLintContext(ctx);
    expect(getLintContext()).toBe(ctx);
    resetRulesSlot();
    expect(getLintContext()).toBeNull();
  });
});

// UIX-7: per-file removal + whole-slot clear, and the loadToken that makes
// both safe against loads still parked on an await when the clear lands.
const lintCtx = () => ({ runner: { query: () => Promise.resolve([]) }, datasetColumns: ['a'] });

describe('removeRuleFile', () => {
  it('splices files and sources together — survivors stay aligned', async () => {
    await load(); // upload → source null
    await addRuleFiles([
      { name: 'remote.quac.csv', text: THREE_RULES, sourceUrl: 'https://example.test/remote.quac.csv' },
    ]);
    await load('third.quac.csv');
    expect(await removeRuleFile('test.quac.csv')).toBe(true);
    const state = rulesState.get();
    expect(state.phase).toBe('ready');
    expect(state.files.map((f) => f.file.name)).toEqual(['remote.quac.csv', 'third.quac.csv']);
    expect(state.sources).toEqual(['https://example.test/remote.quac.csv', null]);
    expect(state.results.map((r) => r.file)).toEqual(['remote.quac.csv', 'third.quac.csv']);
  });

  it('removing the last file empties the slot but keeps the lint context', async () => {
    const ctx = lintCtx();
    await setLintContext(ctx);
    await load();
    expect(rulesState.get().lintedWithData).toBe(true);
    expect(await removeRuleFile('test.quac.csv')).toBe(true);
    const state = rulesState.get();
    expect(state.phase).toBe('empty');
    expect(state.files).toEqual([]);
    expect(state.results).toEqual([]);
    expect(state.lintedWithData).toBe(false);
    expect(getLintContext()).toBe(ctx);
    await load(); // a later load lints against the kept context
    expect(rulesState.get().lintedWithData).toBe(true);
  });

  it('returns false for an unknown name and leaves the state untouched', async () => {
    await load();
    const before = rulesState.get();
    expect(await removeRuleFile('nope.quac.csv')).toBe(false);
    expect(rulesState.get()).toBe(before);
  });

  it('fetchErrors survive a non-last remove and clear with the last one', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    try {
      await addRuleUrls(['https://bad.test/x.quac.csv']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await load();
    await load('other.quac.csv');
    expect(rulesState.get().fetchErrors).toHaveLength(1);
    await removeRuleFile('test.quac.csv');
    expect(rulesState.get().fetchErrors).toHaveLength(1);
    await removeRuleFile('other.quac.csv');
    expect(rulesState.get().fetchErrors).toEqual([]);
  });

  it('drops the removed file from dirtyFiles; siblings stay dirty', async () => {
    await load();
    await load('other.quac.csv');
    await updateRule('test.quac.csv', 0, draft({ ruleId: 'R1' }));
    await updateRule('other.quac.csv', 0, draft({ ruleId: 'R1x' }));
    await removeRuleFile('test.quac.csv');
    const { dirtyFiles } = rulesState.get();
    expect(dirtyFiles.has('test.quac.csv')).toBe(false);
    expect(dirtyFiles.has('other.quac.csv')).toBe(true);
  });
});

describe('clearRuleFiles', () => {
  it('empties the slot but keeps the lint context', async () => {
    const ctx = lintCtx();
    await setLintContext(ctx);
    await load();
    clearRuleFiles();
    expect(rulesState.get().phase).toBe('empty');
    expect(rulesState.get().files).toEqual([]);
    expect(getLintContext()).toBe(ctx);
  });

  it('publishes a FRESH object every time (Object.is dedupe must not swallow it)', () => {
    clearRuleFiles();
    const first = rulesState.get();
    clearRuleFiles();
    expect(rulesState.get()).not.toBe(first);
  });
});

// UX-04: the slot card reads `summarizeSlot(...).status` for BOTH the badge and
// whether Clear is on screen, so a fetch window that projects as 'empty' hides
// the one control that can abandon a hung no-timeout fetch. Two things had to
// change together here: the projection's guard order, and addRuleUrls entering
// `phase: 'loading'` BEFORE its fetch (it used to publish nothing until the
// bytes were already in hand).
describe('summarizeSlot during the load window (UX-04)', () => {
  const gatedFetch = (): { gate: Promise<void>; release: () => void } => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (() =>
      gate.then(() => ({
        ok: true,
        text: () => Promise.resolve(THREE_RULES),
      }))) as unknown as typeof fetch;
    return { gate, release: () => release?.() };
  };

  it('a URL fetch in flight projects as loading, not empty', async () => {
    const originalFetch = globalThis.fetch;
    const { release } = gatedFetch();
    try {
      const pending = addRuleUrls(['https://slow.test/rules.quac.csv']);
      // Mid-fetch, first load: no files yet — the state the old emptiness
      // guard matched, leaving the card blank with its Clear hidden.
      expect(summarizeSlot(rulesState.get())).toEqual({
        status: 'loading',
        detail: 'Loading rules files…',
      });
      release();
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(summarizeSlot(rulesState.get()).status).toBe('valid');
  });

  it('stays loading across the fetch → parse → lint seam', async () => {
    const originalFetch = globalThis.fetch;
    const { release } = gatedFetch();
    try {
      const pending = addRuleUrls(['https://slow.test/rules.quac.csv']);
      release();
      // The bytes have landed but the codec import and lint have not run: the
      // badge must not flicker back through a non-loading state here.
      await Promise.resolve();
      expect(summarizeSlot(rulesState.get()).status).toBe('loading');
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(summarizeSlot(rulesState.get()).status).toBe('valid');
  });

  it('an untouched slot is still empty', () => {
    clearRuleFiles();
    expect(summarizeSlot(rulesState.get())).toEqual({ status: 'empty', detail: '' });
  });
});

describe('load-token races', () => {
  it('a clear landing while addRuleFiles awaits its codecs wins', async () => {
    const pending = load(); // parks on the codec import before any publish
    clearRuleFiles();
    await pending;
    expect(rulesState.get().phase).toBe('empty');
    expect(rulesState.get().files).toEqual([]);
  });

  it('a clear landing during the addRuleUrls fetch window wins', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      gate.then(() => ({
        ok: true,
        text: () => Promise.resolve(THREE_RULES),
      }))) as unknown as typeof fetch;
    try {
      const pending = addRuleUrls(['https://slow.test/rules.quac.csv']);
      clearRuleFiles();
      release?.();
      await pending;
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(rulesState.get().phase).toBe('empty');
    expect(rulesState.get().files).toEqual([]);
    expect(rulesState.get().fetchErrors).toEqual([]);
  });

  it('a fetch that fails for every URL settles instead of stranding at loading', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({ ok: false, status: 404 })) as unknown as typeof fetch;
    try {
      await addRuleUrls(['https://nope.test/rules.quac.csv']);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // addRuleFiles returns at its own empty guard, so nothing downstream moves
    // the phase — addRuleUrls has to settle it or the badge sticks at Loading…
    expect(rulesState.get().phase).toBe('empty');
    expect(summarizeSlot(rulesState.get())).toEqual({
      status: 'error',
      detail: '0 files · 0 rules · 1 fetch error',
    });
  });

  it('a remove landing while a sibling add is parked discards the stale add', async () => {
    await load();
    const pending = load('late.quac.csv'); // snapshot still contains test.quac.csv
    await removeRuleFile('test.quac.csv');
    await pending;
    const state = rulesState.get();
    expect(state.files.map((f) => f.file.name)).not.toContain('test.quac.csv');
  });
});
