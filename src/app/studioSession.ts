/**
 * Studio-session seam (P19b) — the bridge between the always-loaded session
 * persister and the lazy Studio chunk, extending the `rulesDraftProbe.ts`
 * pattern. Two directions:
 *
 * - OUT (persist): the workspace registers a probe returning its live
 *   `StudioRecord` (selection, open drawer, unsaved draft) and bumps
 *   `studioSessionRev` on every session-relevant change — the signal is the
 *   persister's dependency, since the workspace's own state is closure-local
 *   and invisible to effects.
 * - IN (restore): boot parks the stored record here; the workspace consumes it
 *   once at mount. While Studio stays UNVISITED the pending record is what
 *   `readStudioSession` reports, so an untouched restored draft keeps being
 *   persisted forward instead of silently dying on the next flush.
 */
import { signal } from './signals';
import type { Signal } from './signals';
import type { StudioRecord } from './sessionSnapshot';

export type StudioSessionProbe = () => StudioRecord | null;

let probe: StudioSessionProbe | null = null;
let pendingRestore: StudioRecord | null = null;

/** Bumped by the workspace on selection/drawer/draft changes — the write-
 *  through's only window into the lazy chunk's closure state. */
export const studioSessionRev: Signal<number> = signal(0);

/** Studio workspace registers at mount (views never unmount). */
export function registerStudioSessionProbe(next: StudioSessionProbe): void {
  probe = next;
}

export function noteStudioSessionChanged(): void {
  studioSessionRev.set(studioSessionRev.get() + 1);
}

/** Boot parks the stored record for the (possibly never-mounted) workspace.
 *  `null` also serves as the purge — a reset must not leave a stale pending
 *  record to be re-persisted into the NEXT session's first flush. */
export function setPendingStudioRestore(record: StudioRecord | null): void {
  pendingRestore = record;
}

/** One-shot consumption at workspace mount; the probe owns truth afterwards. */
export function takePendingStudioRestore(): StudioRecord | null {
  const taken = pendingRestore;
  pendingRestore = null;
  return taken;
}

/** What the persister stores: the live probe when Studio has mounted, else
 *  the pending snapshot carried forward. */
export function readStudioSession(): StudioRecord | null {
  if (probe !== null) return probe();
  return pendingRestore;
}
