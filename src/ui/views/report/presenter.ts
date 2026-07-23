/**
 * Presenter registry — the seam between the (lazy) run controller and the
 * Report view. The pipeline's annotate stage awaits `presentRun`; the view
 * registers its implementation at mount. Because runController navigates to
 * #/report BEFORE the hashchange event mounts the view, a present that
 * arrives early waits for registration instead of failing — the pipeline's
 * annotate stage genuinely spans the first paint.
 *
 * Type-only core imports: this module rides in the entry chunk (reportView is
 * statically imported by the shell), so it must stay dependency-free.
 */
import type { PresentPayload } from '../../../core/pipeline';

export type RunPresenter = (payload: PresentPayload) => Promise<void>;

let current: RunPresenter | null = null;
let waiters: ((presenter: RunPresenter) => void)[] = [];

/** Report view registers at mount (and may re-register); null on teardown. */
export function setPresenter(presenter: RunPresenter | null): void {
  current = presenter;
  if (presenter === null) return;
  const pending = waiters;
  waiters = [];
  for (const waiter of pending) waiter(presenter);
}

/** Awaited by the pipeline's annotate stage (via runController). */
export function presentRun(payload: PresentPayload): Promise<void> {
  if (current !== null) return current(payload);
  return new Promise<void>((resolve, reject) => {
    waiters.push((presenter) => {
      presenter(payload).then(resolve, reject);
    });
  });
}
