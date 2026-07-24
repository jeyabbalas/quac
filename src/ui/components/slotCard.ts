/**
 * Input slot card frame (ingestion.md §1): title + status badge, a body area
 * (drop zone / URL field), an expandable details area. Generic — the Dataset
 * slot uses it in P05; Schema (P06) and Rules (P12) adopt the same frame.
 */
import { createBadge } from './badge';
import type { BadgeTone } from './badge';
import type { SlotState, SlotStatus } from '../../app/store';

export interface SlotCard {
  readonly el: HTMLElement;
  /** Mount point for drop zone / URL field / progress. */
  readonly bodyHost: HTMLElement;
  /** Mount point for extra detail content inside <details>. */
  readonly detailHost: HTMLElement;
  /** Re-render badge + summary line from a SlotState. */
  update: (state: SlotState) => void;
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
  loading: 'Loading',
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

  const details = document.createElement('details');
  details.className = 'q-slotcard-details';
  const detailsToggle = document.createElement('summary');
  detailsToggle.textContent = 'Details';
  const detailHost = document.createElement('div');
  details.append(detailsToggle, detailHost);
  details.hidden = true;

  el.append(header, summary, bodyHost, details);

  return {
    el,
    bodyHost,
    detailHost,
    update: (state) => {
      badgeHost.replaceChildren(createBadge(BADGE_TEXT[state.status], BADGE_TONE[state.status]));
      summary.textContent = state.detail;
      details.hidden = detailHost.childElementCount === 0;
    },
  };
}
