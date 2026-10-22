/**
 * Classify where the running binary was launched from for diagnostics.
 *
 * CLI installation is owned by the package manager or the user. The desktop
 * app runs its bundled sidecar by absolute path and does not create links or
 * edit shell startup files.
 */

/** True when `execPath` points inside a macOS `.app` bundle's executable dir. */
export function isAppBundlePath(execPath: string): boolean {
  return /\.app\/Contents\/MacOS\//u.test(execPath)
}

export interface LaunchSource {
  path: string
  kind: "dmg-app" | "homebrew" | "user-bin" | "dev" | "other"
}

/** Classify where the running binary came from. */
export function describeLaunchSource(
  execPath: string = process.execPath,
): LaunchSource {
  if (isAppBundlePath(execPath)) return { path: execPath, kind: "dmg-app" }
  if (
    /\/target\/(?:debug|release)\//u.test(execPath)
    || execPath.endsWith("/bun")
  )
    return { path: execPath, kind: "dev" }
  if (/\/(?:homebrew|Cellar)\//u.test(execPath))
    return { path: execPath, kind: "homebrew" }
  if (execPath.includes("/.local/bin/"))
    return { path: execPath, kind: "user-bin" }
  return { path: execPath, kind: "other" }
}
