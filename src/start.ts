#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve } from "srvx"
import invariant from "tiny-invariant"

import { markAuthFatalAndSignOut } from "./lib/auth-controller"
import { type AccountType, parseAccountType } from "./lib/auth-types"
import {
  reconcileClaudeCodeOnBoot,
  reconcileClaudeCodeOnShutdown,
} from "./lib/claude-code-reconcile"
import { mergeConfigWithDefaults } from "./lib/config"
import { CopilotAuthFatalError } from "./lib/error"
import { readDefaultRecord } from "./lib/github-token-store"
import { createHandlerLogger } from "./lib/logger"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import {
  evictRunning,
  removePidfile,
  writePidfile,
} from "./lib/replace-running"
import { getConfiguredApiKeys } from "./lib/request-auth"
import { ensureSecretsDir, loadSecretIntoEnv, SECRET_DEFS } from "./lib/secrets"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { logUser, setupCopilotToken } from "./lib/token"
import {
  cacheMacMachineId,
  cacheModels,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"
import { getGitVersion, shortSha, type GitVersion } from "./lib/version"

interface RunServerOptions {
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

/**
 * Probe `localhost:port` before we start so we can fail fast with a
 * useful message instead of spending 5s on Copilot bootstrap and
 * then dying on EADDRINUSE deep inside srvx. Returns:
 *
 *   - "free"     — nothing answered; port is ours to bind.
 *   - "maximal"  — got the canary "Server running" from `/`,
 *                  meaning another copy of maximal is already up.
 *   - "other"    — something answered but it isn't us.
 */
/** Wrap evictRunning() with the CLI's error-handling. On failure to
 *  free the port we exit 1 with a readable message rather than dumping
 *  a stack trace. */
async function maybeEvictRunning(port: number): Promise<void> {
  const keys = getConfiguredApiKeys()
  const apiKey = keys[0] ?? null
  try {
    await evictRunning({ apiKey, port })
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

/** Print a friendly explanation of why the port is held and exit 1.
 *  Extracted so `runServer` stays inside the 100-line lint cap. */
function reportPortBusyAndExit(
  port: number,
  portState: "maximal" | "other",
): never {
  const url = `http://localhost:${port}`
  if (portState === "maximal") {
    consola.warn(
      [
        `Another maximal is already running on port ${port}.`,
        ``,
        `It's already listening at ${url}. Point your client at`,
        `that URL — no second instance needed.`,
        ``,
        `To restart it (take over this port), run:`,
        `    maximal start --replace`,
        ``,
        `Or run a separate copy on another port:`,
        `    maximal start --port ${port + 1}`,
      ].join("\n"),
    )
  } else {
    const lookupHint =
      process.platform === "win32" ?
        `netstat -ano | findstr :${port}`
      : `lsof -i :${port}`
    consola.error(
      [
        `Port ${port} is already in use by another process.`,
        ``,
        `Either stop whatever is holding the port, or pick a`,
        `different one:`,
        `    maximal start --port ${port + 1}`,
        ``,
        `Find the offender with:`,
        `    ${lookupHint}`,
      ].join("\n"),
    )
  }
  process.exit(1)
}

async function probePort(port: number): Promise<"free" | "maximal" | "other"> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(500),
    })
    if (!res.ok) return "other"
    const text = (await res.text()).trim()
    return text === "Server running" ? "maximal" : "other"
  } catch {
    return "free"
  }
}

/** Structured boot-phase line the Tauri shell relays to its splash window as
 *  live status (so a slow or failed start isn't a blank "Starting…" or a
 *  silently-cleared splash). No-op for plain CLI users — gated on the
 *  parent-pid env the shell sets when it spawns the sidecar — so their
 *  terminal never sees the marker. */
export const BOOT_STATUS_MARKER = "@@MAXIMAL_STATUS@@"

export function emitBootStatus(message: string): void {
  if (!process.env.MAXIMAL_SIDECAR_PARENT_PID) return
  process.stdout.write(`${BOOT_STATUS_MARKER} ${message}\n`)
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

  const { server } = await import("./server")

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

  installShutdownHandlers(httpServer)
}

