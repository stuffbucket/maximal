/**
 * `runServer` — the boot orchestrator for `maximal start`.
 *
 * Each phase is a single line of intent: port preflight, config merge,
 * boot logger, secrets, upstream bootstrap, claude-code helper, bind,
 * pidfile, post-bind reconcile, shutdown handlers. Implementation lives
 * in sibling modules (port.ts, boot-io.ts, bootstrap.ts, shutdown.ts,
 * claude-code-flow.ts) so this file reads as a checklist.
 */

import type { PluginGateway } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"
import { serve } from "srvx"

import { removeLegacyShimIfPresent } from "~/apps/claude-code/detect"
import { runAppBootHooks } from "~/apps/registry"
import { type AccountType } from "~/lib/auth/auth-types"
import { refreshAllowanceAtStartup } from "~/lib/budget/runtime"
import { mergeConfigWithDefaults } from "~/lib/config/config"
import { initProxyFromEnv } from "~/lib/http/proxy"
import { initOpencodeVersion } from "~/lib/platform/opencode"
import { ensurePaths } from "~/lib/platform/paths"
import { writePidfile } from "~/lib/platform/replace-running"
import {
  cacheMacMachineId,
  cacheVsCodeDeviceId,
  cacheVsCodeSessionId,
  cacheVSCodeVersion,
} from "~/lib/platform/utils"
import { startPlugins, stopPlugins } from "~/lib/plugins/runtime"
import { hasGithubToken, state } from "~/lib/runtime-state/state"
import { startUpdateNotice } from "~/lib/update/update-notice"
import { getGitVersion, shortSha } from "~/lib/update/version"
import { startWorkingNotice } from "~/lib/working-notice"

import { emitSidecarReady, initBootLogger, printReadyBanner } from "./boot-io"
import { emitBootStatus } from "./boot-status"
import { bootSecrets, bootstrapUpstream } from "./bootstrap"
import { runClaudeCodeFlow } from "./claude-code-flow"
import { listenHostname } from "./listen-host"
import { preflightPort } from "./port"
import { setListeningPort } from "./proxy-port"
import {
  markSessionRunning,
  staleSessionMarkerPresent,
} from "./session-sentinel"
import { installShutdownHandlers } from "./shutdown"

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
  /** Serve this plugin gateway instead of composing the built-in plugins.
   *  Composition-level override for harnesses (the connectors bench builds
   *  one with `composePluginGateway({ plugins })`); the CLI never sets it. */
  pluginGateway?: PluginGateway
}

