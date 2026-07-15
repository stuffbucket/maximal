import consola from "consola"
import fs from "node:fs"

import {
  ConfigValidationError,
  detectUnknownKeys,
  validateAppConfig,
} from "~/lib/config/config-schema"
import { PATHS } from "~/lib/platform/paths"

export interface ApiKeyEntry {
  id: string
  label: string
  key: string
  enabled: boolean
  created_at: string
}

/**
 * The reasoning-effort ladder maximal understands. Mirrors
 * `ReasoningEffortSchema` in config-schema.ts (keep them in lockstep). "max" is
 * the top rung, introduced with the GPT-5.6 trio.
 */
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

/**
 * Per-model AUTHORED tuning — maximal's deltas over default behavior for one
 * model, keyed by forward model id. Consolidates the old parallel `extraPrompts`
 * / `modelReasoningEfforts` / `responsesApiContextManagementModels` maps into one
 * record so onboarding a model is a single keyed entry, not three edits that can
 * drift out of alignment (the gap that hid the GPT-5.6 trio). This is the
 * "authored" half of a future full ModelProfile (#338); the intrinsic catalog
 * facts are the other half. Legacy shapes are folded in on load by
 * `migrateLegacyModelTuning`. `smallModel` stays a separate scalar selector.
 */
export interface ModelTuning {
  /** Extra system-prompt text appended for this model (was extraPrompts[id]). */
  extraPrompt?: string
  /** Authored reasoning effort (was modelReasoningEfforts[id]). */
  reasoningEffort?: ReasoningEffort
  /**
   * Opt this model into the Responses-API server-side context-management path
   * (was membership in responsesApiContextManagementModels).
   */
  responsesApiContextManagement?: boolean
}

export interface AppConfig {
  auth?: {
    /** Legacy free-form list of accepted bearer tokens. */
    apiKeys?: Array<string>
    /** Structured registry managed by Settings → API clients. */
    apiKeyEntries?: Array<ApiKeyEntry>
    /** When true, only requests with a known enabled key are accepted. */
    enforce?: boolean
  }
  providers?: Record<string, ProviderConfig>
  /**
   * Per-model authored tuning, keyed by forward model id. Replaces the old
   * parallel `extraPrompts` / `modelReasoningEfforts` /
   * `responsesApiContextManagementModels` maps (folded in on load by
   * `migrateLegacyModelTuning`). See {@link ModelTuning}.
   */
  models?: Record<string, ModelTuning>
  smallModel?: string
  /**
   * Copilot/OpenAI-Responses-specific server-side prefix-cache retention for
   * the `/responses` path. UNSET (undefined) → param is not sent, behavior
   * unchanged. "24h" keeps the cached prefix alive up to 24h (default is a
   * few minutes); cached input tokens are ~10x cheaper. Opt-in because some
   * model/endpoint combos have historically 400'd on this param — enablement
   * is made safe by a one-shot strip-and-retry fallback in create-responses.ts.
   * NOTE: independent from `store` (which controls response persistence/ZDR).
   */
  promptCacheRetention?: "in_memory" | "24h"
  useFunctionApplyPatch?: boolean
  useMessagesApi?: boolean
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  claudeTokenMultiplier?: number
  logRetentionDays?: number
  /**
   * Opt-in: when true, a fatal Copilot rejection may AUTO-SWITCH to another
   * previously-successful account without a per-event prompt. Defaults OFF —
   * enabling it is the user's PRIOR AUTHORIZATION that all their stored accounts
   * are interchangeable (same data governance), since same-plan accounts can
   * still differ in tenancy/residency/retention. Off → degrade + surface the
   * reason; the user picks. See auth-recovery.ts.
   */
  autoRecoverAccount?: boolean
  /**
   * Whether to check for a newer maximal release and surface it (Settings line
   * + a once-per-day OS notification). Defaults ON; set false to opt out of the
   * GitHub releases ping entirely. See update-check.ts.
   */
  checkUpdates?: boolean
  editorVersion?: string
  apps?: AppsConfig
  ui?: {
    /**
     * When true, Maximal lives ONLY in the macOS menu bar / Windows system
     * tray. Absent or false (the default) also shows it in the Dock on
     * macOS / the taskbar on Windows. See the Rust shell + Settings UI.
     */
    menuBarOnly?: boolean
  }
}