// Idempotency guard so SIGTERM racing with the parent-death watchdog
// (or being delivered twice) doesn't double-stop the server.
let shuttingDown = false

/** Stop the HTTP server, then exit 0. Capped at ~2.5s by an unref'd
 *  watchdog timer so a hung close() can't keep the process alive. */
async function initiateShutdown(
  httpServer: ReturnType<typeof serve>,
  reason: string,
): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true

  consola.info(`shutdown: ${reason}, draining`)

  // Take Claude Code off the proxy before we stop accepting connections,
  // so `claude` isn't stranded over a dead base URL. Ownership-guarded and
  // intent-gated (no-op when routing is off); the intent flag persists, so
  // the next boot re-applies it. Synchronous + best-effort — a slow/failed
  // file write must not delay or block the drain.
  reconcileClaudeCodeOnShutdown()

  // Fail-safe: if close() hangs, hard-exit after 2.5s. .unref() so the
  // timer itself never holds the loop open in the happy path.
  const watchdog = setTimeout(() => {
    consola.warn("shutdown: watchdog tripped, forcing exit")
    process.exit(1)
  }, 2500)
  watchdog.unref()

  try {
    // srvx Server exposes close(); pass true to drop in-flight conns.
    await httpServer.close(true)
  } catch (error) {
    consola.warn("shutdown: server.close() threw", error)
  }

  // Pidfile is a hint, not a lock — best-effort cleanup.
  await removePidfile()

  clearTimeout(watchdog)
  process.exit(0)
}

/** Wire SIGTERM + optional parent-death watchdog. The watchdog only
 *  runs when MAXIMAL_SIDECAR_PARENT_PID is set (Tauri shell spawn);
 *  bare CLI users own their own lifecycle. */
function installShutdownHandlers(httpServer: ReturnType<typeof serve>): void {
  process.on("SIGTERM", () => {
    void initiateShutdown(httpServer, "received SIGTERM")
  })
  process.on("SIGINT", () => {
    void initiateShutdown(httpServer, "received SIGINT")
  })

  const parentPidStr = process.env.MAXIMAL_SIDECAR_PARENT_PID
  const parentPid = parentPidStr ? Number(parentPidStr) : null

  if (parentPid && Number.isInteger(parentPid) && parentPid > 0) {
    consola.info(`shutdown: watching parent pid ${parentPid}`)
    const interval = setInterval(() => {
      try {
        // kill(pid, 0) is the POSIX "is this process alive" probe —
        // sends no signal, throws ESRCH if the parent is gone.
        process.kill(parentPid, 0)
      } catch {
        clearInterval(interval)
        consola.warn(`shutdown: parent ${parentPid} gone`)
        void initiateShutdown(httpServer, `parent ${parentPid} exited`)
      }
    }, 3000)
    interval.unref()
  }
}

/** Boot-event logger. Writes to ~/.local/share/maximal/logs/startup-<date>.log
 *  via the same handler-logger machinery used by /v1/messages. The first
 *  write also creates the logs/ directory so "Reveal logs in Finder"
 *  lands somewhere even on first boot, and the record gives operators a
 *  per-restart audit trail that stdout alone can't answer. */
function initBootLogger(
  git: GitVersion,
  options: RunServerOptions,
): ReturnType<typeof createHandlerLogger> {
  const logger = createHandlerLogger("startup")
  logger.info(
    `maximal start pid=${process.pid} `
      + `version=${git.sha ? shortSha(git.sha) : "unknown"} `
      + `branch=${git.branch || "unknown"} port=${options.port} `
      + `account=${options.accountType}`,
  )
  return logger
}

/** Ready banner printed once the proxy is about to start serving.
 *  Lists the user-facing surfaces and hints at the faster Vite UI
 *  iteration loop for HTML/CSS/TS work. */
function printReadyBanner(serverUrl: string): void {
  consola.box(
    [
      `🌐 Settings:     ${serverUrl}/settings/`,
      `📊 Usage Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
      ``,
      `Fast UI iteration: \`bun run app:ui\` serves the Settings`,
      `bundle at http://localhost:1420/settings/ with HMR.`,
    ].join("\n"),
  )
}

