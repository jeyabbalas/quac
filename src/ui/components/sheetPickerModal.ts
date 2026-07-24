/**
 * SheetPickerModal (ui-design §4): radio list of Excel sheet names, Sheet 1
 * preselected per the brief. Resolves the chosen name, or null when the user
 * cancels (Esc, ×, backdrop, Cancel).
 */
import { openModal } from '../../app/modal';
import './sheetPickerModal.css';

export function pickSheet(sheetNames: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const modal = openModal({
      title: 'Choose a sheet',
      onClose: () => {
        settle(null);
      },
    });

    const intro = document.createElement('p');
    intro.textContent = 'This workbook has more than one sheet. Which one holds the dataset?';

    const list = document.createElement('div');
    list.className = 'q-sheetpicker-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-label', 'Workbook sheets');
    sheetNames.forEach((name, i) => {
      const label = document.createElement('label');
      label.className = 'q-sheetpicker-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'q-sheet';
      radio.value = name;
      radio.checked = i === 0; // Sheet 1 preselected (brief requirement)
      const text = document.createElement('span');
      text.textContent = name;
      label.append(radio, text);
      list.append(label);
    });

    const actions = document.createElement('div');
    actions.className = 'q-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'q-btn';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      modal.close();
    });
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'q-btn q-btn--primary';
    use.textContent = 'Use this sheet';
    use.addEventListener('click', () => {
      const chosen = list.querySelector<HTMLInputElement>('input[name="q-sheet"]:checked');
      settle(chosen?.value ?? sheetNames[0] ?? null);
      modal.close();
    });
    actions.append(cancel, use);

    modal.body.append(intro, list, actions);
  });
}
