/**
 * DuckProgress — the brand duck bobbing along a wavy track.
 * Determinate (`setProgress(label, 62)`) and indeterminate
 * (`setProgress(label, null)`) modes; `prefers-reduced-motion` swaps to a
 * plain bar purely in CSS. One custom property (`--q-dp-pct`) drives both the
 * fill width and the duck position; `--q-dp-glide` is the transition length,
 * so JS never animates anything — a long glide IS the asymptotic crawl for
 * unknown-total stages (runProgressModel.ts), and retargeting a CSS
 * transition resumes from the current computed value for free.
 */
import { assetUrl } from '../../app/urlBase';
import './duckProgress.css';

/** The three sanctioned loading lines (ui-design §6) — their single home. */
export const DUCK_LOADING_LINES = [
  'Getting your ducks in a row…',
  'Dabbling through your data…',
  'Quacking the checks…',
] as const;

/** Progress-surface stage labels — single home (several are e2e-pinned,
 *  notably 'Validating against the schema'). Run stages + local surfaces. */
export const PROGRESS_LABELS = {
  prepare: 'Preparing tables',
  corrections: 'Applying corrections',
  schema: 'Validating against the schema',
  rules: 'Running QC rules',
  annotate: 'Painting the report',
  gridPrep: 'Preparing the grid',
  exportBuild: 'Building the workbook',
  exportRows: 'Writing rows',
  exportFinish: 'Finishing the workbook',
} as const;

export interface DuckProgressOptions {
  /** Transition length in ms for this move; long = asymptotic glide. */
  glideMs?: number;
}

export interface DuckProgress {
  readonly el: HTMLElement;
  /** `pct` 0–100 for determinate progress; `null` for indeterminate. */
  setProgress: (stageLabel: string, pct: number | null, options?: DuckProgressOptions) => void;
  /** Stops the rotating loading copy. */
  dispose: () => void;
}

const ROTATE_MS = 4000;
const ROTATE_IDLE_STOP_MS = 30_000;

/** The brand duck, drawn right-facing so it swims along the track (ui-design
 *  §6: a flat SVG, never the raster logo). ~10 KB, cached after the first
 *  progress bar mounts; the wordmark logo is a separate file. */
function createDuck(): HTMLImageElement {
  const duck = document.createElement('img');
  duck.className = 'q-duckprogress-duck';
  duck.src = assetUrl('logo/quac-duck.svg');
  duck.alt = '';
  duck.width = 44;
  duck.height = 44;
  return duck;
}

const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Elements currently animating toward `[hidden]`. */
const collapsing = new WeakSet<HTMLElement>();

/** Animated reveal for a progress surface (run/export cards): height+opacity
 *  grow via WAAPI so showing the card never snaps the layout. No-op when
 *  already visible; instant under reduced motion. */
export function revealProgressSurface(el: HTMLElement): void {
  if (!el.hidden && !collapsing.has(el)) return; // steady visible or growing
  for (const anim of el.getAnimations()) anim.cancel(); // interrupt a collapse
  collapsing.delete(el);
  el.hidden = false;
  if (reducedMotion()) {
    el.style.overflow = '';
    return;
  }
  const height = `${String(el.scrollHeight)}px`;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [
      { height: '0px', opacity: 0 },
      { height, opacity: 1 },
    ],
    { duration: 200, easing: 'ease-out' },
  );
  anim.finished
    .then(() => {
      el.style.overflow = '';
    })
    .catch(() => undefined); // cancelled — the canceller owns the element now
}

/** Animated collapse that ENDS in `[hidden]` — the attribute stays the
 *  authority for visibility (Playwright semantics preserved). */
export function collapseProgressSurface(el: HTMLElement): void {
  if (el.hidden || collapsing.has(el)) return;
  for (const anim of el.getAnimations()) anim.cancel();
  if (reducedMotion()) {
    el.hidden = true;
    return;
  }
  collapsing.add(el);
  const height = `${String(el.scrollHeight)}px`;
  el.style.overflow = 'hidden';
  const anim = el.animate(
    [
      { height, opacity: 1 },
      { height: '0px', opacity: 0 },
    ],
    { duration: 200, easing: 'ease-in' },
  );
  anim.finished
    .then(() => {
      collapsing.delete(el);
      el.style.overflow = '';
      el.hidden = true;
    })
    .catch(() => undefined); // cancelled — a reveal took over
}

export function createDuckProgress(): DuckProgress {
  const el = document.createElement('div');
  el.className = 'q-duckprogress q-duckprogress--indeterminate';
  el.setAttribute('role', 'progressbar');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');

  const track = document.createElement('div');
  track.className = 'q-duckprogress-track';
  const fill = document.createElement('div');
  fill.className = 'q-duckprogress-fill';
  track.append(fill);
  // The duck is a sibling of the track, not a child: the track clips its fill
  // to the rounded channel (`overflow: hidden`) and would clip the duck too.
  const duck = createDuck();

  const label = document.createElement('p');
  label.className = 'q-duckprogress-label';
  const pun = document.createElement('span');
  pun.className = 'q-duckprogress-pun';
  pun.textContent = DUCK_LOADING_LINES[0];
  const meta = document.createElement('span');
  meta.className = 'q-duckprogress-meta';
  label.append(pun, meta);

  el.append(track, duck, label);

  // Copy rotation is a content update, not motion — it survives reduced-motion.
  // The label is intentionally not a live region; aria-valuetext carries state.
  // Armed by activity (setProgress), parked after 30 s without any.
  let lineIndex = 0;
  let rotation = 0;
  let lastActivity = 0;
  const stopRotation = (): void => {
    if (rotation !== 0) {
      window.clearInterval(rotation);
      rotation = 0;
    }
  };
  const armRotation = (): void => {
    lastActivity = Date.now();
    if (rotation !== 0) return;
    rotation = window.setInterval(() => {
      if (Date.now() - lastActivity > ROTATE_IDLE_STOP_MS) {
        stopRotation();
        return;
      }
      lineIndex = (lineIndex + 1) % DUCK_LOADING_LINES.length;
      pun.textContent = DUCK_LOADING_LINES[lineIndex] ?? DUCK_LOADING_LINES[0];
    }, ROTATE_MS);
  };

  return {
    el,
    setProgress: (stageLabel, pct, options) => {
      armRotation();
      if (pct === null) {
        el.classList.add('q-duckprogress--indeterminate');
        el.removeAttribute('aria-valuenow'); // ARIA-correct indeterminate state
        el.setAttribute('aria-valuetext', stageLabel);
        meta.textContent = stageLabel;
        return;
      }
      const clamped = Math.min(100, Math.max(0, pct));
      const rounded = Math.round(clamped);
      el.classList.remove('q-duckprogress--indeterminate');
      const glide = options?.glideMs;
      if (glide !== undefined) el.style.setProperty('--q-dp-glide', `${String(glide)}ms`);
      el.style.setProperty('--q-dp-pct', `${String(clamped)}%`);
      if (glide === 0) {
        // Force the write to land before the next retarget so a fresh run
        // snaps to 0 instead of gliding backwards from the previous value.
        void el.offsetWidth;
      }
      el.setAttribute('aria-valuenow', String(rounded));
      el.setAttribute('aria-valuetext', `${stageLabel} — ${String(rounded)}%`);
      meta.textContent = `${stageLabel} · ${String(rounded)}%`;
    },
    dispose: () => {
      stopRotation();
    },
  };
}
