#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { getConfig } from "./lib/config"
import { PATHS } from "./lib/paths"
import { chooseExecutor } from "./routes/messages/web-tools-executor"

interface SecretStatus {
  name: string
  source: "env" | "file" | "config" | "unset"
}

export interface DebugInfo {
  version: string
  runtime: {
    name: string
    version: string
    platform: string
    arch: string
  }
  paths: {
    APP_DIR: string
    GITHUB_TOKEN_PATH: string
    CONFIG_PATH: string
    LOG_DIR: string
  }
  tokenExists: boolean
  config: {
    use_messages_api?: boolean
    use_function_apply_patch?: boolean
    use_responses_api_web_search?: boolean
    small_model?: string
    claude_token_multiplier?: number
    api_keys_configured: boolean
    providers_declared: Array<string>
  }
  executor: {
    web_tools: string
    base?: string
    notes?: string
  }
  secrets: Array<SecretStatus>
}

interface RunDebugOptions {
  json: boolean
}

async function getPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url).pathname
    // @ts-expect-error https://github.com/sindresorhus/eslint-plugin-unicorn/blob/v59.0.1/docs/rules/prefer-json-parse-buffer.md
    // JSON.parse() can actually parse buffers
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath)) as {
      version: string
    }
    return packageJson.version
  } catch {
    return "unknown"
  }
}

function getRuntimeInfo() {
  const isBun = typeof Bun !== "undefined"

  return {
    name: isBun ? "bun" : "node",
    version: isBun ? Bun.version : process.version.slice(1),
    platform: os.platform(),
    arch: os.arch(),
  }
}

