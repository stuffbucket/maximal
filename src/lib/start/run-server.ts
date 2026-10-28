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
import {
  refreshCatalogCommands,
  syncMcpClientsWhenBrokerReady,
} from "~/apps/mcp"
import { runAppBootHooks } from "~/apps/registry"
import { type AccountType } from "~/lib/auth/auth-types"
import {
  type AppConfig,
  getConfig,
  mergeConfigWithDefaults,
} from "~/lib/config/config"
import { initProxyFromEnv } from "~/lib/http/proxy"
import {
  reconfigureBroker,
  setBrokerConfigFilter,
  startBrokerSupervisor,
  stopBrokerSupervisor,
} from "~/lib/mcp-broker/supervisor"
import {
  holdBackWorkIqUntilSetUp,
  reconfigureBrokerAfterSetupCheck,
} from "~/lib/mcp-broker/workiq"
import { initOpencodeVersion } from "~/lib/platform/opencode"
import { ensurePaths } from "~/lib/platform/paths"
import { writePidfile } from "~/lib/platform/replace-running"
import {
  cacheMacMachineId,
  cacheVsCodeDeviceId,
  cacheVsCodeSessionId,
  cacheVSCodeVersion,
} from "~/lib/platform/utils"
import { hasGithubToken, state } from "~/lib/runtime-state/state"
import { warmNpmDetection } from "~/lib/system/npm-login-config"
import { startUpdateNotice } from "~/lib/update/update-notice"
import { getGitVersion, shortSha } from "~/lib/update/version"
import { startWorkingNotice } from "~/lib/working-notice"

import { initBootLogger, printReadyBanner } from "./boot-io"
import { emitBootStatus } from "./boot-status"
import { bootSecrets, bootstrapUpstream } from "./bootstrap"
import { runClaudeCodeFlow } from "./claude-code-flow"
import { listenHostname } from "./listen-host"
import { maybeEvictRunning, probePort, reportPortBusyAndExit } from "./port"
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
  const config = mergeConfigWithDefaults()

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

  const hostname = listenHostname()
  bootLogger.info(
    `listening url=${serverUrl} host=${hostname} `
      + `executor=${executorName.split(" ")[0]} `
      + `auth=${hasGithubToken() ? "authenticated" : "unauthenticated"}`,
  )

  const httpServer = serve({
    fetch: server.fetch,
    hostname,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })

  afterListening(config, options.port, httpServer)
}

/** Boot steps that need the bound listener: the broker, client entries that
 *  point at `port`, and the shutdown path that reverts them. */
function afterListening(
  config: AppConfig,
  port: number,
  httpServer: ReturnType<typeof serve>,
): void {
  setListeningPort(port)

  // Broker startup is deliberately detached from ordinary server readiness.
  // A missing, hung, or crashing broker degrades MCP only; Hono is already bound.
  // A Work IQ whose setup isn't done is held back from the broker. Until its
  // config has been read it counts as not done, so the broker starts
  // without it; the check queued right after starts it if it's set up, and
  // anything waiting for the broker waits for that too.
  setBrokerConfigFilter((broker) => holdBackWorkIqUntilSetUp(broker))
  // An upgraded catalog server (e.g. Work IQ) may have moved; find it first.
  const brokerConfig = refreshCatalogCommands(config).mcpBroker ?? {}
  startBrokerSupervisor(brokerConfig)
  void reconfigureBrokerAfterSetupCheck(brokerConfig).catch(
    (error: unknown) => {
      consola.warn("Could not check Work IQ's setup", error)
    },
  )
  // npm's registry and global prefix are looked up in the background, never
  // on the event loop; once known, a server installed with npm may turn out
  // to have moved too. (Until then a refresh keeps each server's last path.)
  void warmNpmDetection()
    .then(async () => {
      const before = getConfig()
      const after = refreshCatalogCommands(before)
      if (after !== before) await reconfigureBroker(after.mcpBroker ?? {})
    })
    .catch((error: unknown) => {
      consola.warn("Could not recheck MCP server paths", error)
    })
  // One-time "Maximal is working" notification (shown by the menu-bar shell).
  void startWorkingNotice()
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
  // MCP entries wait (bounded) for the broker, so an app that connects right
  // away isn't turned away while it probes its servers. Detached: nothing
  // else here, and no ordinary request, waits on the broker.
  void syncMcpClientsWhenBrokerReady()

  // Drop the "session running" sentinel only AFTER the boot hooks
  // so the freshly-written URL is in place when we promise the session is
  // healthy. shutdown clears it; a missing-on-next-boot sentinel means a
  // clean exit, present-on-next-boot means an ungraceful one (see the
  // staleSession check above).
  markSessionRunning(port)

  installShutdownHandlers(httpServer, stopBrokerSupervisor)
}
