/**
 * Companion channel — app wiring (companion.md; protocol in
 * core/share/companion.ts). Loaded only when the link carries
 * `companion=<origin>` (main.ts), so the entry chunk is untouched.
 *
 * Consent comes first: nothing is listened to or sent until the person presses
 * Allow in the bar this module mounts. From then on, each request from the
 * companion — a set of JSON Schema files — is loaded into the schema slot and
 * run against the dataset loaded here, and the findings without data go back.
 * That Allow is the person's standing consent to compute for this tab (the
 * exception ingestion.md §1 names); a reload asks again. Messages are taken
 * only from the window that opened this tab, at the origin the link named,
 * and sent only there.
 */
import { reportError } from './errors';
import { parseHash, readRawHash } from './router';
import { assessRunReadiness } from './runReadiness';
import { effect } from './signals';
import { isRunningStage } from './store';
import { APP_VERSION } from './version';
import { columnDigest } from '../core/schema/column-meta';
import { loadCompanionSchemas, needsRootChoice, schemaState } from '../core/schema/schema-store';
import {
  COMPANION_PARAM,
  closedMessage,
  companionOrigin,
  findingsMessage,
  helloMessage,
  parseCompanionRequest,
  statusMessage,
} from '../core/share/companion';
import type { ShellContext } from './shell';
import type { CompanionMessage, CompanionSchemasRequest } from '../core/share/companion';
import type { SchemaSet } from '../core/schema/types';
import './companion.css';

/** The companion origin the current link names, if it may be one. */
export function linkedCompanionOrigin(): string | null {
  const query = parseHash(readRawHash()).query;
  return companionOrigin(new URLSearchParams(query).get(COMPANION_PARAM));
}

interface Bar {
  ask: (origin: string, allow: () => void, decline: () => void) => void;
  connected: (origin: string, disconnect: () => void) => void;
  status: (text: string) => void;
  notice: (text: string) => void;
}

