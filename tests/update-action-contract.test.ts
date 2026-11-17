/**
 * Contract for the in-app update action: the title bar's icon-only update
 * button and System's "Update to X.Y.Z" button in the combined
 * Settings/Dashboard window, and the tray item. All read the sidecar's
 * update-status. Settings asks in its own dialog, then hands off once; the
 * tray asks natively. On Windows and macOS the update installs in place (the
 * shell's signed-update flow); elsewhere the user is sent to the download
 * page root or, for apt, to the command. Nothing checks github.com for
 * updates or points at the retired /maximal path. Behaviour is covered by
 * tests/update-flow.test.ts and tests/e2e/settings-update.spec.ts.
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
const SHELL_RUNTIME_RS = read("shell/src-tauri/src/sidecar_runtime.rs")
const SHELL_RUST_SOURCES = `${SHELL_LIB_RS}\n${SHELL_RUNTIME_RS}`
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
const UPDATE_FLOW_TS = read("shell/src/ui/features/update/update-flow.ts")
const UPDATE_COPY_TS = read("shell/src/ui/features/update/update-copy.ts")

describe("topbar update button", () => {
  const utilities = SETTINGS_HTML.slice(
    SETTINGS_HTML.indexOf('<div class="topbar__utilities">'),
    SETTINGS_HTML.indexOf("topbar__surface-switcher"),
  )

  test("lives in the topbar utilities, hidden until an update is offered", () => {
    // The wrapper carries [hidden]: .btn's display rule would override the UA
    // [hidden] style on the button itself.
    expect(utilities).toContain("<span data-update-action hidden>")
    expect(utilities).toContain('data-action="open-update"')
  })

  test("is a compact icon-only button, not a text button that takes tab width", () => {
    expect(utilities).toContain('class="btn btn--primary btn--icon"')
    expect(utilities).not.toContain("btn--sm")
    // The glyph is decorative; the name comes from aria-label and title.
    expect(utilities).toMatch(/<svg[^>]*aria-hidden="true"/u)
  })

  test("is labelled through the catalog, including while downloading", () => {
    expect(EN["nav-update-icon"]).toBe("Update Maximal to {version}")
    expect(EN["nav-update-downloading"]).toBe("Downloading update…")
    expect(EN["nav-update-to"]).toBe("Update to {version}")
    expect(EN["system-update-downloading"]).toBe("Downloading…")
    expect(UPDATE_COPY_TS).toContain(
      't("nav-update-icon", { version: offer.version })',
    )
    expect(UPDATE_COPY_TS).toContain('t("nav-update-downloading")')
    expect(SETTINGS_MAIN_TS).toContain(
      'button.setAttribute("aria-label", labels.icon)',
    )
    expect(SETTINGS_MAIN_TS).toContain("button.title = labels.icon")
  })

  test("asks the shell to install the confirmed version, and opens the page when it can't", () => {
    expect(SHELL_TS).toContain(
      'invoke<unknown>("install_update", { onStep, version })',
    )
    // Any IPC failure (a plain browser, an older shell) falls back to the page.
    expect(SHELL_TS).toContain('return "unavailable";')
    expect(UPDATE_FLOW_TS).toContain(
      'if (outcome === "unavailable") deps.openDownloadPage(offer.url)',
    )
  })

  test("the in-place install is reachable from exactly one place: after the dialog said yes", () => {
    // One IPC call site, and one caller of it (the flow's installInPlace dep).
    expect(SHELL_TS.match(/"install_update"/gu)).toHaveLength(1)
    const sources = [SETTINGS_MAIN_TS, UPDATE_FLOW_TS, UPDATE_COPY_TS, SHELL_TS]
    // The definition in shell.ts + the single call in main.ts.
    expect(sources.join("\n").match(/\binstallUpdate\(/gu)).toHaveLength(2)
    expect(SETTINGS_MAIN_TS).toMatch(
      /installInPlace: \(version, onDownloading\) =>\s+installUpdate\(version, onDownloading\)/u,
    )
    const flow = UPDATE_FLOW_TS.slice(UPDATE_FLOW_TS.indexOf("async start("))
    expect(flow.indexOf("await deps.confirm(offer)")).toBeGreaterThan(-1)
    expect(flow.indexOf("await deps.confirm(offer)")).toBeLessThan(
      flow.indexOf("deps.installInPlace("),
    )
  })

  test("the title bar and System share one offer predicate and one flow", () => {
    expect(SETTINGS_MAIN_TS).not.toContain("function offeredUpdate(")
    expect(SETTINGS_MAIN_TS.match(/createUpdateFlow\(/gu)).toHaveLength(1)
    expect(SETTINGS_MAIN_TS).toMatch(
      /'\[data-action="open-update"\]'[\s\S]*?startUpdate\(\)/u,
    )
    expect(SETTINGS_MAIN_TS).toMatch(
      /'\[data-action="system-update"\]'[\s\S]*?startUpdate\(\)/u,
    )
  })
})

describe("System update button", () => {
  const row = SETTINGS_HTML.slice(
    SETTINGS_HTML.indexOf('<dt data-i18n="diagnostics-updates"></dt>'),
    SETTINGS_HTML.indexOf('<dt data-i18n="diagnostics-update-check"></dt>'),
  )

  test("is a primary button in the Updates row, hidden until an update is offered", () => {
    expect(row).toContain("<span data-system-update hidden>")
    expect(row).toMatch(
      /<button\s+type="button"\s+class="btn btn--primary btn--sm"\s+data-action="system-update"/u,
    )
    // It comes before Check now, which stays the quiet action.
    expect(row.indexOf('data-action="system-update"')).toBeLessThan(
      row.indexOf('data-action="check-update"'),
    )
  })

  test("replaces the old text link to the download page", () => {
    expect(SETTINGS_MAIN_TS).not.toContain('t("diagnostics-update-get-it")')
    expect(EN["diagnostics-update-get-it"]).toBeUndefined()
    expect(EN["diagnostics-update-newer"]).toBe("v{version} available")
  })
})

describe("in-place update (shell)", () => {
  test("runs on Windows and macOS; other builds open the download page", () => {
    expect(SHELL_LIB_RS).toContain(
      'const IN_PLACE_UPDATE: bool = cfg!(any(target_os = "windows", target_os = "macos"));',
    )
    expect(SHELL_LIB_RS).toContain(
      "let builder = if profile.updates_enabled() && IN_PLACE_UPDATE {",
    )
    expect(SHELL_LIB_RS).toContain(
      "if !app.state::<AppProfile>().updates_enabled()",
    )
    // Without in-place support the tray item asks natively and opens the
    // page, or, for an apt install, asks Settings to confirm and show the
    // apt command (tests/update-requests.test.ts).
    expect(SHELL_LIB_RS).toContain(
      "fn tray_update_handoff(in_place: bool, apt: bool) -> TrayUpdateHandoff",
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
    expect(flow.match(/stop_sidecar_and_wait\(app\)\.await/gu)).toHaveLength(2)
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
    // Settings already asked about this exact signed version, or the shell
    // asks natively now: there is no third way through.
    expect(SHELL_LIB_RS).toContain(
      "let confirmed = webview_confirmed_release(confirmed_version.as_deref(), &update.version)\n        || confirm_update(app, &update.version).await;",
    )
    expect(SHELL_LIB_RS).toContain("if !confirmed {")
    expect(SHELL_LIB_RS).toContain("report_update_failure(app);")
    expect(EN["native-update-failed-body"]).toContain("mxml.sh")
  })

  test("the tray asks natively; Settings passes the version its dialog confirmed", () => {
    expect(SHELL_LIB_RS).toMatch(
      /fn start_update\(app: &AppHandle\) \{[\s\S]*?run_in_place_update\(&handle, None, \|_\| \{\}\)\.await;/u,
    )
    expect(SHELL_LIB_RS).toMatch(
      /async fn install_update\(\s*app: AppHandle,\s*on_step: Channel<UpdateStep>,\s*version: String,\s*\) -> UpdateOutcome \{[\s\S]*?run_in_place_update\(&app, Some\(version\),/u,
    )
    // Exactly those two callers.
    expect(SHELL_LIB_RS.match(/run_in_place_update\(&/gu)).toHaveLength(2)
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
    expect(SHELL_RUST_SOURCES).toContain(
      'const UPDATE_PAGE_URL: &str = "https://mxml.sh/";',
    )
    expect(SHELL_RUST_SOURCES).not.toContain("mxml.sh/maximal/")
    expect(SHELL_RUST_SOURCES).not.toContain(
      "github.com/stuffbucket/maximal/releases",
    )
  })
})

describe("apt installs (Debian/Ubuntu packages)", () => {
  test("never install in place: Linux stays out of IN_PLACE_UPDATE", () => {
    expect(SHELL_LIB_RS).not.toMatch(
      /IN_PLACE_UPDATE: bool = cfg!\([^)]*linux/u,
    )
  })

  test("the tray item reads 'Update with apt'; Settings asks before showing the command", () => {
    expect(EN["nav-update-apt"]).toBeUndefined()
    expect(EN["native-tray-upgrade-apt"]).toBe("Update with apt…")
    expect(SHELL_LIB_RS).toContain(
      'native_i18n::tr(locale, "native-tray-upgrade-apt")',
    )
    // The sidecar decides: an apt install reports its command.
    expect(SHELL_RUST_SOURCES).toContain('.get("update_command")')
  })

  test("clicking shows the command to copy and the Linux guide, without running it", () => {
    const block = SETTINGS_HTML.slice(
      SETTINGS_HTML.indexOf("<div data-update-apt hidden>"),
      SETTINGS_HTML.indexOf("data-system-details"),
    )
    expect(block).toContain('class="app-card__cmd"')
    expect(block).toContain('data-action="copy-update-command"')
    expect(block).toContain('data-i18n="apps-copy-command"')
    expect(block).toContain(
      'href="https://github.com/stuffbucket/maximal/blob/main/docs/linux.md#update"',
    )
    expect(EN["diagnostics-update-apt-hint"]).toContain("{version}")
    expect(UPDATE_FLOW_TS).toMatch(
      /case "apt":\s+setPhase\("idle"\);\s+deps\.revealAptCommand\(\);\s+return;/u,
    )
    // The tray's explicit request starts the same confirming flow.
    expect(SETTINGS_MAIN_TS).toMatch(
      /subscribeToUpdateRequests\(\(\) => \{[\s\S]*?startUpdate\(\)/u,
    )
    // Nothing in the shell runs apt or asks for root.
    expect(SHELL_LIB_RS).not.toMatch(
      /Command::new\("(?:sudo|apt|apt-get|pkexec)"/u,
    )
  })
})

describe("check for updates", () => {
  test("the tray item sits with the update item and forces a check", () => {
    expect(EN["native-tray-check-updates"]).toBe("Check for updates")
    expect(SHELL_LIB_RS).toContain(
      "menu_id::CHECK_UPDATES => check_updates_from_tray(app)",
    )
    // Same parser as the poll; a forced check goes through ?force=1.
    expect(SHELL_RUST_SOURCES).toContain("parse_update_status(payload)")
    expect(SHELL_RUST_SOURCES).toContain('format!("{base}?force=1")')
  })

  test("its notices come from the catalog and use the dialog plugin", () => {
    expect(EN["native-update-check-current"]).toBe(
      "Maximal is up to date ({version})",
    )
    for (const key of [
      "native-update-check-title",
      "native-update-check-failed",
      "native-update-check-disabled",
    ]) {
      expect(EN[key]).toBeString()
      expect(SHELL_LIB_RS).toContain(`"${key}"`)
    }
    expect(SHELL_LIB_RS).toContain("fn show_update_check_notice(")
  })

  test("Settings has a 'Check now' button beside the Updates status", () => {
    const row = SETTINGS_HTML.slice(
      SETTINGS_HTML.indexOf('<dt data-i18n="diagnostics-updates"></dt>'),
      SETTINGS_HTML.indexOf('<dt data-i18n="diagnostics-update-check"></dt>'),
    )
    expect(row).toContain('data-field="update_status"')
    expect(row).toContain('class="btn btn--ghost btn--sm"')
    expect(row).toContain('data-action="check-update"')
    expect(row).toContain('data-i18n="diagnostics-update-check-now"')
    expect(EN["diagnostics-update-check-now"]).toBe("Check now")
    expect(SETTINGS_MAIN_TS).toContain(
      'path: "/settings/api/update-status?force=1"',
    )
  })

  test("the webview may tell the shell, and the shell may tell the webview", () => {
    expect(SHELL_PERMISSIONS).toContain('"allow-refresh-update-status"')
    expect(SHELL_PERMISSIONS).toContain(
      'commands.allow = ["refresh_update_status"]',
    )
    expect(SHELL_LIB_RS).toContain(
      'const UPDATE_STATUS_EVENT: &str = "update:status";',
    )
    expect(SHELL_TS).toContain('listen("update:status", onChange)')
  })
})
