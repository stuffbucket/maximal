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

export const AppConfigSchema = z
  .object({
    auth: z.object({ apiKeys: z.array(z.string()).optional() }).optional(),
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    extraPrompts: z.record(z.string(), z.string()).optional(),
    smallModel: z.string().optional(),
    responsesApiContextManagementModels: z.array(z.string()).optional(),
    modelReasoningEfforts: z
      .record(z.string(), ReasoningEffortSchema)
      .optional(),
    useFunctionApplyPatch: z.boolean().optional(),
    useMessagesApi: z.boolean().optional(),
    anthropicApiKey: z.string().optional(),
    useResponsesApiWebSearch: z.boolean().optional(),
    claudeTokenMultiplier: z.number().optional(),
    logRetentionDays: z.number().int().min(0).max(3650).optional(),
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
