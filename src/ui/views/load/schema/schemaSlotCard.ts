/**
 * JSON Schema slot card (ingestion.md §3, ui-design.md §4) on the shared
 * SlotCard/DropZone/UrlField primitives. Schema-specific extras: a "Browse
 * folder" action owning the webkitdirectory input, the "Choose index…"
 * re-open button, and a bespoke details renderer (facts, ignored files,
 * findings) whose q-schemaslot-* inner classes are pinned by e2e specs.
 */
import { reportError } from '../../../../app/errors';
import { effect } from '../../../../app/signals';
import {
  loadSchemaEntries,
  loadSchemaUrls,
  needsRootChoice,
  schemaState,
  summarizeSlot,
} from '../../../../core/schema/schema-store';
import type { SchemaSlotState } from '../../../../core/schema/schema-store';
import type { SchemaLoadError, SchemaSet } from '../../../../core/schema/types';
import { createCorsHelp } from '../../../components/corsHelp';
import { createDropZone } from '../../../components/dropZone';
import { createSlotCard } from '../../../components/slotCard';
import { createUrlField } from '../../../components/urlField';
import { entriesFromDataTransfer, entriesFromFileList } from './intake-dom';
import { openIndexPickerModal } from './indexPickerModal';
import './schemaSlot.css';

function severityLabel(error: SchemaLoadError): string {
  return error.severity === 'fatal' ? 'Error' : error.severity === 'warning' ? 'Warning' : 'Note';
}

export function mountSchemaSlotCard(container: HTMLElement): void {
  const card = createSlotCard('JSON Schema');

  const load = (work: Promise<void>): void => {
    work.catch((err: unknown) => reportError(err, { fallbackCode: 'SCHEMA_INVALID' }));
  };

  // Card-level drag/drop: schemaLoad.spec dispatches synthetic drops on the
  // card element, and folder drops need the DataTransfer entries walk.
  const dropZone = createDropZone({
    label: 'Drop schema file(s) or a folder here, or',
    accept: '.json,application/json',
    multiple: true,
    inputAriaLabel: 'Browse schema files',
    dropTarget: card.el,
    onDropTransfer: (dt) => {
      load(entriesFromDataTransfer(dt).then(loadSchemaEntries));
    },
    onFiles: (files) => {
      load(entriesFromFileList(files).then(loadSchemaEntries));
    },
  });

  const urlField = createUrlField({
    label: 'URL',
    inputAriaLabel: 'Schema URL',
    placeholder: 'https://example.org/schema.json',
    onFetch: (value) => {
      const urls = value.split(/\s+/).filter((u) => u !== '');
      if (urls.length > 0) load(loadSchemaUrls(urls));
    },
  });

  // "Browse folder" owns the webkitdirectory input (aria-label pinned).
  const dirInput = document.createElement('input');
  dirInput.type = 'file';
  dirInput.hidden = true;
  dirInput.setAttribute('webkitdirectory', '');
  dirInput.setAttribute('aria-label', 'Browse schema folder');
  dirInput.addEventListener('change', () => {
    if (dirInput.files === null || dirInput.files.length === 0) return;
    load(entriesFromFileList(dirInput.files).then(loadSchemaEntries));
    dirInput.value = '';
  });
  const browseDir = document.createElement('button');
  browseDir.type = 'button';
  browseDir.className = 'q-btn q-btn--small';
  browseDir.textContent = 'Browse folder';
  browseDir.addEventListener('click', () => {
    dirInput.click();
  });

  const chooseButton = document.createElement('button');
  chooseButton.type = 'button';
  chooseButton.className = 'q-btn q-btn--small';
  chooseButton.textContent = 'Choose index…';
  chooseButton.hidden = true;
  chooseButton.addEventListener('click', () => {
    const state = schemaState.get();
    if (state.set !== null && needsRootChoice(state.set)) {
      openIndexPickerModal({ set: state.set });
    }
  });

  card.bodyHost.append(dropZone.el, urlField.el);
  card.actionsHost.append(browseDir, dirInput, chooseButton);
  container.append(card.el);

  /* ---------- rendering ---------- */

  const detailsBody = document.createElement('div');
  detailsBody.className = 'q-schemaslot-detailsbody';

  function renderDetails(set: SchemaSet): void {
    detailsBody.replaceChildren();
    const facts = document.createElement('ul');
    facts.className = 'q-schemaslot-facts';
    const factItems: string[] = [];
    factItems.push(
      set.schemas.length === 1 ? '1 schema file' : `${String(set.schemas.length)} schema files`,
    );
    const root = set.files.find((f) => f.fileId === set.root.rootFileId);
    if (root !== undefined) factItems.push(`root: ${root.relativePath}`);
    if (set.root.indexFileId !== undefined) factItems.push(`index id: ${set.root.indexFileId}`);
    factItems.push(`set id: ${set.setId}`);
    for (const text of factItems) {
      const li = document.createElement('li');
      li.textContent = text;
      facts.append(li);
    }
    detailsBody.append(facts);

    if (set.ignored.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'q-schemaslot-subhead';
      heading.textContent = 'Ignored files';
      const list = document.createElement('ul');
      list.className = 'q-schemaslot-ignored';
      for (const item of set.ignored) {
        const li = document.createElement('li');
        li.textContent = `${item.fileId} (${item.reason.replaceAll('-', ' ')})`;
        list.append(li);
      }
      detailsBody.append(heading, list);
    }

    if (set.errors.length > 0) {
      const heading = document.createElement('p');
      heading.className = 'q-schemaslot-subhead';
      heading.textContent = 'Findings';
      const list = document.createElement('ul');
      list.className = 'q-schemaslot-findings';
      for (const error of set.errors) {
        const li = document.createElement('li');
        li.className = `q-schemaslot-finding q-schemaslot-finding--${error.severity}`;
        li.textContent = `${severityLabel(error)}: ${error.message}`;
        list.append(li);
      }
      detailsBody.append(heading, list);
    }

    // P16: a cross-origin fetch failure gets the "which hosts work?" table.
    if (set.errors.some((e) => e.code === 'E_FETCH' && /cross-origin|CORS/i.test(e.message))) {
      detailsBody.append(createCorsHelp());
    }
  }

  let promptedSetId: string | null = null;

  function render(state: SchemaSlotState): void {
    const set = state.set;
    const pendingChoice = state.phase === 'ready' && set !== null && needsRootChoice(set);
    chooseButton.hidden = !pendingChoice;

    // Fill the detail host BEFORE update() — it derives details visibility
    // from the host's child count.
    if (state.phase !== 'ready' || set === null) {
      card.detailHost.replaceChildren();
    } else {
      renderDetails(set);
      card.detailHost.replaceChildren(detailsBody);
    }
    card.update(summarizeSlot(state));

    if (state.phase !== 'ready' || set === null) return;
    if (set.errors.some((e) => e.severity === 'fatal')) card.setDetailsOpen(true);

    // Auto-open the picker once per loaded set; the button re-opens it.
    if (pendingChoice && promptedSetId !== set.setId) {
      promptedSetId = set.setId;
      openIndexPickerModal({ set });
    }
  }

  effect(() => {
    render(schemaState.get());
  });
}
