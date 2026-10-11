/**
 * Preview → JSON Schema panel: the loaded JSON Schema as a data dictionary,
 * rendered by json-schema-data-dictionary's own `<json-data-dictionary>`
 * component (0.7.0) — ranked search, skip patterns you can follow from either
 * end, a Metadata panel, a sticky column header, resizable columns, Copy and
 * CSV, and a nested variable's fields as indented rows of their own. It replaced the table, search and row projection QuaC used to build
 * itself; the package owns that interaction now, and its tests pin it.
 *
 * The TAB is named for the input (`JSON Schema`, the slot card's name); the
 * caption inside names the rendering. Nobody loads "a data dictionary" — they
 * load a schema and QuaC reformats it into one.
 *
 * What stays QuaC's: the head and caption every Preview panel shares, the
 * state notes (this panel never duplicates the schema slot card's findings,
 * ignored-file list or CORS help: it points at the card and stops), and the
 * look — QuaC's fonts and colours reach the component through its `--dd-*`
 * properties (preview.css). The extraction contract is
 * core/schema/data-dictionary.ts.
 */
import type {
  DataDictionaryElement,
  DataDictionaryTable,
  RenderOptions,
} from 'json-schema-data-dictionary';
import { effect } from '../../../../app/signals';
import { dictionaryTable, topLevelRows } from '../../../../core/schema/data-dictionary';
import { needsRootChoice, schemaState } from '../../../../core/schema/schema-store';
import { note } from './previewDom';

const variables = (n: number): string => `${String(n)} variable${n === 1 ? '' : 's'}`;
const fields = (n: number): string => `${String(n)} nested field${n === 1 ? '' : 's'}`;

/**
 * - `theme: 'light'`: the default, `'auto'`, follows prefers-color-scheme and
 *   would put a dark dictionary inside QuaC's white work area on a dark-OS
 *   machine — the trap Verified fact V22 records for data-table's colorScheme.
 * - No `semanticSearch`: it downloads an embedding model from Hugging Face, and
 *   QuaC makes no third-party request after load (network-isolation.spec).
 *   Keyword search needs nothing else.
 */
const RENDER_OPTIONS: RenderOptions = { theme: 'light' };

type Render = (
  container: HTMLElement,
  table: DataDictionaryTable,
  options?: RenderOptions,
) => DataDictionaryElement;

let rendererPromise: Promise<Render> | null = null;

/**
 * Memoized dynamic import, for the entry chunk's sake: the Load view ships in
 * it, and the package must not. Resolves to the same lazy chunk as the core
 * module's extractor import.
 */
function loadRenderer(): Promise<Render> {
  rendererPromise ??= import('json-schema-data-dictionary').then((m) => m.renderDataDictionary);
  return rendererPromise;
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

  // The component's frame. It has a definite height (preview.css), which is
  // what lets the dictionary keep its title and toolbar in place and scroll its
  // table inside, under a sticky column header.
  const frame = document.createElement('div');
  frame.className = 'q-dd';
  /** One element for the panel's lifetime: see show(). */
  let element: DataDictionaryElement | null = null;

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
    const pending = dictionaryTable(set);
    if (pending === null) {
      showNote('This schema set has errors. Open the JSON Schema card for details.');
      return;
    }
    // Rendered synchronously before the await: the dynamic import already
    // yields a task boundary, and the extraction itself takes milliseconds.
    showNote('Building the data dictionary…');
    void Promise.all([pending, loadRenderer()])
      .then(([table, render]) => {
        if (mine !== token || schemaState.get().set !== set) return; // stale
        show(table, render);
      })
      .catch((err: unknown) => {
        if (mine !== token || schemaState.get().set !== set) return;
        // Panel state, not a toast: architecture.md §7 puts persistent
        // failures where the user can come back to them, and a toast expires.
        console.warn('data dictionary failed to build', err);
        showNote('The data dictionary could not be built from this schema.');
      });
  });

  function show(table: DataDictionaryTable | null, render: Render): void {
    if (table === null || table.rows.length === 0) {
      showNote('This schema defines no variables.');
      return;
    }
    // The head carries the SHAPE of the dictionary; the component's own count
    // beside its search box is the live readout as you type. Variables are
    // the dataset's columns; a nested one's field rows are counted apart.
    const categories = table.categories.length;
    const top = topLevelRows(table).length;
    const nested = table.rows.length - top;
    meta.textContent =
      `${String(categories)} categor${categories === 1 ? 'y' : 'ies'} · ${variables(top)}` +
      (nested > 0 ? ` · ${fields(nested)}` : '');

    // The frame is detached here — a note always precedes this — so a reused
    // element takes its new table while disconnected and renders once, on
    // reconnecting. Reuse is the point: the element keeps the reader's column
    // widths across its re-renders, so a schema reload does not reset them.
    if (element === null) {
      body.replaceChildren(frame);
      element = render(frame, table, RENDER_OPTIONS);
    } else {
      element.table = table;
      body.replaceChildren(frame);
    }
  }
}
