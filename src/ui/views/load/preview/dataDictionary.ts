/**
 * Preview → JSON Schema panel: every variable the loaded JSON Schema defines,
 * one table per category, with a search box over the lot.
 *
 * The TAB is named for the input (`JSON Schema`, the slot card's name); the
 * caption inside names the rendering. Nobody loads "a data dictionary" — they
 * load a schema and QuaC reformats it into one.
 *
 * DOM only — the model is core/schema/data-dictionary.ts. This panel never
 * duplicates the schema slot card's findings, ignored-file list or CORS help:
 * it points at the card and stops.
 */
import { effect } from '../../../../app/signals';
import {
  CONSTRAINT_CAP,
  EXTRA_CAP,
  VALUE_CAP,
  capped,
  dictionaryModel,
  parseQuery,
  rowMatches,
} from '../../../../core/schema/data-dictionary';
import type {
  DictionaryConstraint,
  DictionaryExtra,
  DictionaryModel,
  DictionaryRow,
  DictionaryValue,
} from '../../../../core/schema/data-dictionary';
import { needsRootChoice, schemaState } from '../../../../core/schema/schema-store';

/** A screen reader should hear "12 of 265 variables" once, not per keystroke. */
const COUNT_ANNOUNCE_DELAY_MS = 300;

const variables = (n: number): string => `${String(n)} variable${n === 1 ? '' : 's'}`;

function note(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'q-panel-note';
  p.textContent = text;
  return p;
}

/** `+3 more` behind a native <details> — keyboard-operable and axe-clean for free. */
function overflowDetails(count: number, render: (host: HTMLElement) => void): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `+${String(count)} more`;
  details.append(summary);
  render(details);
  return details;
}

function conditionLine(condition: string): HTMLElement {
  const when = document.createElement('span');
  when.className = 'q-dd-when';
  when.textContent = `when ${condition}`;
  return when;
}

function valueEl(value: DictionaryValue): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = value.kind === 'sentinel' ? 'q-dd-value q-dd-value--sentinel' : 'q-dd-value';
  // A `measurement` carries no code — its range IS the label. Rendering both
  // would print "null 1–20".
  if (value.code !== null) {
    const chip = document.createElement('span');
    chip.className = 'q-dd-chip';
    chip.textContent = value.code;
    wrap.append(chip);
  }
  if (value.label !== '') {
    const label = document.createElement('span');
    label.textContent = value.code === null ? value.label : ` ${value.label}`;
    if (value.code === null) label.className = 'q-dd-chip';
    wrap.append(label);
  }
  // The long, heavily-repeated `description` goes in `title`, not the cell:
  // 825 of them would triple the table's height.
  if (value.note !== undefined) wrap.title = value.note;
  if (value.condition !== undefined) wrap.append(conditionLine(value.condition));
  return wrap;
}

function valuesCell(row: DictionaryRow): HTMLTableCellElement {
  const td = document.createElement('td');
  if (row.values.length === 0) {
    td.textContent = '—';
    return td;
  }
  const list = document.createElement('div');
  list.className = 'q-dd-values';

  const append = (host: HTMLElement, from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      const value = row.values[i];
      if (value === undefined) continue;
      // The separator is the TEXT `Missing-value codes`, byte-identical to
      // tooltips.ts:83, so QuaC says the same thing in both places.
      if (i === row.sentinelStart) {
        const sep = document.createElement('div');
        sep.className = 'q-dd-valuesep';
        sep.textContent = 'Missing-value codes';
        host.append(sep);
      }
      host.append(valueEl(value));
    }
  };

  const { shown, hidden } = capped(row.values, VALUE_CAP);
  append(list, 0, shown.length);
  if (hidden.length > 0) {
    list.append(
      overflowDetails(hidden.length, (host) => {
        append(host, shown.length, row.values.length);
      }),
    );
  }
  td.append(list);
  return td;
}

function constraintEl(item: DictionaryConstraint): HTMLElement {
  const wrap = document.createElement('div');
  // `text` is already rendered prose from the extractor.
  wrap.append(document.createTextNode(item.text));
  if (item.condition !== undefined) wrap.append(conditionLine(item.condition));
  return wrap;
}

function constraintsCell(row: DictionaryRow): HTMLTableCellElement {
  const td = document.createElement('td');
  if (row.constraints.length === 0) {
    td.textContent = '—';
    return td;
  }
  const list = document.createElement('div');
  list.className = 'q-dd-constraints';
  const { shown, hidden } = capped(row.constraints, CONSTRAINT_CAP);
  for (const item of shown) list.append(constraintEl(item));
  if (hidden.length > 0) {
    list.append(
      overflowDetails(hidden.length, (host) => {
        for (const item of hidden) host.append(constraintEl(item));
      }),
    );
  }
  td.append(list);
  return td;
}

