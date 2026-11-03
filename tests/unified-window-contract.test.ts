import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const SETTINGS_HTML = readFileSync(
  resolve(REPO_ROOT, "shell/ui/settings/index.html"),
  "utf8",
)
const SETTINGS_MAIN_TS = readFileSync(
  resolve(REPO_ROOT, "shell/src/main.ts"),
  "utf8",
)
const SHELL_LIB_RS = readFileSync(
  resolve(REPO_ROOT, "shell/src-tauri/src/lib.rs"),
  "utf8",
)
const SHELL_CARGO_TOML = readFileSync(
  resolve(REPO_ROOT, "shell/src-tauri/Cargo.toml"),
  "utf8",
)

describe("unified Settings, Dashboard, Sessions & Appearance contract", () => {
  test("uses a single topbar with Settings tabs and a three-surface switcher", () => {
    expect(SETTINGS_HTML).toContain(
      '<header class="topbar" data-tauri-drag-region>',
    )
    expect(SETTINGS_HTML).not.toContain('<nav class="sidebar"')

    for (const tab of [
      "account",
      "integrations",
      "models-keys",
      "appearance",
      "system",
    ]) {
      expect(SETTINGS_HTML).toContain(`data-nav="${tab}"`)
    }

    expect(SETTINGS_HTML).toContain("topbar__surface-switcher")
    for (const surface of ["settings", "dashboard", "sessions"]) {
      expect(SETTINGS_HTML).toContain(`data-surface-target="${surface}"`)
    }
    expect(SETTINGS_HTML).toContain("data-dashboard-frame")
    expect(SETTINGS_HTML).toContain("data-dashboard-controls")
    expect(SETTINGS_MAIN_TS).toContain('sessions: ["dashboard"]')
    expect(SETTINGS_MAIN_TS).toContain('type: "maximal:surface"')
    expect(SETTINGS_MAIN_TS).toContain('safeInvoke("set_main_surface"')
  })

  test("keeps endpoint and API keys at the bottom of Integrations", () => {
    expect(SETTINGS_MAIN_TS).toContain(
      'integrations: ["apps", "mcp", "requests", "endpoint", "api-clients"]',
    )
    expect(SETTINGS_MAIN_TS).toContain('"models-keys": ["models"]')
    const requests = SETTINGS_HTML.indexOf('data-section="requests"')
    const endpoint = SETTINGS_HTML.indexOf('data-section="endpoint"')
    const apiClients = SETTINGS_HTML.indexOf('data-section="api-clients"')
    const models = SETTINGS_HTML.indexOf('data-section="models"')
    expect(requests).toBeLessThan(endpoint)
    expect(endpoint).toBeLessThan(apiClients)
    expect(apiClients).toBeLessThan(models)
  })

  test("includes Appearance section with Dock/taskbar visibility toggle defaulting to checked", () => {
    expect(SETTINGS_HTML).toContain('data-section="appearance"')
    expect(SETTINGS_HTML).toContain("data-dock-visibility-toggle")
    expect(SETTINGS_HTML).toContain('data-i18n="appearance-dock-label"')
    expect(SETTINGS_HTML).toContain('data-i18n="appearance-dock-sub"')
  })

  test("remembers last selected tab and overrides to account tab when an account problem exists", () => {
    expect(SETTINGS_MAIN_TS).toContain("maximal.lastTab")
    expect(SETTINGS_MAIN_TS).toContain("maximal.lastSettingsTab")
    expect(SETTINGS_MAIN_TS).toContain("hasAccountProblem")
  })

  test("configures persistent Tauri window geometry, chrome, Dock visibility, and macOS Dock context menu", () => {
    expect(SHELL_CARGO_TOML).toContain('tauri-plugin-window-state = "2.5"')
    expect(SHELL_LIB_RS).toContain("MAIN_WINDOW_FALLBACK_WIDTH: f64 = 1100.0")
    expect(SHELL_LIB_RS).toContain("MAIN_WINDOW_FALLBACK_HEIGHT: f64 = 720.0")
    expect(SHELL_LIB_RS).toContain(
      "StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED",
    )
    expect(SHELL_LIB_RS).toContain(
      ".with_filter(|label| label == SETTINGS_WINDOW_LABEL)",
    )
    expect(SHELL_LIB_RS).toContain(".min_inner_size(640.0, 480.0)")
    expect(SHELL_LIB_RS).toContain(".prevent_overflow()")
    expect(SHELL_LIB_RS).toContain(".visible(false)")
    expect(SHELL_LIB_RS).toContain("TitleBarStyle::Overlay")
    expect(SHELL_LIB_RS).toContain("DockVisibilityState")
    expect(SHELL_LIB_RS).toContain("get_dock_visibility")
    expect(SHELL_LIB_RS).toContain("set_dock_visibility")
    expect(SHELL_LIB_RS).toContain("applicationDockMenu:")
    expect(SHELL_LIB_RS).toContain("menu_id::SESSIONS")
    expect(SHELL_LIB_RS).toContain("open_sessions_window")
    expect(SHELL_LIB_RS).toContain("fn set_main_surface")
  })
})
