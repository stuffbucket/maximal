import type { PluginSettings } from "@stuffbucket/maximal-plugin-sdk/gateway"

import consola from "consola"
import fs from "node:fs"

import type { BudgetConfig } from "~/lib/budget/schema"

import {
  ConfigValidationError,
  detectUnknownKeys,
  validateAppConfig,
} from "~/lib/config/config-schema"
import { parseJsonText } from "~/lib/platform/json-text"
import { PATHS } from "~/lib/platform/paths"

export interface ApiKeyEntry {
  id: string
  label: string
  key: string
  enabled: boolean
  created_at: string
}

export interface ModelMappingRule {
  match:
    | { type: "exact"; value: string }
    | { type: "glob"; value: string }
    | { type: "regex"; value: string; flags?: "" | "u" }
  target: string
}

export interface AnthropicMessagesConfig {
  haikuModel?: string
  sonnetModel?: string
  autoPermissionModel?: string
}

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
    apiKeyEntries?: Array<ApiKeyEntry>
    enforce?: boolean
  }
  providers?: Record<string, ProviderConfig>
  extraPrompts?: Record<string, string>
  smallModel?: string
  responsesApiContextManagementModels?: Array<string>
  promptCacheRetention?: "in_memory" | "24h"
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  >
  modelMappings?: Array<ModelMappingRule>
  anthropicMessages?: AnthropicMessagesConfig
  useFunctionApplyPatch?: boolean
  useMessagesApi?: boolean
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  claudeTokenMultiplier?: number
  logRetentionDays?: number
  autoRecoverAccount?: boolean
  checkUpdates?: boolean
  editorVersion?: string
  apps?: AppsConfig
  plugins?: PluginSettings
  pluginInventory?: { entry: string }
  mcpBroker?: unknown
  budget?: BudgetConfig
}

export interface AppsConfig {
  pi?: {
    enabled?: boolean
    configDirectory?: string
  }
  codex?: {
    enabled?: boolean
  }
  claudeCode?: {
    enabled?: boolean
    mcpServers?: Array<string>
    fastModel?: string
    capableModel?: string
    classifierModel?: string
  }
  claudeDesktop?: {
    enabled?: boolean
    mcpServers?: Array<string>
  }
}

export function anthropicMessagesConfig(
  config: AppConfig,
): AnthropicMessagesConfig {
  const legacy = config.apps?.claudeCode
  const haikuModel = config.anthropicMessages?.haikuModel ?? legacy?.fastModel
  const sonnetModel =
    config.anthropicMessages?.sonnetModel ?? legacy?.capableModel
  const autoPermissionModel =
    config.anthropicMessages?.autoPermissionModel ?? legacy?.classifierModel
  return {
    ...(haikuModel ? { haikuModel } : {}),
    ...(sonnetModel ? { sonnetModel } : {}),
    ...(autoPermissionModel ? { autoPermissionModel } : {}),
  }
}

export interface ModelConfig {
  temperature?: number
  topP?: number
  topK?: number
}

export type ProviderAuthType = "authorization" | "x-api-key"

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

export interface ResolvedProviderConfig {
  name: string
  type: "anthropic"
  baseUrl: string
  apiKey: string
  authType: ProviderAuthType
  models?: Record<string, ModelConfig>
  adjustInputTokens?: boolean
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const gpt5CommentaryPrompt = `# Working with the user

You interact with the user through a terminal. You have 2 ways of communicating with the users:  
- Share intermediary updates in \`commentary\` channel.  
- After you have completed all your work, send a message to the \`final\` channel.  

## Intermediary updates

- Intermediary updates go to the \`commentary\` channel.
- User updates are short updates while you are working, they are NOT final answers.
- You use 1-2 sentence user updates to communicate progress and new information to the user as you are doing work.
- Do not begin responses with conversational interjections or meta commentary. Avoid openers such as acknowledgements (“Done —”, “Got it”, “Great question, ”) or framing phrases.
- You provide user updates frequently, every 20s.
- Before exploring or doing substantial work, you start with a user update acknowledging the request and explaining your first step. You should include your understanding of the user request and explain what you will do. Avoid commenting on the request or using starters such as "Got it -" or "Understood -" etc.
- When exploring, e.g. searching, reading files, you provide user updates as you go, every 20s, explaining what context you are gathering and what you've learned. Vary your sentence structure when providing these updates to avoid sounding repetitive - in particular, don't start each sentence the same way.
- After you have sufficient context, and the work is substantial, you provide a longer plan (this is the only user update that may be longer than 2 sentences and can contain formatting).
- Before performing file edits of any kind, you provide updates explaining what edits you are making.`

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
    "gpt-5.3-codex": gpt5CommentaryPrompt,
    "gpt-5.4-mini": gpt5CommentaryPrompt,
    "gpt-5.4": gpt5CommentaryPrompt,
    "gpt-5.5": gpt5CommentaryPrompt,
  },
  smallModel: "gpt-5-mini",
  responsesApiContextManagementModels: [],
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
    "gpt-5.3-codex": "xhigh",
    "gpt-5.4-mini": "xhigh",
    "gpt-5.4": "xhigh",
    "gpt-5.5": "xhigh",
  },
  modelMappings: [
    {
      match: { type: "exact", value: "codex-auto-review" },
      target: "gpt-5.6-luna",
    },
  ],
  useFunctionApplyPatch: true,
  useMessagesApi: true,
  useResponsesApiWebSearch: true,
}

export function getDefaultConfig(): AppConfig {
  return structuredClone(defaultConfig)
}

let cachedConfig: AppConfig | null = null

let unreadableConfigError: string | undefined

