/**
 * The two DOM builders the Preview panels share.
 *
 * Both were private to dataDictionary.ts until the QC rules panel needed them
 * verbatim. They are five and eight lines over documented primitives
 * (`.q-panel-note`, native `<details>`), which is exactly the size at which a
 * second copy stops being cheaper than an import. Every panel uses `note` for
 * its states; `overflowDetails` is the QC rules panel's alone since the JSON
 * Schema panel became json-schema-data-dictionary's own component.
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
