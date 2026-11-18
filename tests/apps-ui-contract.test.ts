import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { createMockBackend } from "../scripts/ui-harness-api"

const REPO_ROOT = resolve(import.meta.dir, "..")

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

describe("Apps shell contract", () => {
  test("routes Apps rows through typed toggle endpoints and override bodies", () => {
    const client = source("shell/src/proxy/client.ts")
    const hook = source("shell/src/ui/features/apps/useApps.ts")
    const panel = source("shell/src/ui/features/apps/AppsPanel.tsx")

    for (const appId of [
      "chatgpt",
      "claude-code",
      "claude-desktop",
      "codex",
      "copilot-cli",
      "pi",
    ]) {
      expect(client).toContain(`| "${appId}"`)
    }
    expect(client).toContain('kind: "codex-toggle"')
    expect(client).toContain('path: "/settings/api/apps/codex/toggle"')
    expect(client).toContain('"codex-toggle": AppEntry')
    expect(hook).toContain("options?: ToggleAppOptions")
    expect(hook).toContain("overrideOtherMaximal?: boolean")
    expect(hook).toContain("overrideOtherMaximal: true")
    expect(hook).toContain('kind: "app-toggle"')
    expect(hook).toContain("path: `/settings/api/apps/${appId}/toggle`")
    expect(hook).toContain('?.kind !== "config"')
    expect(hook).toContain("adoptExisting?: boolean")
    expect(hook).toContain("configDirectory?: string")
    expect(hook).not.toContain('path: "/settings/api/apps/chatgpt/toggle"')
    expect(hook).not.toContain('path: "/settings/api/apps/pi/toggle"')
    expect(hook).not.toContain('path: "/settings/api/apps/copilot-cli/toggle"')
    expect(hook).toContain('window.addEventListener("focus", onAttention)')
    expect(hook).toContain("generation !== refreshGeneration.current")
    expect(panel).toContain("toggleApp(app.id, enabled, options)")
  })

  test("uses a semantic Harnesses table with switch-or-Connect actions", () => {
    const row = source("shell/src/ui/features/apps/HarnessRow.tsx")
    const panel = source("shell/src/ui/features/apps/AppsPanel.tsx")
    const glyphs = source("shell/src/ui/features/apps/glyphs.tsx")
    const shell = source("shell/src/tauri/shell.ts")

    expect(panel).toContain('<table className="table harnesses__table">')
    expect(panel).toContain('t("apps-col-harness")')
    expect(panel).toContain('t("apps-col-type")')
    expect(panel).toContain('t("apps-col-status")')
    expect(row).toContain("import { Switch }")
    expect(row).toContain('t("apps-connect")')
    expect(row).toContain("<HarnessTypeIcon appId={app.id} />")
    expect(row).toContain('"Claude Desktop (Cowork, Code)"')
    expect(glyphs).toContain("function TerminalGlyph")
    expect(glyphs).toContain("function WindowGlyph")
    expect(row).not.toContain("Checkbox")
    expect(row).not.toContain("InstallOffer")
    expect(row).toContain('install.kind === "desktop"')
    expect(row).toContain("void revealPath(preferredInstall.path)")
    expect(shell).toContain("{ paths: [path] }")
  })

  test("packages every harness icon with the Settings UI", () => {
    const build = source("scripts/build-ui.ts")
    expect(build).toContain(
      'cp(SETTINGS_ICONS, join(SETTINGS_OUT, "icons"), { recursive: true })',
    )

    for (const appId of [
      "chatgpt",
      "claude-code",
      "claude-desktop",
      "codex",
      "copilot-cli",
      "pi",
    ]) {
      expect(source(`shell/src/ui/features/apps/icons/${appId}.svg`)).toMatch(
        /<svg(?:\s|>)/,
      )
    }
  })

  test("opens Connect resolutions without bypassing ownership", () => {
    const row = source("shell/src/ui/features/apps/HarnessRow.tsx")

    expect(row).toContain("setConnectOpen(true)")
    expect(row).toContain("await openOfficialInstructions(app)")
    expect(row).toContain('app.conflict === "other-maximal-config"')
    expect(row).toContain("overrideOtherMaximal: true")
    expect(row).toContain('t("apps-override-body"')
    expect(row).toContain("hasConflict && !canConfigure ? null")
    expect(row).toContain('app.conflict === "existing-provider"')
    expect(row).toContain("adoptExisting: true")
    expect(row).toContain("sameDirectory")
  })

  test("provides inspectable Codex harness states and toggle behavior", async () => {
    const fixtures = source("scripts/ui-harness-fixtures.ts")

    expect(fixtures).toContain('id: "codex"')
    expect(fixtures).toContain('kind: "cli"')
    expect(fixtures).toContain('kind: "desktop"')
    expect(fixtures).toContain('"codex-missing"')
    expect(fixtures).toContain('"codex-cleanup-required"')
    expect(fixtures).toContain('conflict: "cleanup-required"')

    const backend = createMockBackend("codex-cleanup-required")
    const res = await backend.handle(
      new Request("http://harness/settings/api/apps/codex/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      }),
    )
    expect(
      (await res?.json()) as { id: string; enabled: boolean },
    ).toMatchObject({
      id: "codex",
      enabled: false,
    })
  })

  test("models not-found and other-profile conflict behavior", async () => {
    const fixtures = source("scripts/ui-harness-fixtures.ts")
    expect(fixtures).toContain('"apps-not-found"')
    expect(fixtures).toContain('"apps-other-maximal"')
    expect(fixtures).toContain('conflict: "other-maximal-config"')

    const missing = createMockBackend("apps-not-found")
    const missingResponse = await missing.handle(
      new Request("http://harness/settings/api/apps/claude-code/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      }),
    )
    expect(missingResponse?.status).toBe(409)
    const missingBody = (await missingResponse?.json()) as {
      error: { message: string }
    }
    expect(missingBody.error.message).toContain("Install it first")

    const otherProfile = createMockBackend("apps-other-maximal")
    const refused = await otherProfile.handle(
      new Request("http://harness/settings/api/apps/claude-code/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      }),
    )
    expect(await refused?.json()).toMatchObject({
      enabled: false,
      conflict: "other-maximal-config",
    })

    const overridden = await otherProfile.handle(
      new Request("http://harness/settings/api/apps/claude-code/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: true, overrideOtherMaximal: true }),
      }),
    )
    expect(await overridden?.json()).toMatchObject({
      enabled: true,
      conflict: null,
    })

    const foreign = createMockBackend("apps-conflict")
    const protectedResponse = await foreign.handle(
      new Request("http://harness/settings/api/apps/claude-code/toggle", {
        method: "POST",
        body: JSON.stringify({ enabled: true, overrideOtherMaximal: true }),
      }),
    )
    expect(await protectedResponse?.json()).toMatchObject({
      enabled: false,
      conflict: "foreign-base-url",
    })
  })
})

describe("Claude Desktop restart dialog", () => {
  const FULL_LOCALES = ["en", "es", "zh", "fr", "de", "ru", "ja", "it", "pt"]
  const KEYS = [
    "apps-desktop-restart-title",
    "apps-desktop-relaunch",
    "apps-desktop-signin-note",
    "apps-desktop-restart-ok",
  ]

  test("opens after an applied change only, as an informational dialog", () => {
    const row = source("shell/src/ui/features/apps/HarnessRow.tsx")
    const hook = source("shell/src/ui/features/apps/useApps.ts")

    // Gated on the app, on request success, and on the server having applied
    // the requested state (a refused enable comes back ok with a conflict).
    expect(row).toContain(
      "desktopRestartChange(app.id, next, await onToggle(next))",
    )
    // Connecting over another Maximal profile's setting is an enable too.
    expect(row).toContain(
      "setRestartNotice(desktopRestartChange(app.id, true, result))",
    )
    expect(row).toContain("<DesktopRestartDialog")
    // Not an inline banner, and not a confirm/cancel prompt.
    expect(
      source("shell/src/ui/features/apps/DesktopRestartDialog.tsx"),
    ).not.toContain("<Callout")
    expect(row).not.toContain("relaunchNoticeShown")
    const dialog = source("shell/src/ui/features/apps/DesktopRestartDialog.tsx")
    expect(dialog).toContain("<NoticeDialog")
    expect(dialog).not.toContain("ConfirmDialog")
    expect(hook).toContain("applied: toggleApplied(result.data, enabled)")
    // The failure branch returns before `applied` is ever set.
    expect(hook).toContain("return { ok: false, error: message }")
  })

  test("leaves the Claude Code Windows restart dialog as it was", () => {
    const row = source("shell/src/ui/features/apps/HarnessRow.tsx")

    expect(row).toContain(
      'const needsWindowsRestartWarning = app.id === "claude-code" && isWindows()',
    )
    expect(row).toContain("if (!next && needsWindowsRestartWarning)")
    expect(row).toContain('title={t("apps-restart-title")}')
    expect(row).toContain('t("apps-restart-windows-body")')
    expect(row).toContain('t("apps-restart-after-disable"')
    expect(row).toContain("await onToggle(false)")
    // The confirm path calls onToggle directly, never the guidance wrapper.
    expect(row).not.toContain("await applyToggle(false)")
  })

  test("its strings are in every full catalog", () => {
    const base = JSON.parse(source("shell/src/i18n/en.json")) as Record<
      string,
      string
    >
    expect(base["apps-desktop-restart-title"]).toBe("Restart Claude Desktop")
    expect(base["apps-desktop-relaunch"]).toBe(
      "Quit and reopen Claude Desktop for this change to take effect.",
    )
    expect(base["apps-desktop-signin-note"]).toBe(
      "If Claude Desktop asks you to sign in and sign-in doesn’t complete, leave the integration enabled, quit Claude Desktop completely, reopen it, and try again.",
    )
    expect(base["apps-desktop-restart-ok"]).toBe("Got it")
    for (const locale of FULL_LOCALES) {
      const catalog = JSON.parse(
        source(`shell/src/i18n/${locale}.json`),
      ) as Record<string, string>
      for (const key of KEYS)
        expect(catalog[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
