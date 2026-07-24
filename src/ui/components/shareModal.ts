/**
 * ShareModal (url-params.md §4): the assembled link up top (char count + Copy,
 * or the `config=` manifest path past MAX_URL_CHARS), then per-slot provenance
 * — URL-loaded ✓ included / uploaded ✗ excluded + why. Schema's crawl bases
 * collapse into one grouped row (file count + root) with the URLs behind a
 * <details>. Reads the authoritative slot states; nothing uploaded ever
 * enters the link.
 */
import { openModal } from '../../app/modal';
import { showToast } from '../../app/toast';
import { triggerDownload } from './download';
import { rulesState } from '../../core/rules/rules-store';
import { schemaState } from '../../core/schema/schema-store';
import { configToManifest } from '../../core/share/configManifest';
import { buildShareModel } from '../../core/share/shareModel';
import { MAX_URL_CHARS, assembleFragment } from '../../core/share/urlConfig';
import type { AppStore } from '../../app/store';
import type { SchemaSet } from '../../core/schema/types';
import type { ShareArtifact, ShareModel } from '../../core/share/shareModel';
import './shareModal.css';

const SLOT_LABEL: Record<ShareArtifact['slot'], string> = {
  data: 'Dataset',
  schema: 'Schema',
  rules: 'Rules',
};

const UPLOAD_EXPLANATION =
  "Uploaded files can't travel in a link. Host this file (GitHub raw / gist) and load it by URL to include it.";

/** Render-time context for the grouped schema row (the model stays per-URL). */
interface SchemaGroupInfo {
  fileCount: number;
  root?: string;
}

function rootLabel(set: SchemaSet): string | undefined {
  return set.files.find((f) => f.fileId === set.root.rootFileId)?.relativePath;
}

function collectShareModel(store: AppStore): ShareModel {
  const dataset = store.dataset.get();
  const schema = schemaState.get();
  const rules = rulesState.get();
  const set = schema.set;
  const label = set ? rootLabel(set) : undefined;
  return buildShareModel({
    dataset:
      dataset === null
        ? null
        : {
            name: dataset.name,
            ...(dataset.sourceUrl !== undefined ? { sourceUrl: dataset.sourceUrl } : {}),
          },
    schema:
      set === null
        ? null
        : {
            origin: set.origin,
            sourceUrls: schema.sourceUrls,
            ...(label !== undefined ? { rootLabel: label } : {}),
            ...(set.root.indexFileId !== undefined ? { indexFileId: set.root.indexFileId } : {}),
          },
    rules: rules.files.map((f, i) => ({
      name: f.file.name,
      sourceUrl: rules.sources[i] ?? null,
    })),
  });
}

function schemaGroupInfo(): SchemaGroupInfo | null {
  const set = schemaState.get().set;
  if (set === null) return null;
  const root = rootLabel(set);
  return { fileCount: set.files.length, ...(root !== undefined ? { root } : {}) };
}

/** One row per dataset / rules file / uploaded schema set. */
function artifactItem(artifact: ShareArtifact): HTMLElement {
  const item = document.createElement('li');
  item.className = `q-share-item q-share-item--${artifact.shareable ? 'in' : 'out'}`;

  const mark = document.createElement('span');
  mark.className = 'q-share-mark';
  mark.textContent = artifact.shareable ? '✓' : '✗';
  mark.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'q-share-item-body';
  const label = document.createElement('span');
  label.className = 'q-share-label';
  label.textContent = `${SLOT_LABEL[artifact.slot]}: ${artifact.label}`;
  body.append(label);

  if (artifact.shareable && artifact.url !== undefined) {
    const url = document.createElement('code');
    url.className = 'q-share-url';
    url.textContent = artifact.url;
    body.append(url);
  } else {
    const note = document.createElement('p');
    note.className = 'q-share-note';
    note.textContent = UPLOAD_EXPLANATION;
    body.append(note);
  }
  item.append(mark, body);
  return item;
}

function schemaGroupLabel(info: SchemaGroupInfo | null): string {
  if (info === null) return 'Schema';
  const files = `${String(info.fileCount)} file${info.fileCount === 1 ? '' : 's'}`;
  return info.root !== undefined ? `Schema: ${files} · root ${info.root}` : `Schema: ${files}`;
}

/** URL-loaded schema: one row for the whole set, crawl bases in a <details>. */
function schemaGroupItem(urls: ShareArtifact[], info: SchemaGroupInfo | null): HTMLElement {
  const item = document.createElement('li');
  item.className = 'q-share-item q-share-item--in';

  const mark = document.createElement('span');
  mark.className = 'q-share-mark';
  mark.textContent = '✓';
  mark.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'q-share-item-body';
  const label = document.createElement('span');
  label.className = 'q-share-label';
  label.textContent = schemaGroupLabel(info);

  const details = document.createElement('details');
  details.className = 'q-share-urls';
  const summary = document.createElement('summary');
  summary.textContent = `${String(urls.length)} source URL${urls.length === 1 ? '' : 's'} in the link`;
  const list = document.createElement('ul');
  list.className = 'q-share-urllist';
  for (const artifact of urls) {
    const entry = document.createElement('li');
    const code = document.createElement('code');
    code.className = 'q-share-url';
    code.textContent = artifact.url ?? '';
    entry.append(code);
    list.append(entry);
  }
  details.append(summary, list);

  body.append(label, details);
  item.append(mark, body);
  return item;
}

