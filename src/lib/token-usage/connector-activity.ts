/**
 * Live connector use for the Sessions view: Work IQ (MCP tool calls the
 * proxy runs for a client) and FigJam (calls through its bridge). It is kept
 * apart from the session ledger on purpose: a connector call is not a model
 * request, so it adds no tokens, cache or session.
 *
 * Only counts, times and the tool's name are held, in memory, never a call's
 * arguments or results. Every call has a deadline (`MAX_CALL_MS`) and a
 * finished one is listed for `LINGER_MS` more, so a poll that lands between
 * two quick calls still sees them and a call that never reports its end
 * can't keep a row up.
 *
 * Work IQ runs in this process, so the MCP route records its calls here.
 * FigJam's bridge runs in the plugin child: it reports through its status
 * (`PluginStatus.activity`), which the caller passes as `reported`.
 */

import type { PluginActivity } from "@stuffbucket/maximal-plugin-sdk/gateway"

import type { ConnectorActivityView } from "./sessions-schema"

/** The connectors listed, in the order they are listed. */
export const CONNECTOR_IDS = ["workiq", "figjam"] as const
export type ConnectorId = (typeof CONNECTOR_IDS)[number]

/** How long a finished call keeps its row up. */
export const LINGER_MS = 10_000
/** A call that hasn't ended by now is no longer counted as running. */
export const MAX_CALL_MS = 300_000
/** Most calls remembered per connector; the oldest make room. */
const MAX_CALLS = 256
const MAX_TOOL_NAME = 80

interface Ledger {
  /** Running calls: id to start time. */
  calls: Map<number, number>
  lastActivityAtMs: number
  lastTool: string | null
}

const ledgers = new Map<ConnectorId, Ledger>()
let nextCall = 0

const isConnector = (id: string): id is ConnectorId =>
  (CONNECTOR_IDS as ReadonlyArray<string>).includes(id)

/** A tool name as it may be shown: no control characters, bounded. */
function toolLabel(name: string): string | null {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = name.replaceAll(/[\u0000-\u001F\u007F]/g, " ").trim()
  return clean === "" ? null : clean.slice(0, MAX_TOOL_NAME)
}

/**
 * Record that `pluginId` started running `tool`. Returns the function that
 * records its end (safe to call twice); `end(false)` says the call was
 * refused before it ran (a blocked tool, say), which leaves no trace. A
 * plugin that isn't listed is ignored.
 */
export function beginConnectorCall(
  pluginId: string,
  tool: string,
  nowMs: number = Date.now(),
): (ran?: boolean) => void {
  if (!isConnector(pluginId)) return () => {}
  let ledger = ledgers.get(pluginId)
  if (!ledger) {
    ledger = { calls: new Map(), lastActivityAtMs: 0, lastTool: null }
    ledgers.set(pluginId, ledger)
  }
  const owner = ledger
  if (owner.calls.size >= MAX_CALLS) {
    const oldest = owner.calls.keys().next()
    if (oldest.done !== true) owner.calls.delete(oldest.value)
  }
  const before = {
    lastActivityAtMs: owner.lastActivityAtMs,
    lastTool: owner.lastTool,
  }
  const call = nextCall++
  owner.calls.set(call, nowMs)
  owner.lastActivityAtMs = nowMs
  owner.lastTool = toolLabel(tool)
  return (ran = true) => {
    if (!owner.calls.delete(call)) return
    if (ran) {
      owner.lastActivityAtMs = Date.now()
    } else if (owner.lastActivityAtMs === nowMs) {
      // Nothing else has happened since: forget this call altogether.
      Object.assign(owner, before)
    }
  }
}

/** Calls in progress and when each began, from the proxy's own ledger and a
 *  connector's report of itself. Calls past their deadline are dropped. */
function runningCalls(
  ledger: Ledger | undefined,
  reported: Readonly<PluginActivity> | undefined,
  nowMs: number,
): { count: number; startedAtMs: number | null; expiresAtMs: number | null } {
  const starts: Array<number> = []
  const deadlines: Array<number> = []
  if (ledger) {
    for (const [call, startedAt] of ledger.calls) {
      const deadline = startedAt + MAX_CALL_MS
      if (nowMs >= deadline) ledger.calls.delete(call)
      else {
        starts.push(startedAt)
        deadlines.push(deadline)
      }
    }
  }
  let count = starts.length
  if (reported && reported.activeCalls > 0 && reported.startedAtMs !== null) {
    // Older plugins do not report an aggregate deadline. Newer ones can keep
    // overlapping calls visible until the newest call's deadline, but never
    // claim more than one full call window from the current observation.
    const deadline = Math.min(
      reported.expiresAtMs ?? reported.startedAtMs + MAX_CALL_MS,
      nowMs + MAX_CALL_MS,
    )
    if (nowMs < deadline) {
      count += reported.activeCalls
      starts.push(reported.startedAtMs)
      deadlines.push(deadline)
    }
  }
  return {
    count,
    startedAtMs: starts.length > 0 ? Math.min(...starts) : null,
    expiresAtMs: deadlines.length > 0 ? Math.max(...deadlines) : null,
  }
}

/** When a call last began or ended, and the tool then, from whichever of the
 *  ledger and the connector's report is later. A clock that ran ahead can't
 *  keep a row up past its own bounds. */
function lastActivity(
  ledger: Ledger | undefined,
  reported: Readonly<PluginActivity> | undefined,
  nowMs: number,
): { atMs: number; tool: string | null } {
  const reportedAt = Math.min(reported?.lastActivityAtMs ?? 0, nowMs)
  const ledgerAt = Math.min(ledger?.lastActivityAtMs ?? 0, nowMs)
  return reportedAt > ledgerAt ?
      { atMs: reportedAt, tool: reported?.lastTool ?? null }
    : { atMs: ledgerAt, tool: ledger?.lastTool ?? null }
}

/**
 * The connectors in use at `nowMs`: running ones, and ones whose last call
 * ended less than `LINGER_MS` ago. `reported` is what a connector's own
 * status says about its calls (FigJam).
 */
export function connectorActivity(options: {
  nowMs: number
  reported?: (connector: ConnectorId) => Readonly<PluginActivity> | undefined
}): Array<ConnectorActivityView> {
  const { nowMs } = options
  const views: Array<ConnectorActivityView> = []
  for (const connector of CONNECTOR_IDS) {
    const ledger = ledgers.get(connector)
    const reported = options.reported?.(connector)
    const running = runningCalls(ledger, reported, nowMs)

    const last = lastActivity(ledger, reported, nowMs)
    if (running.count === 0 && nowMs - last.atMs >= LINGER_MS) continue

    views.push({
      connector,
      state: running.count > 0 ? "running" : "recent",
      active_calls: running.count,
      started_at_ms: running.startedAtMs,
      last_activity_at_ms: last.atMs,
      expires_at_ms: running.expiresAtMs ?? last.atMs + LINGER_MS,
      last_tool: last.tool === null ? null : toolLabel(last.tool),
    })
  }
  return views
}

/** Forget every call. For tests. */
export function __resetConnectorActivityForTests(): void {
  ledgers.clear()
  nextCall = 0
}
