import consola from "consola"
import os from "node:os"
import path from "node:path"

import type { ClientApp, ClientAppEnableOptions } from "~/apps"
import type { AppEntry } from "~/lib/config/settings-types"
import type { Model } from "~/services/copilot/get-models"

import { currentProfileId } from "~/apps/profile-identity"
import {
  echoApiKeyHelperCommand,
  ensureApiKey,
  resolveApiKey,
} from "~/lib/auth/api-key-helper"
import { resolveBudgetDisplay } from "~/lib/budget/units"
import { getConfig, writeConfig } from "~/lib/config/config"
import { PATHS } from "~/lib/platform/paths"
import {
  setModels,
  state,
  subscribeModelCatalogChanged,
} from "~/lib/runtime-state/state"
import { proxyBaseUrl } from "~/lib/start/proxy-port"

import { fetchPiCatalog } from "./catalog"
import { detectPiInstallations, type PiInstallation } from "./detect"
import { projectPiModels } from "./models"
import {
  applyPiProvider,
  inspectPiProvider,
  PiOwnershipError,
  revertPiProvider,
  type PiConflict,
  type PiTarget,
} from "./ownership"

interface PiAppOptions {
  filePath?: string
  journalPath?: string
  profileId?: string
  detectInstallations?: () => Array<PiInstallation>
  loadCatalog?: () => Promise<ReadonlyArray<Model>>
}
interface Mutation {
  success: boolean
  conflict: PiConflict | null
}

function directoryFor(explicit?: string): string {
  const directory =
    explicit
    ?? getConfig().apps?.pi?.configDirectory
    ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(os.homedir(), ".pi", "agent")
  if (!path.isAbsolute(directory))
    throw new Error("Pi's configuration directory must be an absolute path")
  return path.resolve(directory)
}

function persistIntent(enabled: boolean, directory?: string): void {
  const config = getConfig()
  writeConfig({
    ...config,
    apps: {
      ...config.apps,
      pi: {
        ...config.apps?.pi,
        enabled,
        ...(directory ? { configDirectory: directory } : {}),
      },
    },
  })
}

function intended(): boolean {
  return getConfig().apps?.pi?.enabled === true
}

function allowed(
  conflict: PiConflict | null,
  options: ClientAppEnableOptions,
): boolean {
  if (conflict === null) return true
  if (conflict === "existing-provider") return options.adoptExisting === true
  if (conflict === "other-maximal-config")
    return options.overrideOtherMaximal === true
  return false
}

function credentials(provision = false): string {
  const key = provision ? ensureApiKey("pi") : resolveApiKey("pi")
  if (!key.ok) throw new Error(key.error)
  return `!${echoApiKeyHelperCommand(key.key)}`
}

function projection(models: ReadonlyArray<Model>) {
  const baseUrl = `${proxyBaseUrl()}/v1`
  const definitions = projectPiModels(
    models,
    baseUrl,
    resolveBudgetDisplay(getConfig().budget).creditUsd,
  )
  if (definitions.length === 0)
    throw new Error(
      "The Copilot model catalog is not ready. Sign in or refresh models, then enable Pi again.",
    )
  return { name: "Maximal", baseUrl, models: definitions }
}

class PiIntegration {
  readonly options: PiAppOptions
  private unsubscribe: (() => void) | null = null
  private queue = Promise.resolve()
  private lastError = ""

  constructor(options: PiAppOptions) {
    this.options = options
  }

  target(directory?: string): PiTarget {
    return {
      filePath:
        this.options.filePath
        ?? path.join(directoryFor(directory), "models.json"),
      journalPath:
        this.options.journalPath ?? path.join(PATHS.APP_DIR, "pi-routing.json"),
      profileId: this.options.profileId ?? currentProfileId(),
    }
  }

  installations(): Array<PiInstallation> {
    return (this.options.detectInstallations ?? detectPiInstallations)()
  }

