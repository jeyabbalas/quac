export interface EmptyStateOptions {
  title: string;
  body?: string;
}

/** Centered placeholder for views with nothing to show yet. Copy belongs to
 *  the caller (pun rationing is a content decision, not a component one).
 *
 *  Doctrine (ui-design.md §5): this framed treatment is for VIEW-level
 *  empties only (a whole route with nothing to show). Empties inside a panel
 *  or list use a quiet `.q-panel-note` paragraph instead — a dashed box
 *  inside a sticker card reads as a broken drop zone. */
export function createEmptyState(options: EmptyStateOptions): HTMLElement {
  const section = document.createElement('section');
  section.className = 'q-empty';
  const title = document.createElement('h2');
  title.className = 'q-empty-title';
  title.textContent = options.title;
  section.append(title);
  const bodyText = options.body ?? '';
  if (bodyText !== '') {
    const body = document.createElement('p');
    body.className = 'q-empty-body';
    body.textContent = bodyText;
    section.append(body);
  }
  return section;
}
