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
