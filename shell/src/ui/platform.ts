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
export function isWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  const uaData = (navigator as { userAgentData?: { platform?: string } })
    .userAgentData;
  if (uaData?.platform) return /windows/i.test(uaData.platform);
  return /windows/i.test(navigator.userAgent);
}