export class ConfigUnreadableError extends Error {
  constructor(reason: string) {
    super(
      `${PATHS.CONFIG_PATH} isn't valid JSON (${reason}), so Maximal won't write to it. Fix or remove the file, then try again.`,
    )
    this.name = "ConfigUnreadableError"
  }
}

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      "utf8",
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      return
    }
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  let parsed: unknown
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    unreadableConfigError = undefined
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return defaultConfig
    }
    parsed = parseJsonText(raw)
  } catch (error) {
    unreadableConfigError =
      error instanceof Error ? error.message : String(error)
    consola.error(
      `Couldn't read ${PATHS.CONFIG_PATH}; using the defaults and leaving the file as it is until it's fixed.`,
      error,
    )
    return defaultConfig
  }

  let config: AppConfig
  try {
    config = validateAppConfig(parsed)
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      consola.error(
        `Invalid ${PATHS.CONFIG_PATH}:\n${error.issues
          .map((i) => `  ${i.path || "<root>"}: ${i.message}`)
          .join("\n")}`,
      )
      process.exit(1)
    }
    throw error
  }

  const unknown = detectUnknownKeys(parsed)
  if (unknown.length > 0) {
    consola.warn(
      `Config has unknown keys (ignored, may be deprecated): ${unknown.join(", ")}`,
    )
  }

  return config
}

function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}
  const modelReasoningEfforts = config.modelReasoningEfforts ?? {}
  const defaultModelReasoningEfforts = defaultConfig.modelReasoningEfforts ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  const missingReasoningEffortModels = Object.keys(
    defaultModelReasoningEfforts,
  ).filter((model) => !Object.hasOwn(modelReasoningEfforts, model))

  const hasExtraPromptChanges = missingExtraPromptModels.length > 0
  const hasReasoningEffortChanges = missingReasoningEffortModels.length > 0
  const needsModelMappingDefault = config.modelMappings === undefined

  if (
    !hasExtraPromptChanges
    && !hasReasoningEffortChanges
    && !needsModelMappingDefault
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
      modelReasoningEfforts: {
        ...defaultModelReasoningEfforts,
        ...modelReasoningEfforts,
      },
      ...(needsModelMappingDefault ?
        { modelMappings: defaultConfig.modelMappings }
      : {}),
    },
    changed: true,
  }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()
  const { mergedConfig, changed } = mergeDefaultConfig(config)

  if (changed && unreadableConfigError === undefined) {
    try {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(mergedConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn(
        "Failed to write merged extraPrompts to config file",
        writeError,
      )
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= readConfigFromDisk()
  return cachedConfig
}

export function reloadConfig(): AppConfig {
  cachedConfig = readConfigFromDisk()
  return cachedConfig
}

export function writeConfig(next: AppConfig): AppConfig {
  if (unreadableConfigError !== undefined) {
    throw new ConfigUnreadableError(unreadableConfigError)
  }
  const validated = validateAppConfig(next)
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  const tmpPath = `${PATHS.CONFIG_PATH}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
  try {
    fs.chmodSync(tmpPath, 0o600)
  } catch (error) {
    void error
  }
  fs.renameSync(tmpPath, PATHS.CONFIG_PATH)
  cachedConfig = validated
  return validated
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  return config.extraPrompts?.[model] ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  return config.smallModel ?? "gpt-5-mini"
}

export function getResponsesApiContextManagementModels(): Array<string> {
  const config = getConfig()
  return (
    config.responsesApiContextManagementModels
    ?? defaultConfig.responsesApiContextManagementModels
    ?? []
  )
}

export function isResponsesApiContextManagementModel(model: string): boolean {
  return getResponsesApiContextManagementModels().includes(model)
}

export function getPromptCacheRetention(): "in_memory" | "24h" | undefined {
  const config = getConfig()
  return config.promptCacheRetention
}

export function getReasoningEffortForModel(
  model: string,
): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const config = getConfig()
  return (
    config.modelReasoningEfforts?.[model]
    ?? defaultConfig.modelReasoningEfforts?.[model]
    ?? "high"
  )
}

export function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
): ProviderAuthType {
  if (authType === undefined || authType === "x-api-key") {
    return "x-api-key"
  }

  if (authType === "authorization") {
    return authType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to x-api-key`,
  )
  return "x-api-key"
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  const provider = config.providers?.[providerName]
  if (!provider) {
    return null
  }

  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? "anthropic"
  if (type !== "anthropic") {
    consola.warn(
      `Provider ${providerName} is ignored because only anthropic type is supported`,
    )
    return null
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "")
  const apiKey = (provider.apiKey ?? "").trim()
  const authType = resolveProviderAuthType(providerName, provider.authType)
  if (!baseUrl || !apiKey) {
    consola.warn(
      `Provider ${providerName} is enabled but missing baseUrl or apiKey`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    apiKey,
    authType,
    models: provider.models,
    adjustInputTokens: provider.adjustInputTokens,
  }
}

export function isMessagesApiEnabled(): boolean {
  const config = getConfig()
  return config.useMessagesApi ?? true
}

export function getAnthropicApiKey(): string | undefined {
  const config = getConfig()
  return config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? undefined
}

export function isResponsesApiWebSearchEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSearch ?? true
}

export function getClaudeTokenMultiplier(): number {
  const config = getConfig()
  return config.claudeTokenMultiplier ?? 1.15
}

export const DEFAULT_LOG_RETENTION_DAYS = 7

export function getLogRetentionDays(): number {
  const config = getConfig()
  return config.logRetentionDays ?? DEFAULT_LOG_RETENTION_DAYS
}

export function isAutoRecoverAccountEnabled(): boolean {
  const config = getConfig()
  return config.autoRecoverAccount ?? false
}

export function isUpdateCheckEnabled(): boolean {
  if (process.env.MAXIMAL_UPDATE_POLICY === "disabled") return false
  const config = getConfig()
  return config.checkUpdates ?? true
}
