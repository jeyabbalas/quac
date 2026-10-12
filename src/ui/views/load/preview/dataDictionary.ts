/**
 * Preview → JSON Schema panel: the loaded JSON Schema as a data dictionary,
 * rendered by json-schema-data-dictionary's own `<json-data-dictionary>`
 * component (0.8.0) — ranked search, skip patterns you can follow from either
 * end, a Metadata panel, a sticky column header, resizable columns, Copy and
 * an Excel download, and a nested variable's fields as indented rows of their
 * own. It replaced the table, search and row projection QuaC used to build
 * itself; the package owns that interaction now, and its tests pin it.
 *
 * The TAB is named for the input (`JSON Schema`, the slot card's name); the
 * caption inside names the rendering. Nobody loads "a data dictionary" — they
 * load a schema and QuaC reformats it into one.
 *
 * What stays QuaC's: the head and caption every Preview panel shares, the
 * state notes (this panel never duplicates the schema slot card's findings,
 * ignored-file list or CORS help: it points at the card and stops), the
 * Semantic search switch in the head (semanticSearch.ts), and the look —
 * QuaC's fonts and colours reach the component through its `--dd-*`
 * properties (preview.css). The extraction contract is
 * core/schema/data-dictionary.ts.
 */
import type {
  ColumnResizeDetail,
  ColumnWidths,
  DataDictionaryElement,
  DataDictionaryTable,
  RenderOptions,
} from 'json-schema-data-dictionary';
import { effect } from '../../../../app/signals';
import { dictionaryTable, topLevelRows } from '../../../../core/schema/data-dictionary';
import { needsRootChoice, schemaState } from '../../../../core/schema/schema-store';
import { note } from './previewDom';
import {
  readSemanticPref,
  semanticSearchOptions,
  stopSemanticSearch,
  writeSemanticPref,
} from './semanticSearch';
import type { SemanticLibraryExports } from './semanticSearch';

const variables = (n: number): string => `${String(n)} variable${n === 1 ? '' : 's'}`;
const fields = (n: number): string => `${String(n)} nested field${n === 1 ? '' : 's'}`;

/**
 * `theme: 'light'`: the default, `'auto'`, follows prefers-color-scheme and
 * would put a dark dictionary inside QuaC's white work area on a dark-OS
 * machine — the trap Verified fact V22 records for data-table's colorScheme.
 * `semanticSearch` is added while the head's switch is on.
 */
const RENDER_OPTIONS: RenderOptions = { theme: 'light' };

/** What the panel uses of the package: the renderer, and what semantic search needs. */
type Library = Pick<
  typeof import('json-schema-data-dictionary'),
  'renderDataDictionary' | SemanticLibraryExports
>;

let libraryPromise: Promise<Library> | null = null;

/**
 * Memoized dynamic import, for the entry chunk's sake: the Load view ships in
 * it, and the package must not. Resolves to the same lazy chunk as the core
 * module's extractor import. The destructuring names what is used, so the
 * bundler can leave the rest of the package out of that chunk.
 */
function loadLibrary(): Promise<Library> {
  libraryPromise ??= import('json-schema-data-dictionary').then(
    ({ renderDataDictionary, createWorkerEmbedder, createIndexedDbVectorCache }) => ({
      renderDataDictionary,
      createWorkerEmbedder,
      createIndexedDbVectorCache,
    }),
  );
  return libraryPromise;
}

/** The component's search box, inside its open shadow root. */
const searchBox = (element: DataDictionaryElement): HTMLInputElement | null =>
  element.shadowRoot?.querySelector<HTMLInputElement>('[data-dd-search]') ?? null;

