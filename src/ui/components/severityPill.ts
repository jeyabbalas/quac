/**
 * Count pill for the QC Report nav tab. Hidden while all counts are zero so
 * the tab's accessible name stays a stable "QC Report"; when visible it shows
 * the total, tinted by the highest severity present, with a text equivalent
 * in aria-label (severity is never conveyed by color alone).
 */
export interface SeverityCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export interface SeverityPill {
  readonly el: HTMLSpanElement;
  update: (counts: SeverityCounts) => void;
}

const TONES = ['error', 'warning', 'info'] as const;

function part(count: number, singular: string, plural: string): string {
  if (count === 0) return '';
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/** Small tinted label pill naming a severity (offenders/findings rows). */
export function createSeverityLabel(severity: 'error' | 'warning' | 'info'): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = `q-pill q-pill--${severity}`;
  el.textContent = severity;
  return el;
}

export function createSeverityPill(): SeverityPill {
  const el = document.createElement('span');
  el.className = 'q-pill';
  el.hidden = true;
  return {
    el,
    update: (counts) => {
      const total = counts.errors + counts.warnings + counts.infos;
      if (total === 0) {
        el.hidden = true;
        el.textContent = '';
        el.removeAttribute('aria-label');
        return;
      }
      const tone = counts.errors > 0 ? 'error' : counts.warnings > 0 ? 'warning' : 'info';
      for (const t of TONES) el.classList.toggle(`q-pill--${t}`, t === tone);
      el.hidden = false;
      el.textContent = String(total);
      const parts = [
        part(counts.errors, 'error', 'errors'),
        part(counts.warnings, 'warning', 'warnings'),
        part(counts.infos, 'info', 'infos'),
      ].filter((p) => p !== '');
      const findings = total === 1 ? 'finding' : 'findings';
      el.setAttribute('aria-label', `${String(total)} ${findings}: ${parts.join(', ')}`);
    },
  };
}
