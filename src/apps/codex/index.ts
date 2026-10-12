import type {
  AppEntry,
  AppInstall,
  AppInstallHint,
} from "~/lib/config/settings-types"

import { state } from "~/lib/runtime-state/state"

import type { ClientApp } from "../index"

import { COPILOT_REVIEW_MODEL } from "./catalog-runtime"
import {
  codexConfigPath,
  chooseProviderId,
  configuredModel,
  hasCodexRouting,
  hasUnmanagedProvider,
  isCodexEnabled,
  prepareCodexConfig,
  readCodexConfig,
  revertCodexConfig,
  writeCodexConfig,
} from "./config"
import { detectCodexDesktop } from "./desktop-detect"
import { detectCodex } from "./detect"
import {
  codexProvider,
  readCodexGatewayModels,
  verifyCodexProvider,
} from "./provider"
import {
  prepareReviewCatalog,
  reviewCatalogIsCurrent,
  withoutReviewCatalog,
  writeReviewCatalog,
} from "./review-catalog"

const routingLock = new Set<string>()
const EXISTING_SETUP_NOTICE =
  "Your existing Codex setup already routes through Maximal. Configure uses separate managed settings; Disconnect restores your existing setup."

async function mutateRouting<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  if (routingLock.has("codex"))
    throw new Error(
      "Codex routing is already being changed. Wait for it to finish.",
    )
  routingLock.add("codex")
  try {
    return await operation()
  } finally {
    routingLock.delete("codex")
  }
}

function availableModels(): Array<string> {
  return (state.models?.data ?? [])
    .filter(
      (model) =>
        model.supported_endpoints?.includes("/responses")
        && model.policy?.state !== "disabled",
    )
    .map((model) => model.id)
    .sort()
}

function disableRouting(): boolean {
  const before = readCodexConfig()
  const after = withoutReviewCatalog(revertCodexConfig(before))
  writeCodexConfig(before, after)
  return before !== after
}

async function enableRouting(
  options: Parameters<ClientApp["enable"]>[0],
  installs: Array<AppInstall>,
  verifyProvider: typeof verifyCodexProvider,
): Promise<{ success: boolean; restartRequired: boolean }> {
  const before = readCodexConfig()
  const model = options?.model ?? configuredModel(before)
  if (!model)
    throw new Error(
      "Set a model in your Codex configuration before enabling routing.",
    )
  const models =
    state.models ? availableModels() : await readCodexGatewayModels()
  if (!models.includes(model)) {
    throw new Error(
      "Your configured Codex model is not available through Maximal's Responses API. Set a supported model in your Codex configuration, then try again.",
    )
  }
  const routingBase = before
  const after = prepareCodexConfig(
    routingBase,
    codexProvider(chooseProviderId(routingBase)),
    model,
  )
  // Already-current connections do not consume quota or rewrite snapshots.
  const catalogWasCurrent = reviewCatalogIsCurrent(before, installs, models)
  if (catalogWasCurrent && after === before) {
    return { success: true, restartRequired: false }
  }
  const catalog = await prepareReviewCatalog(after, {
    installs,
    availableModels: models,
    selectedModel: model,
  })
  const withCatalog = catalog.config
  const changed = withCatalog !== before || !catalogWasCurrent
  if (changed) {
    await verifyProvider(after, model)
    if (model !== COPILOT_REVIEW_MODEL)
      await verifyProvider(after, COPILOT_REVIEW_MODEL)
  }
  writeReviewCatalog(catalog)
  catalog.checkUnchanged()
  writeCodexConfig(before, withCatalog)
  return { success: true, restartRequired: changed }
}

interface CodexAppOptions {
  detectInstalls: () => Promise<Array<AppInstall>>
  installHint: AppInstallHint | null
  verifyProvider?: typeof verifyCodexProvider
}

export function createCodexApp(
  id: "codex" | "codex-desktop",
  name: string,
  optionsForApp: CodexAppOptions,
): ClientApp {
  const { detectInstalls, installHint } = optionsForApp
  return {
    id,
    name,
    kind: "config",
    apiKeyLabel: "codex",

    async detect() {
      return (await detectInstalls()).length > 0
    },

    async getDetails(): Promise<AppEntry> {
      const installs = await detectInstalls()
      let enabled = false
      let managed = false
      let model: string | null = null
      let automaticReview = false
      let notice: string | undefined
      try {
        const text = readCodexConfig()
        managed = hasCodexRouting(text)
        enabled = isCodexEnabled(text)
        automaticReview = reviewCatalogIsCurrent(
          text,
          installs,
          availableModels(),
        )
        model = configuredModel(text)
        if (hasUnmanagedProvider(text)) {
          notice = EXISTING_SETUP_NOTICE
        }
      } catch (error) {
        notice =
          error instanceof Error ?
            error.message
          : "Could not read Codex settings."
      }
      return {
        id,
        name,
        kind: "config",
        enabled,
        status: installs.length > 0 ? "ready" : "not-installed",
        installs,
        install: installs.length > 0 ? null : installHint,
        conflict: null,
        routing: {
          model,
          available_models: availableModels(),
          managed,
          automatic_review: automaticReview,
          review_update_required: enabled && !automaticReview,
          notice,
          uses_existing_setup: notice === EXISTING_SETUP_NOTICE,
        },
      }
    },

    enable(options) {
      return mutateRouting(async () => {
        const installs = await detectInstalls()
        if (installs.length === 0)
          throw new Error(
            "Install Codex CLI or Desktop first, then enable routing.",
          )
        return enableRouting(
          options,
          installs,
          optionsForApp.verifyProvider ?? verifyCodexProvider,
        )
      })
    },

    disable() {
      return mutateRouting(() => {
        const changed = disableRouting()
        return Promise.resolve({ success: changed, restartRequired: changed })
      })
    },

    uninstall() {
      return mutateRouting(() =>
        Promise.resolve({
          reverted: disableRouting() ? [`reverted ${codexConfigPath()}`] : [],
        }),
      )
    },

    isEnabled() {
      try {
        return isCodexEnabled(readCodexConfig())
      } catch {
        return false
      }
    },
  }
}

async function detectInstalls(): Promise<Array<AppInstall>> {
  return (await Promise.all([detectCodex(), detectCodexDesktop()])).flat()
}

export const codexApp = createCodexApp("codex", "Codex CLI and Desktop", {
  detectInstalls,
  installHint: { method: "npm", command: "npm install -g @openai/codex" },
})

export const codexDesktopApp = createCodexApp(
  "codex-desktop",
  "Codex Desktop",
  { detectInstalls, installHint: null },
)