function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'q-btn q-btn--primary' : 'q-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function mountBar(): Bar {
  const bar = document.createElement('div');
  bar.className = 'q-companion';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Companion connection');
  const text = document.createElement('p');
  text.className = 'q-companion-text';
  const live = document.createElement('p');
  live.className = 'q-companion-status';
  live.setAttribute('aria-live', 'polite');
  const actions = document.createElement('div');
  actions.className = 'q-companion-actions';
  bar.append(text, live, actions);
  const main = document.querySelector('.q-main');
  if (main) main.prepend(bar);
  else document.body.prepend(bar);

  return {
    ask(origin, allow, decline) {
      text.textContent =
        `${origin} asks QuaC to keep checking a dataset against its JSON Schemas. If you allow it, ` +
        'QuaC loads each set of schemas that page sends, checks the dataset you load here, and sends ' +
        'back only the findings without data — never your data.';
      live.textContent = '';
      actions.replaceChildren(button('Allow', true, allow), button('Not now', false, decline));
    },
    connected(origin, disconnect) {
      text.textContent =
        `Connected to ${origin}: each time it sends schemas, QuaC checks your dataset here and sends ` +
        'back only the findings without data.';
      actions.replaceChildren(button('Disconnect', false, disconnect));
    },
    status(t) {
      live.textContent = t;
    },
    notice(t) {
      text.textContent = t;
      live.textContent = '';
      actions.replaceChildren();
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Wire the channel when the link asks for it. Never throws: a broken channel must not break QuaC. */
export function startCompanion(ctx: ShellContext, booted: Promise<void>): void {
  const origin = linkedCompanionOrigin();
  if (origin === null) return;
  const bar = mountBar();
  const opener = window.opener as Window | null;
  if (opener === null) {
    bar.notice(
      `This tab was meant to check data for ${origin}, but that page did not open it. ` +
        'Open QuaC again from that page to connect.',
    );
    return;
  }
  bar.ask(
    origin,
    () => {
      connect(ctx, booted, origin, opener, bar);
    },
    () => {
      bar.notice('Not connected: nothing is sent anywhere. QuaC works as usual.');
    },
  );
}

function connect(
  ctx: ShellContext,
  booted: Promise<void>,
  origin: string,
  opener: Window,
  bar: Bar,
): void {
  const { store } = ctx;
  /** The newest request: an older one still loading, waiting or running is dropped. */
  let latest: CompanionSchemasRequest | null = null;
  /** The setId of the set the newest request loaded — what its run must check. */
  let loadedSetId: string | null = null;
  /** Loaded, and waiting for a dataset or for a run in flight to end. */
  let pending: CompanionSchemasRequest | null = null;
  /** The request whose run is in flight. */
  let active: CompanionSchemasRequest | null = null;
  let open = true;
  let disposers: (() => void)[] = [];

  const send = (message: CompanionMessage): void => {
    if (!open) return;
    try {
      opener.postMessage(message, origin);
    } catch {
      // The opener closed or navigated away; the next request (if any) proves it is back.
    }
  };

  const stop = (notify: boolean, text: string): void => {
    if (!open) return;
    if (notify) send(closedMessage());
    open = false;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('pagehide', onPagehide);
    for (const dispose of disposers) dispose();
    bar.notice(text);
  };

  /** Whether `req` is still the one to answer: the newest, on an open connection. */
  const current = (req: CompanionSchemasRequest): boolean => open && latest === req;

  async function run(req: CompanionSchemasRequest): Promise<void> {
    active = req;
    send(statusMessage(req.id, 'running'));
    bar.status('Checking your dataset against the schemas it sent…');
    try {
      const [{ startRun }, { collectFindings }] = await Promise.all([
        import('./runController'),
        import('../ui/views/report/findingsExport'),
      ]);
      if (!current(req)) return;
      await startRun(ctx);
      // A newer request arrived while this ran: its findings would answer an old question.
      if (!current(req)) return;
      const stage = store.pipeline.get().stage;
      if (stage !== 'done') {
        const why = stage === 'cancelled' ? 'The run was cancelled.' : 'The run did not finish.';
        send(statusMessage(req.id, 'failed', why));
        bar.status(why);
        return;
      }
      send(findingsMessage(req.id, collectFindings(ctx)));
      bar.status(`Sent the findings without data at ${new Date().toLocaleTimeString()}.`);
    } catch (err) {
      reportError(err, { fallbackCode: 'BRIDGE_FAILED' });
      send(statusMessage(req.id, 'failed', errorText(err)));
      bar.status('The check failed; see the message above.');
    } finally {
      active = null;
      // A request that arrived during this run waited for it; nothing else would start it.
      const next = pending;
      if (open && next !== null) {
        queueMicrotask(() => {
          tryRun(next);
        });
      }
    }
  }

  /**
   * Why the newest request's set cannot be checked, or null when it can: the
   * schema leg of `assessRunReadiness`, asked of the companion's own set. It
   * is asked before anything else — with the person's QC rules loaded, a run
   * is possible without any schema, and its findings would answer a question
   * the companion did not ask.
   */
  function schemaProblem(set: SchemaSet): string | null {
    if (columnDigest(set) !== null) return null;
    const fatal = set.errors.find((e) => e.severity === 'fatal');
    if (fatal !== undefined) return fatal.message;
    return needsRootChoice(set)
      ? 'More than one of its files could be the root schema, and it named none.'
      : 'The schemas have errors that block validation.';
  }

  function tryRun(req: CompanionSchemasRequest): void {
    if (!current(req) || active === req) return;
    const { set } = schemaState.get();
    if (set?.setId !== loadedSetId) {
      pending = null;
      const why =
        'The schemas it sent were replaced or cleared in QuaC before the check could run.';
      send(statusMessage(req.id, 'failed', why));
      bar.status(why);
      return;
    }
    const problem = schemaProblem(set);
    if (problem !== null) {
      pending = null;
      send(statusMessage(req.id, 'schemas-unusable', problem));
      bar.status(`The schemas it sent cannot be used: ${problem}`);
      return;
    }
    if (active !== null) {
      pending = req;
      send(statusMessage(req.id, 'busy'));
      bar.status('A check is in progress; the newest schemas are checked when it ends.');
      return;
    }
    const readiness = assessRunReadiness(store);
    if (readiness.ready) {
      pending = null;
      void run(req);
      return;
    }
    pending = req;
    if (readiness.code === 'running') {
      send(statusMessage(req.id, 'busy'));
      bar.status('A run is in progress; the check starts when it ends.');
      return;
    }
    send(statusMessage(req.id, 'needs-dataset', readiness.reason));
    bar.status('Load your dataset on the Load tab: the check runs as soon as it is in.');
  }

  async function handle(req: CompanionSchemasRequest): Promise<void> {
    await booted;
    if (!current(req)) return;
    const n = req.files.length;
    bar.status(`Loading ${String(n)} schema file${n === 1 ? '' : 's'}…`);
    let set: SchemaSet | null;
    try {
      set = await loadCompanionSchemas(
        req.files.map((f) => ({ relativePath: f.path, raw: f.text })),
        req.index,
      );
    } catch (err) {
      if (!current(req)) return;
      send(statusMessage(req.id, 'schemas-unusable', errorText(err)));
      bar.status('The schemas it sent did not load.');
      return;
    }
    if (!current(req)) return;
    loadedSetId = set?.setId ?? null;
    tryRun(req);
  }

  function onMessage(event: MessageEvent): void {
    if (event.origin !== origin || event.source !== opener) return;
    const req = parseCompanionRequest(event.data);
    if (req === null) return;
    if (req.kind === 'ping') {
      send(helloMessage(APP_VERSION, store.dataset.get() !== null));
    } else if (req.kind === 'close') {
      stop(false, `${origin} closed the connection. Nothing more is sent.`);
    } else {
      latest = req;
      void handle(req);
    }
  }

  function onPagehide(): void {
    send(closedMessage());
  }

  // A request waiting for a dataset (or for the person's own run to end)
  // starts once that changes — deferred out of the effect so the readiness
  // reads inside tryRun do not become this effect's dependencies.
  disposers = [
    effect(() => {
      const dataset = store.dataset.get();
      const stage = store.pipeline.get().stage;
      if (pending !== null && dataset !== null && !isRunningStage(stage) && active === null) {
        const req = pending;
        queueMicrotask(() => {
          tryRun(req);
        });
      }
    }),
  ];

  window.addEventListener('message', onMessage);
  window.addEventListener('pagehide', onPagehide);
  bar.connected(origin, () => {
    stop(true, 'Disconnected: nothing more is sent.');
  });
  bar.status('Waiting for schemas…');
  send(helloMessage(APP_VERSION, store.dataset.get() !== null));
}
