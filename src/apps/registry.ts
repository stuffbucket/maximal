import consola from "consola"

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

export interface AppShutdownHooksResult {
  attempted: Array<ClientApp["id"]>
  completed: Array<ClientApp["id"]>
  failed: Array<{ appId: ClientApp["id"]; error: unknown }>
}

/** Run every app's `onShutdown`. Synchronous so it also works from the
 *  process `exit` handler, where no async work can complete. Failures remain
 *  best-effort, but are returned and logged rather than disappearing. */
export function runAppShutdownHooks(
  list: Array<ClientApp> = getAllApps(),
): AppShutdownHooksResult {
  const result: AppShutdownHooksResult = {
    attempted: [],
    completed: [],
    failed: [],
  }

  for (const app of list) {
    if (!app.onShutdown) continue
    result.attempted.push(app.id)
    try {
      app.onShutdown()
      result.completed.push(app.id)
    } catch (error) {
      result.failed.push({ appId: app.id, error })
      consola.warn(`${app.id}: shutdown hook failed`, error)
    }
  }

  return result
}
