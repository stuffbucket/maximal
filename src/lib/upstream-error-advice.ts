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

import type { Model } from "~/services/copilot/get-models"

import { forwardId, isVariantId } from "./anthropic-id-rewrite"

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

/**
 * Copilot rejects a model the account's plan doesn't offer with a 400
 * `model_not_supported`. The proxy deliberately doesn't pin a model (that
 * would fight the client's `/model` picker), so the recovery is to switch
 * models — and we list the ones the plan actually has.
 */
const modelNotSupportedAdvisor: ErrorAdvisor = {
  id: "model_not_supported",
  matches: ({ upstream }) => {
    if (upstream.status !== 400) return false
    if (upstream.code === "model_not_supported") return true
    return /model is not supported|model_not_supported/i.test(upstream.message)
  },
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
      shown.push(`  …and ${available.length - MAX_LISTED} more (see /model).`)
    }
    return {
      context: "GitHub Copilot doesn't offer the requested model on your plan.",
      recovery:
        "Switch to a supported model — in Claude Code run /model and pick "
        + "one (other clients: set the model id explicitly):\n"
        + shown.join("\n"),
    }
  },
}

/** The registry. Add an advisor here to handle a new error class. */
const ADVISORS: ReadonlyArray<ErrorAdvisor> = [modelNotSupportedAdvisor]

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
  models: ReadonlyArray<Model>,
): string | null {
  const upstream = parseUpstreamError(status, body)
  const ctx: AdviceContext = { upstream, models }
  const advisor = ADVISORS.find((a) => a.matches(ctx))
  if (!advisor) return null
  return composeAdvisedMessage(advisor.advise(ctx), upstream)
}
