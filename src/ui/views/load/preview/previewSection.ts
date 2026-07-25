/**
 * Load-view Preview section (UIX-4): one Tier 1 sticker holding a tabbed view
 * of all three inputs — the dataset, the JSON Schema, and the QC rules. It
 * replaces a bare 50-row table that only ever showed you one of the three
 * things you loaded.
 *
 * The SECTION stays hidden until at least one slot fills, so first run is
 * unchanged. The three TABS are always present once it shows; an empty panel
 * carries a quiet note saying what would fill it (ui-design.md:201).
 */
import { effect } from '../../../../app/signals';
import { createPanelTabs } from '../../../components/panelTabs';
import { rulesState } from '../../../../core/rules/rules-store';
import { schemaState } from '../../../../core/schema/schema-store';
import { mountDataDictionary } from './dataDictionary';
import { mountDatasetPreview } from './datasetPreview';
import { mountRulesPreview } from './rulesPreview';
import { isPreviewVisible, resolvePreviewTab } from './previewModel';
import type { PreviewAvailability, PreviewTabId } from './previewModel';
import type { ShellContext } from '../../../../app/shell';
import './preview.css';

// The three labels are the three SLOT CARD names, verbatim (ui-design.md:100):
// Dataset · JSON Schema · QC Rules. A tab strip sitting directly under the
// cards has to name the same three things the same way — "Data dictionary"
// named the RENDERING, not the input, and left the schema card the only slot
// with no tab bearing its name. The dictionary framing survives inside the
// panel, where it describes what you are looking at rather than what you
// loaded. The tab ID stays `dictionary` — it is internal.
const TABS = [
  { id: 'dataset', label: 'Dataset' },
  { id: 'dictionary', label: 'JSON Schema' },
  { id: 'rules', label: 'QC rules' },
] as const;

export function mountPreviewSection(host: HTMLElement, ctx: ShellContext): void {
  const section = document.createElement('section');
  section.className = 'q-preview';
  section.hidden = true;

  const head = document.createElement('div');
  head.className = 'q-preview-head';
  const title = document.createElement('h2');
  title.className = 'q-preview-title';
  title.textContent = 'Preview';
  head.append(title);
  section.append(head);

  // The effect below WRITES tabs.active, so it must never READ it: signals are
  // push-based with no batching, so a self-triggering effect re-enters
  // mid-click. It cost a real bug — `active.set('dictionary')` synchronously
  // re-ran the effect while `pinned` was still false (onSelect fires after the
  // write), which resolved the default straight back to Dataset and bounced
  // the user's FIRST click on any other tab. Mirroring the selection in a
  // plain local keeps the effect's dependencies to the three stores.
  let pinned = false;
  let current: PreviewTabId = 'dataset';

  // 'q-preview', not 'q-report': the shell keeps all three views mounted and
  // toggles hidden, so both tablists sit in the document at once.
  const tabs = createPanelTabs<PreviewTabId>({
    idPrefix: 'q-preview',
    label: 'Preview panels',
    tabs: TABS,
    initial: current,
    onSelect: (id) => {
      pinned = true; // user activation — stop re-resolving the default
      current = id;
    },
  });
  tabs.mount(section);
  host.append(section);

  mountDatasetPreview(tabs.panel('dataset'), ctx);
  mountDataDictionary(tabs.panel('dictionary'));
  mountRulesPreview(tabs.panel('rules'));

  effect(() => {
    const schema = schemaState.get();
    const availability: PreviewAvailability = {
      dataset: ctx.store.dataset.get() !== null,
      dictionary: schema.phase === 'ready' && schema.set !== null,
      rules: rulesState.get().files.length > 0,
    };
    section.hidden = !isPreviewVisible(availability);
    current = resolvePreviewTab(current, availability, pinned);
    tabs.active.set(current);
  });
}
