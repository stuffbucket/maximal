/**
 * Contract for the in-app update action: the topbar "Update to X.Y.Z" button
 * in the combined Settings/Dashboard window and the tray item. Both read the
 * sidecar's update-status and send the user to the download page root; neither
 * may point at the retired /maximal path or at github.com.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string =>
  readFileSync(resolve(REPO_ROOT, path), "utf8")

const SETTINGS_HTML = read("shell/ui/settings/index.html")
const SETTINGS_MAIN_TS = read("shell/src/main.ts")
const SHELL_LIB_RS = read("shell/src-tauri/src/lib.rs")
const EN = JSON.parse(read("shell/src/i18n/en.json")) as Record<string, string>

describe("topbar update button", () => {
  test("lives in the topbar utilities, hidden until an update is offered", () => {
    const utilities = SETTINGS_HTML.slice(
      SETTINGS_HTML.indexOf('<div class="topbar__utilities">'),
      SETTINGS_HTML.indexOf("data-surface-mode-btn"),
    )
    // The wrapper carries [hidden]: .btn's display rule would override the UA
    // [hidden] style on the button itself.
    expect(utilities).toContain("<span data-update-action hidden>")
    expect(utilities).toContain('class="btn btn--primary btn--sm"')
    expect(utilities).toContain('data-action="open-update"')
  })

  test("is labelled through the catalog and opens the download page externally", () => {
    expect(EN["nav-update-to"]).toBe("Update to {version}")
    expect(SETTINGS_MAIN_TS).toContain('t("nav-update-to", { version })')
    expect(SETTINGS_MAIN_TS).toContain(
      "void openExternalUrl(lastUpdateStatus.url)",
    )
  })

  test("shares one predicate with the Diagnostics Updates row", () => {
    const uses = SETTINGS_MAIN_TS.match(/offeredUpdate\(/g) ?? []
    // Definition + button render + click guard + Diagnostics row.
    expect(uses.length).toBeGreaterThanOrEqual(4)
    expect(SETTINGS_MAIN_TS).not.toContain(
      "if (data.update_available && data.latest)",
    )
  })
})

describe("tray update item", () => {
  test("is labelled 'Update to X.Y.Z…'", () => {
    expect(EN["native-tray-upgrade"]).toBe("Update to {latest}…")
  })

  test("falls back to the download page root, never the retired path", () => {
    expect(SHELL_LIB_RS).toContain(
      'const UPDATE_PAGE_URL: &str = "https://mxml.sh/";',
    )
    expect(SHELL_LIB_RS).not.toContain("mxml.sh/maximal/")
    expect(SHELL_LIB_RS).not.toContain(
      "github.com/stuffbucket/maximal/releases",
    )
  })
})
