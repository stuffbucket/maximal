/**
 * Settings opened in a plain browser against a headless Maximal.
 *
 * The native shell authenticates with its own per-launch key (served over
 * Tauri IPC); none of this applies there. A plain browser instead supplies an
 * existing Maximal API key that the person types into the access dialog. The
 * key lives only in this tab's sessionStorage, never in localStorage, a
 * cookie or a URL, and it travels only in the `x-api-key` header.
 */

const STORAGE_KEY = "maximal.browserApiKey";
const BROWSER_AUTH_REQUIRED = "maximal:browser-auth-required";
/** The challenge Maximal's key middleware sends (src/lib/auth/request-auth.ts). */
const API_KEY_CHALLENGE = 'Bearer realm="copilot-api"';

const authEvents = new EventTarget();
let required = false;

/**
 * Running inside the Tauri webview. Tauri injects its IPC bridge before any
 * page script runs; `invoke` itself depends on it. (The optional `isTauri`
 * export is not available everywhere the Settings bundle runs, e.g. under
 * Storybook's `@tauri-apps/api/core` stand-in.)
 */
export function isNativeShell(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

/**
 * Maximal's own API-key challenge, as opposed to a 401 Maximal forwarded from
 * GitHub or Copilot (an expired sign-in), which carries no such header.
 */
export function isApiKeyChallenge(
  response: Pick<Response, "status" | "headers">,
): boolean {
  return (
    response.status === 401 &&
    response.headers.get("www-authenticate")?.trim() === API_KEY_CHALLENGE
  );
}

/** The browser's credential for this tab, if one was saved. */
export function browserApiKey(): string | undefined {
  if (isNativeShell()) return undefined;
  try {
    return globalThis.sessionStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    // Storage disabled: there is no saved credential.
    return undefined;
  }
}

/** Throws when the browser refuses session storage; the dialog says so. */
export function saveBrowserApiKey(key: string): void {
  globalThis.sessionStorage.setItem(STORAGE_KEY, key.trim());
  required = false;
}

export function clearBrowserApiKey(): void {
  try {
    globalThis.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage disabled: there is no saved credential to remove.
  }
}

/** A Maximal key challenge arrived and no accepted key has replaced it yet. */
export function browserAuthRequired(): boolean {
  return required;
}

export function onBrowserAuthRequired(listener: () => void): () => void {
  authEvents.addEventListener(BROWSER_AUTH_REQUIRED, listener);
  return () => authEvents.removeEventListener(BROWSER_AUTH_REQUIRED, listener);
}

/** Open the access dialog (a Connect action). Does nothing in the app. */
export function openBrowserAuth(): void {
  if (isNativeShell()) return;
  authEvents.dispatchEvent(new Event(BROWSER_AUTH_REQUIRED));
}

/**
 * A request sent with `requestKey` met Maximal's key challenge: forget that
 * key and ask for one. Ignored in the app, while already asking, and when the
 * stored key has changed since the request left, so a late 401 for an old key
 * can neither discard a newer one nor reopen the dialog over it. The refused
 * request is never sent again; the caller reports it as failed.
 */
export function requireBrowserAuth(requestKey: string | undefined): void {
  if (isNativeShell() || required || browserApiKey() !== requestKey) return;
  clearBrowserApiKey();
  required = true;
  openBrowserAuth();
}
