import type {
  ToolAnnotations,
  ToolResult,
} from "@stuffbucket/maximal-plugin-sdk"

/**
 * What a tool call does to the service, for retry decisions:
 * - `read` — no side effects; retried on 429/503/504 and once after a lost
 *   connection;
 * - `idempotent-write` — repeating it is harmless; retried on 429, once on
 *   503/504;
 * - `write` — retried only when the server refused it outright (429);
 *   after a 5xx, timeout or lost connection the outcome is unknown and the
 *   caller is told to check before retrying.
 */
export type ToolKind = "read" | "idempotent-write" | "write"

/** Throttling found inside a successful tool result. */
export interface ResultThrottle {
  /** 429, 503 or 504. */
  status: number
  /** The service's `Retry-After`, in ms, when the result carries one. */
  retryAfterMs?: number
  /**
   * For batch results: indexes of the throttled entries (the others
   * succeeded or failed for good). Absent: the whole call was throttled.
   */
  indexes?: ReadonlyArray<number>
}

/** The call a result belongs to, for `ThrottleHooks.inspect`. */
export interface InspectedCall {
  tool: string
  args: Record<string, unknown>
  /** Clock time, for HTTP-date `Retry-After` values. */
  now: number
}

/** A tool whose list argument the kit may split and partly re-issue. */
export interface BatchTool {
  /** Tool name, e.g. `fetch`. */
  tool: string
  /** The string-array argument, e.g. `entityUrls`. */
  argument: string
  /** Property of the (structured or JSON text) result holding one entry per item, in order. Default `results`. */
  results?: string
}

/**
 * Connector-specific rate-limiting behaviour (code, not manifest): how to
 * classify tools, which lane a call uses, and how throttling shows inside a
 * successful result. Everything is optional; the kit's defaults use the
 * tool annotations and HTTP status only.
 */
export interface ThrottleHooks {
  /** `undefined` falls back to the annotations (`readOnlyHint` ⇒ read, `idempotentHint` ⇒ idempotent write, else write). */
  kind?(
    tool: string,
    args: Record<string, unknown>,
    annotations: ToolAnnotations | undefined,
  ): ToolKind | undefined
  /** Lane for per-lane caps and cool-downs (`undefined` ⇒ `default`). */
  lane?(tool: string, args: Record<string, unknown>): string | undefined
  /** Fewer attempts for expensive tools (never more than the policy's). */
  attempts?(tool: string, args: Record<string, unknown>): number | undefined
  /** Throttling reported inside a result the server returned normally. */
  inspect?(result: ToolResult, call: InspectedCall): ResultThrottle | undefined
  /** Batch tools: split long lists and re-issue only throttled entries. */
  batch?: ReadonlyArray<BatchTool>
}

/** The kit's classification from MCP annotations (hints, so the conservative answer wins when absent). */
export function kindFromAnnotations(
  annotations: ToolAnnotations | undefined,
): ToolKind {
  if (annotations?.readOnlyHint === true) return "read"
  if (annotations?.idempotentHint === true) return "idempotent-write"
  return "write"
}

/** The body of a result: `structuredContent`, else the first text block parsed as JSON. */
export function resultBody(
  result: ToolResult,
): Record<string, unknown> | undefined {
  if (result.structuredContent) return result.structuredContent
  const text = result.content.find((block) => block.type === "text")?.text
  if (typeof text !== "string") return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return (
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ) ?
        (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
