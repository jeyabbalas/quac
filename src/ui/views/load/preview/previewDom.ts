/**
 * The two DOM builders every Preview panel shares.
 *
 * Both were private to dataDictionary.ts until the QC rules panel needed them
 * verbatim. They are five and eight lines over documented primitives
 * (`.q-panel-note`, native `<details>`), which is exactly the size at which a
 * second copy stops being cheaper than an import: two copies of a `+N more`
 * disclosure is two keyboard behaviours to keep in step, and the two panels
 * are meant to read as one component.
 */

/** The in-panel empty (ui-design.md:201) — never the framed `.q-empty`. */
export function note(text: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'q-panel-note';
  p.textContent = text;
  return p;
}

/** `+3 more` behind a native <details> — keyboard-operable and axe-clean for free. */
export function overflowDetails(
  count: number,
  render: (host: HTMLElement) => void,
): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `+${String(count)} more`;
  details.append(summary);
  render(details);
  return details;
}