  private operate(work: () => Mutation | Promise<Mutation>): Promise<Mutation> {
    const next = this.queue.then(work).catch((error: unknown) => {
      if (error instanceof PiOwnershipError)
        return { success: false, conflict: error.conflict }
      throw error
    })
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private subscribe(): void {
    this.unsubscribe ??= subscribeModelCatalogChanged(() => this.reconcile())
  }
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  details(
    conflict: AppEntry["conflict"] = null,
    options?: ClientAppEnableOptions,
  ): AppEntry {
    const installations = this.installations()
    const destination = this.target(options?.configDirectory)
    const inspected = inspectPiProvider(destination)
    return {
      id: "pi",
      name: "Pi",
      kind: "config",
      ...inspected,
      conflict: conflict ?? inspected.conflict,
      status:
        installations.length > 0 || inspected.enabled ?
          "ready"
        : "not-installed",
      installs: installations.map((installation) => ({
        ...installation,
        kind: "cli",
        source: "unknown",
      })),
      install:
        installations.length > 0 ?
          null
        : {
            method: "npm",
            command: "npm install -g @earendil-works/pi-coding-agent",
            automatic: null,
          },
      config_directory: path.dirname(destination.filePath),
    }
  }

  private async provision(options: ClientAppEnableOptions): Promise<Mutation> {
    const destination = this.target(options.configDirectory)
    if (
      destination.filePath !== this.target().filePath
      && inspectPiProvider(this.target()).enabled
    ) {
      throw new Error(
        "Disable the current Pi integration before choosing another directory",
      )
    }
    const inspection = inspectPiProvider(destination)
    if (!allowed(inspection.conflict, options))
      return { success: false, conflict: inspection.conflict }
    const catalog =
      this.options.loadCatalog ?
        await this.options.loadCatalog()
      : (state.models?.data ?? [])
    const provider = projection(catalog)
    applyPiProvider(
      destination,
      { ...provider, apiKey: credentials(true) },
      { ...options, claim: true },
    )
    try {
      persistIntent(true, path.dirname(destination.filePath))
    } catch (error) {
      if (!inspection.enabled) revertPiProvider(destination)
      throw error
    }
    this.subscribe()
    return { success: true, conflict: null }
  }

  enable(options: ClientAppEnableOptions = {}): Promise<Mutation> {
    return this.operate(() => this.provision(options))
  }

  disable(): Promise<Mutation> {
    return this.operate(() => {
      persistIntent(false)
      this.stop()
      revertPiProvider(this.target())
      return { success: true, conflict: null }
    })
  }

  reconcile(): void {
    if (!intended() || !state.models?.data.length) return
    try {
      applyPiProvider(this.target(), {
        ...projection(state.models.data),
        apiKey: credentials(),
      })
      this.lastError = ""
    } catch (error) {
      if (
        error instanceof PiOwnershipError
        && error.conflict === "other-maximal-config"
      )
        persistIntent(false)
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastError)
        consola.warn("pi: automatic synchronization stopped", message)
      this.lastError = message
    }
  }

  boot(): void {
    this.subscribe()
    this.reconcile()
  }

  refreshCredentials(): void {
    if (!intended()) return
    try {
      applyPiProvider(this.target(), { apiKey: credentials() })
    } catch (error) {
      consola.warn("pi: credentials left unchanged", error)
    }
  }
}

const cli: NonNullable<ClientApp["cli"]> = {
  extraArgs: {
    "config-dir": {
      type: "string",
      description: "Absolute Pi agent directory to configure.",
    },
    "adopt-existing": {
      type: "boolean",
      description:
        "Adopt the existing Maximal provider, preserving it for disable.",
    },
    "override-other-maximal": {
      type: "boolean",
      description:
        "Transfer an unchanged provider from another Maximal profile.",
    },
    "account-type": {
      type: "string",
      description: "Copilot account type when fetching an uncached catalog.",
    },
  },
  enableOptions: (args) => ({
    configDirectory:
      typeof args["config-dir"] === "string" ? args["config-dir"] : undefined,
    adoptExisting: args["adopt-existing"] === true,
    overrideOtherMaximal: args["override-other-maximal"] === true,
    accountType:
      typeof args["account-type"] === "string" ?
        args["account-type"]
      : undefined,
  }),
}

/** Pi's standard custom-provider configuration, managed only after explicit enable. */
export function createPiApp(
  options: PiAppOptions = {},
): ClientApp & { refreshCredentials(): void } {
  const integration = new PiIntegration(options)
  return {
    id: "pi",
    name: "Pi",
    kind: "config",
    apiKeyLabel: "pi",
    cli: {
      ...cli,
      async handle(op, args) {
        if (op === "enable" && !state.models?.data.length) {
          const enableOptions = (await cli.enableOptions?.(args)) ?? {}
          const inspected = inspectPiProvider(
            integration.target(enableOptions.configDirectory),
          )
          if (allowed(inspected.conflict, enableOptions))
            setModels(
              await fetchPiCatalog(
                enableOptions.accountType ?? state.accountType,
              ),
            )
        }
        return false
      },
    },
    detect: () => Promise.resolve(integration.installations().length > 0),
    getDetails: (conflict, enableOptions) =>
      Promise.resolve(integration.details(conflict, enableOptions)),
    enable: (enableOptions) => integration.enable(enableOptions),
    disable: () => integration.disable(),
    isEnabled: () => inspectPiProvider(integration.target()).enabled,
    async uninstall() {
      const wasEnabled = inspectPiProvider(integration.target()).enabled
      const result = await integration.disable()
      return {
        reverted:
          result.success && wasEnabled ?
            [`reverted ${integration.target().filePath}`]
          : [],
        conflict: result.conflict,
      }
    },
    onBoot: () => integration.boot(),
    // Keep cached models across proxy restarts. Explicit disable/uninstall alone removes the provider.
    onShutdown: () => integration.stop(),
    refreshCredentials: () => integration.refreshCredentials(),
  }
}

export const piApp = createPiApp()

/** Refresh a managed helper after an explicit API-key registry change; never mint a replacement key. */
export function refreshPiApiKeyHelper(): void {
  piApp.refreshCredentials()
}
