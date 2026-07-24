/**
 * DuckProgress — the brand duck bobbing along a wavy track.
 * Determinate (`setProgress(label, 62)`) and indeterminate
 * (`setProgress(label, null)`) modes; `prefers-reduced-motion` swaps to a
 * plain bar purely in CSS. One custom property (`--q-dp-pct`) drives both the
 * fill width and the duck position, so JS never animates anything.
 */
import { assetUrl } from '../../app/urlBase';

/** The three sanctioned loading lines (ui-design §6) — their single home. */
export const DUCK_LOADING_LINES = [
  'Getting your ducks in a row…',
  'Dabbling through your data…',
  'Quacking the checks…',
] as const;

export interface DuckProgress {
  readonly el: HTMLElement;
  /** `pct` 0–100 for determinate progress; `null` for indeterminate. */
  setProgress: (stageLabel: string, pct: number | null) => void;
  /** Stops the rotating loading copy. */
  dispose: () => void;
}

const ROTATE_MS = 4000;

/** The brand duck, drawn right-facing so it swims along the track (ui-design
 *  §6: a flat SVG, never the raster logo). ~10 KB, cached after the first
 *  progress bar mounts; the wordmark logo is a separate file. */
function createDuck(): HTMLImageElement {
  const duck = document.createElement('img');
  duck.className = 'q-duckprogress-duck';
  duck.src = assetUrl('logo/quac-duck.svg');
  duck.alt = '';
  duck.width = 40;
  duck.height = 40;
  return duck;
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
  let lineIndex = 0;
  const rotation = window.setInterval(() => {
    lineIndex = (lineIndex + 1) % DUCK_LOADING_LINES.length;
    pun.textContent = DUCK_LOADING_LINES[lineIndex] ?? DUCK_LOADING_LINES[0];
  }, ROTATE_MS);

  return {
    el,
    setProgress: (stageLabel, pct) => {
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
      el.style.setProperty('--q-dp-pct', `${String(clamped)}%`);
      el.setAttribute('aria-valuenow', String(rounded));
      el.setAttribute('aria-valuetext', `${stageLabel} — ${String(rounded)}%`);
      meta.textContent = `${stageLabel} · ${String(rounded)}%`;
    },
    dispose: () => {
      window.clearInterval(rotation);
    },
  };
}