export function mountDataDictionary(panel: HTMLElement): void {
  const head = document.createElement('div');
  head.className = 'q-preview-panelhead';
  const title = document.createElement('h3');
  title.className = 'q-preview-paneltitle';
  title.textContent = 'JSON Schema';
  const meta = document.createElement('span');
  meta.className = 'q-preview-meta';

  // The switch. A plain labelled checkbox, like the run bar's Apply
  // corrections. Hidden with the dictionary: there is nothing to search in a
  // state note.
  const semantic = document.createElement('label');
  semantic.className = 'q-dd-semantic';
  semantic.title =
    'Also list variables related in meaning, not only those that share a word. ' +
    'Runs the LEAF model in this browser; the first use downloads it from this site, ' +
    'and nothing is sent anywhere.';
  const semanticBox = document.createElement('input');
  semanticBox.type = 'checkbox';
  semanticBox.checked = readSemanticPref();
  semantic.append(semanticBox, document.createTextNode(' Semantic search'));
  semantic.hidden = true;

  const side = document.createElement('span');
  side.className = 'q-dd-headside';
  side.append(meta, semantic);
  head.append(title, side);

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
  let lib: Library | null = null;

  // The reader's column widths, handed back on every render: assigning the
  // component's options (the switch, a new schema) starts it from these
  // rather than from its defaults.
  let widths: ColumnWidths | undefined;
  frame.addEventListener('dd-column-resize', (event) => {
    widths = (event as CustomEvent<ColumnResizeDetail>).detail.widths;
  });

  const optionsFor = (library: Library): RenderOptions => ({
    ...RENDER_OPTIONS,
    ...(widths === undefined ? {} : { columnWidths: widths }),
    ...(semanticBox.checked ? { semanticSearch: semanticSearchOptions(library) } : {}),
  });

  semanticBox.addEventListener('change', () => {
    writeSemanticPref(semanticBox.checked);
    if (element !== null && lib !== null) {
      // New options re-render the component; a query typed before the flip
      // is run again, now with (or without) the related variables.
      const query = searchBox(element)?.value ?? '';
      element.options = optionsFor(lib);
      const box = searchBox(element);
      if (box !== null && query !== '') {
        box.value = query;
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    // After the re-render, which dropped the dictionary's index.
    if (!semanticBox.checked) void stopSemanticSearch();
  });

  const showNote = (text: string): void => {
    meta.textContent = '';
    semantic.hidden = true;
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
    void Promise.all([pending, loadLibrary()])
      .then(([table, library]) => {
        if (mine !== token || schemaState.get().set !== set) return; // stale
        show(table, library);
      })
      .catch((err: unknown) => {
        if (mine !== token || schemaState.get().set !== set) return;
        // Panel state, not a toast: architecture.md §7 puts persistent
        // failures where the user can come back to them, and a toast expires.
        console.warn('data dictionary failed to build', err);
        showNote('The data dictionary could not be built from this schema.');
      });
  });

  function show(table: DataDictionaryTable | null, library: Library): void {
    if (table === null || table.rows.length === 0) {
      showNote('This schema defines no variables.');
      return;
    }
    lib = library;
    // The head carries the SHAPE of the dictionary; the component's own count
    // beside its search box is the live readout as you type. Variables are
    // the dataset's columns; a nested one's field rows are counted apart.
    const categories = table.categories.length;
    const top = topLevelRows(table).length;
    const nested = table.rows.length - top;
    meta.textContent =
      `${String(categories)} categor${categories === 1 ? 'y' : 'ies'} · ${variables(top)}` +
      (nested > 0 ? ` · ${fields(nested)}` : '');
    semantic.hidden = false;

    // The frame is detached here — a note always precedes this — so a reused
    // element takes its options and table while disconnected and renders
    // once, on reconnecting. Options are re-read every time: the switch may
    // have moved, or a cleared schema stopped the semantic worker, while no
    // dictionary was on show.
    if (element === null) {
      body.replaceChildren(frame);
      element = library.renderDataDictionary(frame, table, optionsFor(library));
    } else {
      element.options = optionsFor(library);
      element.table = table;
      body.replaceChildren(frame);
    }
  }
}
