/**
 * Unit coverage for the app-data root resolver. Drives the pure
 * `resolveAppDir({ platform, homedir, copilotApiHome, appData })` overload so
 * the tests assert the win32 / POSIX / override convention deterministically on
 * any host without mutating `process.platform` or `process.env`.
 */

import { describe, expect, it } from "bun:test"
import path from "node:path"

import { resolveAppDir } from "~/lib/paths"

const HOME = path.join("/home", "alice")
const WIN_HOME = String.raw`C:\Users\alice`
const WIN_APPDATA = String.raw`C:\Users\alice\AppData\Roaming`

describe("resolveAppDir", () => {
  it("uses ~/.local/share/maximal on linux", () => {
    expect(resolveAppDir({ platform: "linux", homedir: HOME })).toBe(
      path.join(HOME, ".local", "share", "maximal"),
    )
  })

  it("uses ~/.local/share/maximal on macOS (darwin), unchanged", () => {
    expect(resolveAppDir({ platform: "darwin", homedir: HOME })).toBe(
      path.join(HOME, ".local", "share", "maximal"),
    )
  })

  it(String.raw`uses %APPDATA%\maximal on win32`, () => {
    expect(
      resolveAppDir({
        platform: "win32",
        homedir: WIN_HOME,
        appData: WIN_APPDATA,
      }),
    ).toBe(path.join(WIN_APPDATA, "maximal"))
  })

  it("falls back to <home>/AppData/Roaming/maximal on win32 with no APPDATA", () => {
    expect(resolveAppDir({ platform: "win32", homedir: WIN_HOME })).toBe(
      path.join(WIN_HOME, "AppData", "Roaming", "maximal"),
    )
  })

  it("treats a blank/whitespace APPDATA as unset on win32", () => {
    expect(
      resolveAppDir({ platform: "win32", homedir: WIN_HOME, appData: "  " }),
    ).toBe(path.join(WIN_HOME, "AppData", "Roaming", "maximal"))
  })

  it("COPILOT_API_HOME overrides on win32", () => {
    const override = String.raw`D:\custom\maximal-home`
    expect(
      resolveAppDir({
        platform: "win32",
        homedir: WIN_HOME,
        appData: WIN_APPDATA,
        copilotApiHome: override,
      }),
    ).toBe(override)
  })

  it("COPILOT_API_HOME overrides on POSIX", () => {
    const override = "/srv/maximal-home"
    expect(
      resolveAppDir({
        platform: "linux",
        homedir: HOME,
        copilotApiHome: override,
      }),
    ).toBe(override)
  })

  it("ignores a blank/whitespace COPILOT_API_HOME (falls through to default)", () => {
    expect(
      resolveAppDir({ platform: "linux", homedir: HOME, copilotApiHome: "  " }),
    ).toBe(path.join(HOME, ".local", "share", "maximal"))
  })

  it("logs land under <root>/logs on win32 (single-root model)", () => {
    const root = resolveAppDir({
      platform: "win32",
      homedir: WIN_HOME,
      appData: WIN_APPDATA,
    })
    expect(path.join(root, "logs")).toBe(
      path.join(WIN_APPDATA, "maximal", "logs"),
    )
  })
})
