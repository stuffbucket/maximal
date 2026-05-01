/**
 * Interceptor state machine + per-request state for web-tools.
 *
 * Closes domain D4. Transitions are exhaustive over the input alphabet
 * (upstream SSE events). Per-request `RequestState` holds use counters
 * and the resolved active tool decls so policy checks are O(1).
 *
 * Spec: docs/spec/web-tools.md, section "Implementation outline".
 */

import type {
  WebSearchToolDecl,
  WebFetchToolDecl,
  WebToolDecl,
} from "./web-tools-types"

import {
  TOOL_NAME,
  MAX_URL_LENGTH,
  DEFAULT_MAX_USES,
  type ToolName,
  type WebSearchErrorCode,
  type WebFetchErrorCode,
} from "./web-tools-vocab"

// ────────────────────────────────────────────────────────────────────
// Per-request state.
// ────────────────────────────────────────────────────────────────────

export interface RequestState {
  /** Resolved tool decls keyed by tool name; only present for tools the
   *  request actually declared. Absence means the proxy must pass the
   *  block through unchanged (no interception). */
  active: {
    [TOOL_NAME.webSearch]?: WebSearchToolDecl
    [TOOL_NAME.webFetch]?: WebFetchToolDecl
  }
  /** Use counter per tool name. Increments on each successful or
   *  error-returning invocation; rejection by max_uses_exceeded does
   *  NOT increment. */
  uses: {
    [TOOL_NAME.webSearch]: number
    [TOOL_NAME.webFetch]: number
  }
}

export function newRequestState(
  declared: ReadonlyArray<WebToolDecl>,
): RequestState {
  const active: RequestState["active"] = {}
  for (const decl of declared) {
    if (decl.name === TOOL_NAME.webSearch) active[TOOL_NAME.webSearch] = decl
    else active[TOOL_NAME.webFetch] = decl
  }
  return {
    active,
    uses: { [TOOL_NAME.webSearch]: 0, [TOOL_NAME.webFetch]: 0 },
  }
}

export function isToolActive(state: RequestState, name: ToolName): boolean {
  return state.active[name] !== undefined
}

// ────────────────────────────────────────────────────────────────────
// Interceptor state machine.
// ────────────────────────────────────────────────────────────────────

interface BufferedToolUse {
  id: string
  name: ToolName
  /** Anthropic streams `input_json_delta` events; we accumulate the
   *  partial JSON here and `JSON.parse` once `content_block_stop`
   *  arrives. */
  partialJson: string
}

export type InterceptorState =
  | { kind: "idle" }
  | { kind: "buffering"; tool: BufferedToolUse }

export const IDLE: InterceptorState = { kind: "idle" }

export function startBuffering(id: string, name: ToolName): InterceptorState {
  return { kind: "buffering", tool: { id, name, partialJson: "" } }
}

export function appendDelta(
  state: InterceptorState,
  jsonDelta: string,
): InterceptorState {
  if (state.kind !== "buffering") {
    throw new Error(
      "appendDelta: not in buffering state — caller must guard with state.kind",
    )
  }
  return {
    kind: "buffering",
    tool: { ...state.tool, partialJson: state.tool.partialJson + jsonDelta },
  }
}

// ────────────────────────────────────────────────────────────────────
// Policy checks. Run BEFORE invoking the executor. On `ok: false`, the
// caller emits a `*_error` block (counter does NOT increment).
// ────────────────────────────────────────────────────────────────────

export type PolicyResult<E> = { ok: true } | { ok: false; code: E }

/** Domain match honors `*.example.com` glob and exact host match. Any
 *  non-empty `allowed_domains` list is implicitly closed: a URL whose
 *  host is not in the allowlist is denied. `blocked_domains` is always
 *  applied after allowlist. */
function hostMatches(host: string, patterns: ReadonlyArray<string>): boolean {
  return patterns.some((pat) => {
    if (pat.startsWith("*.")) return host.endsWith(pat.slice(1))
    return host === pat
  })
}

export function checkSearchPolicy(
  state: RequestState,
  input: unknown,
): PolicyResult<WebSearchErrorCode> {
  const decl = state.active[TOOL_NAME.webSearch]
  if (!decl) return { ok: false, code: "unavailable" }

  if (
    typeof input !== "object"
    || input === null
    || typeof (input as { query?: unknown }).query !== "string"
  ) {
    return { ok: false, code: "invalid_input" }
  }
  const query = (input as { query: string }).query

  const maxUses = decl.max_uses ?? DEFAULT_MAX_USES.webSearch
  if (state.uses[TOOL_NAME.webSearch] >= maxUses) {
    return { ok: false, code: "max_uses_exceeded" }
  }

  // Anthropic doesn't publish a query-length cap; pick a sane bound.
  if (query.length === 0 || query.length > 2000) {
    return { ok: false, code: "query_too_long" }
  }

  return { ok: true }
}

function parseFetchUrl(
  input: unknown,
):
  | { ok: true; url: string; parsed: URL }
  | { ok: false; code: WebFetchErrorCode } {
  if (
    typeof input !== "object"
    || input === null
    || typeof (input as { url?: unknown }).url !== "string"
  ) {
    return { ok: false, code: "invalid_input" }
  }
  const url = (input as { url: string }).url
  if (url.length > MAX_URL_LENGTH) return { ok: false, code: "url_too_long" }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, code: "invalid_input" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "invalid_input" }
  }
  return { ok: true, url, parsed }
}

function checkDomainPolicy(
  host: string,
  decl: WebFetchToolDecl,
): PolicyResult<WebFetchErrorCode> {
  if (decl.blocked_domains?.length && hostMatches(host, decl.blocked_domains)) {
    return { ok: false, code: "url_not_allowed" }
  }
  if (
    decl.allowed_domains?.length
    && !hostMatches(host, decl.allowed_domains)
  ) {
    return { ok: false, code: "url_not_allowed" }
  }
  return { ok: true }
}

export function checkFetchPolicy(
  state: RequestState,
  input: unknown,
): PolicyResult<WebFetchErrorCode> {
  const decl = state.active[TOOL_NAME.webFetch]
  if (!decl) return { ok: false, code: "unavailable" }

  const parsed = parseFetchUrl(input)
  if (!parsed.ok) return parsed

  const maxUses = decl.max_uses ?? DEFAULT_MAX_USES.webFetch
  if (state.uses[TOOL_NAME.webFetch] >= maxUses) {
    return { ok: false, code: "max_uses_exceeded" }
  }

  return checkDomainPolicy(parsed.parsed.hostname, decl)
}

export function recordUse(state: RequestState, name: ToolName): void {
  state.uses[name]++
}
