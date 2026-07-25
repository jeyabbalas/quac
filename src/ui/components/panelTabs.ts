/**
 * PanelTabs (ui-design.md §5) — the shared tab strip + panel set, ARIA APG
 * tabs pattern. Behaviour only: the visual language lives in
 * styles/primitives.css, where a third consumer (the Studio's aria-pressed
 * language switch) can reach it without importing a view's stylesheet.
 *
 * The pattern, verbatim from where it grew up (the Report panel column):
 * `role="tablist"` + `aria-label`; each button `role="tab"` with `id`,
 * `aria-controls` and `aria-selected`; each panel `role="tabpanel"` +
 * `aria-labelledby`, `hidden` when inactive; a ROVING tabindex so the whole
 * strip is ONE tab stop; ←/→ wrap, Home/End jump, and every move both selects
 * and focuses. Without the roving tabindex Tab walked all four tabs and the
 * arrows did nothing, which is not what `role="tablist"` promises a screen
 * reader user.
 */
import { effect, signal } from '../../app/signals';
import type { Signal } from '../../app/signals';

export interface PanelTabSpec<Id extends string> {
  id: Id;
  /** Visible short label. E2E locators pin this text — never reword casually. */
  label: string;
  /** Full name for title + aria-label when `label` is an abbreviation. */
  fullLabel?: string;
}

export interface PanelTabsOptions<Id extends string> {
  /**
   * REQUIRED and unique per instance — element ids are `${idPrefix}-tab-${id}`.
   * The shell keeps all three views mounted and toggles `hidden`
   * (shell.ts:152), so the Report and Load tablists sit in the document at the
   * same time; a shared prefix would break `aria-controls` resolution and trip
   * axe's duplicate-id-aria.
   */
  idPrefix: string;
  /** aria-label on the tablist. */
  label: string;
  tabs: readonly PanelTabSpec<Id>[];
  initial?: Id;
  /** USER activation only (click / arrow key) — never fires for `active.set()`. */
  onSelect?: (id: Id) => void;
}

export interface PanelTabs<Id extends string> {
  readonly tablist: HTMLElement;
  readonly active: Signal<Id>;
  panel: (id: Id) => HTMLElement;
  mount: (host: HTMLElement) => void;
}

export function createPanelTabs<Id extends string>(options: PanelTabsOptions<Id>): PanelTabs<Id> {
  const { idPrefix, tabs, onSelect } = options;
  const first = tabs[0];
  if (first === undefined) throw new Error('createPanelTabs: at least one tab is required');
  const ids = tabs.map((t) => t.id);

  const active = signal<Id>(options.initial ?? first.id);

  const tablist = document.createElement('div');
  tablist.className = 'q-paneltabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', options.label);

  const buttons = new Map<Id, HTMLButtonElement>();
  const panels = new Map<Id, HTMLElement>();

  for (const spec of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'q-paneltab';
    button.setAttribute('role', 'tab');
    button.id = `${idPrefix}-tab-${spec.id}`;
    button.setAttribute('aria-controls', `${idPrefix}-panel-${spec.id}`);
    button.textContent = spec.label;
    if (spec.fullLabel !== undefined && spec.fullLabel !== spec.label) {
      button.title = spec.fullLabel;
      button.setAttribute('aria-label', spec.fullLabel);
    }
    button.addEventListener('click', () => {
      select(spec.id);
    });
    buttons.set(spec.id, button);
    tablist.append(button);

    const panel = document.createElement('div');
    panel.className = 'q-panel';
    panel.id = `${idPrefix}-panel-${spec.id}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panels.set(spec.id, panel);
  }

  /** User activation: moves the selection AND notifies. */
  function select(id: Id): void {
    active.set(id);
    onSelect?.(id);
  }

  const moveTo = (index: number): void => {
    const id = ids[((index % ids.length) + ids.length) % ids.length];
    if (id === undefined) return;
    select(id);
    buttons.get(id)?.focus();
  };

  tablist.addEventListener('keydown', (event) => {
    const index = ids.indexOf(active.get());
    if (index < 0) return;
    switch (event.key) {
      case 'ArrowRight':
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
        moveTo(index - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(ids.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  effect(() => {
    const current = active.get();
    for (const id of ids) {
      const selected = id === current;
      const button = buttons.get(id);
      if (button) {
        button.setAttribute('aria-selected', String(selected));
        button.classList.toggle('q-paneltab--active', selected);
        button.tabIndex = selected ? 0 : -1;
      }
      const panel = panels.get(id);
      if (panel) panel.hidden = !selected;
    }
  });

  return {
    tablist,
    active,
    panel: (id) => {
      const panel = panels.get(id);
      if (panel === undefined) throw new Error(`createPanelTabs: unknown tab ${id}`);
      return panel;
    },
    mount: (host) => {
      host.append(tablist, ...panels.values());
    },
  };
}
