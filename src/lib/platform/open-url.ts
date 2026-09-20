/**
 * Cross-platform "open this URL in the user's default browser."
 *
 * `Bun.spawn` against the OS's standard launch helper:
 *   macOS:   `open <url>`
 *   Windows: `cmd /c start "" <url>`  (the empty quoted title is required
 *            so `start` doesn't interpret a URL with spaces as the title)
 *   Linux:   `xdg-open <url>`
 *
 * Headless detection: on Linux when `DISPLAY` is unset (and `WAYLAND_DISPLAY`
 * is unset too), we treat the environment as headless and refuse to spawn —
 * `xdg-open` would otherwise print an error and the caller's flow gets
 * confusing. macOS and Windows have no equivalent "no GUI" signal that's
 * cheap to probe; assume a GUI is present.
 */

export interface OpenUrlResult {
  ok: boolean
  reason?: "headless" | "spawn-failed"
}

export function isHeadless(): boolean {
  if (process.platform !== "linux") return false
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
}

export function openUrl(url: string): OpenUrlResult {
  if (isHeadless()) return { ok: false, reason: "headless" }

  const cmd = launchArgs(url)
  if (!cmd) return { ok: false, reason: "spawn-failed" }

  try {
    const proc = Bun.spawn(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    })
    // We don't wait for the child — the launcher backgrounds the browser
    // and returns immediately on every supported OS. unref so the daemon
    // doesn't keep the proc handle alive.
    proc.unref()
    return { ok: true }
  } catch {
    return { ok: false, reason: "spawn-failed" }
  }
}

function launchArgs(url: string): Array<string> | null {
  switch (process.platform) {
    case "darwin": {
      return ["open", url]
    }
    case "win32": {
      return ["cmd", "/c", "start", "", url]
    }
    case "linux": {
      return ["xdg-open", url]
    }
    default: {
      return null
    }
  }
}
