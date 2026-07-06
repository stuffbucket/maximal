/**
 * Runtime validation for AppConfig.
 *
 * The config interface in config.ts is the type-level contract; this
 * file is the runtime contract — what the on-disk JSON has to look
 * like. They mirror each other; if you add a field to one, add it
 * here too.
 *
 * Validation strategy:
 *   - Known top-level keys: type-checked. A bad value (e.g. a string
 *     where a boolean is required) throws ConfigValidationError with
 *     the offending JSON path.
 *   - Unknown top-level keys: kept (passthrough), reported by
 *     `detectUnknownKeys()` so the caller can warn without aborting.
 *     This preserves forward-compat — older proxies don't choke on
 *     fields written by newer ones.
 */

import { z } from "zod"

import type { AppConfig } from "./config"

const ProviderAuthTypeSchema = z.enum(["authorization", "x-api-key"])

const ModelConfigSchema = z.object({
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
})

const ProviderConfigSchema = z.object({
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  authType: ProviderAuthTypeSchema.optional(),
  models: z.record(z.string(), ModelConfigSchema).optional(),
  adjustInputTokens: z.boolean().optional(),
})

const ReasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

/**
 * Validation regex for an API key value. CLI-safe character set so the
 * key can survive double-quoting / single-quoting in any shell without
 * escaping headaches: ASCII letters, digits, underscore, hyphen.
 *
 * Plus a single special form: the literal "*" wildcard (and only that —
 * no embedded glob) which the auth middleware honors as "accept any
 * non-empty bearer." Useful for the default "permit-all" entry the UI
 * seeds when the user first enables API-key auth.
 */
export const API_KEY_VALUE_PATTERN = /^(?:\*|[\w-]{8,128})$/

const ApiKeyEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(64),
  key: z.string().regex(API_KEY_VALUE_PATTERN),
  enabled: z.boolean(),
  created_at: z.string(),
})

export const AppConfigSchema = z
  .object({
    auth: z
      .object({
        /**
         * Legacy free-form list of accepted bearer tokens. Kept for
         * backward compatibility with users who edit config.json by
         * hand. The Settings UI manages `apiKeyEntries` instead;
         * `getConfiguredApiKeys()` merges both.
         */
        apiKeys: z.array(z.string()).optional(),
        /**
         * Structured API-key registry written by the Settings UI.
         * Each entry has its own enabled flag so a key can be paused
         * without losing its label/history.
         */
        apiKeyEntries: z.array(ApiKeyEntrySchema).optional(),
        /**
         * When false (default), the proxy accepts any request — the
         * `apiKeyEntries` registry is used purely to attribute traffic
         * to a named client. When true, requests must present a key
         * that matches an enabled entry; everything else gets 401.
         * The Settings UI exposes this as "Block unknown connections."
         */
        enforce: z.boolean().optional(),
      })
      .optional(),
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    extraPrompts: z.record(z.string(), z.string()).optional(),
    smallModel: z.string().optional(),
    responsesApiContextManagementModels: z.array(z.string()).optional(),
    /**
     * Copilot/OpenAI-Responses-specific: extend server-side prefix-cache
     * retention on the `/responses` path (default TTL is ~5-10 min; "24h"
     * keeps the cached prefix alive across long pauses, cutting cost + TTFT
     * on repeat requests). UNSET by default — some model/endpoint combos have
     * historically rejected the param, so it is opt-in. See getPromptCacheRetention.
     */
    promptCacheRetention: z.enum(["in_memory", "24h"]).optional(),
    modelReasoningEfforts: z
      .record(z.string(), ReasoningEffortSchema)
      .optional(),
    useFunctionApplyPatch: z.boolean().optional(),
    useMessagesApi: z.boolean().optional(),
    anthropicApiKey: z.string().optional(),
    useResponsesApiWebSearch: z.boolean().optional(),
    claudeTokenMultiplier: z.number().optional(),
    logRetentionDays: z.number().int().min(0).max(3650).optional(),
    autoRecoverAccount: z.boolean().optional(),
    checkUpdates: z.boolean().optional(),
    editorVersion: z.string().optional(),
    apps: z
      .object({
        claudeCode: z
          .object({
            enabled: z.boolean().optional(),
          })
          .optional(),
        claudeDesktop: z
          .object({
            enabled: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  // passthrough: keep unknown keys in the parsed output. Lets older
  // proxies tolerate config files written by newer ones.
  .loose()

export interface ConfigIssue {
  path: string
  message: string
}

export class ConfigValidationError extends Error {
  readonly issues: ReadonlyArray<ConfigIssue>

  constructor(issues: ReadonlyArray<ConfigIssue>) {
    const summary = issues
      .map((i) => `  ${i.path || "<root>"}: ${i.message}`)
      .join("\n")
    super(`config validation failed:\n${summary}`)
    this.name = "ConfigValidationError"
    this.issues = issues
  }
}

/** Validates raw JSON against AppConfigSchema. Throws
 *  ConfigValidationError on invalid shape; returns the parsed config
 *  (still typed as AppConfig — passthrough leaves unknown keys, but
 *  TS doesn't see them). */
export function validateAppConfig(raw: unknown): AppConfig {
  const result = AppConfigSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }))
    throw new ConfigValidationError(issues)
  }
  return result.data
}

/** Returns top-level keys present in `raw` that AppConfigSchema does
 *  not declare. Caller decides what to do (warn / log / nothing). */
export function detectUnknownKeys(raw: unknown): Array<string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
  const known = new Set(Object.keys(AppConfigSchema.shape))
  return Object.keys(raw as Record<string, unknown>).filter(
    (k) => !known.has(k),
  )
}
