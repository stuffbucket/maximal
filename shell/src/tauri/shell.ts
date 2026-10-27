import { invoke } from "@tauri-apps/api/core";

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
