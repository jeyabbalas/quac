import { createEmptyState } from '../../components/emptyState';

/** P04 placeholder — the rule workspace and editor land in P17. */
export function mountStudioView(container: HTMLElement): void {
  container.append(
    createEmptyState({
      title: 'Rule Studio',
      body: 'Compose, test, and export QC rules — coming in a later phase.',
    }),
  );
}
