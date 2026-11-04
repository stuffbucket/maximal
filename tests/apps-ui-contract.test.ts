import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { createMockBackend } from "../scripts/ui-harness-api"

const REPO_ROOT = resolve(import.meta.dir, "..")

function source(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8")
}

describe("Apps shell contract", () => {
  test("routes the combined Codex card through its typed toggle endpoint", () => {
    const client = source("shell/src/proxy/client.ts")
    const hook = source("shell/src/ui/features/apps/useApps.ts")
    const panel = source("shell/src/ui/features/apps/AppsPanel.tsx")

    expect(client).toContain(
      'export type AppId = "claude-code" | "claude-desktop" | "codex" | "copilot-cli"',
    )
    expect(client).toContain('kind: "codex-toggle"')
    expect(client).toContain('path: "/settings/api/apps/codex/toggle"')
    expect(client).toContain('"codex-toggle": AppEntry')
    expect(hook).toContain("toggleApp: (appId: AppId, enabled: boolean)")
    expect(hook).toContain('kind: "codex-toggle"')
    expect(hook).toContain('path: "/settings/api/apps/codex/toggle"')
    expect(panel).toContain("toggleApp(app.id, enabled)")
  })

  test("renders every Codex surface and an actionable cleanup state", () => {
    const card = source("shell/src/ui/features/apps/AppCard.tsx")

    expect(card).toContain("app.installs.map")
    expect(card).toContain("install.kind")
    expect(card).toContain('case "cleanup-required"')
    expect(card).toContain('t("apps-install-kind-cli")')
    expect(card).toContain('t("apps-install-kind-desktop")')
    expect(card).toContain('t("apps-conflict-cleanup-detail"')
    expect(card).toContain('<ul className="app-card__guidance">')
    expect(card).toContain('t("apps-codex-shared-setting")')
    expect(card).toContain('t("apps-codex-restart-session")')
    expect(card).toContain('t("apps-codex-settings-unchanged")')
    expect(card).toContain('t("apps-codex-settings-precedence")')
    expect(card).not.toContain('t("apps-codex-routing-summary")')
    expect(card).not.toContain('t("apps-codex-settings-preserved")')
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
      enabled: true,
    })
  })
})

describe("Claude Code install offer (Windows WinGet)", () => {
  test("starts only from the card's button and confirm, and shows progress and failures", () => {
    const offer = source("shell/src/ui/features/apps/InstallOffer.tsx")
    const hook = source("shell/src/ui/features/apps/useClaudeCodeInstall.ts")
    const card = source("shell/src/ui/features/apps/AppCard.tsx")
    const client = source("shell/src/proxy/client.ts")

    expect(card).toContain("<InstallOffer")
    expect(card).not.toContain("copyInstall")
    expect(offer).toContain('install.automatic === "winget"')
    expect(offer).toContain("setConfirmOpen(true)")
    expect(offer).toContain("<ConfirmDialog")
    expect(offer).toContain('role="status"')
    expect(offer).toContain('t("apps-install-failed-title")')
    expect(hook).toContain('path: "/settings/api/apps/claude-code/install"')
    expect(hook).toContain('body: { method: "winget" }')
    expect(hook).toContain("requestSequence")
    expect(hook).toContain("humanize(result.error)")
    expect(hook).toContain("window.setTimeout(() => void poll(), POLL_MS)")
    expect(hook).not.toContain("setInterval")
    expect(offer).toContain("automatic && !running && !succeeded")
    expect(offer).toContain('<div className="app-card__conflict-text">')
    expect(offer).not.toContain('<span className="app-card__conflict-text">')
    expect(client).toContain('kind: "claude-code-install-start"')
    expect(client).toContain('kind: "claude-code-install-status"')
    expect(client).toContain(
      "export type { AuthStatus, ClaudeCodeInstallStatus, UpstreamRejection }",
    )
    expect(client).not.toContain("interface ClaudeCodeInstallStatus")
  })

  test("every install string the offer renders exists in the English base catalog", () => {
    const offer = source("shell/src/ui/features/apps/InstallOffer.tsx")
    const base = JSON.parse(source("shell/src/i18n/en.json")) as Record<
      string,
      string
    >
    const used = new Set(
      [...offer.matchAll(/t\("(apps-install-[a-z-]+)"/gu)].map((m) => m[1]),
    )
    expect(used.size).toBeGreaterThan(8)
    const missing = [...used].filter((key) => !(key in base))
    expect(missing).toEqual([])
  })
})
