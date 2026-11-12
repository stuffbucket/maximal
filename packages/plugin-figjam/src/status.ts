import type {
  PluginAttention,
  PluginStatus,
  PluginStatusAction,
} from "@stuffbucket/maximal-plugin-sdk"

import { createHash } from "node:crypto"

/** What the Figma plugin folder holds relative to this build and these ports. */
export type PluginFolder = "missing" | "stale" | "current"

export interface StartFailure {
  code: string
  summary: string
  detail: string
}

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

const nameList = (names: ReadonlyArray<string>): string =>
  names.length === 0 ?
    "None"
  : names.map((name) => displayName(name)).join(", ")

/** Everything the status shows, as the controller knows it. */
export interface StatusInput {
  startFailure: StartFailure | undefined
  /** `undefined` while the bridge is starting. */
  bridge:
    | {
        port: number
        boards: ReadonlyArray<string>
        pending: ReadonlyArray<string>
      }
    | undefined
  building: boolean
  folder: PluginFolder
  buildError: string | undefined
  manifestPath: string
  /** Approve and Deny for each waiting panel. */
  pairActions: Array<PluginStatusAction>
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

/** What the person is asked while panels wait, or `undefined` when none do. */
function pairAttention(input: StatusInput): PluginAttention | undefined {
  const pending = input.bridge?.pending ?? []
  if (pending.length === 0 || input.pairActions.length === 0) return undefined
  const [first] = pending
  return {
    summary:
      pending.length === 1 ?
        `A FigJam panel ("${displayName(first)}") wants to connect`
      : `${pending.length} FigJam panels want to connect`,
    actions: input.pairActions,
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
    { label: "Port", value: String(bridge.port) },
    { label: "Connected boards", value: nameList(bridge.boards) },
    { label: "Waiting for approval", value: nameList(bridge.pending) },
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
        ...input.pairActions,
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
      { label: "Figma plugin manifest", value: input.manifestPath },
    ],
    actions: [
      ...input.pairActions,
      {
        id: SETUP_ACTION,
        label: "Rebuild the Figma plugin",
        kind: "secondary",
      },
    ],
  }
}
