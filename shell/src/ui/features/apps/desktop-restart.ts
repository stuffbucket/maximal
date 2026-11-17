import { t } from "../../../i18n";

/** Which way a Claude Desktop change went. */
export type DesktopChange = "enabled" | "disabled";

/** The parts of a fresh app entry (`AppEntry`) that say whether a toggle
 *  took. Structural, so this module stays free of the DOM-bound client. */
interface ToggledEntry {
  enabled: boolean;
  conflict: string | null;
}

/** The parts of a toggle's `MutationResult` the dialog depends on. */
interface ToggleResult {
  ok: boolean;
  error?: string;
  applied?: boolean;
}

/**
 * Whether the server applied the requested state: it came back in that
 * state and with no conflict. A refused enable still answers 200 (the fresh
 * entry carries the reason), so success alone isn't enough.
 */
export function toggleApplied(
  entry: ToggledEntry,
  requested: boolean,
): boolean {
  return entry.enabled === requested && entry.conflict === null;
}

/**
 * The change to tell the person about after a Claude Desktop toggle, or null
 * when there is nothing to restart for: another app, a failed request, or a
 * change that wasn't applied.
 */
export function desktopRestartChange(
  appId: string,
  requested: boolean,
  result: ToggleResult,
): DesktopChange | null {
  if (appId !== "claude-desktop" || !result.ok || result.applied !== true) {
    return null;
  }
  return requested ? "enabled" : "disabled";
}

/**
 * The restart dialog's words. Claude Desktop reads its gateway profile at
 * launch, so either change needs a quit and reopen; only an enable can leave
 * it stuck at sign-in, so only an enable carries the recovery note.
 */
export function desktopRestartCopy(change: DesktopChange): {
  title: string;
  body: string;
  note: string | null;
  action: string;
} {
  return {
    title: t("apps-desktop-restart-title"),
    body: t("apps-desktop-relaunch"),
    note: change === "enabled" ? t("apps-desktop-signin-note") : null,
    action: t("apps-desktop-restart-ok"),
  };
}
