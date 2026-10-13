import type { ClientApp } from "./index"

import { claudeCodeApp } from "./claude-code"
import { claudeDesktopApp } from "./claude-desktop"
import { codexApp } from "./codex"
import { copilotCliApp } from "./copilot-cli"

const apps: Record<string, ClientApp> = {
  "claude-code": claudeCodeApp,
  "claude-desktop": claudeDesktopApp,
  codex: codexApp,
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
