/**
 * The app's budget service and the helpers the routes call: the service wired
 * to the real config, usage database, provider windows and usage stream,
 * plus the one-step "reserve or throw" the enforcement points share.
 */

import consola from "consola"

import type { BudgetStatusResponse } from "~/lib/config/settings-types"

import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import { requestContext } from "~/lib/http/request-context"
import { onTokenUsageEvent } from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

import { BudgetExceededError } from "./errors"
import { findProviderWindow, listProviderWindows } from "./provider-windows"
import { recordBudgetEvent } from "./reports/events"
import { budgetKeyOf } from "./scope"
import {
  createBudgetService,
  type BudgetHold,
  type BudgetIntent,
  type BudgetService,
  type BudgetWarning,
} from "./service"
import { buildBudgetStatus } from "./status"
import { createUsageDbBudgetStore } from "./store"

function announceWarning(warning: BudgetWarning): void {
  const percent = Math.round((warning.used / Math.max(1, warning.limit)) * 100)
  consola.warn(
    `Rule "${warning.limitId}" is at ${percent}% of its limit${
      warning.resetsAtMs === null ?
        ""
      : `; it resets ${new Date(warning.resetsAtMs).toISOString()}`
    }.`,
  )
  emitBudgetChanged()
}

let service: BudgetService | undefined

/** The status snapshot, with what calls in progress hold. */
export function currentBudgetStatus(): Promise<BudgetStatusResponse> {
  return buildBudgetStatus(getConfig().budget, {
    held: (scope) => getBudgetService().heldNanoAiu(scope),
  })
}

/** Push the current status to the shell (`budget.changed`). Best-effort. */
export function emitBudgetChanged(): void {
  currentBudgetStatus()
    .then((status) => {
      settingsEventBus.publish("budget.changed", status)
    })
    .catch((error: unknown) => {
      consola.debug("Could not build the budget status for an event", error)
    })
}

export function getBudgetService(): BudgetService {
  service ??= createBudgetService({
    config: () => getConfig().budget,
    store: createUsageDbBudgetStore(),
    windows: {
      lookup: (ref) => findProviderWindow(ref),
      ready: async () => {
        await listProviderWindows()
      },
    },
    spendEvents: (listener) =>
      onTokenUsageEvent((event) => {
        listener({
          createdAtMs: event.created_at_ms,
          nanoAiu: event.total_nano_aiu,
          key: budgetKeyOf(event.client_label, event.client),
          provider:
            event.source === "copilot" ?
              "copilot"
            : (event.provider_name ?? ""),
          ...(event.plugin_id === null ? {} : { plugin: event.plugin_id }),
          model: event.model,
        })
      }),
    onWarning: announceWarning,
    onEvent: recordBudgetEvent,
  })
  return service
}

/** Drop the app's service so the next use builds a fresh one. */
export function __resetBudgetServiceForTests(): void {
  service?.stop()
  service = undefined
}

/** The key the current request belongs to (`budgetKeyOf`). */
export function currentBudgetKey(): string {
  const store = requestContext.getStore()
  return budgetKeyOf(
    store?.usage.apiKeyLabel,
    deriveUsageClient(store?.usage.apiKeyLabel, store?.userAgent ?? ""),
  )
}

/** Hold the call's estimate, or throw `BudgetExceededError` when a limit
 *  refuses it. */
export async function reserveBudget(
  intent: BudgetIntent,
  budget: BudgetService = getBudgetService(),
): Promise<BudgetHold> {
  const decision = await budget.reserve(intent)
  if (!decision.ok) throw new BudgetExceededError(decision.refusal)
  return decision.hold
}

/** Throw `BudgetExceededError` when a limit is already spent; holds nothing.
 *  For calls whose cost can't be estimated. */
export async function admitBudget(
  intent: BudgetIntent,
  budget: BudgetService = getBudgetService(),
): Promise<void> {
  const decision = await budget.check(intent)
  if (!decision.ok) throw new BudgetExceededError(decision.refusal)
}

/** The chat endpoints Copilot serves, which a limit gates on spend already
 *  recorded (their cost can't be estimated up front). */
export type ChatBudgetOperation = "chat_completions" | "messages" | "responses"

/** Refuse a chat request while a limit that covers it is spent
 *  (`BudgetExceededError`). Nothing is held: the request is admitted while
 *  its limits have room, and can go over by what is in flight. */
export async function admitChat(
  operation: ChatBudgetOperation,
  model?: string,
  budget?: BudgetService,
): Promise<void> {
  await admitBudget(
    {
      operation,
      provider: COPILOT_PROVIDER_ID,
      key: currentBudgetKey(),
      ...(model === undefined ? {} : { model }),
      estimateNanoAiu: 0,
    },
    budget,
  )
}
