import { isTauri } from "@tauri-apps/api/core";

const STORAGE_KEY = "maximal.browserApiKey";
const BROWSER_AUTH_REQUIRED = "maximal:browser-auth-required";
const authEvents = new EventTarget();

export function onBrowserAuthRequired(listener: () => void): () => void {
  authEvents.addEventListener(BROWSER_AUTH_REQUIRED, listener);
  return () => authEvents.removeEventListener(BROWSER_AUTH_REQUIRED, listener);
}

let required = false;

/** Tauri exposes its IPC bridge even when its optional convenience flag is absent. */
export function isNativeShell(): boolean {
  return isTauri() || "__TAURI_INTERNALS__" in globalThis;
}

/** Distinguish Maximal's key gate from forwarded GitHub/Copilot 401s. */
export function isApiKeyChallenge(response: Pick<Response, "status" | "headers">): boolean {
  return response.status === 401 &&
    response.headers.get("www-authenticate") === 'Bearer realm="copilot-api"';
}

/** A browser credential lasts only for this tab, never in URLs or localStorage. */
export function browserApiKey(): string | undefined {
  if (isNativeShell()) return undefined;
  try {
    return globalThis.sessionStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveBrowserApiKey(key: string): void {
  globalThis.sessionStorage.setItem(STORAGE_KEY, key.trim());
  required = false;
}

export function clearBrowserApiKey(): void {
  try {
    globalThis.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be disabled; there is then no saved credential to remove.
  }
}

export function browserAuthRequired(): boolean {
  return required;
}

export function openBrowserAuth(): void {
  if (isNativeShell()) return;
  authEvents.dispatchEvent(new Event(BROWSER_AUTH_REQUIRED));
}

/** Ignore stale or repeated 401s so they cannot erase a key being typed. */
export function requireBrowserAuth(requestKey: string | undefined): void {
  if (isNativeShell() || required || browserApiKey() !== requestKey) return;
  clearBrowserApiKey();
  required = true;
  openBrowserAuth();
}
