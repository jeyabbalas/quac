export type BadgeTone = 'neutral' | 'valid' | 'warning' | 'error' | 'info';

/** Small status label (slot cards, studio lists). Presentational — re-create on change. */
export function createBadge(text: string, tone: BadgeTone = 'neutral'): HTMLSpanElement {
  const badge = document.createElement('span');
  badge.className = `q-badge q-badge--${tone}`;
  badge.textContent = text;
  return badge;
}
