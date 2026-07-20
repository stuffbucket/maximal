/**
 * `runServer` — the boot orchestrator for `maximal start`.
 *
 * Each phase is a single line of intent: port preflight, config merge,
 * boot logger, secrets, upstream bootstrap, claude-code helper, bind,
 * pidfile, post-bind reconcile, shutdown handlers. Implementation lives
 * in sibling modules (port.ts, boot-io.ts, bootstrap.ts, shutdown.ts,
 * claude-code-flow.ts) so this file reads as a checklist.
 */

import consola from "consola"
import { serve } from "srvx"

import { removeLegacyShimIfPresent } from "~/apps/claude-code/detect"
import { reconcileClaudeCodeOnBoot } from "~/apps/claude-code/reconcile"
import { type AccountType } from "~/lib/auth/auth-types"
import { mergeConfigWithDefaults } from "~/lib/config/config"
import { initProxyFromEnv } from "~/lib/http/proxy"
import { ensureCliSymlink } from "~/lib/platform/cli-path"
import { initOpencodeVersion } from "~/lib/platform/opencode"
import { ensurePaths } from "~/lib/platform/paths"
import { writePidfile } from "~/lib/platform/replace-running"
import {
  cacheMacMachineId,
  cacheVsCodeDeviceId,
  cacheVsCodeSessionId,
  cacheVSCodeVersion,
} from "~/lib/platform/utils"
import { hasGithubToken, setLastView, state } from "~/lib/runtime-state/state"
import { getGitVersion, shortSha } from "~/lib/update/version"
import { buildSnapshot, LiveFeedHub } from "~/lib/ws/live-feed"
import { presenceRegistry } from "~/lib/ws/presence-registry"
import { createWebSocketHandler } from "~/routes/ws/route"

import { initBootLogger, printReadyBanner } from "./boot-io"
import { emitBootStatus } from "./boot-status"
import { bootSecrets, bootstrapUpstream } from "./bootstrap"
import { runClaudeCodeFlow } from "./claude-code-flow"
import { maybeEvictRunning, probePort, reportPortBusyAndExit } from "./port"
import {
  markSessionRunning,
  staleSessionMarkerPresent,
} from "./session-sentinel"
import { installShutdownHandlers } from "./shutdown"

// Injectable server binder. Defaults to srvx's real `serve()`; tests swap it
// via `__setServeForTests` to avoid binding a port. This is a module-local
// seam ON PURPOSE — the alternative, `mock.module("srvx", …)`, forward-leaks
// the stub into sibling files that need the REAL srvx (the real-port WS
// handshake test), and Bun does not reset module mocks between files. See
// docs/dev/testing-strategy.md §5 + the mockModuleLeakGuard eslint rule.
type ServeFn = typeof serve
let serveImpl: ServeFn = serve

/** Test-only: swap the srvx `serve` binder. Pass `null` to restore the real one. */
export function __setServeForTests(fn: ServeFn | null): void {
  serveImpl = fn ?? serve
}

/**
 * Construct the live-feed WebSocket wiring (§1.2–1.3): one presence registry (the
 * tray-open dedup source) + one hub (producers → feed + (re)connect snapshot),
 * plus the Bun `websocket` handler that drives the socket lifecycle. Kept out of
 * `runServer`'s checklist body; the caller passes `websocket` into `serve(...)`
 * and calls `hub.start()` once the sidecar is listening.
 */
function createLiveFeed(): {
  hub: LiveFeedHub
  websocket: ReturnType<typeof createWebSocketHandler>
} {
  const registry = presenceRegistry
  const hub = new LiveFeedHub({ registry, buildSnapshot })
  return {
    hub,
    // onView persists the tab's section+scroll (§1.4) so a tray-reopened tab keeps
    // the user's place; buildInlineUiState reads it back on the next page load.
    websocket: createWebSocketHandler({ hub, registry, onView: setLastView }),
  }
}

export interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: AccountType
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  /** Evict any running instance on :4141 before binding. Optional —
   *  test fixtures + non-CLI callers can omit; treated as false. */
  replace?: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Print something immediately so users know `maximal start` is
  // doing something. The next ~3-5s are spent on Copilot bootstrap
  // (token exchange, model fetch, machine-id + session-id caching),
  // and without this line the terminal just sits silent.
  consola.start("Starting maximal…")

  // If --replace was passed, try to take over the port from a
  // running instance before the regular probe.
  if (options.replace) {
    emitBootStatus(`Taking over port ${options.port}…`)
    await maybeEvictRunning(options.port)
  }

  // Bail out early if the port is already taken — much friendlier
  // than crashing 5s later inside srvx with EADDRINUSE.
  const portState = await probePort(options.port)
  if (portState !== "free") reportPortBusyAndExit(options.port, portState)

  // Ensure config is merged with defaults at startup
  mergeConfigWithDefaults()

  const git = getGitVersion()
  consola.info(
    `Source revision: ${shortSha(git.sha)}${git.branch ? ` (${git.branch})` : ""}`,
  )

  const bootLogger = initBootLogger(git, options)

  await initOpencodeVersion()

  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  state.verbose = options.verbose
  if (options.verbose) {
    // Module-scope mutation, but runServer runs once at startup —
    // no concurrent caller exists.
    // eslint-disable-next-line require-atomic-updates
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  // Record the port we're about to bind so the control-surface Origin guard +
  // CORS (server.ts) know which localhost origin is "us" (§6). Set before the
  // bind since the server module reads it lazily, per-request.
  state.boundPort = options.port

  await ensurePaths()
  bootSecrets()

  // Crash-detection: did the previous run exit ungracefully (skipped
  // initiateShutdown AND the `exit` safety net — i.e. SIGKILL, power
  // loss, OS-level kill)? If so AND the Claude Code base URL is still
  // ours from before, the user has likely been hitting "connection
  // refused" in `claude` since then. We can't auto-recover the
  // inter-session window (an external watchdog would be needed), but
  // we can at least surface the cause so the symptom isn't mysterious.
  // The reconcileClaudeCodeOnBoot() call below will re-apply the URL
  // for the new session; that ends the broken-window.
  const staleSession = staleSessionMarkerPresent()
  if (staleSession) {
    consola.warn(
      "Previous maximal session ended ungracefully (likely a crash, "
        + "force-quit, or system shutdown). If `claude` produced "
        + "connection-refused errors since then, that was why — your "
        + "Claude Code config still pointed at this proxy. Routing is "
        + "being re-applied now and will work again.",
    )
  }

  // One-shot cleanup of the pre-v0.4.13 ~/.local/share/maximal/shims/claude
  // wrapper, which is now orphaned (we route via ~/.claude/settings.json
  // instead). The shim emits 'maximal: the claude binary this shim wrapped
  // is gone' when its hard-coded versioned target disappears on Claude
  // auto-update, which breaks `claude` invocations until manually removed.
  // Idempotent; only deletes a file carrying the SHIM_MARKER.
  const removedShim = removeLegacyShimIfPresent()
  if (removedShim) {
    consola.info(`Removed legacy Claude Code shim at ${removedShim}`)
  }

  // First-launch CLI shim (macOS .dmg only). The .app bundle's CLI
  // lives at …/Maximal.app/Contents/MacOS/maximal, off every default
  // PATH; symlink it into ~/.local/bin so `maximal` works in a
  // terminal. Idempotent + best-effort — never blocks boot. No-op for
  // Homebrew/dev launches (not an .app bundle). See lib/cli-path.ts.
  const link = ensureCliSymlink()
  if (link.linked) {
    consola.info(`Linked CLI onto PATH: ${link.symlinkPath} → ${link.target}`)
    if (link.pathBlockAdded) {
      consola.info(
        "Added ~/.local/bin to PATH in ~/.zprofile (open a new terminal to pick it up).",
      )
    }
  }

  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  await bootstrapUpstream(options.githubToken)

  const executorName =
    process.env.OLLAMA_API_KEY ?
      "OllamaWebExecutor"
    : "InProcessFetchExecutor (search disabled; set OLLAMA_API_KEY)"
  consola.info(`Web-tools executor: ${executorName}`)

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    if (state.models) {
      await runClaudeCodeFlow(serverUrl)
    } else {
      consola.warn(
        "--claude-code requires an authenticated session; skipping helper.",
      )
    }
  }

  emitBootStatus("Starting the server…")
  printReadyBanner(serverUrl)

  const { server } = await import("~/server")

  bootLogger.info(
    `listening url=${serverUrl} `
      + `executor=${executorName.split(" ")[0]} `
      + `auth=${hasGithubToken() ? "authenticated" : "unauthenticated"}`,
  )

  const liveFeed = createLiveFeed()

  const httpServer = serveImpl({
    fetch: server.fetch,
    port: options.port,
    bun: {
      idleTimeout: 0,
      websocket: liveFeed.websocket,
    },
  })

  finalizeBoot(httpServer, liveFeed.hub)
}

/**
 * Post-bind finalization — order is load-bearing: record the PID, re-apply the
 * Claude Code base URL (self-heals a URL a prior crash stranded over a dead
 * proxy; ownership-guarded, no-op when routing is off), then drop the
 * "session running" sentinel ONLY after that URL is in place (a
 * present-on-next-boot sentinel means the last exit was ungraceful — see the
 * `staleSession` check), then attach the live-feed producers now that we're
 * listening (§1.3, idempotent), then install the shutdown handlers.
 */
function finalizeBoot(httpServer: ReturnType<ServeFn>, hub: LiveFeedHub): void {
  void writePidfile()
  reconcileClaudeCodeOnBoot()
  markSessionRunning()
  hub.start()
  installShutdownHandlers(httpServer)
}