async function checkTokenExists(): Promise<boolean> {
  try {
    const stats = await fs.stat(PATHS.GITHUB_TOKEN_PATH)
    if (!stats.isFile()) return false

    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

/** Status of a sensitive value: env wins, config-file fallback, else
 *  unset. We never read the value here — only the source.
 *
 *  Exported and env-injected for testability — the actual debug
 *  subcommand passes process.env. */
export interface SecretStatusInput {
  name: string
  envVar: string
  configValue: string | undefined
  /** Optional fileName under the secrets/ dir — if present and the
   *  file exists with safe mode, source is "file". Used by M5 to
   *  distinguish env-from-file vs env-from-shell. */
  fileName?: string
}

export function secretStatus(
  input: SecretStatusInput,
  env: NodeJS.ProcessEnv = process.env,
): SecretStatus {
  const value = env[input.envVar]
  if (value !== undefined && value.length > 0) {
    // In the file-loaded case the value is in env at this point
    // (loadSecretIntoEnv ran at boot). To distinguish, peek at the
    // file: if it exists with safe mode and matches the env value,
    // report "file". Otherwise "env". Read is best-effort —
    // diagnostics, not authoritative.
    if (input.fileName !== undefined && fileMatches(input.fileName, value)) {
      return { name: input.name, source: "file" }
    }
    return { name: input.name, source: "env" }
  }
  if (input.configValue !== undefined && input.configValue.length > 0) {
    return { name: input.name, source: "config" }
  }
  return { name: input.name, source: "unset" }
}

function fileMatches(fileName: string, value: string): boolean {
  // Best-effort — any error means "couldn't verify, assume not from
  // file."
  try {
    const filePath = path.join(PATHS.APP_DIR, "secrets", fileName)
    const stats = fsSync.statSync(filePath)
    if (!stats.isFile()) return false
    if ((stats.mode & 0o777) !== 0o600) return false
    return fsSync.readFileSync(filePath, "utf8").trim() === value
  } catch {
    return false
  }
}

/** Diagnostic shape of the executor `selectExecutor()` would pick.
 *  Delegates to `chooseExecutor()` so debug output and runtime
 *  selection share one source of truth. */
export function describeExecutor(
  env: NodeJS.ProcessEnv = process.env,
): DebugInfo["executor"] {
  const choice = chooseExecutor(env)
  return {
    web_tools: choice.kind,
    ...(choice.base === undefined ? {} : { base: choice.base }),
    ...(choice.notes === undefined ? {} : { notes: choice.notes }),
  }
}

async function getDebugInfo(): Promise<DebugInfo> {
  const [version, tokenExists] = await Promise.all([
    getPackageVersion(),
    checkTokenExists(),
  ])

  // Config read can throw if the file is malformed; surface as empty
  // rather than crashing — the user is debugging.
  let config: ReturnType<typeof getConfig>
  try {
    config = getConfig()
  } catch {
    config = {}
  }

  return {
    version,
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH,
      CONFIG_PATH: PATHS.CONFIG_PATH,
      LOG_DIR: `${PATHS.APP_DIR}/logs`,
    },
    tokenExists,
    config: {
      use_messages_api: config.useMessagesApi,
      use_function_apply_patch: config.useFunctionApplyPatch,
      use_responses_api_web_search: config.useResponsesApiWebSearch,
      small_model: config.smallModel,
      claude_token_multiplier: config.claudeTokenMultiplier,
      api_keys_configured: (config.auth?.apiKeys?.length ?? 0) > 0,
      providers_declared: Object.keys(config.providers ?? {}),
    },
    executor: describeExecutor(),
    secrets: [
      secretStatus({
        name: "ollama_api_key",
        envVar: "OLLAMA_API_KEY",
        configValue: undefined,
        fileName: "ollama",
      }),
      secretStatus({
        name: "anthropic_api_key",
        envVar: "ANTHROPIC_API_KEY",
        configValue: config.anthropicApiKey,
        fileName: "anthropic",
      }),
    ],
  }
}

type Stringy = string | number | boolean | undefined

function formatField(name: string, value: Stringy): string {
  const v = value === undefined ? "<unset>" : String(value)
  return `  ${name}: ${v}`
}

function printDebugInfoPlain(info: DebugInfo): void {
  const lines = [
    `copilot-api debug`,
    ``,
    `Version: ${info.version}`,
    `Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})`,
    ``,
    `Paths:`,
    `  APP_DIR: ${info.paths.APP_DIR}`,
    `  CONFIG_PATH: ${info.paths.CONFIG_PATH}`,
    `  GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}`,
    `  LOG_DIR: ${info.paths.LOG_DIR}`,
    ``,
    `GitHub token: ${info.tokenExists ? "<set>" : "<unset>"}`,
    ``,
    `Config:`,
    formatField("use_messages_api", info.config.use_messages_api),
    formatField(
      "use_function_apply_patch",
      info.config.use_function_apply_patch,
    ),
    formatField(
      "use_responses_api_web_search",
      info.config.use_responses_api_web_search,
    ),
    formatField("small_model", info.config.small_model),
    formatField("claude_token_multiplier", info.config.claude_token_multiplier),
    formatField("api_keys_configured", info.config.api_keys_configured),
    formatField(
      "providers_declared",
      info.config.providers_declared.length > 0 ?
        info.config.providers_declared.join(", ")
      : "<none>",
    ),
    ``,
    `Web-tools executor: ${info.executor.web_tools}`,
    ...(info.executor.base ? [`  base: ${info.executor.base}`] : []),
    ...(info.executor.notes ? [`  ${info.executor.notes}`] : []),
    ``,
    `Secrets:`,
    ...info.secrets.map((s) => `  ${s.name}: <${s.source}>`),
  ]

  consola.info(lines.join("\n"))
}

function printDebugInfoJson(info: DebugInfo): void {
  console.log(JSON.stringify(info, null, 2))
}

export async function runDebug(options: RunDebugOptions): Promise<void> {
  const debugInfo = await getDebugInfo()

  if (options.json) {
    printDebugInfoJson(debugInfo)
  } else {
    printDebugInfoPlain(debugInfo)
  }
}

export const debug = defineCommand({
  meta: {
    name: "debug",
    description: "Print debug information about the application",
  },
  args: {
    json: {
      type: "boolean",
      default: false,
      description: "Output debug information as JSON",
    },
  },
  run({ args }) {
    return runDebug({
      json: args.json,
    })
  },
})
