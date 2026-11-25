/**
 * The app's budget service and the helpers the routes call: the service wired
 * to the real config, usage database, provider windows and usage stream,
 * plus the one-step "reserve or throw" the enforcement points share.
 */

import consola from "consola"

import type { BudgetStatusResponse } from "~/lib/config/settings-types"
import type { PersistedTokenUsageEvent } from "~/lib/token-usage/store"

import { registerCoreAttentionSource } from "~/lib/attention"
import { getConfig } from "~/lib/config/config"
import { settingsEventBus } from "~/lib/config/settings-events"
import { requestContext } from "~/lib/http/request-context"
import { queueNotice } from "~/lib/plugins/notices"
import { createCopilotProvider } from "~/lib/plugins/providers/copilot"
import { currentPresence } from "~/lib/presence"
import { state } from "~/lib/runtime-state/state"
import {
  onTokenUsageEvent,
  publishPersistedTokenUsageEvents,
  recordPreparedTokenUsageEvents,
  type UsageTokens,
} from "~/lib/token-usage"
import { deriveUsageClient } from "~/lib/token-usage/client"
import { defaultTokenPriceRates } from "~/services/copilot/get-models"
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
import { DEFAULT_MAX_HELD, createPauseGate, type PauseGate } from "./pause"
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
  type BudgetCheck,
  type BudgetHold,
  type BudgetIntent,
  type BudgetService,
  type ObservedBudgetTokens,
  type BudgetWarning,
} from "./service"
import { buildBudgetStatus } from "./status"
import { createUsageDbBudgetStore } from "./store"

/** A rule crossed its warning threshold: log it, and tell the person where
 *  the rule's `notify.warn` says. */
const DEFAULT_MAX_WAIT_SECONDS = 600

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
    unit: warning.unit,
    used: warning.used,
    limit: warning.limit,
    resetsAtMs: warning.resetsAtMs,
  })
  emitBudgetChanged()
}

let service: BudgetService | undefined
let gate: PauseGate | undefined
let stopWakingGate: (() => void) | undefined
let overrides: OverrideRegistry | undefined
let center: ApprovalCenter | undefined
let refresher: AllowanceRefresher | undefined

/** How `pause` rules hold requests (`budget.pause`). */
export function pauseSettings(): { maxWaitMs: number; maxHeld: number } {
  const pause = getConfig().budget?.pause
  return {
    maxWaitMs: (pause?.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS) * 1000,
    maxHeld: pause?.maxHeld ?? DEFAULT_MAX_HELD,
  }
}

/** Whether any rule pauses, so a request is worth looking at. */
export function hasPauseRules(): boolean {
  const budget = getConfig().budget
  if (budget?.enabled === false) return false
  return (budget?.limits ?? []).some((limit) => limit.action === "pause")
}

/** The requests held at pause rules. A change to the budget (a limit raised,
 *  an approval) wakes them to look again. */
export function getPauseGate(): PauseGate {
  if (!gate) {
    gate = createPauseGate({
      maxHeld: () => pauseSettings().maxHeld,
      onChange: () => {
        getApprovalCenter().heldChanged()
      },
    })
    const woken = gate
    stopWakingGate = settingsEventBus.subscribe("budget.changed", () => {
      woken.recheck()
    })
  }
  return gate
}

/** Let the request being served through the budget gate, because a person
 *  resumed it. */
export function markBudgetCleared(): void {
  const store = requestContext.getStore()
  if (store) store.budgetCleared = true
}

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
    heldCount: (limitId) => getPauseGate().heldCount(limitId),
    wake: (limitId) => getPauseGate().recheck(limitId),
    resumeHeld: (limitId) => getPauseGate().resume(limitId),
    cancelHeld: (limitId) => getPauseGate().cancel(limitId),
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
    held: (scope, metric) => getBudgetService().heldNanoAiu(scope, metric),
    presence: currentPresence(),
    overrides: (limitId) => getOverrideRegistry().active(limitId, Date.now()),
    approval: (limitId) => getApprovalCenter().approval(limitId),
    paused: (limitId) => getPauseGate().heldCount(limitId),
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
          // A cached prompt is still a prompt (`~/lib/budget/metric`).
          inputTokens: event.input_tokens + event.cache_read_input_tokens,
          outputTokens: event.output_tokens,
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
    presence: () => currentPresence(),
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
  stopWakingGate?.()
  stopWakingGate = undefined
  gate = undefined
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

/** Persist authoritative usage and close its hold without a crash window. */
export async function settleBudgetUsage(
  hold: BudgetHold,
  events: ReadonlyArray<PersistedTokenUsageEvent>,
  actualNanoAiu?: number,
): Promise<void> {
  if (hold.persisted) {
    try {
      await hold.settle(events, { nanoAiu: actualNanoAiu }, () => {
        publishPersistedTokenUsageEvents(events)
      })
    } catch (error) {
      await hold.unreconcile("settlement-failed").catch(() => undefined)
      throw error
    }
  } else {
    await hold.commit({ nanoAiu: actualNanoAiu })
    recordPreparedTokenUsageEvents(events)
  }
}

/** Persist any observed tokens while retaining the provisional cost as
 * unreconciled. */
export async function unreconcileBudgetUsage(
  hold: BudgetHold,
  events: ReadonlyArray<PersistedTokenUsageEvent>,
  input: {
    reason: "stream-interrupted" | "usage-missing" | "settlement-failed"
    observedTokens?: ObservedBudgetTokens
  },
): Promise<void> {
  if (hold.persisted) {
    await hold.unreconcile(input.reason, events, {
      afterPersist: () => {
        publishPersistedTokenUsageEvents(events)
      },
      ...(input.observedTokens === undefined ?
        {}
      : { observedTokens: input.observedTokens }),
    })
  } else {
    await hold.commit()
    recordPreparedTokenUsageEvents(events)
  }
}

