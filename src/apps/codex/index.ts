import type { AppEntry } from "~/lib/config/settings-types"

import { ensureApiKey } from "~/lib/auth/api-key-helper"

import type { AppUninstallResult, ClientApp } from "../index"

import {
  CODEX_KEY_LABEL,
  CodexConfigConflictError,
  CodexOtherMaximalConfigError,
} from "./config"
import { detectCodexInstallations, type CodexInstallation } from "./detect"
import {
  applyCodexProvider,
  codexProviderConflict,
  getCodexConfigPath,
  isCodexProviderConfigured,
  revertCodexProvider,
} from "./provider"
import {
  reconcileCodexOnBoot,
  reconcileCodexOnShutdown,
  setCodexRoutingIntent,
} from "./reconcile"

const CODEX_INSTALL_COMMAND = "npm install -g @openai/codex"

export interface CreateCodexAppOptions {
  detectInstallations?: () => Array<CodexInstallation>
  filePath?: string
  execPath?: string
}

type ProviderOptions = NonNullable<Parameters<typeof applyCodexProvider>[0]>

function conflictMutation(error: unknown) {
  if (error instanceof CodexOtherMaximalConfigError) {
    return Promise.resolve({
      success: false,
      conflict: "other-maximal-config" as const,
    })
  }
  if (error instanceof CodexConfigConflictError) {
    return Promise.resolve({
      success: false,
      conflict: "cleanup-required" as const,
    })
  }
  throw error
}

function inspectProvider(
  options: ProviderOptions,
): Pick<AppEntry, "enabled" | "conflict"> {
  try {
    const conflict = codexProviderConflict(options)
    return {
      enabled: conflict === null && isCodexProviderConfigured(options),
      conflict,
    }
  } catch (error) {
    if (
      error instanceof CodexConfigConflictError
      || error instanceof CodexOtherMaximalConfigError
    ) {
      return { enabled: false, conflict: "cleanup-required" }
    }
    throw error
  }
}

function enableProvider(options: ProviderOptions) {
  try {
    const conflict = codexProviderConflict(options)
    if (conflict && !options.overrideOtherMaximal) {
      return Promise.resolve({ success: false, conflict })
    }
    ensureApiKey(CODEX_KEY_LABEL)
    applyCodexProvider(options)
  } catch (error) {
    return conflictMutation(error)
  }
  setCodexRoutingIntent(true)
  return Promise.resolve({ success: true, conflict: null })
}

function disableProvider(options: ProviderOptions) {
  let result: ReturnType<typeof revertCodexProvider>
  try {
    result = revertCodexProvider(options)
  } catch (error) {
    if (error instanceof CodexOtherMaximalConfigError) {
      setCodexRoutingIntent(false)
    }
    return conflictMutation(error)
  }
  setCodexRoutingIntent(false)
  const cleanupRequired = result.status === "cleanup-required"
  return Promise.resolve({
    success: !cleanupRequired,
    conflict: cleanupRequired ? ("cleanup-required" as const) : null,
  })
}

function uninstallProvider(
  options: ProviderOptions,
): Promise<AppUninstallResult> {
  try {
    const result = revertCodexProvider(options)
    return Promise.resolve({
      reverted:
        result.wrote && result.status !== "cleanup-required" ?
          [`reverted ${result.path}`]
        : [],
      conflict:
        result.status === "cleanup-required" ? "cleanup-required" : null,
    })
  } catch (error) {
    if (error instanceof CodexOtherMaximalConfigError) {
      return Promise.resolve({
        reverted: [],
        conflict: "other-maximal-config" as const,
      })
    }
    if (error instanceof CodexConfigConflictError) {
      return Promise.resolve({ reverted: [], conflict: "cleanup-required" })
    }
    throw error
  }
}

export function createCodexApp(options: CreateCodexAppOptions = {}): ClientApp {
  const detectInstallations =
    options.detectInstallations ?? detectCodexInstallations
  const providerOptions = () => ({
    filePath: options.filePath ?? getCodexConfigPath(),
    execPath: options.execPath ?? process.execPath,
  })

  return {
    id: "codex",
    name: "Codex CLI",
    kind: "config",
    apiKeyLabel: CODEX_KEY_LABEL,

    detect() {
      return Promise.resolve(detectInstallations().length > 0)
    },

    getDetails(conflict: AppEntry["conflict"] = null): Promise<AppEntry> {
      const installations = detectInstallations()
      const inspected = inspectProvider(providerOptions())
      return Promise.resolve({
        id: "codex",
        name: "Codex CLI",
        kind: "config",
        enabled: inspected.enabled,
        status: installations.length > 0 ? "ready" : "not-installed",
        installs: installations.map((installation) => ({
          kind: installation.kind,
          path: installation.path,
          version: installation.version,
          source: "unknown",
        })),
        install:
          installations.length === 0 ?
            { method: "npm", command: CODEX_INSTALL_COMMAND, automatic: null }
          : null,
        conflict: conflict ?? inspected.conflict,
      })
    },

    enable(options) {
      return enableProvider({ ...providerOptions(), ...options })
    },

    disable() {
      return disableProvider(providerOptions())
    },

    isEnabled() {
      return inspectProvider(providerOptions()).enabled
    },

    uninstall() {
      return uninstallProvider(providerOptions())
    },

    onBoot() {
      const provider = providerOptions()
      reconcileCodexOnBoot(undefined, provider.filePath, provider.execPath)
    },

    onShutdown() {
      reconcileCodexOnShutdown(undefined, providerOptions().filePath)
    },
  }
}

export const codexApp = createCodexApp()
