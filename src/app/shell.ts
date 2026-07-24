/**
 * App shell: header banner (brand · actions · nav tabs), main region swapping
 * the three views, footer privacy line. Views are mounted lazily on first
 * visit and then toggled with `hidden`, preserving their state for P05/P17.
 */
import { effect } from './signals';
import { initToasts } from './toast';
import { openModal } from './modal';
import { ROUTE_IDS } from './router';
import { assetUrl } from './urlBase';
import { createDuckProgress } from '../ui/components/duckProgress';
import { createSeverityPill } from '../ui/components/severityPill';
import { openShareModal } from '../ui/components/shareModal';
import { mountLoadView } from '../ui/views/load/loadView';
import { mountReportView } from '../ui/views/report/reportView';
import { mountStudioView } from '../ui/views/studio/studioView';
import { createCancelToken } from './store';
import { installTypedSync } from './typedSync';
import type { RouteId, Router } from './router';
import type { AppStore } from './store';
import './shell.css';

export interface ShellContext {
  store: AppStore;
  router: Router;
}

declare global {
  interface Window {
    /** Test/debug hook (nav.spec.ts): opens a demo modal exercising Modal + DuckProgress. */
    __quac?: { openDemoModal: () => void };
  }
}

const TAB_LABELS: Record<RouteId, string> = {
  load: 'Load',
  report: 'QC Report',
  studio: 'Rule Studio',
};

const VIEW_MOUNTERS: Record<RouteId, (container: HTMLElement, ctx: ShellContext) => void> = {
  load: mountLoadView,
  report: mountReportView,
  studio: mountStudioView,
};