/** Interactive Claude Code helper: prompt for primary + small model,
 *  generate a clipboard-ready env script, and copy it. Factored out
 *  to keep runServer() under the lint line cap. */
async function runClaudeCodeFlow(serverUrl: string): Promise<void> {
  consola.log(
    "\n💡 Tip: The --claude-code flag simply generates a clipboard command for launching Claude Code. \n"
      + "All models remain fully accessible without this flag, just configure the model ID directly in your settings.json file.",
  )

  invariant(state.models, "Models should be loaded by now")

  const selectedModel = await consola.prompt(
    "Select a model to use with Claude Code",
    { type: "select", options: state.models.data.map((m) => m.id) },
  )

  const selectedSmallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    { type: "select", options: state.models.data.map((m) => m.id) },
  )

  const command = generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "true",
      CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
      CLAUDE_PLUGIN_ENABLE_QUESTION_RULES: "true",
    },
    "claude",
  )

  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

/**
 * Bring the GitHub Copilot upstream online — but only if we already
 * have a token. Reads the token from disk (or accepts an explicit
 * `--github-token` override); never fires the device-code flow on its
 * own. Errors during Copilot bootstrap are caught: a stale or revoked
 * token shouldn't keep the HTTP server from binding, since the user
 * needs the UI up to re-authenticate.
 */
async function bootstrapUpstream(
  githubTokenOverride: string | undefined,
): Promise<void> {
  if (githubTokenOverride) {
    state.githubToken = githubTokenOverride
    consola.info("Using provided GitHub token")
  } else {
    const existing = await readDefaultRecord()
    if (existing) {
      state.githubToken = existing.accessToken
      if (state.showToken) {
        consola.info("GitHub token:", existing.accessToken)
      }
    }
  }

  if (state.githubToken) {
    try {
      emitBootStatus("Connecting to GitHub Copilot…")
      await logUser()
      await setupCopilotToken()
      await cacheModels()
      consola.info(
        `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
      )
      return
    } catch (error) {
      // A *fatal* Copilot error (license revoked, TOS not accepted, not
      // entitled) is actionable — but only if we preserve its message +
      // remediation URL. Route it through markAuthFatalAndSignOut so the
      // Settings "Sign in" screen shows the real reason instead of a generic
      // "Not signed in" that dead-ends the user. Non-fatal/transient errors
      // keep the plain warn-and-degrade path (the token may still be good;
      // the proxy stays up so the user can retry or re-auth).
      if (error instanceof CopilotAuthFatalError) {
        consola.warn(
          "GitHub token present but Copilot rejected it; surfacing the reason in Settings.",
          error.message,
        )
        await markAuthFatalAndSignOut(error)
        return
      }
      consola.warn(
        "GitHub token present but Copilot bootstrap failed; serving in unauthenticated mode.",
        error,
      )
      state.githubToken = undefined
    }
  }

  consola.warn(
    "No GitHub token; proxy is up in unauthenticated mode — sign in via /settings or run `maximal auth`.",
  )
}

/** Load file-based provider secrets into process.env. Env still wins;
 *  this only populates unset values from ~/.local/share/copilot-api/
 *  secrets/<provider>. Iterates SECRET_DEFS so adding a provider is
 *  a one-line change in secrets.ts. */
function bootSecrets(): void {
  ensureSecretsDir()
  for (const def of SECRET_DEFS) {
    const result = loadSecretIntoEnv({
      envVar: def.envVar,
      fileName: def.fileName,
    })
    if (result.source === "file") {
      consola.info(`Loaded ${def.envVar} from secrets/${def.fileName}`)
    }
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    replace: {
      type: "boolean",
      default: false,
      description: "Evict any running instance and take over the port",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      // Fail closed on an invalid account type rather than constructing a
      // bogus host from a typo (boundary D1).
      accountType: parseAccountType(args["account-type"]),
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      replace: args.replace,
    })
  },
})
