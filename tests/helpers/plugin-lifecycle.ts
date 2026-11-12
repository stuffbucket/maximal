/**
 * The recording side of the end-to-end plugin lifecycle test
 * (`tests/e2e-plugin-lifecycle.test.ts`): what an MCP client sends and
 * receives on `/mcp/<id>` (JSON-RPC, both directions), the Settings events
 * stream (`plugins.changed` frames), Settings API exchanges, and `step()`,
 * which runs one lifecycle step and records, normalised, everything that
 * crossed a boundary during it. Raw payloads stay available for secret scans.
 */

import type { Transport } from "@modelcontextprotocol/client"
import type {
  LifecycleHarness,
  Normalizer,
} from "@stuffbucket/maximal-plugin-host/testing"
import type {
  FakeRemoteMcp,
  RecordedRequest,
} from "@stuffbucket/maximal-plugin-workiq/testing"

import { formatEntry } from "@stuffbucket/maximal-plugin-host/testing"
import fs from "node:fs"
import path from "node:path"

import { PATHS } from "~/lib/platform/paths"
import { DEFAULT_ON_PLUGINS } from "~/lib/plugins/settings"

import type { FakeClaudeCli } from "./fake-claude-cli"

// ── Recorders ──────────────────────────────────────────────────────────

export interface McpMessage {
  dir: "send" | "receive"
  message: unknown
}

/**
 * Wrap a client transport so every JSON-RPC message it sends and receives
 * is appended to `log`. The wrapper forwards to the real transport (its
 * methods bound to it, so private fields keep working).
 */
export function recordingTransport<T extends Transport>(
  transport: T,
  log: Array<McpMessage>,
): T {
  return new Proxy(transport, {
    get(target, property) {
      if (property === "send") {
        return (message: unknown, options?: unknown) => {
          log.push({ dir: "send", message: structuredClone(message) })
          return (target.send as (m: unknown, o?: unknown) => Promise<void>)(
            message,
            options,
          )
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === "function" ?
          (value as (...args: Array<unknown>) => unknown).bind(target)
        : value
    },
    set(target, property, value: unknown) {
      if (property === "onmessage" && typeof value === "function") {
        const handler = value as (message: unknown, extra?: unknown) => void
        // The MCP `Transport` contract is this callback property.
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- see above
        target.onmessage = (message: unknown, extra?: unknown) => {
          log.push({ dir: "receive", message: structuredClone(message) })
          handler(message, extra)
        }
        return true
      }
      return Reflect.set(target, property, value, target)
    },
  })
}

export interface SseFrame {
  event: string
  data: string
}

/** A Settings events stream reader (`GET /settings/api/events`). */
export interface SseRecorder {
  readonly frames: ReadonlyArray<SseFrame>
  close(): Promise<void>
}

function parseFrame(block: string): SseFrame {
  let event = "message"
  const data: Array<string> = []
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart())
  }
  return { event, data: data.join("\n") }
}

export async function openSse(url: string, key: string): Promise<SseRecorder> {
  const controller = new AbortController()
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (!response.ok || !response.body)
    throw new Error(`events stream answered ${response.status}`)
  const frames: Array<SseFrame> = []
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const pump = (async () => {
    let buffer = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += value
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        frames.push(...blocks.map((block) => parseFrame(block)))
      }
    } catch {
      // Aborted on close.
    }
  })()
  return {
    frames,
    async close() {
      controller.abort()
      await pump
    },
  }
}

export interface ApiExchange {
  request: string
  body?: unknown
  status: number
  /** Raw response text (for secret scans). */
  text: string
  response: unknown
}

