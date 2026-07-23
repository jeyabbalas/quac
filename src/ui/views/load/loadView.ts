import { createEmptyState } from '../../components/emptyState';

/** P04 placeholder — the input slot cards land in P05. */
export function mountLoadView(container: HTMLElement): void {
  container.append(
    createEmptyState({
      title: 'Load your inputs',
      body:
        'Dataset, JSON Schema, and QC rules slots arrive in an upcoming phase. ' +
        'Your files stay in this browser.',
    }),
  );
}
