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
import { type AccountType } from "~/lib/auth-types"
import { ensureCliSymlink } from "~/lib/cli-path"
import { mergeConfigWithDefaults } from "~/lib/config"
import { initOpencodeVersion } from "~/lib/opencode"
import { ensurePaths } from "~/lib/paths"
import { initProxyFromEnv } from "~/lib/proxy"
import { writePidfile } from "~/lib/replace-running"
import { state } from "~/lib/state"
import {
  cacheMacMachineId,
  cacheVsCodeDeviceId,
  cacheVsCodeSessionId,
  cacheVSCodeVersion,
} from "~/lib/utils"
import { getGitVersion, shortSha } from "~/lib/version"

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
      + `auth=${state.githubToken ? "authenticated" : "unauthenticated"}`,
  )

  const httpServer = serve({
    fetch: server.fetch,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })

  // Best-effort: record our PID so a future `maximal start --replace`
  // can fall back to SIGTERM/SIGKILL if the graceful shutdown route
  // doesn't free the port in time.
  void writePidfile()

  // Now that we're actually listening, re-apply the Claude Code base URL
  // if the user left routing on. Self-heals a URL a prior crash/force-kill
  // stranded over a dead proxy. Ownership-guarded; no-op when routing is off.
  reconcileClaudeCodeOnBoot()

  // Drop the "session running" sentinel only AFTER reconcileClaudeCodeOnBoot
  // so the freshly-written URL is in place when we promise the session is
  // healthy. shutdown clears it; a missing-on-next-boot sentinel means a
  // clean exit, present-on-next-boot means an ungraceful one (see the
  // staleSession check above).
  markSessionRunning()

  installShutdownHandlers(httpServer)
}
