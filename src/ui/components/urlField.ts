/** Labeled URL input + Fetch button (ingestion.md §1). */

export interface UrlFieldOptions {
  /** Accessible label, e.g. 'Dataset URL'. */
  label: string;
  onFetch: (url: string) => void;
}

export interface UrlField {
  readonly el: HTMLElement;
  setBusy: (busy: boolean) => void;
}

let urlFieldSeq = 0;

export function createUrlField(options: UrlFieldOptions): UrlField {
  const el = document.createElement('div');
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
  input.placeholder = 'https://…';
  input.spellcheck = false;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'q-btn q-urlfield-btn';
  button.textContent = 'Fetch';

  const submit = (): void => {
    const url = input.value.trim();
    if (url !== '') options.onFetch(url);
  };
  button.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
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
