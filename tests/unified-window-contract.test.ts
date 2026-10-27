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

describe("unified Settings + Dashboard window & Appearance contract", () => {
  test("replaces left sidebar with a single topbar containing consolidated tabs and right-side mode icon button", () => {
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

    expect(SETTINGS_HTML).toContain("data-surface-mode-btn")
    expect(SETTINGS_HTML).toContain('data-mode-icon="dashboard"')
    expect(SETTINGS_HTML).toContain('data-mode-icon="settings"')
    expect(SETTINGS_HTML).toContain("data-dashboard-frame")
    expect(SETTINGS_HTML).toContain("data-dashboard-controls")
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

  test("configures Tauri window chrome, minimum size, default Dock visibility, and macOS Dock context menu", () => {
    expect(SHELL_LIB_RS).toContain(".min_inner_size(640.0, 480.0)")
    expect(SHELL_LIB_RS).toContain(".prevent_overflow()")
    expect(SHELL_LIB_RS).toContain("TitleBarStyle::Overlay")
    expect(SHELL_LIB_RS).toContain("DockVisibilityState")
    expect(SHELL_LIB_RS).toContain("get_dock_visibility")
    expect(SHELL_LIB_RS).toContain("set_dock_visibility")
    expect(SHELL_LIB_RS).toContain("applicationDockMenu:")
  })
})
