/**
 * `/figjam/*` — how the FigJam panel finds and reaches the bridge, on
 * Maximal's own origin (the only one the panel's manifest allows).
 *
 *   GET /figjam/bridge.json   → JSON metadata: is the bridge up, which profile
 *                               this Maximal is, where the panel socket is
 *   GET /figjam/plugin        → WebSocket upgrade, relayed to the bridge (see
 *                               `relay.ts`)
 *
 * The bridge runs in the FigJam plugin's generation child process, so this
 * parent-owned route learns where it listens from the plugin's own status
 * (the `Port` fact) and never caches it: a generation handoff or a restart
 * changes the answer, and a bridge that is not serving answers "unavailable".
 * The bridge's port is internal. It is never returned, and the panel never
 * needs it.
 *
 * Callers must be on this computer and, when a browser labels the request, be
 * a Figma plugin frame (`Origin: null`): the same allowlist the bridge's own
 * socket applies. Nothing secret is ever answered or logged: no tokens, no
 * file paths, only the port-free availability and profile.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"
import type { Context } from "hono"

import consola from "consola"
import { Hono } from "hono"

import type { FigjamRelayData } from "~/lib/figjam/relay"

import { defaultGetRequestIp, isLoopbackAddress } from "~/lib/auth/request-auth"
import {
  type FigjamProfile,
  isVerboseProfile,
  resolveFigjamProfile,
} from "~/lib/figjam/profile"
import { getPluginGateway } from "~/lib/plugins/gateway"
import { currentProxyPort } from "~/lib/start/proxy-port"
import { BUILD_VERSION } from "~/lib/update/build-info"

/** Where the panel's socket lives on Maximal's origin. */
export const FIGJAM_PANEL_PATH = "/figjam/plugin"

/** The marker the panel looks for, so it knows it reached Maximal's FigJam. */
export const FIGJAM_DISCOVERY_SERVICE = "maximal-figjam-bridge"

export type BridgeAvailability =
  | { available: true; port: number }
  | {
      available: false
      reason: "disabled" | "unavailable" | "starting" | "error"
    }

const PLUGIN_ID = "figjam"

/** The label of the plugin status fact that carries the bridge's port (`BRIDGE_PORT_FACT` in plugin-figjam's status.ts; a test pins them equal). */
export const BRIDGE_PORT_FACT = "Port"

/** What the FigJam plugin currently serves, read fresh from its status. */
export function bridgeAvailability(
  gateway: PluginGateway | undefined,
): BridgeAvailability {
  const snapshot = gateway?.list().find((entry) => entry.id === PLUGIN_ID)
  if (!snapshot) return { available: false, reason: "unavailable" }
  if (!snapshot.enabled) return { available: false, reason: "disabled" }
  if (snapshot.lifecycle === "failed") {
    return { available: false, reason: "error" }
  }
  if (snapshot.lifecycle !== "active") {
    return { available: false, reason: "starting" }
  }
  const status = snapshot.status
  if (status?.state === "error") return { available: false, reason: "error" }
  const fact = status?.facts?.find((item) => item.label === BRIDGE_PORT_FACT)
  const port = Number(fact?.value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { available: false, reason: "starting" }
  }
  return { available: true, port }
}

interface BunServerLike {
  upgrade(request: Request, options: { data: FigjamRelayData }): boolean
}

function bunServerOf(request: Request): BunServerLike | undefined {
  const runtime: unknown = Reflect.get(request, "runtime")
  if (typeof runtime !== "object" || runtime === null) return undefined
  const bun: unknown = Reflect.get(runtime, "bun")
  if (typeof bun !== "object" || bun === null) return undefined
  const server: unknown = Reflect.get(bun, "server")
  if (
    typeof server === "object"
    && server !== null
    && typeof Reflect.get(server, "upgrade") === "function"
  ) {
    return server as BunServerLike
  }
  return undefined
}

const PROFILE_PARAM = /^[a-z0-9][a-z0-9-]{0,39}$/

/** `undefined` to go on; otherwise the refusal. */
function refuseRequest(
  c: Context,
  getRequestIp: (c: Context) => string | null,
): Response | Promise<Response> | undefined {
  // A remote caller must not learn the route exists.
  if (!isLoopbackAddress(getRequestIp(c))) return c.notFound()
  const origin = c.req.header("origin")
  if (origin !== undefined && origin !== "null") {
    consola.warn(
      `figjam: refused a request from origin ${origin}; only the Figma plugin frame (Origin: null) and local tools may use ${c.req.path}`,
    )
    return c.json(
      {
        error: {
          type: "forbidden",
          code: "ORIGIN_REJECTED",
          message: "Cross-origin requests are not allowed.",
        },
      },
      403,
    )
  }
  return undefined
}

