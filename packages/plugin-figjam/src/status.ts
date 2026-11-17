import type {
  PluginActivity,
  PluginAttention,
  PluginAttentionRequest,
  PluginStatus,
} from "@stuffbucket/maximal-plugin-sdk"

import { createHash } from "node:crypto"

/** What the Figma plugin folder holds relative to this build and these ports. */
export type PluginFolder = "missing" | "stale" | "current"

export interface StartFailure {
  code: string
  summary: string
  detail: string
}

/** The status fact that carries the port the bridge is bound to (read by the discovery route). */
export const BRIDGE_PORT_FACT = "Port"

/** Id of the action that builds (or rebuilds) the Figma plugin files. */
export const SETUP_ACTION = "setup"

/** Id of the action that starts the bridge again after a failed start. */
export const RETRY_ACTION = "retry"

/** What the person does in Figma after the plugin files are written. */
export const IMPORT_INSTRUCTIONS =
  "In the Figma desktop app: Plugins → Development → Import plugin from manifest…, then choose this file."

/** A panel name as shown to people: no control characters, bounded. */
export function displayName(name: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = name.replaceAll(/[\u0000-\u001F\u007F]/g, " ").trim()
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean || "unnamed"
}

/** Tool use older than this is left out of the status. */
const ACTIVITY_KEEP_MS = 60_000

/**
 * The status's `activity` from the bridge's tool counters: the tool's name
 * and times only. Left out when no call is running and the last one is old.
 */
export function toPluginActivity(
  bridge: {
    inFlight: number
    startedAtMs: number | null
    lastActivityAtMs: number | null
    lastTool: string | null
    expiresAtMs?: number | null
  },
  nowMs: number = Date.now(),
): PluginActivity | undefined {
  const { inFlight, lastActivityAtMs, lastTool } = bridge
  if (lastActivityAtMs === null) return undefined
  if (inFlight === 0 && nowMs - lastActivityAtMs > ACTIVITY_KEEP_MS)
    return undefined
  return {
    activeCalls: inFlight,
    startedAtMs: inFlight > 0 ? bridge.startedAtMs : null,
    lastActivityAtMs,
    ...(lastTool === null ? {} : { lastTool: displayName(lastTool) }),
    ...(bridge.expiresAtMs === undefined ?
      {}
    : {
        expiresAtMs: inFlight > 0 ? bridge.expiresAtMs : null,
      }),
  }
}

const nameList = (names: ReadonlyArray<string>): string =>
  names.length === 0 ?
    "None"
  : names.map((name) => displayName(name)).join(", ")

const pendingNames = (bridge: { pending: ReadonlyArray<PairPending> }) =>
  bridge.pending.map((request) => request.name)

/** A panel waiting to be let in, as the bridge describes it. */
export interface PairPending {
  name: string
  /** The board the panel is open on, when it said. */
  board?: string | null
  /** The Figma profile the panel runs as, when it said. */
  user?: string | null
}

/** Everything the status shows, as the controller knows it. */
export interface StatusInput {
  startFailure: StartFailure | undefined
  /** `undefined` while the bridge is starting. */
  bridge:
    | {
        port: number
        /** The port that was asked for; differs from `port` when it was taken. */
        preferredPort: number
        boards: ReadonlyArray<string>
        pending: ReadonlyArray<PairPending>
      }
    | undefined
  building: boolean
  folder: PluginFolder
  buildError: string | undefined
  manifestPath: string
  /** The name Figma lists the development plugin under (profile-specific). */
  pluginName: string
  /** Names of the panels whose Approve and Deny actions are registered. */
  registered: ReadonlySet<string>
}

function readySummary(boards: number, pending: number): string {
  if (pending > 0) return "A FigJam panel is waiting for approval"
  if (boards === 0) return "Ready for FigJam panels"
  return `Connected to ${boards} FigJam board${boards === 1 ? "" : "s"}`
}

/**
 * Action ids for a waiting panel, stable for the same panel name (unlike a
 * counter) so a tray menu item that has gone stale still reaches the right
 * panel. Ids are `a-z0-9-`: the readable part is the sanitized name, and a
 * short hash of the exact name keeps names that sanitize alike apart.
 */
export function pairActionIds(name: string): {
  approveId: string
  denyId: string
} {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 24)
    .replaceAll(/-$/g, "")
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8)
  const suffix = slug === "" ? hash : `${slug}-${hash}`
  return { approveId: `approve-${suffix}`, denyId: `deny-${suffix}` }
}

