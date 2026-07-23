import { createEmptyState } from '../../components/emptyState';

/** P04 placeholder — the annotated grid and report panels land in P14. */
export function mountReportView(container: HTMLElement): void {
  container.append(
    createEmptyState({
      title: 'No flags yet.',
      body: 'Run QC and see what floats up.',
    }),
  );
}
