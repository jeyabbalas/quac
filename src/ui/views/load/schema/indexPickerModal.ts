/**
 * IndexPickerModal (ui-design.md §4): radio list of root candidates with
 * relativePath, `$id`, title, and an array-shape badge, plus the
 * "why ambiguous" note. Selection → `chooseRoot` (records `indexFileId` for
 * Share). Dismissal never traps or auto-selects — the slot card offers a
 * re-open button.
 */
import { openModal } from '../../../../app/modal';
import { chooseRoot } from '../../../../core/schema/schema-store';
import type { SchemaSet } from '../../../../core/schema/types';
import { createBadge } from '../../../components/badge';
import './indexPickerModal.css';

export interface IndexPickerOptions {
  set: SchemaSet;
  /** Called after `chooseRoot` when the user confirms. */
  onChoose?: () => void;
  /** Called when the modal closes without a selection. */
  onDismiss?: () => void;
}

export function openIndexPickerModal(options: IndexPickerOptions): void {
  const { set } = options;
  let confirmed = false;
  const handle = openModal({
    title: 'Choose the index schema',
    onClose: () => {
      if (!confirmed) options.onDismiss?.();
    },
  });

  const note = document.createElement('p');
  note.className = 'q-idxpick-note';
  note.textContent =
    set.root.status === 'none'
      ? 'These files reference each other in a cycle; choose the entry point.'
      : "More than one unreferenced file could be the table's index schema. Choose the file that describes the dataset.";

  const list = document.createElement('div');
  list.className = 'q-idxpick-list';
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Candidate index schemas');

  let selected = set.root.candidates[0]?.fileId ?? '';
  set.root.candidates.forEach((candidate, i) => {
    const row = document.createElement('label');
    row.className = 'q-idxpick-row';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'q-idxpick';
    radio.value = candidate.fileId;
    radio.checked = i === 0;
    radio.addEventListener('change', () => {
      selected = candidate.fileId;
    });

    const body = document.createElement('span');
    body.className = 'q-idxpick-body';
    const path = document.createElement('strong');
    path.className = 'q-idxpick-path';
    const file = set.files.find((f) => f.fileId === candidate.fileId);
    path.textContent = file?.relativePath ?? candidate.fileId;
    body.append(path);
    if (candidate.title !== undefined) {
      const title = document.createElement('span');
      title.className = 'q-idxpick-title';
      title.textContent = candidate.title;
      body.append(title);
    }
    if (candidate.declaredId !== undefined) {
      const id = document.createElement('code');
      id.className = 'q-idxpick-id';
      id.textContent = candidate.declaredId;
      body.append(id);
    }

    row.append(radio, body);
    if (candidate.arrayOfObjects) row.append(createBadge('array of objects', 'info'));
    list.append(row);
  });

  const actions = document.createElement('div');
  actions.className = 'q-idxpick-actions';
  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'q-btn q-btn--primary';
  confirm.textContent = 'Use this file';
  confirm.addEventListener('click', () => {
    if (selected === '') return;
    confirmed = true;
    chooseRoot(selected);
    handle.close();
    options.onChoose?.();
  });
  actions.append(confirm);

  handle.body.append(note, list, actions);
}
