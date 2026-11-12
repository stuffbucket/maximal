/**
 * The app's budget service and the helpers the routes call: the service wired
 * to the real config, usage database, provider windows and usage stream,
 * plus the one-step "reserve or throw" the enforcement points share.
 */

import consola from "consola"

import type { BudgetStatusResponse } from "~/lib/config/settings-types"

import { registerCoreAttentionSource } from "~/lib/attention"
import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import { requestContext } from "~/lib/http/request-context"
import { queueNotice } from "~/lib/plugins/notices"
import { createCopilotProvider } from "~/lib/plugins/providers/copilot"
import { state } from "~/lib/runtime-state/state"
import { onTokenUsageEvent } from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import { COPILOT_PROVIDER_ID } from "~/services/copilot/upstream-request"

import {
  ATTENTION_SOURCE_ID,
  createApprovalCenter,
  overrideExpiry,
  type ApprovalCenter,
} from "./approvals"
import { BudgetExceededError } from "./errors"
import { createUsageDbOverrideStorage } from "./override-store"
import { createOverrideRegistry, type OverrideRegistry } from "./overrides"
import { resolvePeriod } from "./periods"
import {
  findProviderWindow,
  listProviderWindows,
  observeProviderWindows,
} from "./provider-windows"
import {
  createAllowanceRefresher,
  type AllowanceRefresher,
  type RefreshResult,
} from "./refresh"
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

/** A rule crossed its warning threshold: log it, and tell the person where
 *  the rule's `notify.warn` says. */
function announceWarning(warning: BudgetWarning): void {
  const percent = Math.round((warning.used / Math.max(1, warning.limit)) * 100)
  consola.warn(
    `Rule "${warning.limitId}" is at ${percent}% of its limit${
      warning.resetsAtMs === null ?
        ""
      : `; it resets ${new Date(warning.resetsAtMs).toISOString()}`
    }.`,
  )
  getApprovalCenter().warned({
    limitId: warning.limitId,
    periodKey: String(warning.resetsAtMs),
    used: warning.used,
    limit: warning.limit,
    resetsAtMs: warning.resetsAtMs,
  })
  emitBudgetChanged()
}

let service: BudgetService | undefined
let overrides: OverrideRegistry | undefined
let center: ApprovalCenter | undefined
let refresher: AllowanceRefresher | undefined

/** What approvals granted, kept across restarts. */
export function getOverrideRegistry(): OverrideRegistry {
  overrides ??= createOverrideRegistry({
    storage: createUsageDbOverrideStorage(),
  })
  return overrides
}

/** Native notices, attention entries and the approvals an `ask` rule puts to
 *  the person. */
export function getApprovalCenter(): ApprovalCenter {
  center ??= createApprovalCenter({
    config: () => getConfig().budget,
    overrides: getOverrideRegistry(),
    notice: (notice) => {
      queueNotice({
        plugin: ATTENTION_SOURCE_ID,
        name: "Rules",
        code: notice.code,
        message: notice.message,
        params: notice.params,
      })
    },
    changed: emitBudgetChanged,
    expiryFor: (limit) => {
      const nowMs = Date.now()
      return overrideExpiry(
        resolvePeriod(limit.limitReset, nowMs, (ref) =>
          findProviderWindow(ref),
        ),
        nowMs,
      )
    },
  })
  return center
}

// What the menu-bar tray lists beside the plugins' own attention.
registerCoreAttentionSource({
  id: ATTENTION_SOURCE_ID,
  items: () => getApprovalCenter().items(),
  run: (actionId) => getApprovalCenter().run(actionId),
})

/** The status snapshot, with what calls in progress hold and what approvals
 *  granted. */
export async function currentBudgetStatus(): Promise<BudgetStatusResponse> {
  await getOverrideRegistry().ready()
  return buildBudgetStatus(getConfig().budget, {
    held: (scope) => getBudgetService().heldNanoAiu(scope),
    overrides: (limitId) => getOverrideRegistry().active(limitId, Date.now()),
    approval: (limitId) => getApprovalCenter().approval(limitId),
  })
}

/** The refresher for the providers the host supplies (Copilot). */
function getAllowanceRefresher(): AllowanceRefresher {
  refresher ??= createAllowanceRefresher({
    provider: (id) =>
      id === COPILOT_PROVIDER_ID ? createCopilotProvider() : undefined,
    observe: observeProviderWindows,
  })
  return refresher
}

/** Ask a provider for its allowance now (rate limited), and tell the shell
 *  when it answered. */
export async function refreshProviderAllowance(
  providerId: string,
): Promise<RefreshResult> {
  const result = await getAllowanceRefresher().refresh(providerId)
  if (result.ok) emitBudgetChanged()
  return result
}

/** At start, when signed in: read Copilot's allowance so the window shows
 *  it before the first request. Best-effort. */
export function refreshAllowanceAtStartup(): void {
  if (!state.githubToken) return
  void refreshProviderAllowance(COPILOT_PROVIDER_ID)
}

/** Replace the allowance refresher; `undefined` restores the real one. */
export function __setAllowanceRefresherForTests(
  next: AllowanceRefresher | undefined,
): void {
  refresher = next
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
    overrides: {
      ready: () => getOverrideRegistry().ready(),
      active: (limitId, nowMs) => getOverrideRegistry().active(limitId, nowMs),
    },
    onAsk: (event) => getApprovalCenter().ask(event),
    onLimitReached: (event) => {
      getApprovalCenter().reached(event)
    },
  })
  return service
}

/** Drop the app's service, overrides and approvals so the next use builds
 *  fresh ones. */
export function __resetBudgetServiceForTests(): void {
  service?.stop()
  service = undefined
  overrides = undefined
  center = undefined
  refresher = undefined
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
