/**
 * Rules-draft probe registry (UIX-7) — the seam between the always-loaded
 * clear actions and the lazy Studio chunk (presenter.ts pattern). An OPEN
 * editor drawer with unsaved edits is invisible to `rulesState.dirtyFiles`
 * (only SAVED edits land there), yet a rules clear would destroy it without
 * a word: the Studio render effect closes the drawer unconfirmed the moment
 * its file vanishes. Studio registers a probe at mount; the clear actions
 * consult it to decide whether a confirm dialog is owed.
 */
export type RulesDraftProbe = () => string | null;

let probe: RulesDraftProbe | null = null;

/** Studio workspace registers at mount (views never unmount). */
export function registerRulesDraftProbe(next: RulesDraftProbe): void {
  probe = next;
}

/** File name of an open UNSAVED drawer draft, or null when there is none. */
export function peekRulesDraftFile(): string | null {
  return probe?.() ?? null;
}
