import { useEffect, type RefObject } from "react";

/** How often to look again while the element is on screen. A look is file
 *  probes and cached values on the proxy, so this is cheap. */
export const RECHECK_POLL_MS = 3_000;

/**
 * Call `check` when the window comes back to the front (the user returning
 * from their terminal) and every `pollMs` while `ref`'s element is showing.
 * Settings keeps every section mounted and hides the others, so a check only
 * runs while the element is outside any `[hidden]` ancestor. Overlapping
 * checks are skipped. `check` must be a stable callback.
 */
export function useRecheckWhileVisible(
  ref: RefObject<HTMLElement | null>,
  check: () => Promise<void>,
  enabled: boolean,
  pollMs = RECHECK_POLL_MS,
): void {
  useEffect(() => {
    if (!enabled) return;
    let checking = false;
    const run = (): void => {
      const onScreen =
        document.visibilityState === "visible" &&
        ref.current !== null &&
        ref.current.closest("[hidden]") === null;
      if (!onScreen || checking) return;
      checking = true;
      void check().finally(() => {
        checking = false;
      });
    };
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    const timer = window.setInterval(run, pollMs);
    return () => {
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
      window.clearInterval(timer);
    };
  }, [ref, check, enabled, pollMs]);
}