/** ~400 chars of JSON is plenty to recognise the shape; the schema file has the rest. */
const JSON_PREVIEW_CHARS = 400;

function extraEl(extra: DictionaryExtra): HTMLElement {
  const label = document.createElement('span');
  label.className = 'q-dd-extra-label';
  label.textContent = extra.label;
  if (!extra.nested) {
    const wrap = document.createElement('div');
    wrap.append(label, document.createTextNode(` ${extra.text}`));
    return wrap;
  }
  // Defensive path: on HESP every extra is a scalar (x-role, x-unit,
  // x-universe, x-derivation).
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.append(label);
  const pre = document.createElement('pre');
  pre.className = 'q-dd-json';
  pre.textContent =
    extra.text.length > JSON_PREVIEW_CHARS
      ? `${extra.text.slice(0, JSON_PREVIEW_CHARS)}…`
      : extra.text;
  details.append(summary, pre);
  return details;
}

function extrasCell(row: DictionaryRow): HTMLTableCellElement {
  const td = document.createElement('td');
  if (row.extras.length === 0) {
    td.textContent = '—';
    return td;
  }
  const list = document.createElement('div');
  list.className = 'q-dd-extras';
  const { shown, hidden } = capped(row.extras, EXTRA_CAP);
  for (const extra of shown) list.append(extraEl(extra));
  if (hidden.length > 0) {
    list.append(
      overflowDetails(hidden.length, (host) => {
        for (const extra of hidden) host.append(extraEl(extra));
      }),
    );
  }
  td.append(list);
  return td;
}

const COLUMNS = [
  'Variable',
  'Description',
  'Type',
  'Valid values',
  'Constraints',
  'Additional information',
] as const;

/**
 * Type and Format in ONE cell. Format was its own column until it was measured
 * against real data: 260 of HESP's 265 variables carry none, so the column was
 * ~95px of em-dash at 1440 — and the 5 that do carry one get a 40-character
 * `Matches pattern ^HH[0-9]{8}_W(0[1-9]|1[0-9]|20)$`, which wrapped to five
 * lines inside it. Folded in, the empty case costs nothing and the present case
 * gets the whole cell width. It also reads correctly: JSON Schema's `format`
 * qualifies a `type`, it is not a peer of it.
 */
function typeCell(row: DictionaryRow): HTMLTableCellElement {
  const td = document.createElement('td');
  if (row.type === '' && row.format === '') {
    td.textContent = '—';
    return td;
  }
  if (row.type !== '') td.append(document.createTextNode(row.type));
  if (row.format !== '') {
    // Same treatment as `.q-dd-when`: a muted mono line under the cell's
    // primary content. The payload is a regex far more often than a keyword.
    const format = document.createElement('span');
    format.className = 'q-dd-format';
    format.textContent = row.format;
    td.append(format);
  }
  return td;
}

interface RenderedRow {
  tr: HTMLTableRowElement;
  row: DictionaryRow;
}

interface RenderedCategory {
  section: HTMLDetailsElement;
  count: HTMLElement;
  rows: RenderedRow[];
  /** What the USER last left this open at — restored when a filter clears. */
  userOpen: boolean;
}

