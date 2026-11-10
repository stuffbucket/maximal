/**
 * Reframe opaque upstream (Copilot) errors into something a user can act on,
 * WITHOUT throwing away the original error — that raw text is the real
 * diagnostic, so we wrap it in context and a recovery step rather than
 * replacing it.
 *
 * Shape of an advised message (what the client renders):
 *
 *   <context>            — one plain-language line: what went wrong
 *   <recovery>           — a concrete step the user can take now
 *   Upstream error (<status>): <message> [<code>]   — the original, preserved
 *
 * Extensibility is the point: each recognizable failure is one `ErrorAdvisor`
 * in the `ADVISORS` registry. To handle a new error class, add an advisor —
 * `forwardError` and the composition below don't change. An unrecognized
 * error falls through untouched (raw body forwarded, as before).
 */

import type { UpstreamCall } from "~/lib/errors/http-errors"
import type { Model } from "~/services/copilot/get-models"

import { forwardId, isVariantId } from "~/lib/models/anthropic-id-rewrite"

/** The original upstream error, parsed but never discarded. `raw` is the
 *  body exactly as Copilot sent it. */
export interface UpstreamError {
  status: number
  message: string
  code: string | null
  raw: string
}

/** Everything an advisor may consult to recognize and explain an error. */
export interface AdviceContext {
  upstream: UpstreamError
  /** Current model catalog, for advisors that suggest alternatives. */
  models: ReadonlyArray<Model>
  /** The endpoint and model of the refused request, when known. */
  call?: UpstreamCall
}

/** The two human-facing halves an advisor produces. The composer frames
 *  them and appends the preserved original. */
export interface ErrorAdvice {
  /** One line: what went wrong, in plain language. */
  context: string
  /** Concrete recovery step(s) the user can take now. */
  recovery: string
}

export interface ErrorAdvisor {
  id: string
  matches: (ctx: AdviceContext) => boolean
  advise: (ctx: AdviceContext) => ErrorAdvice
}

// ── Parsing ──────────────────────────────────────────────────────────────

interface NestedError {
  code?: unknown
  message?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ?
      (value as Record<string, unknown>)
    : null
}

/** Read `error.code`/`error.message` (nested OpenAI/Copilot shape), falling
 *  back to a top-level `code`/`message`. */
function readError(parsed: unknown): NestedError {
  const obj = asRecord(parsed)
  if (!obj) return {}
  const nested = asRecord(obj.error)
  return {
    code: nested?.code ?? obj.code,
    message: nested?.message ?? obj.message,
  }
}

/** Normalize an upstream body into {status, message, code, raw}. Tolerant of
 *  non-JSON bodies (keeps the raw text as the message). */
export function parseUpstreamError(
  status: number,
  body: string,
): UpstreamError {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      status,
      message: body.trim() || "(no error body)",
      code: null,
      raw: body,
    }
  }

  const { code, message } = readError(parsed)
  return {
    status,
    message:
      typeof message === "string" && message.trim() ?
        message.trim()
      : body.trim() || "(no error body)",
    code: typeof code === "string" ? code : null,
    raw: body,
  }
}

// ── Advisors ─────────────────────────────────────────────────────────────

/** Cap the enumerated catalog so the inline error stays readable; the rest
 *  are reachable via the client's own picker. */
const MAX_LISTED = 12

function listAvailableModels(models: ReadonlyArray<Model>): Array<string> {
  return models
    .filter((m) => m.model_picker_enabled && !isVariantId(m.id))
    .map((m) => `${m.name} (${forwardId(m.id)})`)
}

/** Copilot's 400 `model_not_supported`, by code or by message text. */
function isModelNotSupported(upstream: UpstreamError): boolean {
  if (upstream.status !== 400) return false
  if (upstream.code === "model_not_supported") return true
  return /model is not supported|model_not_supported/i.test(upstream.message)
}

/** The catalog entry of a refused call whose model is in the catalog but
 *  doesn't list the called endpoint; null when that isn't known to be so. */
function wrongEndpointModel({ models, call }: AdviceContext): Model | null {
  if (!call?.model) return null
  const model = models.find((m) => m.id === call.model)
  const endpoints = model?.supported_endpoints
  if (!model || !endpoints || endpoints.includes(call.endpoint)) return null
  return model
}

const inlineCode = (text: string): string => `\`${text}\``

