/**
 * Drag-drop zone with real button semantics (ui-design §7): the whole zone is
 * a <button> wrapping a hidden file input, so it is keyboard-activatable and
 * focusable by default. Drag styling is class-based.
 */

export interface DropZoneOptions {
  /** Zone label, e.g. 'Drop file or browse'. */
  label: string;
  /** `accept` attribute for the hidden input (e.g. '.csv,.tsv'). */
  accept?: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}

export interface DropZone {
  readonly el: HTMLElement;
  setDisabled: (disabled: boolean) => void;
}

export function createDropZone(options: DropZoneOptions): DropZone {
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  if (options.accept !== undefined) input.accept = options.accept;
  input.multiple = options.multiple ?? false;
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = ''; // re-selecting the same file must fire again
    if (files.length > 0) options.onFiles(files);
  });

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'q-dropzone';
  const label = document.createElement('span');
  label.className = 'q-dropzone-label';
  label.textContent = options.label;
  const browse = document.createElement('span');
  browse.className = 'q-dropzone-browse';
  browse.textContent = 'browse';
  button.append(label, browse, input);
  button.addEventListener('click', () => {
    input.click();
  });

  button.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!button.disabled) button.classList.add('q-dropzone--over');
  });
  button.addEventListener('dragleave', () => {
    button.classList.remove('q-dropzone--over');
  });
  button.addEventListener('drop', (event) => {
    event.preventDefault();
    button.classList.remove('q-dropzone--over');
    if (button.disabled) return;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length > 0) options.onFiles(options.multiple ? files : files.slice(0, 1));
  });

  return {
    el: button,
    setDisabled: (disabled) => {
      button.disabled = disabled;
    },
  };
}
