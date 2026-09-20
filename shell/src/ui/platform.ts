/**
 * Best-effort OS detection for the settings webview.
 *
 * The embedded UI is the SAME bundle on every platform, so anything that
 * must differ by OS (e.g. the Windows-only "restart Claude Code" caveat)
 * has to branch at runtime. We have no `tauri-plugin-os` registered, and
 * the UI can also be opened in a plain browser, so the dependency-free
 * signal is the user-agent: WebView2 on Windows reports "Windows NT",
 * WKWebView on macOS reports "Macintosh". Prefer the structured
 * `userAgentData.platform` when present, fall back to the UA string.
 */
export type OsKind = "macos" | "windows" | "linux";

/**
 * The current OS, normalized to the values the i18n catalog's `os` argument
 * expects (see shell/src/i18n). Single source of the OS branch; isWindows()
 * and any runtime OS check derive from it.
 */
export function osKind(): OsKind {
  if (typeof navigator === "undefined") return "macos";
  const uaData = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  const signal = uaData?.platform ?? navigator.userAgent;
  if (/win/i.test(signal)) return "windows";
  if (/linux|x11/i.test(signal) && !/android/i.test(signal)) return "linux";
  return "macos";
}

export function isWindows(): boolean {
  return osKind() === "windows";
}
