/** Labeled URL input + Fetch submit, as a real <form> (ingestion.md §1). */

export interface UrlFieldOptions {
  /** Visible label, e.g. 'Dataset URL'. */
  label: string;
  /** Accessible-name override when the visible label is generic ('URL'). */
  inputAriaLabel?: string;
  placeholder?: string;
  onFetch: (url: string) => void;
}

export interface UrlField {
  readonly el: HTMLElement;
  setBusy: (busy: boolean) => void;
}

let urlFieldSeq = 0;

export function createUrlField(options: UrlFieldOptions): UrlField {
  const el = document.createElement('form');
  el.className = 'q-urlfield';

  urlFieldSeq += 1;
  const id = `q-urlfield-${String(urlFieldSeq)}`;

  const label = document.createElement('label');
  label.htmlFor = id;
  label.className = 'q-urlfield-label';
  label.textContent = options.label;

  const input = document.createElement('input');
  input.type = 'url';
  input.id = id;
  input.className = 'q-urlfield-input';
  input.placeholder = options.placeholder ?? 'https://…';
  input.spellcheck = false;
  if (options.inputAriaLabel !== undefined) {
    input.setAttribute('aria-label', options.inputAriaLabel);
  }

  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'q-btn q-urlfield-btn';
  button.textContent = 'Fetch';

  el.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (url !== '') options.onFetch(url);
  });

  el.append(label, input, button);
  return {
    el,
    setBusy: (busy) => {
      input.disabled = busy;
      button.disabled = busy;
      button.textContent = busy ? 'Fetching…' : 'Fetch';
    },
  };
}
