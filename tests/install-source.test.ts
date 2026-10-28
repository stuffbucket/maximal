/**
 * Apt-install detection and the update line `maximal start` logs
 * (src/lib/update/install-source.ts, src/lib/update/update-notice.ts).
 */

import { afterEach, describe, expect, test } from "bun:test"

import {
  APT_BINARY,
  APT_DESKTOP_MARKER,
  APT_MARKER,
  aptUpgradeCommand,
  detectAptInstall,
  type InstallProbe,
  updateAvailableMessage,
} from "~/lib/update/install-source"
import {
  __resetUpdateCheckDepsForTests,
  __setUpdateCheckDepsForTests,
} from "~/lib/update/update-check"
import { checkAndLogUpdate } from "~/lib/update/update-notice"

const probe = (
  overrides: Partial<InstallProbe> & { files?: Array<string> } = {},
): InstallProbe => {
  const files = new Set(overrides.files ?? [APT_MARKER])
  return {
    platform: overrides.platform ?? "linux",
    execPath: overrides.execPath ?? APT_BINARY,
    exists: overrides.exists ?? ((path) => files.has(path)),
  }
}

describe("detectAptInstall", () => {
  test("the packaged binary with the package's marker is an apt install", () => {
    expect(detectAptInstall(probe())).toEqual({ desktop: false })
  })

  test("notices the desktop package beside it", () => {
    expect(
      detectAptInstall(probe({ files: [APT_MARKER, APT_DESKTOP_MARKER] })),
    ).toEqual({ desktop: true })
  })

  test("another copy of the binary is not, even with the package installed", () => {
    expect(
      detectAptInstall(probe({ execPath: "/home/me/bin/maximal" })),
    ).toBeNull()
    expect(
      detectAptInstall(probe({ execPath: "/usr/local/bin/maximal" })),
    ).toBeNull()
  })

  test("needs the marker", () => {
    expect(detectAptInstall(probe({ files: [] }))).toBeNull()
  })

  test("is Linux only", () => {
    expect(detectAptInstall(probe({ platform: "darwin" }))).toBeNull()
    expect(detectAptInstall(probe({ platform: "win32" }))).toBeNull()
  })

  test("the markers live where the packages install them", () => {
    expect(APT_BINARY).toBe("/usr/bin/maximal")
    expect(APT_MARKER).toBe("/usr/lib/maximal/installed-by-apt")
    expect(APT_DESKTOP_MARKER).toBe("/usr/lib/maximal/desktop-installed-by-apt")
  })
})

describe("update messages", () => {
  test("the apt command upgrades only what's installed", () => {
    expect(aptUpgradeCommand({ desktop: false })).toBe(
      "sudo apt update && sudo apt install --only-upgrade maximal",
    )
    expect(aptUpgradeCommand({ desktop: true })).toBe(
      "sudo apt update && sudo apt install --only-upgrade maximal maximal-desktop",
    )
  })

  test("the log line names the version and how to get it", () => {
    expect(
      updateAvailableMessage(
        "0.6.0",
        "sudo apt update && sudo apt install --only-upgrade maximal",
        "https://mxml.sh/",
      ),
    ).toBe(
      "Maximal 0.6.0 is available: sudo apt update && sudo apt install --only-upgrade maximal",
    )
    expect(updateAvailableMessage("0.6.0", null, "https://mxml.sh/")).toBe(
      "Maximal 0.6.0 is available: https://mxml.sh/",
    )
  })
})

const manifest = (version: string): Response =>
  new Response(JSON.stringify({ channels: { stable: { version } } }), {
    status: 200,
  })

describe("checkAndLogUpdate", () => {
  afterEach(() => {
    __resetUpdateCheckDepsForTests()
  })

  test("logs the apt line when an apt install is behind", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifest("999.0.0")),
      aptInstall: { desktop: false },
    })
    const lines: Array<string> = []

    const logged = await checkAndLogUpdate((line) => lines.push(line))

    expect(logged).toBe(
      "Maximal 999.0.0 is available: sudo apt update && sudo apt install --only-upgrade maximal",
    )
    expect(lines).toEqual([logged ?? ""])
  })

  test("logs the download page for other installs", async () => {
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifest("999.0.0")),
      aptInstall: null,
    })
    const lines: Array<string> = []

    await checkAndLogUpdate((line) => lines.push(line))

    expect(lines).toEqual(["Maximal 999.0.0 is available: https://mxml.sh/"])
  })

  test("logs nothing when current or when the check fails", async () => {
    const lines: Array<string> = []
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.resolve(manifest("0.0.1")),
      aptInstall: { desktop: false },
    })
    expect(await checkAndLogUpdate((line) => lines.push(line))).toBeNull()

    __resetUpdateCheckDepsForTests()
    __setUpdateCheckDepsForTests({
      fetch: () => Promise.reject(new Error("offline")),
      aptInstall: { desktop: false },
    })
    expect(await checkAndLogUpdate((line) => lines.push(line))).toBeNull()
    expect(lines).toEqual([])
  })
})