/** What a panel says about itself (a profile and the Maximal port its manifest allows) against what this Maximal is. */
function warnAboutPanel(
  c: Context,
  profile: FigjamProfile,
  maximalPort: number,
): void {
  const asked = c.req.query("profile")
  const panelPort = Number(c.req.query("maximalPort"))
  if (
    asked !== undefined
    && PROFILE_PARAM.test(asked)
    && asked !== profile.id
  ) {
    consola.warn(
      `figjam: a panel built for Maximal profile ${asked} asked profile ${profile.id}; it will refuse to connect. Re-import the Figma plugin from this profile's manifest.`,
    )
  }
  if (Number.isInteger(panelPort) && panelPort !== maximalPort) {
    consola.warn(
      `figjam: a panel built for Maximal port ${panelPort} reached Maximal on port ${maximalPort}; its manifest does not allow this origin. Rebuild the Figma plugin and run it again.`,
    )
  }
}

export interface FigjamRoutesOptions {
  /** Injectable so tests can simulate other callers. */
  getRequestIp?: (c: Context) => string | null
  /** Injectable so tests needn't run the plugin. */
  availability?: () => BridgeAvailability
  profile?: FigjamProfile
  /** The port Maximal serves on, for noticing a manifest built for another. */
  maximalPort?: () => number
}

export function createFigjamRoutes(options: FigjamRoutesOptions = {}): Hono {
  const getRequestIp = options.getRequestIp ?? defaultGetRequestIp
  const availability =
    options.availability ?? (() => bridgeAvailability(getPluginGateway()))
  const maximalPort = options.maximalPort ?? currentProxyPort
  const profile = options.profile ?? resolveFigjamProfile()
  const verbose = isVerboseProfile(profile)
  const note = (message: string): void => {
    if (verbose) consola.info(message)
    else consola.debug(message)
  }

  const refuse = (c: Context) => refuseRequest(c, getRequestIp)

  const app = new Hono()

  app.get("/bridge.json", (c) => {
    const refusal = refuse(c)
    if (refusal) return refusal

    // What the panel says about itself, for diagnostics only.
    warnAboutPanel(c, profile, maximalPort())
    const panel = c.req.query("panel")

    const state = availability()
    note(
      `figjam: discovery from a panel${panel && /^[\w.+-]{1,32}$/.test(panel) ? ` ${panel}` : ""}: ${state.available ? "bridge available" : `unavailable (${state.reason})`}`,
    )
    const common = {
      service: FIGJAM_DISCOVERY_SERVICE,
      schema: 1,
      profile: { kind: profile.kind, id: profile.id },
      maximal: { version: BUILD_VERSION },
    }
    if (!state.available) {
      return c.json({ ...common, available: false, reason: state.reason }, 503)
    }
    return c.json({
      ...common,
      available: true,
      panel: { path: FIGJAM_PANEL_PATH },
    })
  })

  app.get("/plugin", (c) => {
    const refusal = refuse(c)
    if (refusal) return refusal
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "This endpoint is a WebSocket; connect with ws://.",
          },
        },
        426,
      )
    }
    const state = availability()
    if (!state.available) {
      consola.warn(
        `figjam: a panel tried to connect, but the bridge is unavailable (${state.reason})`,
      )
      return c.json(
        { error: { type: "unavailable", message: `FigJam: ${state.reason}` } },
        503,
      )
    }
    const server = bunServerOf(c.req.raw)
    if (!server) {
      consola.error(
        "figjam: this server cannot upgrade WebSockets, so the panel cannot connect",
      )
      return c.json(
        { error: { type: "unavailable", message: "WebSockets unavailable." } },
        501,
      )
    }
    const data: FigjamRelayData = {
      target: `ws://127.0.0.1:${state.port}/plugin`,
      verbose,
      queue: [],
    }
    if (!server.upgrade(c.req.raw, { data })) {
      consola.warn("figjam: the panel's WebSocket upgrade failed")
      return c.json(
        {
          error: { type: "invalid_request_error", message: "Upgrade failed." },
        },
        400,
      )
    }
    // Bun has taken the connection; this response is never sent.
    return new Response(null, { status: 101 })
  })

  return app
}

export const figjamRoutes = createFigjamRoutes()
