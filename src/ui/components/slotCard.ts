/**
 * Input slot card frame (ingestion.md §1): title + status badge, a body area
 * (drop zone / URL field), an optional actions row, an expandable details
 * area. Generic — all three Load slots (Dataset · JSON Schema · QC Rules)
 * share this frame.
 */
import { createBadge } from './badge';
import type { BadgeTone } from './badge';
import type { SlotState, SlotStatus } from '../../app/store';

export interface SlotCard {
  readonly el: HTMLElement;
  /** Mount point for drop zone / URL field / progress. */
  readonly bodyHost: HTMLElement;
  /** Row for card-level actions (e.g. "Browse folder"); hidden while empty. */
  readonly actionsHost: HTMLElement;
  /** Mount point for extra detail content inside <details>. */
  readonly detailHost: HTMLElement;
  /** Re-render badge + summary line from a SlotState. */
  update: (state: SlotState) => void;
  /** Expand/collapse the details area (e.g. auto-open on fatal findings). */
  setDetailsOpen: (open: boolean) => void;
}

const BADGE_TONE: Record<SlotStatus, BadgeTone> = {
  empty: 'neutral',
  loading: 'info',
  valid: 'valid',
  warning: 'warning',
  error: 'error',
};

const BADGE_TEXT: Record<SlotStatus, string> = {
  empty: 'Empty',
  loading: 'Loading…',
  valid: 'Valid',
  warning: 'Warning',
  error: 'Error',
};

export function createSlotCard(title: string): SlotCard {
  const el = document.createElement('section');
  el.className = 'q-slotcard';
  el.setAttribute('aria-label', `${title} input`);

  const header = document.createElement('div');
  header.className = 'q-slotcard-header';
  const heading = document.createElement('h2');
  heading.className = 'q-slotcard-title';
  heading.textContent = title;
  const badgeHost = document.createElement('span');
  badgeHost.append(createBadge(BADGE_TEXT.empty, BADGE_TONE.empty));
  header.append(heading, badgeHost);

  const summary = document.createElement('p');
  summary.className = 'q-slotcard-summary';
  summary.textContent = '';

  const bodyHost = document.createElement('div');
  bodyHost.className = 'q-slotcard-body';

  const actionsHost = document.createElement('div');
  actionsHost.className = 'q-slotcard-actions';
  actionsHost.hidden = true;

  const details = document.createElement('details');
  details.className = 'q-slotcard-details';
  const detailsToggle = document.createElement('summary');
  detailsToggle.textContent = 'Details';
  const detailHost = document.createElement('div');
  details.append(detailsToggle, detailHost);
  details.hidden = true;

  el.append(header, summary, bodyHost, actionsHost, details);

  return {
    el,
    bodyHost,
    actionsHost,
    detailHost,
    update: (state) => {
      badgeHost.replaceChildren(createBadge(BADGE_TEXT[state.status], BADGE_TONE[state.status]));
      summary.textContent = state.detail;
      actionsHost.hidden = actionsHost.childElementCount === 0;
      details.hidden = detailHost.childElementCount === 0;
    },
    setDetailsOpen: (open) => {
      details.open = open;
    },
  };
}
