/**
 * Work IQ rate-limiting behaviour for the connector kit: which tools read
 * and which write, which Microsoft 365 workload (lane) a call hits, and
 * how Microsoft Graph throttling shows inside Work IQ's normal results.
 *
 * Work IQ calls Microsoft Graph for the user and reports Graph's answer
 * per path (`fetch`: `{ results: [{ statusCode, data, error }] }`) or for
 * the whole call (`{ statusCode, error }`), so a throttled Graph request
 * arrives as a successful MCP tool result carrying 429/503/504 — not as an
 * HTTP error from the MCP endpoint.
 */
import type { ToolResult } from "@stuffbucket/maximal-plugin-sdk"

import {
  parseRetryAfter,
  resultBody,
  type ConnectorLimits,
  type InspectedCall,
  type ResultThrottle,
  type ThrottleHooks,
  type ToolKind,
} from "@stuffbucket/maximal-connector-kit"

const THROTTLED = new Set([429, 503, 504])

/** "Retry after 7 seconds", "Retry-After: 7" in error text. */
const RETRY_AFTER_TEXT = /retry[ -]?after\D{0,20}(\d+(?:\.\d+)?)/i

/** Graph error codes that mean "throttled" even without a status. */
const THROTTLE_CODES: Record<string, number> = {
  toomanyrequests: 429,
  activitylimitreached: 429,
  serviceunavailable: 503,
  servicenotavailable: 503,
  gatewaytimeout: 504,
}

/** Tools that never change data. */
const READ_TOOLS = new Set([
  "fetch",
  "fetch_blob",
  "call_function",
  "search_paths",
  "get_schema",
  "list_agents",
  "retrieve",
  "ask",
  "get_debug_link",
])

/** Tools that change data. */
const WRITE_TOOLS = new Set([
  "create_entity",
  "update_entity",
  "delete_entity",
  "upload_blob",
])

/** The Microsoft Search endpoint: a POST that only reads. */
const SEARCH_ACTION = "/search/query"

const COPILOT_TOOLS = new Set([
  "ask",
  "retrieve",
  "list_agents",
  "get_debug_link",
])
const FILE_TOOLS = new Set(["fetch_blob", "upload_blob"])

/**
 * Lane prefixes, tried in order against the normalised path (no leading
 * slash, no `v1.0/`, lower case, `users/{id}` → `users/*`).
 */