export type BudgetUsagePreparer = (
  usage: UsageTokens,
) => PersistedTokenUsageEvent | null

export interface BudgetUsageFinish {
  usage: UsageTokens
  missingReason?: "usage-missing" | "stream-interrupted"
  observedTokens?: ObservedBudgetTokens
}

function observedTokensIn(usage: UsageTokens): ObservedBudgetTokens {
  return {
    input:
      typeof usage.input_tokens === "number"
      || typeof usage.cache_creation_input_tokens === "number"
      || typeof usage.cache_read_input_tokens === "number",
    output: typeof usage.output_tokens === "number",
  }
}

/** Prepare observed chat usage, then either settle its authoritative bill or
 * keep the provisional estimate as unreconciled. */
export async function finishBudgetUsage(
  hold: BudgetHold,
  prepare: BudgetUsagePreparer,
  input: BudgetUsageFinish,
): Promise<void> {
  const { usage, missingReason = "usage-missing" } = input
  const event = prepare(usage)
  const events = event ? [event] : []
  await (typeof usage.total_nano_aiu === "number" ?
    settleBudgetUsage(hold, events, usage.total_nano_aiu)
  : unreconcileBudgetUsage(hold, events, {
      reason: missingReason,
      observedTokens: input.observedTokens ?? observedTokensIn(usage),
    }))
}

/** Bind a chat request's hold and usage preparer to its terminal usage. */
export function createBudgetUsageFinisher(
  hold: BudgetHold,
  prepare: BudgetUsagePreparer,
): (
  usage: UsageTokens,
  missingReason?: "usage-missing" | "stream-interrupted",
) => Promise<void> {
  return (usage, missingReason) =>
    finishBudgetUsage(
      hold,
      prepare,
      missingReason === undefined ? { usage } : { usage, missingReason },
    )
}

/** Throw `BudgetExceededError` when a limit is already spent; holds nothing.
 *  For calls whose cost can't be estimated. */
export async function admitBudget(
  intent: BudgetIntent,
  budget: BudgetService = getBudgetService(),
): Promise<void> {
  // A person let this request through a rule that was holding it.
  if (requestContext.getStore()?.budgetCleared) return
  const decision = await budget.check(intent)
  if (!decision.ok) throw new BudgetExceededError(decision.refusal)
}

/** The chat endpoints Copilot serves. */
export type ChatBudgetOperation = "chat_completions" | "messages" | "responses"

const NANO_AIU_PER_MILLIONTH_CREDIT = 1_000

/** A conservative provisional cost for the reply ceiling advertised by the
 * request. Catalog prices are AI credits per million tokens; storage is
 * nano-AIU. Prompt and cache costs remain unknown until final usage arrives. */
export function estimateChatNanoAiu(
  model: string | undefined,
  maxTokens: number | null | undefined,
): number {
  if (!model || typeof maxTokens !== "number" || maxTokens <= 0) return 0
  const selected = state.models?.data.find((entry) => entry.id === model)
  if (!selected) return 0
  const prices = defaultTokenPriceRates(selected)
  const outputPrice = prices?.output_price ?? prices?.output ?? 0
  if (!Number.isFinite(outputPrice) || outputPrice <= 0) return 0
  return Math.ceil(maxTokens * outputPrice * NANO_AIU_PER_MILLIONTH_CREDIT)
}

/** Reserve a provisional chat estimate or throw `BudgetExceededError`. */
export async function admitChat(
  operation: ChatBudgetOperation,
  request: ChatBudgetRequest = {},
  budget: BudgetService = getBudgetService(),
): Promise<BudgetHold> {
  const intent = chatIntent(operation, request)
  if (requestContext.getStore()?.budgetCleared) {
    return budget.reserveCleared(intent)
  }
  return reserveBudget(intent, budget)
}

/** Gate a multi-turn chat flow that cannot yet close one hold atomically. */
export async function gateChat(
  operation: ChatBudgetOperation,
  request: ChatBudgetRequest = {},
  budget?: BudgetService,
): Promise<void> {
  await admitBudget(chatIntent(operation, request), budget)
}

/** What a chat request tells the budget before it runs. */
export interface ChatBudgetRequest {
  model?: string
  maxTokens?: number | null
}

function chatIntent(
  operation: ChatBudgetOperation,
  { model, maxTokens }: ChatBudgetRequest,
): BudgetIntent {
  return {
    operation,
    provider: COPILOT_PROVIDER_ID,
    key: currentBudgetKey(),
    ...(model === undefined ? {} : { model }),
    estimateNanoAiu: estimateChatNanoAiu(model, maxTokens),
    // The most the reply can be, when the request says: what a token limit
    // holds. The cost estimate uses the same reply ceiling when priced.
    ...(typeof maxTokens === "number" && maxTokens > 0 ?
      { estimateOutputTokens: maxTokens }
    : {}),
  }
}

/** The budget's answer for a chat request, without throwing: a pause rule's
 *  refusal says it may be held (`refusal.pause`). */
export function checkChat(
  operation: ChatBudgetOperation,
  request: ChatBudgetRequest = {},
  budget: BudgetService = getBudgetService(),
): Promise<BudgetCheck> {
  return budget.check(chatIntent(operation, request))
}
