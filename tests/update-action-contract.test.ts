/**
 * Contract for the in-app update action: the topbar "Update to X.Y.Z" button
 * in the combined Settings/Dashboard window and the tray item. Both read the
 * sidecar's update-status. On Windows and macOS they install the update in
 * place (a native confirm, then the shell's signed-update flow); elsewhere they
 * send the user to the download page root. Neither checks github.com for
 * updates or points at the retired /maximal path.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const read = (path: string): string =>
  readFileSync(resolve(REPO_ROOT, path), "utf8")

const SETTINGS_HTML = read("shell/ui/settings/index.html")
const SETTINGS_MAIN_TS = read("shell/src/main.ts")
const SHELL_TS = read("shell/src/tauri/shell.ts")
const SHELL_LIB_RS = read("shell/src-tauri/src/lib.rs")
const SHELL_PERMISSIONS = read("shell/src-tauri/permissions/default.toml")
const TAURI_CONF = JSON.parse(read("shell/src-tauri/tauri.conf.json")) as {
  plugins?: {
    updater?: {
      pubkey?: string
      requireSignedVersion?: boolean
      endpoints?: Array<string>
    }
  }
  bundle?: { createUpdaterArtifacts?: unknown }
}
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

  test("is labelled through the catalog, including while downloading", () => {
    expect(EN["nav-update-to"]).toBe("Update to {version}")
    expect(EN["nav-update-downloading"]).toBe("Downloading update…")
    expect(SETTINGS_MAIN_TS).toContain('t("nav-update-to", { version })')
    expect(SETTINGS_MAIN_TS).toContain('t("nav-update-downloading")')
  })

  test("asks the shell to install, and opens the download page when it can't", () => {
    expect(SETTINGS_MAIN_TS).toContain("await installUpdate(")
    expect(SETTINGS_MAIN_TS).toContain(
      'if (outcome === "unavailable") void openExternalUrl(status.url)',
    )
    expect(SHELL_TS).toContain('invoke<unknown>("install_update", { onStep })')
    // Any IPC failure (a plain browser, an older shell) falls back to the page.
    expect(SHELL_TS).toContain('return "unavailable";')
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

describe("in-place update (shell)", () => {
  test("runs on Windows and macOS; other builds open the download page", () => {
    expect(SHELL_LIB_RS).toContain(
      'const IN_PLACE_UPDATE: bool = cfg!(any(target_os = "windows", target_os = "macos"));',
    )
    expect(SHELL_LIB_RS).toContain("let builder = if IN_PLACE_UPDATE {")
    // Without in-place support the tray item and the button open the page.
    expect(SHELL_LIB_RS).toMatch(
      /fn start_update\(app: &AppHandle\) \{\s+if !IN_PLACE_UPDATE \{\s+open_update_url\(app\);/u,
    )
  })

  test("a macOS app that can't replace itself fails over before asking", () => {
    const flow = SHELL_LIB_RS.slice(
      SHELL_LIB_RS.indexOf("async fn install_in_place("),
      SHELL_LIB_RS.indexOf("async fn confirm_update("),
    )
    expect(flow.indexOf("update_location_problem()")).toBeGreaterThan(-1)
    expect(flow.indexOf("update_location_problem()")).toBeLessThan(
      flow.indexOf("confirm_update(app"),
    )
    // Stops the sidecar before relaunching on macOS, and before the
    // installer replaces it on Windows.
    expect(flow.match(/stop_sidecar_for_update\(app\)\.await/gu)).toHaveLength(
      2,
    )
    expect(flow).toContain("app.restart();")
  })

  test("checks the CDN desktop manifest, never github.com", () => {
    expect(SHELL_LIB_RS).toContain(
      'const DESKTOP_UPDATE_MANIFEST_BASE: &str = "https://mxml.sh/updates/desktop/";',
    )
    expect(TAURI_CONF.plugins?.updater?.endpoints).toBeUndefined()
    // No string literal in the shell points a request at GitHub.
    expect(/"https:\/\/(?:api\.)?github\.com/u.test(SHELL_LIB_RS)).toBe(false)
  })

  test("verifies against Maximal's updater key, signed for the version", () => {
    const pubkey = TAURI_CONF.plugins?.updater?.pubkey ?? ""
    const decoded = Buffer.from(pubkey, "base64").toString("utf8")
    expect(decoded).toStartWith(
      "untrusted comment: minisign public key: E8DAB79E2EB1D6C4\n",
    )
    expect(TAURI_CONF.plugins?.updater?.requireSignedVersion).toBe(true)
    // Only the Windows release job signs: a committed true would make every
    // other `tauri build` (macOS, dev) demand the private key.
    expect(TAURI_CONF.bundle?.createUpdaterArtifacts).toBeUndefined()
  })

  test("asks before installing, and says so plainly when it can't", () => {
    expect(SHELL_LIB_RS).toContain('"native-update-confirm-body"')
    expect(EN["native-update-confirm-body"]).toContain("{version}")
    expect(SHELL_LIB_RS).toContain(
      "if !confirm_update(app, &update.version).await",
    )
    expect(SHELL_LIB_RS).toContain("report_update_failure(app);")
    expect(EN["native-update-failed-body"]).toContain("mxml.sh")
  })

  test("the webview may call the update commands", () => {
    expect(SHELL_PERMISSIONS).toContain('"allow-install-update"')
    expect(SHELL_PERMISSIONS).toContain('commands.allow = ["install_update"]')
    expect(SHELL_PERMISSIONS).toContain(
      'commands.allow = ["update_installs_in_place"]',
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
