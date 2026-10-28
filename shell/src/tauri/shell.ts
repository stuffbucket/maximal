import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

let shellKeyFetched = false;
let shellKeyCache: string | null = null;

export async function getShellApiKey(): Promise<string | null> {
  if (shellKeyFetched) return shellKeyCache;
  try {
    shellKeyCache = await invoke<string>("get_shell_api_key");
  } catch {
    shellKeyCache = null;
  }
  shellKeyFetched = true;
  return shellKeyCache;
}

export async function openUrl(url: string): Promise<void> {
  await invoke("plugin:opener|open_url", { url });
}

export async function safeInvoke(cmd: string): Promise<boolean> {
  try {
    await invoke(cmd);
    return true;
  } catch (err) {
    console.warn(`safeInvoke(${cmd}) failed:`, err);
    return false;
  }
}

/**
 * Whether "Update to X.Y.Z" installs the update in place (the Windows and
 * macOS apps). False in a plain browser, where the button opens the download
 * page.
 */
export async function updateInstallsInPlace(): Promise<boolean> {
  try {
    return (await invoke<boolean>("update_installs_in_place")) === true;
  } catch {
    return false;
  }
}

/**
 * Tell the shell that Settings just ran a fresh update check, so the tray's
 * "Update to X.Y.Z" item reads the result. A no-op outside the app.
 */
export async function refreshShellUpdateStatus(): Promise<void> {
  try {
    await invoke("refresh_update_status");
  } catch {
    // Not in the app, or the shell is busy: the tray catches up on its poll.
  }
}

/**
 * Run `onChange` whenever the shell ran an update check on its own (the
 * tray's "Check for updates"), so the page can re-read the status. Returns
 * nothing to undo: the page listens for its whole life. Does nothing outside
 * the app.
 */
export async function onShellUpdateCheck(onChange: () => void): Promise<void> {
  try {
    await listen("update:status", onChange);
  } catch {
    // Not in the app: no shell to hear from.
  }
}

/** How an in-place update attempt ended (`install_update` in the shell). */
export type InstallUpdateOutcome =
  | "unavailable"
  | "busy"
  | "cancelled"
  | "failed";

const INSTALL_UPDATE_OUTCOMES: ReadonlyArray<InstallUpdateOutcome> = [
  "unavailable",
  "busy",
  "cancelled",
  "failed",
];

/**
 * Run the shell's in-place update: a native confirm naming the version, then
 * download, install and relaunch. `onDownloading` fires once the user
 * confirms. A failed install is reported by the shell itself, which then
 * opens the download page. Resolves "unavailable" where updates don't install
 * in place (a plain browser), so the caller opens the download page. Never
 * resolves after a successful install: the app relaunches.
 */
export async function installUpdate(
  onDownloading: () => void,
): Promise<InstallUpdateOutcome> {
  try {
    const onStep = new Channel<string>();
    onStep.onmessage = (step) => {
      if (step === "downloading") onDownloading();
    };
    const outcome = await invoke<unknown>("install_update", { onStep });
    return INSTALL_UPDATE_OUTCOMES.find((o) => o === outcome) ?? "unavailable";
  } catch (err) {
    console.warn("install_update failed:", err);
    return "unavailable";
  }
}

export type DockVisibilityMode = "always" | "when-window-open";

const DOCK_VISIBILITY_STORAGE_KEY = "maximal.dockVisibility";

export async function getDockVisibility(): Promise<DockVisibilityMode> {
  try {
    const mode = await invoke<string>("get_dock_visibility");
    if (mode === "always" || mode === "when-window-open") {
      return mode;
    }
  } catch {
    try {
      const stored = window.localStorage.getItem(DOCK_VISIBILITY_STORAGE_KEY);
      if (stored === "always" || stored === "when-window-open") {
        return stored;
      }
    } catch {
      // ignore storage errors
    }
  }
  return "always";
}

export async function setDockVisibility(
  mode: DockVisibilityMode,
): Promise<boolean> {
  try {
    window.localStorage.setItem(DOCK_VISIBILITY_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
  try {
    await invoke("set_dock_visibility", { mode });
    return true;
  } catch (err) {
    console.warn("set_dock_visibility failed:", err);
    return false;
  }
}
