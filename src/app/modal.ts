/**
 * Modal dialog primitive: focus-trapped, Esc/backdrop/button closes, focus
 * restored to the opener on close. One modal at a time is the supported
 * contract (every spec'd use — pickers, share, pertinence — is exclusive).
 */
export interface ModalOptions {
  title: string;
  /** 'wide' (720px cap) for content-heavy dialogs like Share; default 560px. */
  size?: 'default' | 'wide';
  onClose?: () => void;
}

export interface ModalHandle {
  /** The dialog element (`role="dialog"`). */
  readonly root: HTMLElement;
  /** Mount point for caller content. */
  readonly body: HTMLElement;
  close: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let modalSeq = 0;

export function openModal(options: ModalOptions): ModalHandle {
  const opener = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'q-modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'q-modal';
  if (options.size === 'wide') dialog.classList.add('q-modal--wide');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1; // focus target of last resort if callers remove all focusables

  modalSeq += 1;
  const titleId = `q-modal-title-${String(modalSeq)}`;
  dialog.setAttribute('aria-labelledby', titleId);

  const header = document.createElement('div');
  header.className = 'q-modal-header';
  const title = document.createElement('h2');
  title.className = 'q-modal-title';
  title.id = titleId;
  title.textContent = options.title;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'q-modal-close';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '×';
  header.append(title, closeButton);

  const body = document.createElement('div');
  body.className = 'q-modal-body';
  dialog.append(header, body);
  overlay.append(dialog);

  const focusables = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];

  let closed = false;

  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    document.body.style.overflow = previousOverflow;
    if (opener instanceof HTMLElement) opener.focus();
    options.onClose?.();
  }

  // Document-level in the capture phase: the trap holds even if focus escapes.
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(); // recomputed per keypress — caller content may change
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const current = document.activeElement;
    const inside = current instanceof HTMLElement && dialog.contains(current);
    if (event.shiftKey) {
      if (!inside || current === first || current === dialog) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || current === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closeButton.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', onKeydown, true);

  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  document.body.append(overlay);
  (focusables()[0] ?? dialog).focus();

  return { root: dialog, body, close };
}
