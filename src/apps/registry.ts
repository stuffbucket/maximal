import type { ClientApp } from "./index"

import { claudeCodeApp } from "./claude-code"
import { claudeDesktopApp } from "./claude-desktop"
import { codexApp, codexDesktopApp } from "./codex"
import { copilotCliApp } from "./copilot-cli"

const apps: Record<string, ClientApp> = {
  "claude-code": claudeCodeApp,
  "claude-desktop": claudeDesktopApp,
  codex: codexApp,
  "codex-desktop": codexDesktopApp,
  "copilot-cli": copilotCliApp,
}

export function getAllApps(): Array<ClientApp> {
  return [
    apps["claude-code"],
    apps["claude-desktop"],
    apps.codex,
    apps["copilot-cli"],
  ]
}

export function getApp(id: string): ClientApp | undefined {
  return apps[id]
}
