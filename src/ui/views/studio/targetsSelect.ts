/**
 * target_variables control (P17): removable chips + a combobox input with a
 * filtered listbox fed from the dataset columns. Enter adds the highlighted
 * option or the typed text verbatim — unknown targets are ALLOWED (rules may
 * ship ahead of their dataset); with a dataset present an unknown chip gets
 * the warning tint so pertinence problems are visible before lint says so.
 * Keyboard: ArrowDown/ArrowUp walk the list, Enter adds, Escape closes the
 * list (and only the list), Backspace on an empty input pops the last chip.
 */
import type { ColumnFeedEntry } from './completionSource';

export interface TargetsSelect {
  readonly el: HTMLElement;
  getValues: () => string[];
  setValues: (values: readonly string[]) => void;
  setColumns: (columns: readonly ColumnFeedEntry[], hasDataset: boolean) => void;
  focus: () => void;
}

export function createTargetsSelect(deps: { onChange: () => void }): TargetsSelect {
  let values: string[] = [];
  let columns: readonly ColumnFeedEntry[] = [];
  let hasDataset = false;
  let activeIndex = -1;

  const el = document.createElement('div');
  el.className = 'q-targets';

  const chips = document.createElement('div');
  chips.className = 'q-chips';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'q-rf-targets';
  input.className = 'q-chips-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Add target column…';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'q-targets-listbox');

  const listbox = document.createElement('ul');
  listbox.className = 'q-combolist';
  listbox.id = 'q-targets-listbox';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', 'Dataset columns');
  listbox.hidden = true;

  el.append(chips, listbox);

  function isKnown(value: string): boolean {
    return columns.some((c) => c.name === value);
  }

  function renderChips(): void {
    chips.replaceChildren();
    values.forEach((value, i) => {
      const chip = document.createElement('span');
      const unknown = hasDataset && !isKnown(value);
      chip.className = unknown ? 'q-chip q-chip--unknown' : 'q-chip';
      if (unknown) chip.title = 'Not a dataset column';
      const text = document.createElement('span');
      text.textContent = value;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'q-chip-remove';
      remove.setAttribute('aria-label', `Remove ${value}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        values = values.filter((_, j) => j !== i);
        renderChips();
        deps.onChange();
        input.focus();
      });
      chip.append(text, remove);
      chips.append(chip);
    });
    chips.append(input);
  }

  function filtered(): ColumnFeedEntry[] {
    const q = input.value.trim().toLowerCase();
    return columns.filter(
      (c) => !values.includes(c.name) && (q === '' || c.name.toLowerCase().includes(q)),
    );
  }

  function closeList(): void {
    listbox.hidden = true;
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function renderList(): void {
    const options = filtered();
    listbox.replaceChildren();
    if (options.length === 0) {
      closeList();
      return;
    }
    if (activeIndex >= options.length) activeIndex = options.length - 1;
    options.forEach((column, i) => {
      const item = document.createElement('li');
      item.id = `q-targets-opt-${String(i)}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      if (i === activeIndex) item.classList.add('q-combolist-active');
      const name = document.createElement('span');
      name.textContent = column.name;
      item.append(name);
      if (column.type !== undefined) {
        const type = document.createElement('span');
        type.className = 'q-combolist-type';
        type.textContent = column.type;
        item.append(type);
      }
      // mousedown (not click): keeps focus in the input, no blur round-trip.
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        add(column.name);
      });
      listbox.append(item);
    });
    listbox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (activeIndex >= 0) {
      input.setAttribute('aria-activedescendant', `q-targets-opt-${String(activeIndex)}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function add(raw: string): void {
    const value = raw.trim();
    input.value = '';
    closeList();
    if (value === '' || values.includes(value)) {
      renderChips();
      return;
    }
    values = [...values, value];
    renderChips();
    deps.onChange();
    input.focus();
  }

  input.addEventListener('input', () => {
    activeIndex = -1;
    renderList();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = filtered().length;
      if (count === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + delta + count) % count;
      renderList();
      return;
    }
    if (event.key === 'Enter') {
      // Always swallow Enter here — adding a chip must never save the rule.
      event.preventDefault();
      const options = filtered();
      const active = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (active !== undefined) add(active.name);
      else if (input.value.trim() !== '') add(input.value);
      return;
    }
    if (event.key === 'Escape') {
      if (!listbox.hidden) {
        event.preventDefault(); // close the list, not the drawer
        closeList();
      }
      return;
    }
    if (event.key === 'Backspace' && input.value === '' && values.length > 0) {
      event.preventDefault();
      values = values.slice(0, -1);
      renderChips();
      deps.onChange();
    }
  });

  input.addEventListener('blur', () => {
    closeList();
  });

  renderChips();

  return {
    el,
    getValues: () => [...values],
    setValues: (next) => {
      values = [...next];
      renderChips();
    },
    setColumns: (nextColumns, nextHasDataset) => {
      columns = nextColumns;
      hasDataset = nextHasDataset;
      renderChips();
      if (!listbox.hidden) renderList();
    },
    focus: () => {
      input.focus();
    },
  };
}
