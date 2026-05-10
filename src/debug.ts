#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import os from "node:os"

import {
  type AppConfig,
  DEFAULT_LOG_RETENTION_DAYS,
  getConfig,
} from "./lib/config"
import { PATHS } from "./lib/paths"
import { SECRET_DEFS, secretIsFromFile } from "./lib/secrets"
import { getGitVersion, shortSha } from "./lib/version"
import { chooseExecutor } from "./routes/messages/web-tools-executor"

interface SecretStatus {
  name: string
  source: "env" | "file" | "config" | "unset"
}

export interface DebugInfo {
  version: string
  git: {
    sha: string | undefined
    branch: string | undefined
  }
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
    log_retention_days: number
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
  // Resolved at compile time via `--define __MAXIMAL_VERSION__`
  // (see release.yml) for release binaries; falls back to
  // package.json for `bun src/main.ts` / unbundled installs.
  // Reading package.json from disk via fs.readFile + import.meta.url
  // fails in `bun --compile` output, which historically left every
  // shipped binary reporting `Version: unknown`.
  const { BUILD_VERSION } = await import("./lib/build-info")
  return BUILD_VERSION
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

/** Status of a sensitive value: env wins, file fallback, then config,
 *  else unset. We never read the value here — only the source. */
export interface SecretStatusInput {
  name: string
  envVar: string
  configValue: string | undefined
  /** Optional fileName under the secrets/ dir — if present and the
   *  file exists with safe mode, source is "file". */
  fileName?: string
}

export function secretStatus(
  input: SecretStatusInput,
  env: NodeJS.ProcessEnv = process.env,
): SecretStatus {
  const value = env[input.envVar]
  if (value !== undefined && value.length > 0) {
    // The value is in env either because the user set it or because
    // loadSecretIntoEnv copied it from a file at boot. To distinguish,
    // peek at the file. Best-effort — diagnostics, not authoritative.
    if (
      input.fileName !== undefined
      && secretIsFromFile(input.fileName, value)
    ) {
      return { name: input.name, source: "file" }
    }
    return { name: input.name, source: "env" }
  }
  if (input.configValue !== undefined && input.configValue.length > 0) {
    return { name: input.name, source: "config" }
  }
  return { name: input.name, source: "unset" }
}

/** Diagnostic shape of the executor `selectExecutor()` would pick.
 *  Strips the apiKey from the Ollama variant so it never reaches
 *  diagnostic output. */
export function describeExecutor(
  env: NodeJS.ProcessEnv = process.env,
): DebugInfo["executor"] {
  const choice = chooseExecutor(env)
  switch (choice.kind) {
    case "OllamaWebExecutor": {
      return { web_tools: choice.kind, base: choice.base }
    }
    case "InProcessFetchExecutor": {
      return { web_tools: choice.kind, notes: choice.notes }
    }
    default: {
      throw new Error(
        `unhandled executor kind: ${(choice as { kind: string }).kind}`,
      )
    }
  }
}

/** Project AppConfig down to the diagnostic subset displayed by both
 *  `copilot-api debug` and `/_debug/state`. Adding a field updates
 *  one place. */
export function summarizeConfig(config: AppConfig): DebugInfo["config"] {
  return {
    use_messages_api: config.useMessagesApi,
    use_function_apply_patch: config.useFunctionApplyPatch,
    use_responses_api_web_search: config.useResponsesApiWebSearch,
    small_model: config.smallModel,
    claude_token_multiplier: config.claudeTokenMultiplier,
    log_retention_days: config.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS,
    api_keys_configured: (config.auth?.apiKeys?.length ?? 0) > 0,
    providers_declared: Object.keys(config.providers ?? {}),
  }
}

/** Resolve every known secret's source for diagnostic output. Iterates
 *  SECRET_DEFS so adding a provider in one place updates both
 *  `debug` and `/_debug/state`. */
export function collectSecretStatuses(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Array<SecretStatus> {
  return SECRET_DEFS.map((def) =>
    secretStatus(
      {
        name: def.name,
        envVar: def.envVar,
        configValue: def.readConfig?.(config),
        fileName: def.fileName,
      },
      env,
    ),
  )
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
    git: getGitVersion(),
    runtime: getRuntimeInfo(),
    paths: {
      APP_DIR: PATHS.APP_DIR,
      GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH,
      CONFIG_PATH: PATHS.CONFIG_PATH,
      LOG_DIR: `${PATHS.APP_DIR}/logs`,
    },
    tokenExists,
    config: summarizeConfig(config),
    executor: describeExecutor(),
    secrets: collectSecretStatuses(config),
  }
}

type Stringy = string | number | boolean | undefined

function formatField(name: string, value: Stringy): string {
  const v = value === undefined ? "<unset>" : String(value)
  return `  ${name}: ${v}`
}

function printDebugInfoPlain(info: DebugInfo): void {
  const lines = [
    `maximal debug`,
    ``,
    `Version: ${info.version}`,
    `Git: ${shortSha(info.git.sha)}${info.git.branch ? ` (${info.git.branch})` : ""}`,
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
    formatField("log_retention_days", info.config.log_retention_days),
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
