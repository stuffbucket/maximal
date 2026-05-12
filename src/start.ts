#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve } from "srvx"
import invariant from "tiny-invariant"

import { mergeConfigWithDefaults } from "./lib/config"
import { initOpencodeVersion } from "./lib/opencode"
import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { ensureSecretsDir, loadSecretIntoEnv, SECRET_DEFS } from "./lib/secrets"
import { evaluateSetup } from "./lib/setup-status"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { logUser, setupCopilotToken, setupGitHubToken } from "./lib/token"
import {
  cacheMacMachineId,
  cacheModels,
  cacheVSCodeVersion,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
} from "./lib/utils"
import { getGitVersion, shortSha } from "./lib/version"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
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

export async function runServer(options: RunServerOptions): Promise<void> {
  // Work around unjs/consola#357 until a release includes PR #359.
  consola.options.throttle = 0

  // Print something immediately so users know `maximal start` is
  // doing something. The next ~3-5s are spent on Copilot bootstrap
  // (token exchange, model fetch, machine-id + session-id caching),
  // and without this line the terminal just sits silent.
  consola.start("Starting maximal…")

  // Bail out early if the port is already taken — much friendlier
  // than crashing 5s later inside srvx with EADDRINUSE.
  const portState = await probePort(options.port)
  if (portState !== "free") {
    const url = `http://localhost:${options.port}`
    if (portState === "maximal") {
      consola.warn(
        [
          `Another maximal is already running on port ${options.port}.`,
          ``,
          `It's already listening at ${url}. Point your client at`,
          `that URL — no second instance needed.`,
          ``,
          `If you want a separate copy on another port:`,
          `    maximal start --port ${options.port + 1}`,
        ].join("\n"),
      )
    } else {
      const lookupHint =
        process.platform === "win32" ?
          `netstat -ano | findstr :${options.port}`
        : `lsof -i :${options.port}`
      consola.error(
        [
          `Port ${options.port} is already in use by another process.`,
          ``,
          `Either stop whatever is holding the port, or pick a`,
          `different one:`,
          `    maximal start --port ${options.port + 1}`,
          ``,
          `Find the offender with:`,
          `    ${lookupHint}`,
        ].join("\n"),
      )
    }
    process.exit(1)
  }

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
  await logSetupSnapshot()

  bootSecrets()
  await cacheVSCodeVersion()
  cacheMacMachineId()
  cacheVsCodeSessionId()
  await cacheVsCodeDeviceId()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
    await logUser()
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  const executorName =
    process.env.OLLAMA_API_KEY ?
      "OllamaWebExecutor"
    : "InProcessFetchExecutor (search disabled; set OLLAMA_API_KEY)"
  consola.info(`Web-tools executor: ${executorName}`)

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    await runClaudeCodeFlow(serverUrl)
  }

  consola.box(
    `🌐 Usage Viewer: ${serverUrl}/usage-viewer?endpoint=${serverUrl}/usage`,
  )

  const { server } = await import("./server")

  serve({
    fetch: server.fetch,
    port: options.port,
    bun: {
      idleTimeout: 0,
    },
  })
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

/** Per docs/first-run-setup-prd.md §Telemetry: one info-level
 *  snapshot of evaluateSetup() at boot. The Tauri shell polls
 *  /setup-status continuously; the boot log is the audit trail for
 *  "what did we come up with this time." */
async function logSetupSnapshot(): Promise<void> {
  try {
    const snapshot = await evaluateSetup()
    consola.info(
      `Setup status: ready=${snapshot.ready}`
        + (snapshot.nextStep ? ` nextStep=${snapshot.nextStep}` : ""),
    )
  } catch (err) {
    consola.warn("Setup status evaluation failed:", err)
  }
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
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
    })
  },
})