export async function runServer(options: RunServerOptions): Promise<void> {
  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Print something immediately so users know `maximal start` is
  // doing something. The next ~3-5s are spent on Copilot bootstrap
  // (token exchange, model fetch, machine-id + session-id caching),
  // and without this line the terminal just sits silent.
  consola.start("Starting maximal…")

  // Port zero asks the kernel to select a free port. For a concrete port,
  // announce --replace only when the initial probe actually finds an occupant.
  await preflightPort(options.port, options.replace ?? false)

  // Ensure config is merged with defaults at startup
  mergeConfigWithDefaults()

  const git = getGitVersion()
  consola.info(
    `Source revision: ${shortSha(git.sha)}${git.branch ? ` (${git.branch})` : ""}`,
  )

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

  await ensurePaths()
  bootSecrets()

  // Crash-detection: did the previous run exit ungracefully (skipped
  // initiateShutdown AND the `exit` safety net — i.e. SIGKILL, power
  // loss, OS-level kill)? If so, a configured client may still point at
  // the stopped proxy and produce connection-refused errors. We can't
  // auto-recover the inter-session window (an external watchdog would
  // be needed), but we can surface the cause; runAppBootHooks() below
  // re-applies intended routing for the new session.
  const staleSession = staleSessionMarkerPresent()
  if (staleSession) {
    consola.warn(
      "Previous maximal session ended ungracefully (likely a crash, "
        + "force-quit, or system shutdown). If a configured client produced "
        + "connection-refused errors since then, that was why — its local "
        + "config may still point at this proxy. Intended routing is being "
        + "re-applied now.",
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

  emitBootStatus("Starting the server…")

  const { server } = await import("~/server")

  const hostname = listenHostname()
  const httpServer = serve({
    fetch: server.fetch,
    hostname,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
  await httpServer.ready()

  const actualPort = boundServerPort(httpServer)
  const serverUrl = advertisedServerUrl(hostname, actualPort)
  const bootLogger = initBootLogger(git, { ...options, port: actualPort })
  bootLogger.info(
    `listening url=${serverUrl} host=${hostname} `
      + `executor=${executorName.split(" ")[0]} `
      + `auth=${hasGithubToken() ? "authenticated" : "unauthenticated"}`,
  )

  afterListening(actualPort, httpServer, options.pluginGateway)

  if (options.claudeCode) {
    if (state.models) {
      await runClaudeCodeFlow(serverUrl)
    } else {
      consola.warn(
        "--claude-code requires an authenticated session; skipping helper.",
      )
    }
  }

  printReadyBanner(serverUrl)
  emitSidecarReady(actualPort)
}

function boundServerPort(httpServer: ReturnType<typeof serve>): number {
  const url = httpServer.url
  if (!url) throw new Error("Server bound without reporting its listening URL")

  const parsed = new URL(url)
  let port = Number.NaN
  if (parsed.port) port = Number(parsed.port)
  else if (parsed.protocol === "http:") port = 80
  else if (parsed.protocol === "https:") port = 443
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Server reported an invalid listening URL: ${url}`)
  }
  return port
}

function advertisedServerUrl(hostname: string, port: number): string {
  let localHost = hostname
  if (hostname === "0.0.0.0") localHost = "127.0.0.1"
  else if (hostname === "::") localHost = "::1"

  const needsBrackets = localHost.includes(":") && !localHost.startsWith("[")
  const urlHost = needsBrackets ? `[${localHost}]` : localHost
  return `http://${urlHost}:${port}`
}

/** Boot steps that need the bound listener: plugins and the client entries
 *  that point at `port`, and the shutdown path that reverts them. */
function afterListening(
  port: number,
  httpServer: ReturnType<typeof serve>,
  pluginGateway: PluginGateway | undefined,
): void {
  setListeningPort(port)

  // One-time "Maximal is working" notification (shown by the menu-bar shell).
  void startWorkingNotice()
  // Read Copilot's allowance now, so the Rules window shows it before the
  // first request does.
  refreshAllowanceAtStartup()
  // Log a line when a newer version is out (with the apt command for an apt
  // install), at startup and every few hours, for proxies run without the app.
  startUpdateNotice()

  // Best-effort: record our PID so a future `maximal start --replace`
  // can fall back to SIGTERM/SIGKILL if the graceful shutdown route
  // doesn't free the port in time.
  void writePidfile()

  // Now that we're actually listening, re-apply each client's routing if the
  // user left it on (Claude Code's base URL, Claude Desktop's gateway
  // profile, Codex's provider block). Self-heals config a prior
  // crash/force-kill stranded over a dead proxy and picks up this run's port.
  // Ownership-guarded; no-op when off.
  runAppBootHooks()
  // Start the plugins the user turned on, then register their MCP endpoints
  // (`/mcp/<id>`) with the chosen clients. Detached: a slow plugin or
  // `claude` CLI never holds up the listener or ordinary requests.
  void startPlugins({ gateway: pluginGateway }).catch((error: unknown) => {
    consola.warn("Could not start plugins", error)
  })

  // Drop the "session running" sentinel only AFTER the boot hooks
  // so the freshly-written URL is in place when we promise the session is
  // healthy. shutdown clears it; a missing-on-next-boot sentinel means a
  // clean exit, present-on-next-boot means an ungraceful one (see the
  // staleSession check above).
  markSessionRunning(port)

  installShutdownHandlers(httpServer, stopPlugins)
}