/** The listed items, capped so the inline error stays readable. */
function capped(items: ReadonlyArray<string>): string {
  const shown = items.slice(0, MAX_LISTED).join(", ")
  return items.length > MAX_LISTED ?
      `${shown} and ${items.length - MAX_LISTED} more`
    : shown
}

/**
 * Copilot answers a model that's in the catalog but doesn't serve the called
 * endpoint (a decisions model sent to `/v1/images/generations`, say) with the
 * same `model_not_supported` as a model the plan lacks. The catalog's
 * `supported_endpoints` tells them apart, so name the endpoint and the
 * models that do serve it.
 */
const endpointNotSupportedAdvisor: ErrorAdvisor = {
  id: "endpoint_not_supported",
  matches: (ctx) =>
    isModelNotSupported(ctx.upstream) && wrongEndpointModel(ctx) !== null,
  advise: (ctx) => {
    const model = wrongEndpointModel(ctx)
    const endpoint = ctx.call?.endpoint ?? ""
    const own = model?.supported_endpoints ?? []
    const serves =
      own.length > 0 ?
        ` (it serves ${capped(own.map((e) => inlineCode(e)))})`
      : ""
    const alternatives = ctx.models
      .filter(
        (m) => !isVariantId(m.id) && m.supported_endpoints?.includes(endpoint),
      )
      .map((m) => inlineCode(forwardId(m.id)))
    return {
      context: `${inlineCode(forwardId(model?.id ?? ""))} doesn't support ${inlineCode(endpoint)}${serves}.`,
      recovery:
        alternatives.length > 0 ?
          `Models that do: ${capped(alternatives)}.`
        : `No model in your Copilot catalog supports ${inlineCode(endpoint)}.`,
    }
  },
}

/**
 * Copilot rejects a model the account's plan doesn't offer with a 400
 * `model_not_supported`. The proxy deliberately doesn't pin a model (that
 * would fight the client's `/model` picker), so the recovery is to switch
 * models — and we list the ones the plan actually has.
 */
const modelNotSupportedAdvisor: ErrorAdvisor = {
  id: "model_not_supported",
  matches: ({ upstream }) => isModelNotSupported(upstream),
  advise: ({ models }) => {
    const available = listAvailableModels(models)
    if (available.length === 0) {
      return {
        context:
          "GitHub Copilot doesn't offer the requested model on your plan.",
        recovery:
          "maximal couldn't read your Copilot model catalog right now. "
          + "Restart maximal or re-check your sign-in, then retry.",
      }
    }
    const shown = available.slice(0, MAX_LISTED).map((m) => `  • ${m}`)
    if (available.length > MAX_LISTED) {
      shown.push(`  …and ${available.length - MAX_LISTED} more.`)
    }
    return {
      context: "GitHub Copilot doesn't offer the requested model on your plan.",
      recovery:
        "Switch to one of the supported models below — select it in your "
        + "client's model picker, or set the model id explicitly (in Claude "
        + "Code, run /model):\n"
        + shown.join("\n"),
    }
  },
}

/** The registry, most specific first; the first match wins. Add an advisor
 *  here to handle a new error class. */
const ADVISORS: ReadonlyArray<ErrorAdvisor> = [
  endpointNotSupportedAdvisor,
  modelNotSupportedAdvisor,
]

// ── Composition ──────────────────────────────────────────────────────────

/** Frame the advice and append the preserved original error. */
export function composeAdvisedMessage(
  advice: ErrorAdvice,
  upstream: UpstreamError,
): string {
  const original =
    upstream.code ? `${upstream.message} [${upstream.code}]` : upstream.message
  return [
    advice.context,
    "",
    advice.recovery,
    "",
    `Upstream error (${upstream.status}): ${original}`,
  ].join("\n")
}

/**
 * Find an advisor for this upstream error and return the composed,
 * user-friendly message (context + recovery + preserved original), or null
 * when nothing recognizes it (caller forwards the raw body unchanged).
 */
export function adviseUpstreamError(
  status: number,
  body: string,
  context: Omit<AdviceContext, "upstream">,
): string | null {
  const upstream = parseUpstreamError(status, body)
  const ctx: AdviceContext = { ...context, upstream }
  const advisor = ADVISORS.find((a) => a.matches(ctx))
  if (!advisor) return null
  return composeAdvisedMessage(advisor.advise(ctx), upstream)
}