export function mountDataDictionary(panel: HTMLElement): void {
  const head = document.createElement('div');
  head.className = 'q-preview-panelhead';
  const title = document.createElement('h3');
  title.className = 'q-preview-paneltitle';
  title.textContent = 'JSON Schema';
  const meta = document.createElement('span');
  meta.className = 'q-preview-meta';
  head.append(title, meta);

  // Says what the thing below the head IS, in every state — the tab and title
  // name the input, so something has to name the rendering. Outside `body`, so
  // the state notes below replace themselves without taking it with them.
  const caption = document.createElement('p');
  caption.className = 'q-preview-panelcaption';
  caption.textContent = 'JSON Schema formatted as a data dictionary';

  const body = document.createElement('div');
  panel.append(head, caption, body);

  const showNote = (text: string): void => {
    meta.textContent = '';
    body.replaceChildren(note(text));
  };
  // "…to see it here", not "…to see its data dictionary": the caption directly
  // above already says what you would see, and the QC rules panel ends its
  // empty note the same way.
  const EMPTY = 'Load a JSON Schema to see it here.';
  showNote(EMPTY);

  let token = 0;
  effect(() => {
    const state = schemaState.get();
    const mine = (token += 1);

    if (state.phase === 'loading') {
      showNote('Reading the schema files…');
      return;
    }
    const set = state.set;
    if (state.phase === 'empty' || set === null) {
      showNote(EMPTY);
      return;
    }
    if (needsRootChoice(set)) {
      // No button here: the slot card already auto-opens the picker and offers
      // "Choose index…" (schemaSlotCard.ts:83). A second control would be a
      // second source of truth.
      showNote('Choose the index schema to build the data dictionary.');
      return;
    }
    const pending = dictionaryModel(set);
    if (pending === null) {
      showNote('This schema set has errors. Open the JSON Schema card for details.');
      return;
    }
    // Rendered synchronously before the await: the dynamic import already
    // yields a task boundary, and the build itself is 18 ms for all of HESP.
    showNote('Building the data dictionary…');
    void pending
      .then((model) => {
        if (mine !== token || schemaState.get().set !== set) return; // stale
        renderModel(model);
      })
      .catch((err: unknown) => {
        if (mine !== token || schemaState.get().set !== set) return;
        // Panel state, not a toast: architecture.md §7 puts persistent
        // failures where the user can come back to them, and a toast expires.
        console.warn('data dictionary failed to build', err);
        showNote('The data dictionary could not be built from this schema.');
      });
  });

  function renderModel(model: DictionaryModel): void {
    if (model.rowCount === 0) {
      showNote('This schema defines no variables.');
      return;
    }
    // The panel head carries the SHAPE of the dictionary; the count below is
    // the live filter readout. Repeating "265 variables" in both would waste
    // the one line that tells you how the variables are organised.
    const categories = model.categories.length;
    meta.textContent = `${String(categories)} categor${categories === 1 ? 'y' : 'ies'} · ${variables(
      model.rowCount,
    )}`;

    const searchWrap = document.createElement('div');
    searchWrap.className = 'q-dd-head';
    const field = document.createElement('div');
    field.className = 'q-dd-search';
    // A REAL visible <label for>, not aria-label: it matches createUrlField's
    // .q-urlfield-label and satisfies axe's `label` (critical).
    const label = document.createElement('label');
    label.className = 'q-dd-search-label';
    label.htmlFor = 'q-dd-search';
    label.textContent = 'Search variables';
    const input = document.createElement('input');
    input.id = 'q-dd-search';
    input.className = 'q-dd-search-input';
    input.type = 'search'; // native clear button + Escape-to-clear
    input.autocomplete = 'off';
    input.placeholder = 'Name, description, code, or constraint';
    field.append(label, input);

    // Filled by the category loop below; the control beside the search box and
    // the filter both drive the categories through it.
    const rendered: RenderedCategory[] = [];
    // Clicking twelve headers is not a bird's-eye view. The label is DERIVED
    // from what is on screen rather than stored, so it cannot drift out of step
    // with a category collapsed by hand.
    const anyOpen = (): boolean => rendered.some((c) => !c.section.hidden && c.section.open);
    const toggleAll = document.createElement('button');
    toggleAll.type = 'button';
    toggleAll.className = 'q-btn q-btn--ghost q-btn--small q-dd-toggleall';
    const syncToggleAll = (): void => {
      toggleAll.textContent = anyOpen() ? 'Collapse all' : 'Expand all';
    };
    toggleAll.addEventListener('click', () => {
      const target = !anyOpen();
      for (const category of rendered) {
        category.section.open = target;
        category.userOpen = target;
      }
      syncToggleAll();
    });

    const count = document.createElement('p');
    count.className = 'q-dd-count';
    count.setAttribute('role', 'status');
    count.textContent = variables(model.rowCount);
    searchWrap.append(field, toggleAll, count);

    const scroll = document.createElement('div');
    scroll.className = 'q-dd-scroll';
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    // Named distinctly from the tab panel itself.
    scroll.setAttribute('aria-label', 'Data dictionary variables');

    model.categories.forEach((category, index) => {
      // A native <details>, for the same reasons overflowDetails() is one: the
      // whole header row becomes the click target, Enter and Space work, and
      // both Collapse all and the search override reduce to writing `.open`.
      // Open by default — nothing moves until you click, and axe skips
      // unrendered subtrees, so a collapsed default would take twelve tables
      // out of the gate (a11y.spec.ts:114-117).
      const section = document.createElement('details');
      section.className = 'q-dd-cat';
      section.open = true;
      section.addEventListener('toggle', syncToggleAll);
      const catHead = document.createElement('summary');
      catHead.className = 'q-dd-cathead';
      // <summary> takes "phrasing content, optionally intermixed with heading
      // content" (WHATWG), so the <h4> stays a real heading inside it: the
      // h3 → h4 order and the table's aria-labelledby are untouched.
      const mark = document.createElement('span');
      mark.className = 'q-dd-catmark';
      mark.setAttribute('aria-hidden', 'true');
      const catTitle = document.createElement('h4');
      catTitle.className = 'q-dd-cattitle';
      // Index-based, not the package's slug: deterministic and always a valid
      // HTML id (axe: duplicate-id-aria).
      catTitle.id = `q-dd-cat-${String(index)}`;
      catTitle.textContent = category.title;
      const catCount = document.createElement('span');
      catCount.className = 'q-dd-catcount';
      catCount.textContent = variables(category.rows.length);
      catHead.append(mark, catTitle, catCount);
      section.append(catHead);
      if (category.description !== undefined) {
        const desc = document.createElement('p');
        desc.className = 'q-dd-catdesc';
        desc.textContent = category.description;
        section.append(desc);
      }

      const table = document.createElement('table');
      table.className = 'q-dd-table';
      table.setAttribute('aria-labelledby', catTitle.id);
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const column of COLUMNS) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = column;
        headRow.append(th);
      }
      thead.append(headRow);
      const tbody = document.createElement('tbody');
      const rows: RenderedRow[] = [];
      for (const row of category.rows) {
        const tr = document.createElement('tr');
        const name = document.createElement('th');
        name.scope = 'row';
        name.className = 'q-dd-name';
        name.textContent = row.name;
        const desc = document.createElement('td');
        desc.className = 'q-dd-desc';
        desc.textContent = row.description;
        tr.append(name, desc, typeCell(row), valuesCell(row), constraintsCell(row), extrasCell(row));
        tbody.append(tr);
        rows.push({ tr, row });
      }
      table.append(thead, tbody);
      section.append(table);
      scroll.append(section);
      rendered.push({ section, count: catCount, rows, userOpen: true });
    });
    syncToggleAll();

    body.replaceChildren(searchWrap, scroll);

    if (model.warnings.length > 0) {
      // Deliberately NOT merged into the slot card's Findings list, which is
      // QuaC's E_* vocabulary with a severity model — not free-text
      // extraction notes.
      const details = document.createElement('details');
      details.className = 'q-dd-notes';
      const summary = document.createElement('summary');
      summary.textContent = `Dictionary notes (${String(model.warnings.length)})`;
      const list = document.createElement('ul');
      for (const warning of model.warnings) {
        const li = document.createElement('li');
        li.textContent = warning;
        list.append(li);
      }
      details.append(summary, list);
      body.append(details);
    }

    // ---- filtering ----
    // A per-row `hidden` toggle, not a rebuild. Throughput is not the reason
    // (0.066 ms per keystroke over 265 precomputed haystacks): a rebuild would
    // allocate ~8,500 nodes per keystroke, destroy every <details> the user
    // just opened, and reset the scroll position mid-typing.
    let announce: ReturnType<typeof setTimeout> | undefined;
    // Search wins over a collapsed category — a match you cannot see is a
    // filter that lies — but it must hand back what the user had open. The
    // snapshot is taken on the TRANSITION into filtering rather than by
    // listening for user toggles: `toggle` fires from a queued task and cannot
    // tell a click from a programmatic write.
    let filtering = false;
    const applyFilter = (): void => {
      const tokens = parseQuery(input.value);
      const nowFiltering = tokens.length > 0;
      if (nowFiltering && !filtering) for (const c of rendered) c.userOpen = c.section.open;
      let visible = 0;
      for (const category of rendered) {
        let shown = 0;
        for (const { tr, row } of category.rows) {
          const match = rowMatches(row, tokens);
          tr.hidden = !match;
          if (match) shown += 1;
        }
        // The per-category count shows the CURRENTLY VISIBLE number, so it is
        // never a lie while filtered; empty categories hide entirely.
        category.count.textContent = variables(shown);
        category.section.hidden = shown === 0;
        category.section.open = nowFiltering ? shown > 0 : category.userOpen;
        visible += shown;
      }
      filtering = nowFiltering;
      syncToggleAll();

      const empty = body.querySelector('.q-dd-empty');
      if (visible === 0) {
        if (empty === null) {
          const p = note(`No variables match '${input.value.trim()}'.`);
          p.classList.add('q-dd-empty');
          scroll.after(p);
        } else {
          empty.textContent = `No variables match '${input.value.trim()}'.`;
        }
      } else {
        empty?.remove();
      }

      const text =
        tokens.length === 0
          ? variables(model.rowCount)
          : `${String(visible)} of ${variables(model.rowCount)}`;
      // The filter runs synchronously; only the role="status" readout is
      // debounced, so a screen reader hears the result once when you stop
      // typing. 300 ms of lag on a secondary readout is imperceptible.
      clearTimeout(announce);
      announce = setTimeout(() => {
        count.textContent = text;
      }, COUNT_ANNOUNCE_DELAY_MS);
    };
    input.addEventListener('input', applyFilter);
  }
}
