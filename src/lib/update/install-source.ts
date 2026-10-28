/**
 * How this `maximal` was installed, as far as updating it is concerned.
 *
 * The Debian/Ubuntu packages (build/linux/) put the binaries in /usr/bin and
 * drop a marker file each: `maximal` ships `/usr/lib/maximal/installed-by-apt`,
 * `maximal-desktop` ships `/usr/lib/maximal/desktop-installed-by-apt`. apt owns
 * those installs, so an available update is offered as the apt command to run
 * instead of the download page. Anything else (a tarball, Homebrew, a source
 * run, a copy of the binary elsewhere on a machine that also has the package)
 * keeps the generic download page.
 *
 * Two file probes, done once and cached: cheap enough for the request path.
 */

import fs from "node:fs"

export const APT_BINARY = "/usr/bin/maximal"
export const APT_MARKER = "/usr/lib/maximal/installed-by-apt"
export const APT_DESKTOP_MARKER = "/usr/lib/maximal/desktop-installed-by-apt"

/** The Linux guide's update section (docs/linux.md). A link for people;
 *  the update check itself never contacts github.com. */
export const LINUX_UPDATE_URL =
  "https://github.com/stuffbucket/maximal/blob/main/docs/linux.md#update"

export interface AptInstall {
  /** `maximal-desktop` is installed too, so it must be upgraded alongside. */
  desktop: boolean
}

export interface InstallProbe {
  platform: NodeJS.Platform
  execPath: string
  exists: (path: string) => boolean
}

const defaultProbe = (): InstallProbe => ({
  platform: process.platform,
  execPath: process.execPath,
  exists: (path) => fs.existsSync(path),
})

/**
 * The apt install this process runs from, or null. Requires the running
 * binary to be the packaged `/usr/bin/maximal` and the package's marker to be
 * present, so another copy of the binary never claims apt owns it.
 */
export function detectAptInstall(
  probe: InstallProbe = defaultProbe(),
): AptInstall | null {
  if (probe.platform !== "linux") return null
  if (probe.execPath !== APT_BINARY) return null
  if (!probe.exists(APT_MARKER)) return null
  return { desktop: probe.exists(APT_DESKTOP_MARKER) }
}

/** The command that upgrades an apt install, including the desktop package
 *  when it is installed (it depends on the exact `maximal` version). */
export function aptUpgradeCommand(install: AptInstall): string {
  const packages = install.desktop ? "maximal maximal-desktop" : "maximal"
  return `sudo apt update && sudo apt install --only-upgrade ${packages}`
}

/** The one line `maximal start` logs when a newer version is available: the
 *  apt command for an apt install (`updateCommand`), else the download page. */
export function updateAvailableMessage(
  latest: string,
  updateCommand: string | null,
  downloadUrl: string,
): string {
  return `Maximal ${latest} is available: ${updateCommand ?? downloadUrl}`
}

let cached: { install: AptInstall | null } | null = null

/** `detectAptInstall()` for this process, probed once. */
export function currentAptInstall(): AptInstall | null {
  cached ??= { install: detectAptInstall() }
  return cached.install
}

export function __setAptInstallForTests(install: AptInstall | null): void {
  cached = { install }
}

export function __resetAptInstallForTests(): void {
  cached = null
}
