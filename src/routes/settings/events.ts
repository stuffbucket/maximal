/**
 * GET /settings/api/events — the SSE channel the Tauri shell subscribes to
 * for live state pushes (ADR-0007). Replaces the shell's per-section poll
 * loops: the sidecar emits a typed event the instant observable state
 * changes, so sign-in flips to "authenticated" the moment the device-code
 * poller resolves rather than on the next 2s tick.
 *
 * This route is a thin adapter over `settingsEventBus`: on connect it sends
 * the current snapshot, then writes every published event out as a named
 * SSE event whose `data` is the same JSON shape the matching GET returns
 * (e.g. `auth.changed` === GET /settings/api/auth/github/status). The shell
 * keeps those GETs for initial render + as a fallback when the stream drops.
 *
 * AUTH: gated like the rest of /settings/api/* — NOT in the unauth
 * allowlist. The browser/Tauri `EventSource` cannot send custom headers, so
 * the shell passes the key as `?key=<api_key>`. `extractRequestApiKey`
 * honours the query-string key ONLY for this exact path (see request-auth.ts);
 * never for any other endpoint, so keys don't broadly leak into URLs/logs.
 */

import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { getAuthStatus } from "~/lib/auth/auth-controller"
import { settingsEventBus } from "~/lib/config/settings-events"

/** Keep-alive cadence. Proxies and idle-connection reapers close silent
 *  streams; a periodic comment line keeps the channel warm at negligible
 *  cost. 15s is well under common 30–60s idle timeouts. */
const HEARTBEAT_MS = 15_000

export const eventsRoutes = new Hono()

eventsRoutes.get("/", (c) =>
  streamSSE(c, async (stream) => {
    // Initial snapshot so a freshly-connected shell renders immediately,
    // even if it skipped the GET-on-mount.
    await stream.writeSSE({
      event: "auth.changed",
      data: JSON.stringify(getAuthStatus()),
    })

    const unsubscribe = settingsEventBus.subscribe("auth.changed", (status) => {
      void stream.writeSSE({
        event: "auth.changed",
        data: JSON.stringify(status),
      })
    })

    const heartbeat = setInterval(() => {
      // A comment-only line (": ping") is ignored by EventSource but resets
      // idle timers on intermediaries. writeSSE emits it as a comment.
      void stream.writeSSE({ data: "", event: "ping" })
    }, HEARTBEAT_MS)

    // Hold the stream open until the client disconnects (webview closed,
    // navigated away, sidecar reboot). Cleaning up the subscription and the
    // heartbeat here prevents a leak per reconnect.
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(heartbeat)
        unsubscribe()
        resolve()
      })
    })
  }),
)
