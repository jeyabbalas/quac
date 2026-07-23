/**
 * JSON Schema slot card (ingestion.md §3, ui-design.md §4): drop zone (a real
 * button), multi-file + folder browse inputs, URL field, status badge, and a
 * details area with counts, root, ignored files, and every collected finding.
 * Self-contained on purpose — generic SlotCard/DropZone components are P05's
 * to claim; consolidation is deferred to the merge.
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
import { createBadge } from '../../../components/badge';
import type { BadgeTone } from '../../../components/badge';
import { entriesFromDataTransfer, entriesFromFileList } from './intake-dom';
import { openIndexPickerModal } from './indexPickerModal';
import './schemaSlot.css';

const BADGE_BY_STATUS: Record<string, { text: string; tone: BadgeTone }> = {
  empty: { text: 'Empty', tone: 'neutral' },
  loading: { text: 'Loading…', tone: 'info' },
  valid: { text: 'Valid', tone: 'valid' },
  warning: { text: 'Warning', tone: 'warning' },
  error: { text: 'Error', tone: 'error' },
};

function severityLabel(error: SchemaLoadError): string {
  return error.severity === 'fatal' ? 'Error' : error.severity === 'warning' ? 'Warning' : 'Note';
}

export function mountSchemaSlotCard(container: HTMLElement): void {
  const card = document.createElement('section');
  card.className = 'q-schemaslot';
  card.setAttribute('aria-labelledby', 'q-schemaslot-title');

  const head = document.createElement('header');
  head.className = 'q-schemaslot-head';
  const title = document.createElement('h3');
  title.id = 'q-schemaslot-title';
  title.textContent = 'JSON Schema';
  const badgeHolder = document.createElement('span');
  badgeHolder.className = 'q-schemaslot-badge';
  head.append(title, badgeHolder);

  const detailLine = document.createElement('p');
  detailLine.className = 'q-schemaslot-detail';

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'q-schemaslot-drop';
  drop.textContent = 'Drop schema file(s) or a folder here';
  drop.setAttribute('aria-label', 'Drop JSON Schema files or a folder, or press to browse files');

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.setAttribute('aria-label', 'Browse schema files');

  const dirInput = document.createElement('input');
  dirInput.type = 'file';
  dirInput.hidden = true;
  dirInput.setAttribute('webkitdirectory', '');
  dirInput.setAttribute('aria-label', 'Browse schema folder');

  const browse = document.createElement('div');
  browse.className = 'q-schemaslot-browse';
  const browseFiles = document.createElement('button');
  browseFiles.type = 'button';
  browseFiles.className = 'q-btn q-btn--small';
  browseFiles.textContent = 'Browse files';
  const browseDir = document.createElement('button');
  browseDir.type = 'button';
  browseDir.className = 'q-btn q-btn--small';
  browseDir.textContent = 'Browse folder';
  browse.append(browseFiles, browseDir, fileInput, dirInput);

  const urlForm = document.createElement('form');
  urlForm.className = 'q-schemaslot-url';
  const urlLabel = document.createElement('label');
  urlLabel.className = 'q-schemaslot-urllabel';
  urlLabel.textContent = 'URL';
  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.placeholder = 'https://example.org/schema.json';
  urlInput.setAttribute('aria-label', 'Schema URL');
  urlLabel.append(urlInput);
  const urlSubmit = document.createElement('button');
  urlSubmit.type = 'submit';
  urlSubmit.className = 'q-btn q-btn--small';
  urlSubmit.textContent = 'Fetch';
  urlForm.append(urlLabel, urlSubmit);

  const chooseButton = document.createElement('button');
  chooseButton.type = 'button';
  chooseButton.className = 'q-btn q-btn--small q-schemaslot-choose';
  chooseButton.textContent = 'Choose index…';
  chooseButton.hidden = true;

  const details = document.createElement('details');
  details.className = 'q-schemaslot-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  const detailsBody = document.createElement('div');
  detailsBody.className = 'q-schemaslot-detailsbody';
  details.append(summary, detailsBody);

  card.append(head, detailLine, drop, browse, urlForm, chooseButton, details);
  container.append(card);

  /* ---------- intake wiring ---------- */

  const load = (work: Promise<void>): void => {
    work.catch((err: unknown) => reportError(err, { fallbackCode: 'SCHEMA_INVALID' }));
  };

  drop.addEventListener('click', () => {
    fileInput.click();
  });
  browseFiles.addEventListener('click', () => {
    fileInput.click();
  });
  browseDir.addEventListener('click', () => {
    dirInput.click();
  });
  for (const input of [fileInput, dirInput]) {
    input.addEventListener('change', () => {
      if (input.files === null || input.files.length === 0) return;
      const files = input.files;
      load(entriesFromFileList(files).then(loadSchemaEntries));
      input.value = '';
    });
  }

  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    card.classList.add('q-schemaslot--dragging');
  });
  card.addEventListener('dragleave', () => {
    card.classList.remove('q-schemaslot--dragging');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('q-schemaslot--dragging');
    if (event.dataTransfer === null) return;
    load(entriesFromDataTransfer(event.dataTransfer).then(loadSchemaEntries));
  });

  urlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const urls = urlInput.value.split(/\s+/).filter((u) => u !== '');
    if (urls.length === 0) return;
    load(loadSchemaUrls(urls));
  });

  chooseButton.addEventListener('click', () => {
    const state = schemaState.get();
    if (state.set !== null && needsRootChoice(state.set)) {
      openIndexPickerModal({ set: state.set });
    }
  });

  /* ---------- rendering ---------- */

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
  }

  let promptedSetId: string | null = null;

  function render(state: SchemaSlotState): void {
    const slot = summarizeSlot(state);
    const badge = BADGE_BY_STATUS[slot.status] ?? BADGE_BY_STATUS.empty;
    badgeHolder.replaceChildren(createBadge(badge?.text ?? 'Empty', badge?.tone ?? 'neutral'));
    detailLine.textContent = slot.detail;

    const set = state.set;
    const pendingChoice = state.phase === 'ready' && set !== null && needsRootChoice(set);
    chooseButton.hidden = !pendingChoice;

    if (state.phase !== 'ready' || set === null) {
      details.hidden = true;
      detailsBody.replaceChildren();
      return;
    }
    details.hidden = false;
    renderDetails(set);
    if (set.errors.some((e) => e.severity === 'fatal')) details.open = true;

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
