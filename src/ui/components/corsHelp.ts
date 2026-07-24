/**
 * "Which hosts work?" disclosure for CORS failures (url-params.md §5). Renders
 * the verified host table + an optional Retry button. The Dataset card shows it
 * with Retry on FETCH_CORS; the Schema/Rules cards append it (no retry — their
 * URL field is right there) to any fetch-error detail.
 */
import { CORS_HOSTS } from '../../core/share/corsHosts';
import './corsHelp.css';

export interface CorsHelpOptions {
  /** Adds a Retry button that re-attempts the last fetch. */
  onRetry?: () => void;
}

export function createCorsHelp(options: CorsHelpOptions = {}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'q-corshelp';

  const details = document.createElement('details');
  details.className = 'q-corshelp-details';
  const summary = document.createElement('summary');
  summary.textContent = 'Which hosts work?';
  details.append(summary);

  const table = document.createElement('table');
  table.className = 'q-corshelp-table';
  const tbody = document.createElement('tbody');
  for (const host of CORS_HOSTS) {
    const row = document.createElement('tr');
    row.className = host.allowed ? 'q-corshelp-ok' : 'q-corshelp-no';
    const mark = document.createElement('td');
    mark.className = 'q-corshelp-mark';
    mark.textContent = host.allowed ? '✓' : '✗';
    mark.setAttribute('aria-hidden', 'true');
    const name = document.createElement('td');
    name.className = 'q-corshelp-host';
    name.textContent = host.host;
    const note = document.createElement('td');
    note.className = 'q-corshelp-note';
    note.textContent = host.note;
    row.append(mark, name, note);
    tbody.append(row);
  }
  table.append(tbody);
  details.append(table);
  wrap.append(details);

  if (options.onRetry !== undefined) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'q-btn q-btn--small q-corshelp-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', options.onRetry);
    wrap.append(retry);
  }
  return wrap;
}
