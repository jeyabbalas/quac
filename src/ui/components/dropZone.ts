/**
 * Drag-drop zone with real button semantics (ui-design §7): the whole zone is
 * a <button> wrapping a hidden file input, so it is keyboard-activatable and
 * focusable by default. Drag styling is class-based.
 *
 * `dropTarget` promotes drag/drop to an ancestor (the whole slot card): the
 * drag listeners attach there instead of the zone button, so dropping
 * anywhere on the card works and events that bubble from the zone are
 * handled exactly once.
 */

export interface DropZoneOptions {
  /** Zone label, e.g. 'Drop file or browse'. */
  label: string;
  /** `accept` attribute for the hidden input (e.g. '.csv,.tsv'). */
  accept?: string;
  multiple?: boolean;
  /** aria-label for the hidden file input (a stable automation hook). */
  inputAriaLabel?: string;
  /** Element that receives the drag/drop listeners; defaults to the zone. */
  dropTarget?: HTMLElement;
  /** Raw DataTransfer drops (folder walks); wins over onFiles for drops. */
  onDropTransfer?: (dt: DataTransfer) => void;
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
  if (options.inputAriaLabel !== undefined) input.setAttribute('aria-label', options.inputAriaLabel);
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

  const target = options.dropTarget ?? button;
  target.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!button.disabled) button.classList.add('q-dropzone--over');
  });
  target.addEventListener('dragleave', () => {
    button.classList.remove('q-dropzone--over');
  });
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    button.classList.remove('q-dropzone--over');
    if (button.disabled) return;
    const dt = event.dataTransfer;
    if (dt === null) return;
    if (options.onDropTransfer !== undefined) {
      options.onDropTransfer(dt);
      return;
    }
    const files = [...dt.files];
    if (files.length > 0) options.onFiles(options.multiple ? files : files.slice(0, 1));
  });

  return {
    el: button,
    setDisabled: (disabled) => {
      button.disabled = disabled;
    },
  };
}