/** The dialog that asks whether one waiting panel may drive its board. */
function pairRequest(request: PairPending): PluginAttentionRequest {
  const { approveId, denyId } = pairActionIds(request.name)
  const name = displayName(request.name)
  const board = request.board ? displayName(request.board) : undefined
  const user = request.user ? displayName(request.user) : undefined
  return {
    title: `Let the FigJam panel "${name}" connect?`,
    detail:
      "Approving lets this panel, running in Figma on this computer, read and change the board it is open on. "
      + "An approved panel reconnects without asking again. "
      + "If you didn't just turn on \"Let Claude Code drive this board\" in that panel, or the board or profile isn't yours, deny it.",
    facts: [
      { label: "Panel", value: name },
      ...(board ? [{ label: "Board", value: board }] : []),
      ...(user ? [{ label: "Figma profile", value: user }] : []),
    ],
    approve: { id: approveId, label: "Approve", kind: "primary" },
    decline: { id: denyId, label: "Deny", kind: "secondary" },
  }
}

/**
 * What the person is asked while panels wait, or `undefined` when none do.
 * `actions` are the tray's items (each names its panel); `requests` are the
 * questions Settings asks in a dialog.
 */
function pairAttention(input: StatusInput): PluginAttention | undefined {
  const waiting = (input.bridge?.pending ?? []).filter((request) =>
    input.registered.has(request.name),
  )
  if (waiting.length === 0) return undefined
  return {
    summary:
      waiting.length === 1 ?
        `A FigJam panel ("${displayName(waiting[0].name)}") wants to connect`
      : `${waiting.length} FigJam panels want to connect`,
    actions: waiting.flatMap((request) => {
      const { approveId, denyId } = pairActionIds(request.name)
      const name = displayName(request.name)
      return [
        {
          id: approveId,
          label: `Approve "${name}"`,
          kind: "primary" as const,
        },
        {
          id: denyId,
          label: `Deny "${name}"`,
          kind: "secondary" as const,
        },
      ]
    }),
    requests: waiting.map((request) => pairRequest(request)),
  }
}

/** The Settings status for the plugin. */
export function composeStatus(input: StatusInput): PluginStatus {
  const status = composeBase(input)
  const attention = status.state === "error" ? undefined : pairAttention(input)
  return attention ? { ...status, attention } : status
}

function composeBase(input: StatusInput): PluginStatus {
  const { startFailure, bridge } = input
  if (startFailure) {
    return {
      state: "error",
      code: startFailure.code,
      summary: startFailure.summary,
      detail: startFailure.detail,
      actions: [{ id: RETRY_ACTION, label: "Try again" }],
    }
  }
  if (!bridge) {
    return {
      state: "working",
      code: "starting",
      summary: "Starting the FigJam bridge…",
    }
  }
  const facts = [
    { label: BRIDGE_PORT_FACT, value: String(bridge.port) },
    ...(bridge.preferredPort === bridge.port ?
      []
    : [
        {
          label: "Preferred port (in use)",
          value: String(bridge.preferredPort),
        },
      ]),
    { label: "Connected boards", value: nameList(bridge.boards) },
    { label: "Waiting for approval", value: nameList(pendingNames(bridge)) },
  ]
  if (input.building) {
    return {
      state: "working",
      code: "building-plugin",
      summary: "Building the Figma plugin…",
      facts,
    }
  }
  if (input.folder === "missing") {
    return {
      state: "needs-setup",
      code: input.buildError ? "plugin-build-failed" : "plugin-not-built",
      summary:
        input.buildError ?
          "The Figma plugin could not be built"
        : "Set up the Figma plugin to connect FigJam",
      ...(input.buildError ? { detail: input.buildError } : {}),
      facts,
      actions: [
        {
          id: SETUP_ACTION,
          label: "Set up the Figma plugin",
          kind: "primary",
        },
      ],
    }
  }
  return {
    state: "ready",
    code: "ready",
    summary: readySummary(bridge.boards.length, bridge.pending.length),
    detail:
      input.buildError ?
        `The Figma plugin could not be rebuilt: ${input.buildError}`
      : IMPORT_INSTRUCTIONS,
    facts: [
      ...facts,
      { label: "Figma plugin", value: input.pluginName },
      { label: "Figma plugin manifest", value: input.manifestPath },
    ],
    actions: [
      {
        id: SETUP_ACTION,
        label: "Rebuild the Figma plugin",
        kind: "secondary",
      },
    ],
  }
}
