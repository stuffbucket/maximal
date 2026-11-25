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

import consola from "consola"

import type { sendRequest } from "~/lib/http/send-request"
import type { ParentProviderBroker } from "~/lib/plugins/provider-broker"

import { copilotWindowsFromUsage } from "~/lib/budget/copilot-windows"
import { listProviderWindows } from "~/lib/budget/provider-windows"
import { adviseUpstreamError } from "~/lib/errors/upstream-error-advice"
import {
  providerFromBroker,
  type ProviderInvocationJournal,
} from "~/lib/plugins/provider-broker"
import {
  hasCopilotToken,
  state,
  subscribeProviderStateChanged,
} from "~/lib/runtime-state/state"
import { extractCopilotCost } from "~/lib/token-usage"
import {
  defaultTokenPriceRates,
  type Model,
} from "~/services/copilot/get-models"
import { postCopilotJson } from "~/services/copilot/post-copilot-json"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export interface CopilotProviderDeps {
  /** The authenticated HTTP transport; the real one by default. */
  sendRequest?: typeof sendRequest
  /** Reads GitHub's `/copilot_internal/user` reply, which carries the
   *  quotas; the real call by default. */
  getUsage?: () => Promise<unknown>
  /** Durably fence availability/catalog changes before notifying plugins. */
  commitControlMutation?: (digest: string) => Promise<void>
}

function modelInfo(model: Model): ProviderModelInfo {
  const prices = defaultTokenPriceRates(model)
  return {
    id: model.id,
    type: model.capabilities.type,
    endpoints: model.supported_endpoints ?? [],
    preview: model.preview,
    ...(prices ? { prices } : {}),
  }
}

function readCopilotState() {
  return {
    available: hasCopilotToken(),
    models: Object.freeze(
      (state.models?.data ?? []).map((model) => modelInfo(model)),
    ),
  }
}

export function createCopilotProviderBroker(
  deps: CopilotProviderDeps = {},
): ParentProviderBroker {
  const listeners = new Set<() => void>()
  let revision = 0
  let published = readCopilotState()
  let unsubscribeState: (() => void) | undefined
  let publishTail = Promise.resolve()
  const publish = (next: ReturnType<typeof readCopilotState>): void => {
    const commit = async (): Promise<void> => {
      if (deps.commitControlMutation) {
        await deps.commitControlMutation(JSON.stringify(next))
      }
      revision += 1
      published = next
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          consola.warn("Copilot provider listener failed", error)
        }
      }
    }
    if (!deps.commitControlMutation) {
      void commit()
      return
    }
    publishTail = publishTail
      .then(() => commit())
      .catch((error: unknown) => {
        // A failed durable fence must not publish an unfenced provider view.
        consola.warn("Could not commit Copilot provider state", error)
      })
  }
  const snapshot = () => {
    const current = unsubscribeState ? published : readCopilotState()
    return Object.freeze({ revision, ...current })
  }
  return {
    id: COPILOT_PROVIDER_ID,
    displayName: "GitHub Copilot",
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (!unsubscribeState) {
        published = readCopilotState()
        unsubscribeState = subscribeProviderStateChanged(() => {
          publish(readCopilotState())
        })
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        unsubscribeState?.()
        unsubscribeState = undefined
      }
    },
    postJson: (path, body, options) =>
      postCopilotJson(path, body, {
        ...options,
        sendRequest: deps.sendRequest,
      }),
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
    async refreshQuotaWindows() {
      const usage = await (deps.getUsage ?? (() => getCopilotUsage()))()
      return copilotWindowsFromUsage(usage)
    },
  }
}

/** Current public direct-provider API, projected from the parent broker. */
export function createCopilotProvider(
  deps: CopilotProviderDeps = {},
  journal?: ProviderInvocationJournal,
): UpstreamProvider {
  return providerFromBroker(createCopilotProviderBroker(deps), journal)
}
