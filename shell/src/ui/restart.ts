import { apiCall } from "../proxy/client";
import { safeInvoke } from "../tauri/shell";

/**
 * Restarting Maximal's background service from Settings, shared by main.ts
 * (account switch / sign-out) and the panels' "Restart Maximal" remedy.
 */

/** Poll until the service answers again after going down mid-restart, up to
 *  `timeoutMs`. Resolves true once it has gone down and come back. */
export async function waitForSidecarBack(timeoutMs: number): Promise<boolean> {
  const deadlineMs = Date.now() + timeoutMs;
  let sawDown = false;
  while (Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const poll = await apiCall({
      kind: "auth-status",
      method: "GET",
      path: "/settings/api/auth/github/status",
    });
    if (!poll.ok) {
      sawDown = true; // restarting
      continue;
    }
    if (sawDown) return true; // went down and came back → restart complete
  }
  return false;
}

export type RestartOutcome =
  /** Restarted and answering again. */
  | "restarted"
  /** Not running inside the Maximal app (plain browser), so it can't restart itself. */
  | "unavailable"
  /** Asked to restart but it didn't come back in time. */
  | "timed-out";

/** Restart Maximal's background service and wait for it to come back.
 *  Shows the window's busy bar for the duration. */
export async function restartMaximal(timeoutMs = 20_000): Promise<RestartOutcome> {
  const root = document.documentElement;
  root.setAttribute("data-busy", "true");
  try {
    if (!(await safeInvoke("restart_sidecar"))) return "unavailable";
    return (await waitForSidecarBack(timeoutMs)) ? "restarted" : "timed-out";
  } finally {
    root.removeAttribute("data-busy");
  }
}
