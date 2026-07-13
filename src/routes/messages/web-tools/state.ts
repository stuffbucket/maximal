/**
 * Per-request use counters + policy checks for the web-tools agent loop.
 * `RequestState` carries the resolved active tool declarations so policy
 * checks are O(1).
 */

import type { WebSearchToolDecl, WebFetchToolDecl, WebToolDecl } from "./types"

import {
  TOOL_NAME,
  MAX_URL_LENGTH,
  DEFAULT_MAX_USES,
  type ToolName,
  type WebSearchErrorCode,
  type WebFetchErrorCode,
} from "./vocab"

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

// ────────────────────────────────────────────────────────────────────
// Policy checks. Run BEFORE invoking the executor. On `ok: false`, the
// caller emits a `*_error` block (counter does NOT increment).
// ────────────────────────────────────────────────────────────────────

export type PolicyResult<E> = { ok: true } | { ok: false; code: E }

/** True iff `host` satisfies an Anthropic web-tool domain policy, per the
 *  server-tools spec: subdomains of a listed domain are included
 *  (`example.com` covers `docs.example.com`); a bare-host entry with no dot
 *  boundary still matches exactly. `allowed_domains` and `blocked_domains`
 *  are mutually exclusive per spec — if both are somehow present, blocked
 *  is evaluated first. Path/wildcard entries (search-only) are matched on
 *  their host portion here; finer path matching is left to the backend.
 *  Shared by web_search result post-filtering (see exec.ts). */
export function isHostAllowed(
  host: string,
  policy: { allowed_domains?: Array<string>; blocked_domains?: Array<string> },
): boolean {
  if (policy.blocked_domains?.length) {
    return !policy.blocked_domains.some((d) => hostCoveredBy(host, d))
  }
  if (policy.allowed_domains?.length) {
    return policy.allowed_domains.some((d) => hostCoveredBy(host, d))
  }
  return true
}

/** Does `entry` (a bare domain, possibly with a `/path` or trailing `/*`)
 *  cover `host`? Matches the listed host exactly OR as a parent domain
 *  (subdomains auto-included). The path portion is ignored for host
 *  comparison. */
function hostCoveredBy(host: string, entry: string): boolean {
  const listedHost = entry.split("/")[0].toLowerCase()
  const h = host.toLowerCase()
  return h === listedHost || h.endsWith(`.${listedHost}`)
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

/** Domain policy for web_fetch. Routed through the same spec-correct
 *  `isHostAllowed` matcher web_search uses (subdomains auto-included,
 *  blocked-first, path/wildcard entries matched on host portion) so an
 *  identical `allowed_domains`/`blocked_domains` list behaves the same
 *  across both tools. A blocked host, or a host outside a non-empty
 *  allowlist, yields `url_not_allowed`. */
function checkDomainPolicy(
  host: string,
  decl: WebFetchToolDecl,
): PolicyResult<WebFetchErrorCode> {
  if (!isHostAllowed(host, decl)) {
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
