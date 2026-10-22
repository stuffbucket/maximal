import consola from "consola"

import {
  applyCodexProvider,
  getCodexConfigPath,
  revertCodexProvider,
} from "~/apps/codex/provider"
import { getConfig, writeConfig } from "~/lib/config/config"

export function codexRoutingIntended(): boolean {
  return getConfig().apps?.codex?.enabled === true
}

export function setCodexRoutingIntent(enabled: boolean): void {
  const config = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      codex: {
        ...config.apps?.codex,
        enabled,
      },
    },
  })
}

export function refreshCodexApiKeyHelper(
  intended: boolean = codexRoutingIntended(),
  filePath: string = getCodexConfigPath(),
  execPath: string = process.execPath,
): void {
  if (!intended) return
  try {
    const result = applyCodexProvider({ filePath, execPath })
    if (result.wrote) {
      consola.info("codex: refreshed API key helper metadata")
    }
  } catch (error) {
    consola.warn("codex: failed to refresh API key helper metadata", error)
  }
}

export function reconcileCodexOnBoot(
  intended: boolean = codexRoutingIntended(),
  filePath: string = getCodexConfigPath(),
  execPath: string = process.execPath,
): void {
  if (!intended) return
  try {
    const result = applyCodexProvider({ filePath, execPath })
    if (result.wrote) {
      consola.info(
        "codex: applied provider routing on boot" + " (routing intent is on)",
      )
    }
  } catch (error) {
    consola.warn("codex: failed to reconcile provider routing on boot", error)
  }
}

export function reconcileCodexOnShutdown(
  intended: boolean = codexRoutingIntended(),
  filePath: string = getCodexConfigPath(),
): void {
  if (!intended) return
  try {
    const result = revertCodexProvider({ filePath })
    if (result.status === "cleanup-required") {
      consola.warn(
        "codex: provider routing requires manual cleanup after shutdown",
        result.reasons,
      )
    } else if (result.wrote) {
      consola.info(
        "codex: removed provider routing for shutdown"
          + " (routing intent persists for next boot)",
      )
    }
  } catch (error) {
    consola.warn(
      "codex: failed to reconcile provider routing on shutdown",
      error,
    )
  }
}
