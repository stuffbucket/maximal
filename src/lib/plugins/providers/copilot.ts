/**
 * The Copilot upstream provider: the `UpstreamProvider` the host registers at
 * start, built from the pieces the app already has: `postCopilotJson` (auth +
 * transport), the cached model catalog, the upstream-error advice, the
 * per-reply cost and the quota windows Copilot reports. Plugins reach it as
 * `ctx.providers.get("copilot")`.
 */

import type {
  ProviderModelInfo,
  UpstreamProvider,
} from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { sendRequest } from "~/lib/http/send-request"
import type { Model } from "~/services/copilot/get-models"

import { listProviderWindows } from "~/lib/budget/provider-windows"
import { adviseUpstreamError } from "~/lib/errors/upstream-error-advice"
import {
  hasCopilotToken,
  state,
  subscribeModelCatalogChanged,
} from "~/lib/runtime-state/state"
import { extractCopilotCost } from "~/lib/token-usage"
import { postCopilotJson } from "~/services/copilot/post-copilot-json"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

export interface CopilotProviderDeps {
  /** The authenticated HTTP transport; the real one by default. */
  sendRequest?: typeof sendRequest
}

/** Numeric rates of a model's default price tier (or its flat rates). */
function priceRates(model: Model): Record<string, number> | undefined {
  const prices = model.billing?.token_prices
  if (!prices) return undefined
  const tier = typeof prices.default === "object" ? prices.default : prices
  const rates: Record<string, number> = {}
  for (const [name, value] of Object.entries(tier)) {
    if (typeof value === "number" && name !== "max_prompt_tokens") {
      rates[name] = value
    }
  }
  return Object.keys(rates).length > 0 ? rates : undefined
}

function modelInfo(model: Model): ProviderModelInfo {
  const prices = priceRates(model)
  return {
    id: model.id,
    type: model.capabilities.type,
    endpoints: model.supported_endpoints ?? [],
    preview: model.preview,
    ...(prices ? { prices } : {}),
  }
}

export function createCopilotProvider(
  deps: CopilotProviderDeps = {},
): UpstreamProvider {
  return {
    id: COPILOT_PROVIDER_ID,
    displayName: "GitHub Copilot",
    postJson: (path, body, options) =>
      postCopilotJson(path, body, {
        ...options,
        sendRequest: deps.sendRequest,
      }),
    model(id) {
      const model = state.models?.data.find((entry) => entry.id === id)
      return model ? modelInfo(model) : undefined
    },
    onCatalogChange: (listener) => subscribeModelCatalogChanged(listener),
    available: () => hasCopilotToken(),
    adviseError: ({ status, text, call }) =>
      adviseUpstreamError(status, text, {
        models: state.models?.data ?? [],
        call,
      }) ?? undefined,
    cost(reply) {
      const usage = reply.copilot_usage as { total_nano_aiu?: unknown } | null
      const amount = extractCopilotCost(usage)
      return amount === undefined ? undefined : (
          { unit: "nano_aiu", amount, estimated: false }
        )
    },
    quotaWindows: async () =>
      (await listProviderWindows()).filter(
        (window) => window.provider === COPILOT_PROVIDER_ID,
      ),
  }
}
