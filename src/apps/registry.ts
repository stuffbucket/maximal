import consola from "consola"

import type { ClientApp } from "./index"

import { claudeCodeApp } from "./claude-code"
import { claudeDesktopApp } from "./claude-desktop"
import { copilotCliApp } from "./copilot-cli"

const apps: Record<string, ClientApp> = {
  "claude-code": claudeCodeApp,
  "claude-desktop": claudeDesktopApp,
  "copilot-cli": copilotCliApp,
}

export function getAllApps(): Array<ClientApp> {
  return [apps["claude-code"], apps["claude-desktop"], apps["copilot-cli"]]
}

export function getApp(id: string): ClientApp | undefined {
  return apps[id]
}

/** Run every app's `onBoot` once the proxy is listening. Each hook is
 *  synchronous and best-effort; one app's failure never skips another's. */
export function runAppBootHooks(list: Array<ClientApp> = getAllApps()): void {
  for (const app of list) {
    try {
      app.onBoot?.()
    } catch (err) {
      consola.warn(`${app.id}: boot hook failed`, err)
    }
  }
}

/** Run every app's `onShutdown`. Synchronous so it also works from the
 *  process `exit` handler, where no async work can complete. */
export function runAppShutdownHooks(
  list: Array<ClientApp> = getAllApps(),
): void {
  for (const app of list) {
    try {
      app.onShutdown?.()
    } catch {
      // Best-effort: we may be inside an `exit` handler, which can't throw.
    }
  }
}
