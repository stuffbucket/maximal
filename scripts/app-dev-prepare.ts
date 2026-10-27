#!/usr/bin/env bun
/**
 * Dev-mode pre-launch step for `bun run app:dev`.
 *
 * `tauri-plugin-single-instance` handles double-launches of the
 * *packaged* .app, but in dev a second `bun run app:dev` can collide
 * with a sidecar already listening on :4141 from a previous session.
 *
 * Rather than hunt PIDs and signal them (which is platform-specific —
 * lsof/pgrep/SIGTERM don't all exist on Windows), we lean on the
 * existing graceful-shutdown contract: `POST /_internal/shutdown` to
 * the sidecar at :4141. The sidecar exits 0; the Tauri shell's
 * CommandEvent::Terminated handler treats code-0 as "intentional
 * shutdown" and calls app.exit(0), collapsing `tauri dev` with it.
 * Everything tied to :4141 comes down through one HTTP call.
 *
 * Exits 0 on success (no holder, or holder evicted). Exits 1 on
 * unrecoverable conflict (e.g. :4141 held by something that isn't
 * maximal, or graceful shutdown timed out).
 *
 * `MAXIMAL_DEV_PORT=<port>` runs the dev app beside an installed Maximal
 * instead of replacing it. The shell binds that port (lib.rs reads the same
 * variable at build time), only a Maximal already on it is evicted, and the
 * Tauri config written below gives the dev app its own identifier, so the
 * single-instance lock doesn't hand off to the installed app, plus window
 * permissions for the dev port's origin. Pair it with COPILOT_API_HOME
 * pointing at a scratch directory so the dev proxy keeps its own config and
 * leaves your apps' settings alone.
 */

import { writeFileSync } from "node:fs"
import path from "node:path"

const DEFAULT_PORT = 4141

function sidecarPort(): number {
  const raw = process.env.MAXIMAL_DEV_PORT
  if (raw === undefined || raw === "") return DEFAULT_PORT
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
    console.error(`[app-dev-prepare] MAXIMAL_DEV_PORT must be a port number; got "${raw}"`)
    process.exit(1)
  }
  return port
}

const SIDECAR_PORT = sidecarPort()
const PORT_RELEASE_TIMEOUT_MS = 8000
const PORT_POLL_INTERVAL_MS = 100

async function probeSidecar(): Promise<"free" | "maximal" | "other"> {
  try {
    const res = await fetch(`http://localhost:${SIDECAR_PORT}/`, {
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return "other"
    const text = (await res.text()).trim()
    return text === "Server running" ? "maximal" : "other"
  } catch {
    return "free"
  }
}

async function isPortFree(): Promise<boolean> {
  return (await probeSidecar()) === "free"
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

async function requestShutdown(): Promise<void> {
  try {
    const res = await fetch(
      `http://localhost:${SIDECAR_PORT}/_internal/shutdown`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "app-dev relaunch" }),
        signal: AbortSignal.timeout(2000),
      },
    )
    if (!res.ok) {
      console.error(
        `[app-dev-prepare] /_internal/shutdown returned ${res.status}; the running instance may be a remote maximal that won't honor a loopback-gated shutdown.`,
      )
      process.exit(1)
    }
  } catch (err) {
    console.error(
      `[app-dev-prepare] /_internal/shutdown unreachable:`,
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  }
}

async function waitForPortRelease(): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isPortFree()) return
    await sleep(PORT_POLL_INTERVAL_MS)
  }
  console.error(
    `[app-dev-prepare] :${SIDECAR_PORT} did not free within ${PORT_RELEASE_TIMEOUT_MS}ms after /_internal/shutdown. The Tauri shell may be stuck; try \`bun run app:dev\` again or quit the running app from the tray.`,
  )
  process.exit(1)
}

/** Merged over tauri.conf.json by `tauri dev --config` (JSON Merge Patch).
 *  Empty on the default port, so a plain `app:dev` behaves as before. */
function devConfig(): Record<string, unknown> {
  if (SIDECAR_PORT === DEFAULT_PORT) return {}
  const origins = [
    `http://localhost:${SIDECAR_PORT}/*`,
    `http://127.0.0.1:${SIDECAR_PORT}/*`,
  ]
  return {
    productName: "Maximal Dev",
    identifier: "co.stuffbucket.maximal.dev",
    app: {
      security: {
        // Listing capabilities replaces the capabilities/ directory, so name
        // the existing ones and add the dev origin beside :4141.
        capabilities: [
          "default",
          "loopback",
          {
            identifier: "loopback-dev-port",
            description: `The loopback capability for the dev port :${SIDECAR_PORT}.`,
            windows: ["settings", "dashboard"],
            local: false,
            remote: { urls: origins },
            permissions: [
              "core:default",
              "core:window:default",
              "core:window:allow-start-dragging",
              "core:window:allow-internal-toggle-maximize",
              "core:webview:allow-create-webview-window",
              "opener:default",
              "default",
            ],
          },
        ],
      },
    },
  }
}

writeFileSync(
  path.join(import.meta.dir, "..", "shell", "src-tauri", "tauri.dev.conf.json"),
  `${JSON.stringify(devConfig(), null, 2)}\n`,
)

const state = await probeSidecar()
switch (state) {
  case "free":
    // Nothing to do.
    break
  case "maximal":
    console.log(
      `[app-dev-prepare] evicting maximal on :${SIDECAR_PORT} via /_internal/shutdown`,
    )
    await requestShutdown()
    await waitForPortRelease()
    console.log(`[app-dev-prepare] :${SIDECAR_PORT} freed`)
    break
  case "other":
    console.error(
      `[app-dev-prepare] :${SIDECAR_PORT} is held by something that isn't maximal. Stop the holding process and retry.`,
    )
    process.exit(1)
}