function renderProvenance(model: ShareModel, info: SchemaGroupInfo | null): HTMLElement {
  const section = document.createElement('div');
  section.className = 'q-share-provenance';
  const heading = document.createElement('h3');
  heading.className = 'q-share-subhead';
  heading.textContent = 'Loaded files';

  const list = document.createElement('ul');
  list.className = 'q-share-list';
  // The model carries one schema artifact per crawl base; they render as a
  // single grouped row. Everything else stays one row per artifact.
  const schemaUrls = model.artifacts.filter((a) => a.slot === 'schema' && a.shareable);
  let schemaGrouped = false;
  for (const artifact of model.artifacts) {
    if (artifact.slot === 'schema' && artifact.shareable) {
      if (!schemaGrouped) {
        list.append(schemaGroupItem(schemaUrls, info));
        schemaGrouped = true;
      }
      continue;
    }
    list.append(artifactItem(artifact));
  }

  section.append(heading, list);
  return section;
}

function renderLinkSection(model: ShareModel, shareBase: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'q-share-link-section';

  const fullUrl = `${shareBase}${assembleFragment(model.config)}`;
  const heading = document.createElement('h3');
  heading.className = 'q-share-subhead';
  heading.textContent = 'Shareable link';
  section.append(heading);

  if (fullUrl.length > MAX_URL_CHARS) {
    const warn = document.createElement('p');
    warn.className = 'q-share-warn';
    warn.textContent =
      `This link is ${String(fullUrl.length)} characters — beyond the ${String(MAX_URL_CHARS)}-character ` +
      'limit for reliable sharing. Share a config manifest instead:';
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'q-btn';
    download.textContent = 'Download config manifest (JSON)';
    download.addEventListener('click', () => {
      const json = JSON.stringify(configToManifest(model.config), null, 2);
      triggerDownload(new Blob([json], { type: 'application/json' }), 'quac-config.json');
    });
    const instructions = document.createElement('p');
    instructions.className = 'q-share-note';
    instructions.textContent = `Host quac-config.json by URL, then share: ${shareBase}#/load?config=<its URL>`;
    section.append(warn, download, instructions);
    return section;
  }

  const row = document.createElement('div');
  row.className = 'q-share-linkrow';
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.className = 'q-share-link-input';
  input.value = fullUrl;
  input.setAttribute('aria-label', 'Shareable link');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'q-btn q-btn--primary q-share-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    input.select();
    void navigator.clipboard
      .writeText(fullUrl)
      .then(() => {
        showToast('Link copied to clipboard.', { kind: 'success' });
      })
      .catch(() => {
        showToast('Press ⌘/Ctrl-C to copy the selected link.', { kind: 'info' });
      });
  });
  row.append(input, copy);

  const count = document.createElement('p');
  count.className = 'q-share-count';
  count.textContent = `${String(fullUrl.length)} characters`;
  section.append(row, count);

  if (model.index !== undefined) {
    const callout = document.createElement('p');
    callout.className = 'q-share-callout';
    callout.textContent = "The index file is included — recipients won't be asked to pick it.";
    section.append(callout);
  }
  return section;
}

export function openShareModal(store: AppStore): void {
  const model = collectShareModel(store);
  const modal = openModal({ title: 'Share this configuration', size: 'wide' });
  const root = document.createElement('div');
  root.className = 'q-share';

  const intro = document.createElement('p');
  intro.className = 'q-share-intro';
  intro.textContent =
    'Only files loaded by URL can travel in a link — the link lives entirely in the ' +
    'address bar and is never sent to a server. Your uploads and data stay in this browser.';
  root.append(intro);

  if (model.empty) {
    const empty = document.createElement('p');
    empty.className = 'q-share-empty';
    empty.textContent = 'Nothing to share yet — load a dataset, schema, or QC rules first.';
    root.append(empty);
    modal.body.append(root);
    return;
  }

  // Link first — it's what the opener came for; provenance below explains it.
  if (model.hasShareable) {
    const shareBase = `${window.location.origin}${window.location.pathname}`;
    root.append(renderLinkSection(model, shareBase));
  } else {
    const none = document.createElement('p');
    none.className = 'q-share-warn';
    none.textContent =
      'None of the loaded files can be shared by link. Host them by URL ' +
      '(GitHub raw / gist) and load them by URL to build a shareable link.';
    root.append(none);
  }

  root.append(renderProvenance(model, schemaGroupInfo()));
  modal.body.append(root);
}
