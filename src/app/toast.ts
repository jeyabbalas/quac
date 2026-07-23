/**
 * Transient toast notifications, stacked bottom-right in an `aria-live`
 * region. Persistent failures belong in slot/panel state (architecture §7) —
 * toasts auto-expire and can be dismissed with a click.
 */
export type ToastKind = 'info' | 'success' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  hint?: string;
  durationMs?: number;
}

let region: HTMLElement | null = null;

function ensureRegion(): HTMLElement {
  if (!region) {
    region = document.createElement('div');
    region.className = 'q-toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  return region;
}

/** Mount the live region up front (the shell calls this) — screen readers only
 *  announce changes inside a region that already existed. */
export function initToasts(): void {
  ensureRegion();
}

export function showToast(message: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? 'info';
  const toast = document.createElement('div');
  toast.className = `q-toast q-toast--${kind}`;
  toast.setAttribute('role', 'status');

  const msg = document.createElement('p');
  msg.className = 'q-toast-msg';
  msg.textContent = message;
  toast.append(msg);

  const hintText = options.hint ?? '';
  if (hintText !== '') {
    const hint = document.createElement('p');
    hint.className = 'q-toast-hint';
    hint.textContent = hintText;
    toast.append(hint);
  }

  let timer = 0;
  const dismiss = (): void => {
    window.clearTimeout(timer);
    toast.remove();
  };
  timer = window.setTimeout(dismiss, options.durationMs ?? (kind === 'error' ? 8000 : 5000));
  toast.addEventListener('click', dismiss);

  ensureRegion().append(toast);
}