/** Settings API calls with a bearer key; every exchange is logged. */
export function settingsApi(
  origin: string,
  key: string,
  log: Array<ApiExchange>,
) {
  return async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<ApiExchange> => {
    const response = await fetch(`${origin}/settings/api${route}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      // Not JSON; keep the text.
    }
    const exchange: ApiExchange = {
      request: `${method} /settings/api${route}`,
      ...(body === undefined ? {} : { body }),
      status: response.status,
      text,
      response: parsed,
    }
    log.push(exchange)
    return exchange
  }
}

// ── Normalisation ──────────────────────────────────────────────────────

interface ToolLike {
  name: string
  group?: string
  permission?: string
  permissionSource?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const isToolList = (key: string, item: unknown): item is Array<ToolLike> =>
  key === "tools"
  && Array.isArray(item)
  && item.every((tool) => isRecord(tool) && typeof tool.name === "string")

/** Tool arrays become one line per tool (full definitions are asserted separately). */
function summarizeTools(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => summarizeTools(item))
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      isToolList(key, item) ?
        item.map((tool) =>
          [
            tool.name,
            tool.group,
            tool.permission && `${tool.permission}/${tool.permissionSource}`,
          ]
            .filter(Boolean)
            .join(" "),
        )
      : summarizeTools(item)
  }
  return out
}

// ── The run ────────────────────────────────────────────────────────────

export interface StepRecord {
  step: string
  plugin: Array<string>
  api?: Array<unknown>
  mcp?: Array<unknown>
  listChanged?: true
  progress?: Array<unknown>
  sse?: unknown
  upstream?: Array<string>
  storage?: Array<string>
  settingsJson?: unknown
  configJson?: unknown
  /** Claude Code's user-scope `mcpServers` when it changed. */
  claudeMcpServers?: unknown
}

/** Claude Code as Maximal sees it: the fake install and its user config. */
export interface ClaudeSide {
  cli: FakeClaudeCli
  /** `$CLAUDE_CONFIG_DIR/.claude.json`. */
  configFile: string
}

export interface Run {
  /** The plugin under test. */
  id: string
  apiKey: string
  /** The upstream bearer token (shown as `bearer` in upstream lines). */
  bearer: string
  harness: LifecycleHarness
  fake: FakeRemoteMcp
  normalizer: Normalizer
  origin: string
  api: ReturnType<typeof settingsApi>
  apiLog: Array<ApiExchange>
  mcpLog: Array<McpMessage>
  sse: SseRecorder
  steps: Array<StepRecord>
  /** Last full view per `<channel>:<plugin id>`, for deltas. */
  views: Map<string, Record<string, unknown>>
  /** Last recorded `plugins.changed` list (normalised). */
  lastSse: string | undefined
  /** Close MCP sessions, stop plugins and the app server. Idempotent. */
  closeApp(): Promise<void>
  claude: ClaudeSide
}

/** Claude Code's user-scope MCP servers (`.claude.json` → `mcpServers`). */
export function claudeMcpServers(run: Run): Record<string, unknown> {
  const text = readText(run.claude.configFile)
  if (text === undefined) return {}
  const servers = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers
  return isRecord(servers) ? servers : {}
}

/**
 * A Settings view (list item or detail) in full the first time it is seen
 * on `channel`, then only the top-level fields that changed since.
 */
function viewDelta(run: Run, channel: string, view: unknown): unknown {
  if (!isRecord(view) || typeof view.id !== "string") return view
  const key = `${channel}:${view.id}`
  const previous = run.views.get(key)
  run.views.set(key, view)
  if (!previous) return view
  const changed: Record<string, unknown> = {}
  for (const field of new Set([
    ...Object.keys(previous),
    ...Object.keys(view),
  ])) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(view[field]))
      changed[field] = Object.hasOwn(view, field) ? view[field] : "(removed)"
  }
  return Object.keys(changed).length === 0 ?
      { id: view.id, "(unchanged)": true }
    : { id: view.id, "(changed)": changed }
}

/**
 * PATCH answers once the plugin is (re)started; what it does next in the
 * background races the response, so these fields are left out of recorded
 * PATCH responses (the plugin transcript and SSE record them).
 */
const PATCH_BACKGROUND_FIELDS = new Set([
  "status",
  "tools",
  "toolCounts",
  "toolsSource",
  "catalogUpdatedAt",
])

/** A Settings API exchange, normalised, with views as deltas. */
function apiRecord(run: Run, exchange: ApiExchange): unknown {
  const { text: _text, ...rest } = exchange
  const normal = run.normalizer.value(summarizeTools(rest)) as {
    response: unknown
  }
  const response = normal.response
  if (isRecord(response) && Array.isArray(response.plugins)) {
    normal.response = {
      plugins: response.plugins.map((view) => viewDelta(run, "list", view)),
    }
  } else if (isRecord(response) && "settingsVersion" in response) {
    normal.response =
      exchange.request.startsWith("PATCH") ?
        viewDelta(
          run,
          "patch",
          Object.fromEntries(
            Object.entries(response).filter(
              ([field]) => !PATCH_BACKGROUND_FIELDS.has(field),
            ),
          ),
        )
      : viewDelta(run, "detail", response)
  }
  return normal
}

function upstreamLine(run: Run, request: RecordedRequest): string {
  let auth = "other"
  if (request.authorization === null) auth = "none"
  else if (request.authorization === `Bearer ${run.bearer}`) auth = "bearer"
  const session =
    request.sessionId === null ?
      "-"
    : run.normalizer.ordinal("session", request.sessionId)
  const call = [request.rpc, request.tool].filter(Boolean).join(" ")
  return `${request.method} ${call || request.path} → ${request.status} session=${session} auth=${auth} protocol=${request.protocolVersion ?? "-"}`
}

/**
 * Upstream requests in arrival order, except what races by nature: the
 * standalone event-stream GET (opened alongside the next request) is
 * listed after the rest, and parallel session closes (DELETE) are sorted.
 */
function upstreamLines(
  run: Run,
  requests: ReadonlyArray<RecordedRequest>,
): Array<string> {
  const ordered: Array<string> = []
  const streams: Array<string> = []
  let closes: Array<string> = []
  const flushCloses = () => {
    ordered.push(...closes.sort())
    closes = []
  }
  for (const request of requests) {
    const line = upstreamLine(run, request)
    if (request.method === "GET") streams.push(line)
    else if (request.method === "DELETE") closes.push(line)
    else {
      flushCloses()
      ordered.push(line)
    }
  }
  flushCloses()
  return [...ordered, ...streams.sort()]
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/**
 * `config.json` → `plugins`, without the entries the boot migration writes for
 * the default-on plugins (`DEFAULT_ON_PLUGINS`): this walk is about the
 * plugin under test, and those are covered by `plugins-default-on.test.ts`.
 */
export function configPlugins(): unknown {
  const text = readText(PATHS.CONFIG_PATH)
  if (text === undefined) return "(absent)"
  const plugins = (JSON.parse(text) as { plugins?: Record<string, unknown> })
    .plugins
  if (plugins === undefined) return "(none)"
  const rest = Object.fromEntries(
    Object.entries(plugins).filter(([id]) => !DEFAULT_ON_PLUGINS.includes(id)),
  )
  return Object.keys(rest).length === 0 && Object.keys(plugins).length > 0 ?
      "(none)"
    : rest
}

export function settingsFile(run: Run): string {
  return path.join(run.harness.storageRoot, run.id, "settings.json")
}

async function pluginsList(run: Run): Promise<unknown> {
  const response = await fetch(`${run.origin}/settings/api/plugins`, {
    headers: { authorization: `Bearer ${run.apiKey}` },
  })
  return ((await response.json()) as { plugins: unknown }).plugins
}

/** Wait until the last `plugins.changed` frame shows what the list does now. */
async function sseCaughtUp(run: Run): Promise<void> {
  await run.harness.waitFor(
    async () => {
      const frames = run.sse.frames.filter((f) => f.event === "plugins.changed")
      const last = frames.at(-1)
      if (!last) return false
      const sent = run.normalizer.value(
        (JSON.parse(last.data) as { plugins: unknown }).plugins,
      )
      return (
        JSON.stringify(sent)
        === JSON.stringify(run.normalizer.value(await pluginsList(run)))
      )
    },
    { timeoutMs: 5000, intervalMs: 25, message: "SSE did not catch up" },
  )
}

const isListChanged = (entry: McpMessage) =>
  entry.dir === "receive"
  && isRecord(entry.message)
  && entry.message.method === "notifications/tools/list_changed"

const isProgress = (entry: McpMessage) =>
  entry.dir === "receive"
  && isRecord(entry.message)
  && entry.message.method === "notifications/progress"

export const listChangedCount = (log: ReadonlyArray<McpMessage>) =>
  log.filter((entry) => isListChanged(entry)).length

/** Wait for a `tools/list_changed` after `since`, then for the burst to end. */
export async function listChangedAfter(run: Run, since: number): Promise<void> {
  await run.harness.waitFor(() => listChangedCount(run.mcpLog) > since, {
    message: "no tools/list_changed",
  })
  let seen = listChangedCount(run.mcpLog)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const now = listChangedCount(run.mcpLog)
    if (now === seen) return
    seen = now
  }
}

interface Marks {
  plugin: number
  api: number
  mcp: number
  upstream: number
  sse: number
  storage: Array<string>
  settings: string | undefined
  config: string
  claudeServers: string
}

function sseRecord(run: Run, marks: Marks): unknown {
  const last = run.sse.frames
    .slice(marks.sse)
    .findLast((frame) => frame.event === "plugins.changed")
  if (!last) return undefined
  const views = run.normalizer.value(
    summarizeTools((JSON.parse(last.data) as { plugins: unknown }).plugins),
  ) as Array<unknown>
  const text = JSON.stringify(views)
  if (text === run.lastSse) return undefined
  run.lastSse = text
  return views.map((view) => viewDelta(run, "sse", view))
}

/** What crossed each boundary since `marks`. */
function stepRecord(run: Run, name: string, marks: Marks): StepRecord {
  const { normalizer } = run
  const record: StepRecord = {
    step: name,
    plugin: run.harness
      .transcript({ since: marks.plugin + 1 })
      .map((entry) => formatEntry(entry)),
  }
  const api = run.apiLog.slice(marks.api)
  if (api.length > 0)
    record.api = api.map((exchange) => apiRecord(run, exchange))
  const mcp = run.mcpLog.slice(marks.mcp)
  // Notifications ride other streams than the responses (list_changed the
  // standalone GET, progress interleaves with relayed requests), so they
  // are kept out of the ordered sequence: list_changed as a flag, progress
  // in its own (ordered) list.
  const messages = mcp.filter(
    (entry) => !isListChanged(entry) && !isProgress(entry),
  )
  if (messages.length > 0)
    record.mcp = messages.map((entry) =>
      normalizer.value({ [entry.dir]: summarizeTools(entry.message) }),
    )
  const progress = mcp.filter((entry) => isProgress(entry))
  if (progress.length > 0)
    record.progress = progress.map((entry) =>
      normalizer.value((entry.message as { params?: unknown }).params),
    )
  if (messages.length !== mcp.length) record.listChanged = true
  const sse = sseRecord(run, marks)
  if (sse !== undefined) record.sse = sse
  const upstream = run.fake.requests.slice(marks.upstream)
  if (upstream.length > 0) record.upstream = upstreamLines(run, upstream)
  const storage = run.harness.files(run.id)
  if (JSON.stringify(storage) !== JSON.stringify(marks.storage))
    record.storage = storage
  const settings = readText(settingsFile(run))
  if (settings !== marks.settings) {
    record.settingsJson = normalizer.value(
      settings === undefined ? "(absent)" : (
        summarizeTools(JSON.parse(settings) as unknown)
      ),
    )
  }
  const config = configPlugins()
  if (JSON.stringify(config) !== marks.config)
    record.configJson = normalizer.value(config)
  const servers = claudeMcpServers(run)
  if (JSON.stringify(servers) !== marks.claudeServers)
    record.claudeMcpServers = normalizer.value(servers)
  return record
}

/**
 * Run one lifecycle step, settle (host queues, fibers, the SSE stream), and
 * record, normalised, everything that crossed a boundary during it.
 */
export async function step(
  run: Run,
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  const marks: Marks = {
    plugin: run.harness.mark(),
    api: run.apiLog.length,
    mcp: run.mcpLog.length,
    upstream: run.fake.requests.length,
    sse: run.sse.frames.length,
    storage: run.harness.files(run.id),
    settings: readText(settingsFile(run)),
    config: JSON.stringify(configPlugins()),
    claudeServers: JSON.stringify(claudeMcpServers(run)),
  }
  run.harness.step(name)
  try {
    await body()
    await run.harness.flush()
    await sseCaughtUp(run)
  } catch (error) {
    throw new Error(
      `step "${name}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  run.steps.push(stepRecord(run, name, marks))
}

export function textOf(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : []
  const block = content.find(
    (item): item is { type: "text"; text: string } =>
      isRecord(item) && item.type === "text",
  )
  return block?.text ?? ""
}