const LANES: ReadonlyArray<[string, RegExp]> = [
  [
    "teams",
    /^(?:me\/chats|chats|teams|me\/joinedteams|users\/\*\/(?:chats|joinedteams|teamwork|onlinemeetings)|me\/teamwork|me\/onlinemeetings|copilot\/users\/\*\/onlinemeetings|communications\/onlinemeetings)(?:[/(?]|$)/,
  ],
  [
    "outlook",
    /^(?:me|users\/\*)\/(?:messages|mailfolders|events|calendar|contacts|contactfolders|mailboxsettings|outlook|inferenceclassification|reminderview|findmeetingtimes|sendmail)/,
  ],
  [
    "files",
    /^(?:drives|shares|sites|me\/drive|me\/drives|users\/\*\/drive|users\/\*\/drives|groups\/\*\/drive)(?:[/(?]|$)/,
  ],
]

/** Microsoft Search entity types → lane. */
const SEARCH_LANES: ReadonlyArray<[string, ReadonlyArray<string>]> = [
  ["teams", ["chatmessage"]],
  ["outlook", ["message", "event"]],
  ["files", ["driveitem", "listitem", "site", "list", "drive"]],
]

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

/** `jsonBody` may arrive as an object or as a JSON string. */
function jsonBody(
  args: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const body = args.jsonBody
  if (typeof body !== "string") return record(body)
  try {
    return record(JSON.parse(body))
  } catch {
    return undefined
  }
}

/** The path a call is about (first of `entityUrls`, else the tool's path argument). */
export function primaryPath(args: Record<string, unknown>): string | undefined {
  const urls = args.entityUrls
  if (Array.isArray(urls)) return str(urls[0])
  return (
    str(args.functionUrl)
    ?? str(args.actionUrl)
    ?? str(args.parentUrl)
    ?? str(args.entityUrl)
    ?? str(args.path)
  )
}

function normalise(path: string): string {
  return path
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+/, "")
    .replace(/^(?:v1\.0|beta)\//i, "")
    .toLowerCase()
    .replace(/^users\/[^/(?]+/, "users/*")
    .replace(/^copilot\/users\/[^/(?]+/, "copilot/users/*")
    .replace(/^groups\/[^/(?]+/, "groups/*")
}

function isSearch(tool: string, args: Record<string, unknown>): boolean {
  if (tool !== "do_action") return false
  const action = str(args.actionUrl)
  return (
    action !== undefined && `/${normalise(action)}`.startsWith(SEARCH_ACTION)
  )
}

/** Lane of a Microsoft Search request, from its entity types. */
function searchLane(args: Record<string, unknown>): string | undefined {
  const requests = jsonBody(args)?.requests
  const types = new Set(
    (Array.isArray(requests) ? requests : [])
      .flatMap((request) => {
        const entityTypes = record(request)?.entityTypes
        return Array.isArray(entityTypes) ? (entityTypes as Array<unknown>) : []
      })
      .filter((type): type is string => typeof type === "string")
      .map((type) => type.toLowerCase()),
  )
  return SEARCH_LANES.find(([, names]) =>
    names.some((name) => types.has(name)),
  )?.[0]
}

/** Read or write: the Work IQ table first, then (unknown tools) the annotations. */
export function workIqKind(
  tool: string,
  args: Record<string, unknown>,
): ToolKind | undefined {
  if (READ_TOOLS.has(tool)) return "read"
  if (WRITE_TOOLS.has(tool)) return "write"
  if (tool === "do_action") return isSearch(tool, args) ? "read" : "write"
  if (tool === "accept_eula") return "idempotent-write"
  return undefined
}

/** The Microsoft 365 workload a call hits: `teams`, `outlook`, `files`, `copilot`, or the default lane. */
export function workIqLane(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (COPILOT_TOOLS.has(tool)) return "copilot"
  if (FILE_TOOLS.has(tool)) return "files"
  if (isSearch(tool, args)) return searchLane(args)
  const path = primaryPath(args)
  if (path === undefined) return undefined
  const normalised = normalise(path)
  return LANES.find(([, pattern]) => pattern.test(normalised))?.[0]
}

/** Graph's `Retry-After` wherever Work IQ might put it on an entry. */
function entryRetryAfter(
  entry: Record<string, unknown>,
  now: number,
): number | undefined {
  const error = record(entry.error)
  const inner = record(error?.innerError)
  const headers = record(entry.headers)
  const headerValue =
    headers ?
      Object.entries(headers).find(
        ([key]) => key.toLowerCase() === "retry-after",
      )?.[1]
    : undefined
  for (const value of [
    headerValue,
    entry.retryAfter,
    error?.retryAfter,
    inner?.["retry-after"],
    inner?.retryAfter,
  ]) {
    const parsed =
      typeof value === "string" || typeof value === "number" ?
        parseRetryAfter(value, now)
      : undefined
    if (parsed !== undefined) return parsed
  }
  const message = str(error?.message) ?? str(entry.message)
  const match = message ? RETRY_AFTER_TEXT.exec(message) : null
  return match ? parseRetryAfter(match[1], now) : undefined
}

/** The throttling status of one Graph-style entry, if it is throttled. */
function entryStatus(entry: Record<string, unknown>): number | undefined {
  const status = entry.statusCode
  if (typeof status === "number")
    return THROTTLED.has(status) ? status : undefined
  const code = str(record(entry.error)?.code)
  return code ? THROTTLE_CODES[code.toLowerCase()] : undefined
}

/** Text-only error results ("429 Too Many Requests …"). */
function textStatus(text: string): number | undefined {
  if (/\b429\b|too ?many ?requests/i.test(text)) return 429
  if (/\b503\b|service ?unavailable/i.test(text)) return 503
  return undefined
}

/** `fetch` results: the throttled entries, the strongest status and the longest hint. */
function batchThrottle(
  results: ReadonlyArray<unknown>,
  now: number,
): ResultThrottle | undefined {
  const indexes: Array<number> = []
  let status: number | undefined
  let retryAfterMs: number | undefined
  for (const [index, item] of results.entries()) {
    const entry = record(item)
    const entryThrottle = entry ? entryStatus(entry) : undefined
    if (!entry || entryThrottle === undefined) continue
    indexes.push(index)
    status = status === 429 ? 429 : entryThrottle
    const hint = entryRetryAfter(entry, now)
    if (hint !== undefined) retryAfterMs = Math.max(retryAfterMs ?? 0, hint)
  }
  if (status === undefined) return undefined
  return {
    status,
    indexes,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

/** An error result with only text ("429 Too Many Requests. Retry-After: 4"). */
function textThrottle(
  result: ToolResult,
  now: number,
): ResultThrottle | undefined {
  if (!result.isError) return undefined
  const text = result.content.find((block) => block.type === "text")?.text
  if (typeof text !== "string") return undefined
  const status = textStatus(text)
  if (status === undefined) return undefined
  const match = RETRY_AFTER_TEXT.exec(text)
  const retryAfterMs = match ? parseRetryAfter(match[1], now) : undefined
  return { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

/** Throttling inside a Work IQ result: per path for `fetch`, else for the whole call. */
export function inspectWorkIqResult(
  result: ToolResult,
  call: InspectedCall,
): ResultThrottle | undefined {
  const body = resultBody(result)
  const results = body?.results
  if (Array.isArray(results)) return batchThrottle(results, call.now)
  if (!body)
    return call.tool === "fetch" ? undefined : textThrottle(result, call.now)
  const status = entryStatus(body)
  if (status === undefined) return undefined
  const retryAfterMs = entryRetryAfter(body, call.now)
  return { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

/** Work IQ's throttling hooks for `defineRemoteMcpConnector`. */
export const WORKIQ_THROTTLE: ThrottleHooks = {
  kind: (tool, args) => workIqKind(tool, args),
  lane: (tool, args) => workIqLane(tool, args),
  // Copilot answers are slow and expensive: one retry at most.
  attempts: (tool) => (tool === "ask" ? 2 : undefined),
  inspect: inspectWorkIqResult,
  batch: [{ tool: "fetch", argument: "entityUrls" }],
}

/**
 * Work IQ lane caps (the numbers live in the manifest). Teams is throttled
 * hardest by Graph (per-chat and per-tenant limits), Outlook allows four
 * concurrent requests per mailbox, file reads carry up to 4 MB each, and
 * Copilot answers are heavy.
 */
export const WORKIQ_LIMITS: ConnectorLimits = {
  lanes: {
    teams: { maxConcurrency: 2, minIntervalMs: 500 },
    outlook: { maxConcurrency: 4 },
    files: { maxConcurrency: 2 },
    copilot: { maxConcurrency: 2 },
  },
}
