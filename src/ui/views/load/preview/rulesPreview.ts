/**
 * Preview → QC rules panel. The container and its mount point only: this
 * change gives the rules a permanent home in the Preview panel and a head that
 * reads like the other two, not a rules renderer.
 */
import { effect } from '../../../../app/signals';
import { rulesState } from '../../../../core/rules/rules-store';
import { rulesMetaLine } from './previewModel';

export function mountRulesPreview(panel: HTMLElement): void {
  const head = document.createElement('div');
  head.className = 'q-preview-panelhead';
  const title = document.createElement('h3');
  title.className = 'q-preview-paneltitle';
  title.textContent = 'QC rules';
  const meta = document.createElement('span');
  meta.className = 'q-preview-meta';
  head.append(title, meta);

  const body = document.createElement('div');
  const note = document.createElement('p');
  note.className = 'q-panel-note';
  body.append(note);

  panel.append(head, body);

  effect(() => {
    const state = rulesState.get();
    const fileCount = state.files.length;
    if (fileCount === 0) {
      meta.textContent = '';
      body.className = '';
      note.textContent = 'Load a QC rules file to see it here.';
      return;
    }
    const ruleCount = state.results.reduce((sum, r) => sum + r.ruleCount, 0);
    meta.textContent = rulesMetaLine(fileCount, ruleCount);
    body.className = 'q-rulespreview';
    note.textContent = 'A preview of your QC rules will appear here.';
  });
}