export function mountShell(root: HTMLElement, ctx: ShellContext): void {
  initToasts();

  const header = document.createElement('header');
  header.className = 'q-header';
  // Inner rail: the banner paints full-bleed, its contents line up with the
  // main column (same max-width) so brand/tabs share the cards' left edge.
  const headerInner = document.createElement('div');
  headerInner.className = 'q-header-inner';

  const brand = document.createElement('div');
  brand.className = 'q-brand';
  const logo = document.createElement('img');
  logo.src = assetUrl('logo/quac-logo.svg');
  logo.alt = ''; // decorative; the wordmark carries the name
  // Box sizes differ so the two round marks read the same size — see .q-logo.
  logo.width = 56;
  logo.height = 56;
  logo.className = 'q-logo';
  const titles = document.createElement('div');
  titles.className = 'q-brand-text';
  const title = document.createElement('h1');
  title.className = 'q-title';
  title.textContent = 'QuaC';
  const subtitle = document.createElement('p');
  subtitle.className = 'q-subtitle';
  subtitle.textContent = 'in-browser data quality control';
  titles.append(title, subtitle);
  brand.append(logo, titles);

  const actions = document.createElement('div');
  actions.className = 'q-actions';
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'q-btn q-btn--primary';
  share.textContent = 'Share';
  share.disabled = true; // enabled once a slot is loaded (effect below)
  share.title = 'Copy a shareable link to this configuration';
  share.addEventListener('click', () => {
    openShareModal(ctx.store);
  });
  const github = document.createElement('a');
  github.className = 'q-gh';
  github.href = 'https://github.com/jeyabbalas/quac';
  github.target = '_blank';
  github.rel = 'noopener';
  github.setAttribute('aria-label', 'QuaC on GitHub');
  const githubIcon = document.createElement('img');
  githubIcon.src = assetUrl('logo/github-logo.svg');
  githubIcon.alt = '';
  githubIcon.width = 46;
  githubIcon.height = 46;
  github.append(githubIcon);
  actions.append(share, github);

  const nav = document.createElement('nav');
  nav.className = 'q-tabs';
  nav.setAttribute('aria-label', 'Primary');
  const pill = createSeverityPill();
  const makeTab = (id: RouteId): HTMLAnchorElement => {
    const tab = document.createElement('a');
    tab.className = 'q-tab';
    tab.href = `#/${id}`;
    tab.textContent = TAB_LABELS[id];
    tab.addEventListener('click', (event) => {
      // Intercept: router.navigate carries the raw config query along;
      // following the bare href would clobber `#/load?schema=…` params.
      event.preventDefault();
      ctx.router.navigate(id);
    });
    return tab;
  };
  const tabs: Record<RouteId, HTMLAnchorElement> = {
    load: makeTab('load'),
    report: makeTab('report'),
    studio: makeTab('studio'),
  };
  tabs.report.append(pill.el);
  nav.append(tabs.load, tabs.report, tabs.studio);

  headerInner.append(brand, actions, nav);
  header.append(headerInner);

  const main = document.createElement('main');
  main.className = 'q-main';
  const sections: Record<RouteId, HTMLElement> = {
    load: document.createElement('section'),
    report: document.createElement('section'),
    studio: document.createElement('section'),
  };
  for (const id of ROUTE_IDS) {
    sections[id].className = 'q-view';
    sections[id].hidden = true;
    main.append(sections[id]);
  }

  const footer = document.createElement('footer');
  footer.className = 'q-footer';
  const privacyLine = document.createElement('p');
  privacyLine.textContent =
    'Your data never leaves this browser. No uploads, no servers, no storage.';
  footer.append(privacyLine);

  root.append(header, main, footer);

  const mounted = new Set<RouteId>();
  effect(() => {
    const current = ctx.router.route.get();
    for (const id of ROUTE_IDS) {
      const isActive = id === current;
      if (isActive && !mounted.has(id)) {
        mounted.add(id);
        VIEW_MOUNTERS[id](sections[id], ctx);
      }
      sections[id].hidden = !isActive;
      if (isActive) tabs[id].setAttribute('aria-current', 'page');
      else tabs[id].removeAttribute('aria-current');
    }
  });

  effect(() => {
    const run = ctx.store.run.get();
    pill.update(run?.flagsSummary ?? { errors: 0, warnings: 0, infos: 0 });
  });

  // Share becomes available once any slot has content (nothing to share when
  // every slot is empty — keeps the keyboard "disabled Share skipped" contract).
  effect(() => {
    const anyLoaded = (['data', 'schema', 'rules'] as const).some(
      (id) => ctx.store.slots[id].get().status !== 'empty',
    );
    share.disabled = !anyLoaded;
  });

  // P14 re-run semantics (architecture §6): replacing the dataset invalidates
  // the previous run — summary/artifacts cleared (pill goes dark, Report
  // panels return to their empty state) and any in-flight run is cancelled
  // best-effort. The grid itself rebuilds off dataset.generation.
  let runGeneration = 0;
  effect(() => {
    const generation = ctx.store.dataset.get()?.generation ?? 0;
    if (generation === runGeneration) return;
    runGeneration = generation;
    ctx.store.pipeline.get().cancel.cancel();
    ctx.store.run.set(null);
    ctx.store.runArtifacts.set(null);
    ctx.store.pipeline.set({
      stage: 'idle',
      progress: { done: 0, total: 0 },
      cancel: createCancelToken(),
    });
  });

  installTypedSync(ctx);

  window.__quac = { openDemoModal };
}

/** Zero visible UI in the app; drives the e2e focus-trap/Esc test and the
 *  manual DuckProgress checklist (both modes live inside the modal). */
function openDemoModal(): void {
  const indeterminate = createDuckProgress();
  indeterminate.setProgress('Warming up', null);
  const determinate = createDuckProgress();
  determinate.setProgress('Quacking the checks', 62);

  const modal = openModal({
    title: 'QuaC preview',
    onClose: () => {
      indeterminate.dispose();
      determinate.dispose();
    },
  });

  const intro = document.createElement('p');
  intro.textContent = 'A peek at the progress component. Close with Esc, ×, or the backdrop.';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'q-btn';
  done.textContent = 'Got it';
  done.addEventListener('click', () => {
    modal.close();
  });

  modal.body.append(intro, indeterminate.el, determinate.el, done);
}
