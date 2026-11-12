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
const SIDECAR_RUNTIME_RS = readFileSync(
  resolve(REPO_ROOT, "shell/src-tauri/src/sidecar_runtime.rs"),
  "utf8",
)
const SHELL_CARGO_TOML = readFileSync(
  resolve(REPO_ROOT, "shell/src-tauri/Cargo.toml"),
  "utf8",
)
const WINDOWS_JUMP_LIST_RS = readFileSync(
  resolve(REPO_ROOT, "shell/src-tauri/src/windows_jump_list.rs"),
  "utf8",
)
const SETTINGS_STYLES = readFileSync(
  resolve(REPO_ROOT, "shell/src/ui/styles/styles.css"),
  "utf8",
)
const DASHBOARD_STYLES = readFileSync(
  resolve(REPO_ROOT, "shell/ui/dashboard/style.css"),
  "utf8",
)

describe("unified Settings, Dashboard, Sessions, Budget & Appearance contract", () => {
  test("uses a single topbar with Settings tabs and a four-surface switcher", () => {
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
    for (const surface of ["settings", "dashboard", "sessions", "budget"]) {
      expect(SETTINGS_HTML).toContain(`data-surface-target="${surface}"`)
    }
    expect(SETTINGS_HTML).toContain("data-dashboard-frame")
    expect(SETTINGS_HTML).toContain("data-dashboard-controls")
    expect(SETTINGS_MAIN_TS).toContain('sessions: ["dashboard"]')
    expect(SETTINGS_MAIN_TS).toContain('budget: ["budget"]')
    expect(SETTINGS_HTML).toContain('data-section="budget"')
    expect(SETTINGS_HTML).toContain('id="budget-root"')
    expect(SETTINGS_MAIN_TS).toContain('type: "maximal:surface"')
    expect(SETTINGS_MAIN_TS).toContain('safeInvoke("set_main_surface"')
  })

  test("keeps endpoint and API keys at the bottom of Integrations", () => {
    expect(SETTINGS_MAIN_TS).toContain(
      'integrations: ["apps", "connectors", "endpoint", "api-clients"]',
    )
    expect(SETTINGS_MAIN_TS).toContain('"models-keys": ["models"]')
    const connectors = SETTINGS_HTML.indexOf('data-section="connectors"')
    const endpoint = SETTINGS_HTML.indexOf('data-section="endpoint"')
    const apiClients = SETTINGS_HTML.indexOf('data-section="api-clients"')
    const models = SETTINGS_HTML.indexOf('data-section="models"')
    expect(SETTINGS_HTML.indexOf('data-section="apps"')).toBeLessThan(
      connectors,
    )
    expect(connectors).toBeLessThan(endpoint)
    expect(endpoint).toBeLessThan(apiClients)
    expect(apiClients).toBeLessThan(models)
  })

  test("keeps Appearance for close-to-background platforms and removes its dead Windows mode", () => {
    expect(SETTINGS_HTML).toContain('data-section="appearance"')
    expect(SETTINGS_HTML).toContain("data-dock-visibility-toggle")
    expect(SETTINGS_HTML).toContain('data-i18n="appearance-dock-label"')
    expect(SETTINGS_HTML).toContain('data-i18n="appearance-dock-sub"')
    expect(SETTINGS_MAIN_TS).toContain(
      'osKind() === "windows" && id === "appearance" ? "system" : id',
    )
    expect(SETTINGS_MAIN_TS).toContain(
      "if (appearanceNav) appearanceNav.hidden = true",
    )
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
    expect(SHELL_LIB_RS).toContain("SETTINGS_SURFACE_MIN_WIDTH: f64 = 772.0")
    expect(SHELL_LIB_RS).toContain("SETTINGS_SURFACE_MAX_WIDTH: f64 = 1100.0")
    expect(SHELL_LIB_RS).not.toContain("MAIN_WINDOW_MAX_WIDTH")
    expect(SHELL_LIB_RS).not.toContain("MAIN_WINDOW_MAX_HEIGHT")
    expect(SHELL_LIB_RS).toContain("mod main_surface")
    expect(SHELL_LIB_RS).toContain("fn main_window_constraints(surface: &str)")
    expect(SHELL_LIB_RS).toContain(
      "max_width: (surface == main_surface::SETTINGS)",
    )
    expect(SHELL_LIB_RS).toContain("max_height: None")
    expect(SHELL_LIB_RS).toContain(
      "StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED",
    )
    expect(SHELL_LIB_RS).toContain(
      ".with_filter(|label| label == SETTINGS_WINDOW_LABEL)",
    )
    expect(SHELL_LIB_RS).toContain(".skip_initial_state(SETTINGS_WINDOW_LABEL)")
    expect(SHELL_LIB_RS).toContain("fn restore_main_window(")
    expect(SHELL_LIB_RS).toContain("tauri::async_runtime::spawn_blocking")
    expect(SHELL_LIB_RS).toContain(
      "window_after_barrier.restore_state(main_window_state_flags())",
    )
    expect(SHELL_LIB_RS).toContain(
      ".min_inner_size(main_window_min_width(surface), MAIN_WINDOW_MIN_HEIGHT)",
    )
    expect(SHELL_LIB_RS).toContain(".prevent_overflow_with_margin(")
    expect(SHELL_LIB_RS).toContain(".center()")
    expect(SHELL_LIB_RS).toContain(
      "normalize_restored_main_window_geometry(&window_after_barrier)",
    )
    expect(SHELL_LIB_RS).toContain(
      "apply_main_surface_constraints(&window_for_present, &surface)",
    )
    expect(SHELL_LIB_RS).toContain(".visible(false)")
    expect(SHELL_LIB_RS).toContain("TitleBarStyle::Overlay")
    expect(SHELL_LIB_RS).toContain("DockVisibilityState")
    expect(SHELL_LIB_RS).toContain("get_dock_visibility")
    expect(SHELL_LIB_RS).toContain("set_dock_visibility")
    expect(SHELL_LIB_RS).toContain("applicationDockMenu:")
    expect(SHELL_LIB_RS).toContain(
      '.icon_as_template(cfg!(target_os = "macos"))',
    )
    expect(SHELL_LIB_RS).toContain("install_windows_jump_list")
    expect(SHELL_LIB_RS).toContain("tauri::async_runtime::spawn(async move {")
    expect(SHELL_LIB_RS).toContain("app.run_on_main_thread(move ||")
    expect(SHELL_LIB_RS).toContain("CloseWindowAction::ConfirmQuit")
    expect(SHELL_LIB_RS).toContain(
      "CloseWindowAction::ConfirmQuit => request_quit(&app_clone)",
    )
    expect(SHELL_LIB_RS).not.toContain(
      "CloseWindowAction::ConfirmQuit => exit_gracefully",
    )
    expect(SHELL_LIB_RS).toContain("ensure_windows_taskbar_window(&ready_app)")
    expect(SHELL_LIB_RS).toContain("SW_SHOWMINNOACTIVE")
    expect(SIDECAR_RUNTIME_RS).toContain("request_sidecar_shutdown(app).await")
    expect(SIDECAR_RUNTIME_RS).toContain('http_url("/_internal/shutdown")')
    expect(SHELL_CARGO_TOML).toContain('windows = { version = "0.62"')
    expect(SHELL_CARGO_TOML).toContain('"Win32_UI_WindowsAndMessaging"')
    expect(WINDOWS_JUMP_LIST_RS).toContain("ICustomDestinationList")
    expect(WINDOWS_JUMP_LIST_RS).toContain("AddUserTasks")
    expect(SHELL_LIB_RS).toContain("menu_id::SESSIONS")
    expect(SHELL_LIB_RS).toContain("open_sessions_window")
    expect(SHELL_LIB_RS).toContain("menu_id::BUDGET")
    expect(SHELL_LIB_RS).toContain("open_budget_window")
    expect(SHELL_LIB_RS).toContain("ShellAction::Budget")
    expect(SHELL_LIB_RS).toContain("fn save_text_file")
    expect(SHELL_LIB_RS).toContain("fn set_main_surface")
    expect(SHELL_LIB_RS).toContain(
      "apply_main_surface_constraints(&window, normalized)",
    )
  })

  test("keeps bounded content responsive inside each native surface policy", () => {
    expect(SETTINGS_STYLES).toContain("align-items: center")
    expect(SETTINGS_STYLES).toContain("align-items: stretch")
    expect(SETTINGS_STYLES).toContain("flex-wrap: nowrap")
    expect(SETTINGS_STYLES).toContain("overflow-x: auto")
    expect(SETTINGS_STYLES).toContain("flex: 1 1 0")
    expect(SETTINGS_STYLES).toContain("padding-inline-end: var(--space-4)")
    expect(SETTINGS_MAIN_TS).toContain(
      'scrollIntoView({ block: "nearest", inline: "nearest" })',
    )
    expect(DASHBOARD_STYLES).toContain("width: 100%")
    expect(DASHBOARD_STYLES).toContain("max-width: 1120px")
    expect(DASHBOARD_STYLES).toContain("margin-inline: auto")
    expect(DASHBOARD_STYLES).toContain("@media (max-width: 50em)")
  })
})
