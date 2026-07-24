/**
 * Rule Studio view shim (P17). Eager-entry discipline: this module imports
 * only the tiny signals/emptyState/rules-store/errors modules — the actual
 * workspace (CodeMirror, lint, engine SQL) lives behind the memoized dynamic
 * import below, gated on the studio route being ACTIVE (CodeMirror measures
 * unreliably inside `hidden` sections, so the chunk never mounts blind).
 *
 * Empty state doctrine (user-approved interpretation of the phase's task 5):
 * the framed view-level empty shows only when NOTHING is loaded (no dataset,
 * no rule files). Rules-without-dataset still gets the full workspace — the
 * workspace banner explains that SQL checks and completions are pending.
 */
import { effect } from '../../../app/signals';
import { reportError } from '../../../app/errors';
import { createEmptyState } from '../../components/emptyState';
import { rulesState } from '../../../core/rules/rules-store';
import type { ShellContext } from '../../../app/shell';

export function mountStudioView(container: HTMLElement, ctx: ShellContext): void {
  // Body copy pinned by nav.spec.ts — swap there in lockstep.
  const empty = createEmptyState({
    title: 'No rules yet.',
    body: 'Load a dataset to compose rules against it — completions and previews need your columns.',
  });
  const emptyAction = document.createElement('a');
  emptyAction.className = 'q-btn q-empty-action';
  emptyAction.href = '#/load';
  emptyAction.textContent = 'Go to Load';
  empty.append(emptyAction);

  const loadingNote = document.createElement('p');
  loadingNote.className = 'q-panel-note';
  loadingNote.textContent = 'Loading the rule workspace…';
  loadingNote.hidden = true;

  const host = document.createElement('div');
  host.className = 'q-studio';
  host.hidden = true;

  container.append(empty, loadingNote, host);

  let mounted = false;
  let loading = false;
  effect(() => {
    const dataset = ctx.store.dataset.get();
    const rules = rulesState.get();
    const route = ctx.router.route.get();

    const showEmpty = dataset === null && rules.files.length === 0;
    empty.hidden = !showEmpty;
    host.hidden = showEmpty || !mounted;
    loadingNote.hidden = !(loading && !showEmpty && route === 'studio');
    if (showEmpty || route !== 'studio' || mounted || loading) return;

    loading = true;
    loadingNote.hidden = false;
    void import('./studioWorkspace')
      .then((mod) => {
        mounted = true;
        mod.mountStudioWorkspace(host, ctx);
        host.hidden = false;
      })
      .catch((err: unknown) => {
        reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
      })
      .finally(() => {
        loading = false;
        loadingNote.hidden = true;
      });
  });
}
