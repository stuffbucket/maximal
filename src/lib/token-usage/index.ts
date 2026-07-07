import { requestContext, generateTraceId } from "~/lib/http/request-context"
import { state } from "~/lib/runtime-state/state"
import { pricedModelIsPaid } from "~/services/copilot/get-models"

import { EventBus } from "../runtime-state/event-bus"
import {
  enqueueTokenUsageWrite,
  hasAnyToken,
  normalizeOptionalToken,
  normalizeToken,
  resolveTotalTokens,
  type PersistedTokenUsageEvent,
  type TokenUsageEndpoint,
  type TokenUsageSource,
  type UsageTokens,
} from "./store"

export {
  closeUsageStore,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
} from "./store"

export type {
  TokenUsageEndpoint,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePeriod,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTotals,
  UsageTokens,
} from "./store"

export interface TokenUsageEventInput extends UsageTokens {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

interface TokenUsageRecorderOptions {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string | null
  model: string
  providerName?: string | null
  sessionId?: string | null
  source: TokenUsageSource
  traceId?: string | null
}

type CopilotTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "providerName" | "source"
>

type ProviderTokenUsageRecorderOptions = Omit<
  TokenUsageRecorderOptions,
  "source"
>

interface TokenUsageEventMap {
  "token_usage.recorded": PersistedTokenUsageEvent
}

const tokenUsageEventBus = new EventBus<TokenUsageEventMap>()

function resolveTraceId(traceId: string | null | undefined): string {
  return (
    traceId?.trim() || requestContext.getStore()?.traceId || generateTraceId()
  )
}

export function resolveTokenUsageSessionId(
  sessionId: string | null | undefined,
  fallbackSessionId?: string | null,
): string {
  return (
    requestContext.getStore()?.sessionAffinity?.trim()
    || sessionId?.trim()
    || fallbackSessionId?.trim()
    || ""
  )
}

function resolveUserId(input: TokenUsageEventInput): string {
  if (input.source === "provider") {
    return input.providerName?.trim() || ""
  }
  return state.userName?.trim() || ""
}

function toPersistedEvent(
  input: TokenUsageEventInput,
): PersistedTokenUsageEvent | null {
  if (!hasAnyToken(input)) {
    return null
  }

  const now = new Date()
  return {
    cache_creation_input_tokens: normalizeToken(
      input.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeToken(input.cache_read_input_tokens),
    created_at_ms: now.getTime(),
    created_at_utc: now.toISOString(),
    endpoint: input.endpoint,
    input_tokens: normalizeToken(input.input_tokens),
    model: input.model.trim() || "unknown",
    output_tokens: normalizeToken(input.output_tokens),
    provider_name: input.providerName?.trim() || null,
    session_id: resolveTokenUsageSessionId(
      input.sessionId,
      input.fallbackSessionId,
    ),
    source: input.source,
    total_tokens: resolveTotalTokens(input),
    total_nano_aiu: normalizeToken(input.total_nano_aiu),
    is_premium: resolveIsPaid(input.model),
    trace_id: resolveTraceId(input.traceId),
    user_id: resolveUserId(input),
  }
}

/** Paid/free status for a model from the live catalog, persisted as the
 *  `is_premium` column: 1 = paid, 0 = free, null = unknown (model absent from
 *  the catalog — e.g. a passthrough provider model or a not-yet-refreshed
 *  catalog).
 *
 *  Copilot-specific pricing seam (ADR-0016, divergence 1). PRIMARY signal is
 *  the catalog's `billing.token_prices` (per-token AIU billing, live since
 *  2026-06-01): any advertised non-zero rate ⇒ paid. The legacy
 *  `billing.is_premium` flag is only consulted when `token_prices` is absent
 *  (older catalogs / annual-plan accounts) — under usage-based billing
 *  `is_premium === false` no longer means "free", so it must not win over a
 *  present `token_prices`. A second provider would need its own mapping. */
function resolveIsPaid(model: string): number | null {
  const id = model.trim()
  if (!id) return null
  const entry = state.models?.data.find((m) => m.id === id)
  const billing = entry?.billing
  if (!billing) return null

  // PRIMARY: token_prices (per-token AIU billing).
  const pricedPaid = pricedModelIsPaid(billing.token_prices)
  if (pricedPaid !== null) return pricedPaid ? 1 : 0

  // LEGACY FALLBACK: is_premium, only when token_prices is absent/unusable.
  if (typeof billing.is_premium !== "boolean") return null
  return billing.is_premium ? 1 : 0
}

tokenUsageEventBus.subscribe("token_usage.recorded", enqueueTokenUsageWrite)

export function recordTokenUsageEvent(input: TokenUsageEventInput): void {
  const event = toPersistedEvent(input)
  if (!event) {
    return
  }

  tokenUsageEventBus.publish("token_usage.recorded", event)
}

export function createTokenUsageRecorder(
  options: TokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return (usage) => {
    recordTokenUsageEvent({
      ...usage,
      ...options,
    })
  }
}

export function createCopilotTokenUsageRecorder(
  options: CopilotTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return createTokenUsageRecorder({
    ...options,
    source: "copilot",
  })
}

export function createProviderTokenUsageRecorder(
  options: ProviderTokenUsageRecorderOptions,
): (usage: UsageTokens) => void {
  return createTokenUsageRecorder({
    ...options,
    source: "provider",
  })
}

export function normalizeOpenAIUsage(
  usage:
    | {
        completion_tokens?: number
        prompt_tokens?: number
        total_tokens?: number
        prompt_tokens_details?: {
          cached_tokens?: number
        }
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.prompt_tokens_details?.cached_tokens,
  )
  const promptTokens = normalizeToken(usage?.prompt_tokens)
  return {
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: normalizeToken(usage?.completion_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function normalizeResponsesUsage(
  usage:
    | {
        input_tokens?: number
        input_tokens_details?: {
          cached_tokens?: number
        }
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  const cachedTokens = normalizeToken(
    usage?.input_tokens_details?.cached_tokens,
  )
  const inputTokens = normalizeToken(usage?.input_tokens)
  return {
    cache_read_input_tokens: cachedTokens,
    input_tokens: Math.max(0, inputTokens - cachedTokens),
    output_tokens: normalizeToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

/** Extract Copilot's per-request cost (nano-AIU) from a completion
 *  response's sibling `copilot_usage` object. Present on chat/completions,
 *  responses, and messages; undefined/legacy shapes yield undefined. */
export function extractCopilotCost(
  copilotUsage: { total_nano_aiu?: unknown } | null | undefined,
): number | undefined {
  const nano = copilotUsage?.total_nano_aiu
  return typeof nano === "number" && Number.isFinite(nano) ? nano : undefined
}

/** Merge Copilot's per-request cost into already-normalized token counts.
 *  One place for the (normalized usage + sibling copilot_usage) shape every
 *  non-streaming Copilot record site needs, so cost capture can't be
 *  forgotten at a new site or drift in field name. */
export function withCopilotCost(
  base: UsageTokens,
  copilotUsage: { total_nano_aiu?: unknown } | null | undefined,
): UsageTokens {
  return { ...base, total_nano_aiu: extractCopilotCost(copilotUsage) }
}

export function normalizeAnthropicUsage(
  usage:
    | {
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    | null
    | undefined,
): UsageTokens {
  return {
    cache_creation_input_tokens: normalizeOptionalToken(
      usage?.cache_creation_input_tokens,
    ),
    cache_read_input_tokens: normalizeOptionalToken(
      usage?.cache_read_input_tokens,
    ),
    input_tokens: normalizeOptionalToken(usage?.input_tokens),
    output_tokens: normalizeOptionalToken(usage?.output_tokens),
    total_tokens: normalizeOptionalToken(usage?.total_tokens),
  }
}

export function mergeAnthropicUsage(
  current: UsageTokens,
  next: UsageTokens,
): UsageTokens {
  return {
    cache_creation_input_tokens:
      next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens ?? current.cache_read_input_tokens,
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    total_tokens: next.total_tokens ?? current.total_tokens,
  }
}