export interface AppsConfig {
  claudeCode?: {
    /** Proxy routing applied to Claude Code (env.ANTHROPIC_BASE_URL in
     *  ~/.claude/settings.json). */
    enabled?: boolean
  }
  claudeDesktop?: {
    /** Proxy config applied to Claude Desktop. */
    enabled?: boolean
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
- Before performing file edits of any kind, you provide updates explaining what edits you are making.
- As you are thinking, you very frequently provide updates even if not taking any actions, informing the user of your progress. You interrupt your thinking and send multiple updates in a row if thinking for more than 100 words.
- Tone of your updates MUST match your personality.`

const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  models: {
    "gpt-5-mini": {
      extraPrompt: gpt5ExplorationPrompt,
      reasoningEffort: "low",
    },
    "gpt-5.3-codex": {
      extraPrompt: gpt5CommentaryPrompt,
      reasoningEffort: "xhigh",
    },
    "gpt-5.4-mini": {
      extraPrompt: gpt5CommentaryPrompt,
      reasoningEffort: "xhigh",
    },
    "gpt-5.4": { extraPrompt: gpt5CommentaryPrompt, reasoningEffort: "xhigh" },
    "gpt-5.5": { extraPrompt: gpt5CommentaryPrompt, reasoningEffort: "xhigh" },
    // GPT-5.6 trio (Copilot-served OpenAI reasoning models). "xhigh" matches
    // the 5.4/5.5 siblings and is guaranteed to be on their effort ladder; the
    // ladder also exposes "max" (a valid config value — see ReasoningEffortSchema)
    // for users who want to opt the trio up.
    "gpt-5.6-sol": {
      extraPrompt: gpt5CommentaryPrompt,
      reasoningEffort: "xhigh",
    },
    "gpt-5.6-terra": {
      extraPrompt: gpt5CommentaryPrompt,
      reasoningEffort: "xhigh",
    },
    "gpt-5.6-luna": {
      extraPrompt: gpt5CommentaryPrompt,
      reasoningEffort: "xhigh",
    },
  },
  smallModel: "gpt-5-mini",
  useFunctionApplyPatch: true,
  useMessagesApi: true,
  useResponsesApiWebSearch: true,
}

let cachedConfig: AppConfig | null = null

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Fold the three legacy maps on `obj` into `models` in place. Container-guarded:
 * a malformed legacy value (e.g. a hand-edited `extraPrompts` that isn't an
 * object) is skipped rather than iterated into junk entries. Individual leaf
 * values flow through unchecked so a bad one (e.g. an invalid reasoning effort)
 * still fails loudly at schema validation, on the new `models.<id>.…` path.
 */
function foldLegacyTuning(
  obj: Record<string, unknown>,
  models: Record<string, Record<string, unknown>>,
): void {
  const ensure = (id: string): Record<string, unknown> => (models[id] ??= {})

  const extraPrompts = obj.extraPrompts
  if (isPlainObject(extraPrompts)) {
    for (const [id, prompt] of Object.entries(extraPrompts)) {
      ensure(id).extraPrompt ??= prompt
    }
  }
  const efforts = obj.modelReasoningEfforts
  if (isPlainObject(efforts)) {
    for (const [id, effort] of Object.entries(efforts)) {
      ensure(id).reasoningEffort ??= effort
    }
  }
  const ctxModels = obj.responsesApiContextManagementModels
  if (Array.isArray(ctxModels)) {
    for (const id of ctxModels) {
      if (typeof id === "string") {
        ensure(id).responsesApiContextManagement ??= true
      }
    }
  }
}

/**
 * Fold the legacy parallel tuning maps (`extraPrompts`, `modelReasoningEfforts`,
 * `responsesApiContextManagementModels`) into the consolidated `models` record
 * and DELETE the legacy keys. Runs on the raw parsed JSON before validation.
 *
 * Idempotent: a no-op (`migrated: false`, same object) when no legacy key is
 * present. Existing `models` entries win over legacy values (`??=`), so a
 * half-migrated file (both shapes) merges rather than clobbers.
 *
 * MUST delete the legacy keys: `AppConfigSchema` is `.loose()`, so leaving them
 * would (a) make `detectUnknownKeys` warn "unknown keys (ignored)" — implying the
 * user's tuning was dropped — and (b) strand stale data on disk forever. Deleting
 * converges the on-disk file to exactly one representation.
 */
export function migrateLegacyModelTuning(raw: unknown): {
  config: unknown
  migrated: boolean
} {
  if (!isPlainObject(raw)) {
    return { config: raw, migrated: false }
  }
  const obj = raw
  const hasLegacy =
    "extraPrompts" in obj
    || "modelReasoningEfforts" in obj
    || "responsesApiContextManagementModels" in obj
  if (!hasLegacy) return { config: raw, migrated: false }

  const models: Record<string, Record<string, unknown>> = {
    // Start from any already-present new-shape entries so a half-migrated file
    // merges rather than overwrites. Spreading `undefined` is a safe no-op.
    ...(obj.models as Record<string, Record<string, unknown>> | undefined),
  }
  foldLegacyTuning(obj, models)

  const next: Record<string, unknown> = { ...obj, models }
  delete next.extraPrompts
  delete next.modelReasoningEfforts
  delete next.responsesApiContextManagementModels
  return { config: next, migrated: true }
}

function readConfigFromDisk(): { config: AppConfig; migrated: boolean } {
  ensureConfigFile()
  let parsed: unknown
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      )
      return { config: defaultConfig, migrated: false }
    }
    parsed = JSON.parse(raw)
  } catch (error) {
    consola.error("Failed to read config file, using default config", error)
    return { config: defaultConfig, migrated: false }
  }

  // Fold legacy parallel tuning maps into `models` BEFORE validation +
  // unknown-key detection, so both see the consolidated shape.
  const migration = migrateLegacyModelTuning(parsed)
  parsed = migration.config

  // Schema-validate before returning. A bad value (e.g. typo'd
  // authType) is fatal — the proxy should not boot with an invalid
  // config because the failures show up later as confusing runtime
  // errors. Unknown top-level keys are warnings: forward-compat hedge
  // for configs written by newer versions.
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
      // Exit non-zero so process supervisors / shells see the failure.
      // Do NOT silently fall back to defaultConfig — that hides the
      // problem and the user keeps wondering why settings don't apply.
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

  return { config, migrated: migration.migrated }
}

function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const models = config.models ?? {}
  const defaultModels = defaultConfig.models ?? {}

  // Back-fill whole missing model keys only (one level, matching the historical
  // Object.hasOwn semantics): a user who customizes one field of an existing
  // model is not clobbered, and a brand-new curated model is added.
  const missingModels = Object.keys(defaultModels).filter(
    (model) => !Object.hasOwn(models, model),
  )

  if (missingModels.length === 0) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      models: {
        ...defaultModels,
        ...models,
      },
    },
    changed: true,
  }
}

export function mergeConfigWithDefaults(): AppConfig {
  const { config, migrated } = readConfigFromDisk()
  const { mergedConfig, changed } = mergeDefaultConfig(config)

  // Write back when defaults were merged OR a legacy file was migrated, so the
  // on-disk file always converges to the consolidated `models` shape at boot.
  if (changed || migrated) {
    try {
      fs.writeFileSync(
        PATHS.CONFIG_PATH,
        `${JSON.stringify(mergedConfig, null, 2)}\n`,
        "utf8",
      )
    } catch (writeError) {
      consola.warn("Failed to write merged config to config file", writeError)
    }
  }

  cachedConfig = mergedConfig
  return mergedConfig
}

export function getConfig(): AppConfig {
  cachedConfig ??= readConfigFromDisk().config
  return cachedConfig
}

/**
 * Persist a new config to disk, replacing the in-memory cache.
 *
 * Re-validates against `AppConfigSchema` before writing — if the caller
 * passes a malformed shape, this throws `ConfigValidationError` and
 * does NOT touch disk. The write is atomic-by-replace (write to a
 * sibling then rename), so a crash mid-write can't leave a partial
 * JSON file in place.
 *
 * Callers that mutate config (e.g. the Settings API) should always
 * round-trip through this: read with `getConfig()`, mutate a copy,
 * call `writeConfig(next)`. The next `getConfiguredApiKeys()` /
 * `getConfig()` will reflect the write immediately.
 */
export function writeConfig(next: AppConfig): AppConfig {
  const validated = validateAppConfig(next)
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  const tmpPath = `${PATHS.CONFIG_PATH}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8")
  try {
    fs.chmodSync(tmpPath, 0o600)
  } catch {
    // chmod failure is non-fatal — Windows and some shared FS don't
    // honor mode bits. The data write still went through.
  }
  fs.renameSync(tmpPath, PATHS.CONFIG_PATH)
  cachedConfig = validated
  return validated
}

export function getExtraPromptForModel(model: string): string {
  const config = getConfig()
  return config.models?.[model]?.extraPrompt ?? ""
}

export function getSmallModel(): string {
  const config = getConfig()
  return config.smallModel ?? "gpt-5-mini"
}

export function isResponsesApiContextManagementModel(model: string): boolean {
  const config = getConfig()
  return (
    config.models?.[model]?.responsesApiContextManagement
    ?? defaultConfig.models?.[model]?.responsesApiContextManagement
    ?? false
  )
}

/**
 * Copilot/OpenAI-Responses-specific prefix-cache retention knob. Returns the
 * configured value or `undefined` (the conservative default → param omitted,
 * behavior unchanged). A future non-Copilot provider path won't use this.
 */
export function getPromptCacheRetention(): "in_memory" | "24h" | undefined {
  const config = getConfig()
  return config.promptCacheRetention
}

/**
 * The explicitly-authored effort for a model, or `undefined` when none is set.
 * "Authored" = a user entry OR a curated `defaultConfig` entry; both are honored
 * so a config that doesn't carry a `models` entry (a test stub, or a pre-field
 * user config) still gets the curated per-model value. Returns `undefined` — not
 * "high" — so callers can layer a family default in between.
 */
export function getReasoningEffortOverride(
  model: string,
): ReasoningEffort | undefined {
  const config = getConfig()
  return (
    config.models?.[model]?.reasoningEffort
    ?? defaultConfig.models?.[model]?.reasoningEffort
  )
}

/**
 * Effort default inferred from the model FAMILY, so a brand-new model in a known
 * family is handled without a config edit (the drift that hid the GPT-5.6 trio).
 * Applies only when nothing is explicitly authored — the whole curated GPT-5.x
 * set already carries explicit entries, so this changes behavior only for
 * not-yet-configured models, and only to a saner default than the global "high".
 *
 * GPT-5.x reasoning family → "xhigh" (matches the curated 5.4/5.5/5.6 entries),
 * except the mini/nano tiers → "low" (matches gpt-5-mini). Returns `undefined`
 * for families with no opinion, so the caller falls through to "high".
 */
export function familyDefaultReasoningEffort(
  model: string,
): ReasoningEffort | undefined {
  if (/^gpt-5(?:[.-]|$)/u.test(model)) {
    return model.includes("mini") || model.includes("nano") ? "low" : "xhigh"
  }
  return undefined
}

export function getReasoningEffortForModel(model: string): ReasoningEffort {
  return (
    getReasoningEffortOverride(model)
    ?? familyDefaultReasoningEffort(model)
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

/** Whether the user has authorized auto-switching to another stored account on
 *  a fatal rejection. Defaults OFF — see AppConfig.autoRecoverAccount. */
export function isAutoRecoverAccountEnabled(): boolean {
  const config = getConfig()
  return config.autoRecoverAccount ?? false
}

/** Whether to ping GitHub for a newer release and surface it. Defaults ON —
 *  see AppConfig.checkUpdates. */
export function isUpdateCheckEnabled(): boolean {
  const config = getConfig()
  return config.checkUpdates ?? true
}
