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

import type { AppConfig } from "~/lib/config/config"

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

const ExactModelMatcherSchema = z.object({
  type: z.literal("exact"),
  value: z.string().min(1),
})

const GlobModelMatcherSchema = z.object({
  type: z.literal("glob"),
  value: z.string().min(1),
})

const RegexModelMatcherSchema = z
  .object({
    type: z.literal("regex"),
    value: z.string().min(1),
    flags: z.enum(["", "u"]).optional(),
  })
  .superRefine((matcher, context) => {
    try {
      new RegExp(matcher.value, matcher.flags)
    } catch {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Invalid regular expression",
      })
    }
  })

const ModelMappingRuleSchema = z.object({
  match: z.discriminatedUnion("type", [
    ExactModelMatcherSchema,
    GlobModelMatcherSchema,
    RegexModelMatcherSchema,
  ]),
  target: z.string().min(1),
})

const PositiveDurationSchema = z.number().int().min(100).max(3_600_000)
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_]\w*$/u)
const SecretReferenceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w.-]+$/u)
const EnvironmentValuesSchema = z
  .record(EnvironmentNameSchema, z.string().max(32_768))
  .refine((value) => Object.keys(value).length <= 256, {
    message: "too many environment values",
  })
const SecretReferencesSchema = z
  .record(EnvironmentNameSchema, SecretReferenceSchema)
  .refine((value) => Object.keys(value).length <= 256, {
    message: "too many secret references",
  })
const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u)
const McpElicitationActionSchema = z.enum(["passthrough", "maximal", "deny"])
export const McpServerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u)
const McpClientIdSchema = z.enum(["claude-code", "claude-desktop"])
/** Endpoint ids Maximal wrote into a client's own MCP configuration. */
const OwnedMcpServerIdsSchema = z.array(McpServerIdSchema).max(64)

const McpElicitationRuleSchema = z
  .object({
    match: z.object({
      toolNames: z.array(z.string().min(1).max(256)).min(1).max(128).optional(),
      mechanisms: z
        .array(z.enum(["legacy-form", "legacy-url", "modern-input-required"]))
        .min(1)
        .max(3)
        .optional(),
      modes: z
        .array(z.enum(["form", "url"]))
        .min(1)
        .max(2)
        .optional(),
      fieldTypes: z
        .array(z.enum(["boolean", "string", "number", "integer", "enum"]))
        .min(1)
        .max(5)
        .optional(),
      urlHosts: z.array(HostnameSchema).min(1).max(64).optional(),
      maxProperties: z.number().int().min(0).max(128).optional(),
    }),
    action: McpElicitationActionSchema,
  })
  .superRefine((rule, ctx) => {
    if (Object.keys(rule.match).length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "elicitation rules must include at least one match criterion",
        path: ["match"],
      })
    }
  })

const McpServerConfigSchema = z
  .object({
    id: McpServerIdSchema,
    label: z.string().min(1).max(128),
    enabled: z.boolean().optional(),
    /** Clients the user chose to wire this endpoint into. Kept while the
     *  endpoint is off so re-enabling can pre-select them. */
    clients: z.array(McpClientIdSchema).max(2).optional(),
    /** Endpoint-specific key for `/mcp/<id>`. When unset, the route uses the
     *  same authentication as the rest of the main port. */
    apiKey: z.string().trim().min(1).max(512).optional(),
    /** Catalog id this endpoint was added from (`~/lib/mcp-broker/catalog`). */
    catalog: z.string().min(1).max(64).optional(),
    transport: z.object({
      type: z.literal("stdio"),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(16_384)).max(128).optional(),
      cwd: z.string().min(1).max(4096).optional(),
    }),
    versionProbe: z
      .object({
        args: z.array(z.string().max(4096)).max(32),
        timeoutMs: PositiveDurationSchema.optional(),
      })
      .optional(),
    timeouts: z
      .object({
        startupMs: PositiveDurationSchema.optional(),
        initializeMs: PositiveDurationSchema.optional(),
        callMs: PositiveDurationSchema.optional(),
        cancellationMs: PositiveDurationSchema.optional(),
        shutdownMs: PositiveDurationSchema.optional(),
      })
      .optional(),
    environment: z
      .object({
        inherit: z.array(EnvironmentNameSchema).max(128).optional(),
        values: EnvironmentValuesSchema.optional(),
        secretRefs: SecretReferencesSchema.optional(),
      })
      .optional(),
    classification: z
      .object({
        protocol: z.enum(["auto", "legacy", "modern"]).optional(),
        interaction: z
          .enum(["auto", "interactive", "non-interactive"])
          .optional(),
        ownership: z.enum(["auto", "exclusive", "shareable"]).optional(),
      })
      .optional(),
    limits: z
      .object({
        sessions: z.number().int().min(1).max(64).optional(),
        inflightPerSession: z.number().int().min(1).max(64).optional(),
        interactionRounds: z.number().int().min(1).max(16).optional(),
      })
      .optional(),
    elicitation: z
      .object({
        defaultAction: McpElicitationActionSchema.optional(),
        rules: z.array(McpElicitationRuleSchema).max(128).optional(),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
      })
      .optional(),
  })
  .superRefine((server, ctx) => {
    if (
      server.classification?.ownership === "shareable"
      && server.classification.protocol === "legacy"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "legacy MCP servers cannot be configured as shareable",
        path: ["classification", "ownership"],
      })
    }
    if (
      server.classification?.ownership === "shareable"
      && server.classification.interaction === "interactive"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "interactive MCP servers cannot be configured as shareable",
        path: ["classification", "ownership"],
      })
    }
  })

const McpBrokerConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    executablePath: z.string().min(1).max(4096).optional(),
    supervision: z
      .object({
        startupTimeoutMs: PositiveDurationSchema.optional(),
        heartbeatIntervalMs: PositiveDurationSchema.optional(),
        heartbeatDeadlineMs: PositiveDurationSchema.optional(),
        gracefulShutdownMs: PositiveDurationSchema.optional(),
        restartBackoffMinMs: PositiveDurationSchema.optional(),
        restartBackoffMaxMs: PositiveDurationSchema.optional(),
        restartBudget: z.number().int().min(1).max(100).optional(),
        restartWindowMs: PositiveDurationSchema.optional(),
        circuitResetMs: PositiveDurationSchema.optional(),
      })
      .optional(),
    limits: z
      .object({
        ipcFrameBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024)
          .optional(),
        httpBodyBytes: z
          .number()
          .int()
          .min(1024)
          .max(16 * 1024 * 1024)
          .optional(),
        requestSchemaBytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024)
          .optional(),
        pendingRequests: z.number().int().min(1).max(1024).optional(),
      })
      .optional(),
    servers: z.array(McpServerConfigSchema).max(64).optional(),
    /** Install hints for known servers (`~/lib/mcp-broker/catalog`). */
    catalog: z
      .object({
        /** Registry the install command downloads from, for networks that
         *  can't reach npm's public one. */
        npmRegistry: z
          .url({ protocol: /^https?$/u })
          .max(2048)
          .optional(),
      })
      .optional(),
  })
  .superRefine((broker, ctx) => {
    const seen = new Set<string>()
    for (const [index, server] of (broker.servers ?? []).entries()) {
      if (seen.has(server.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate MCP server id '${server.id}'`,
          path: ["servers", index, "id"],
        })
      }
      seen.add(server.id)
    }
    const supervision = broker.supervision
    const heartbeatIntervalMs = supervision?.heartbeatIntervalMs ?? 2_000
    const heartbeatDeadlineMs = supervision?.heartbeatDeadlineMs ?? 10_000
    if (heartbeatDeadlineMs <= heartbeatIntervalMs) {
      ctx.addIssue({
        code: "custom",
        message: "heartbeat deadline must exceed the heartbeat interval",
        path: ["supervision", "heartbeatDeadlineMs"],
      })
    }
    const restartBackoffMinMs = supervision?.restartBackoffMinMs ?? 500
    const restartBackoffMaxMs = supervision?.restartBackoffMaxMs ?? 30_000
    if (restartBackoffMaxMs < restartBackoffMinMs) {
      ctx.addIssue({
        code: "custom",
        message: "maximum restart backoff must not be below the minimum",
        path: ["supervision", "restartBackoffMaxMs"],
      })
    }
  })

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
    modelMappings: z.array(ModelMappingRuleSchema).optional(),
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
        codex: z
          .object({
            enabled: z.boolean().optional(),
          })
          .optional(),
        claudeCode: z
          .object({
            enabled: z.boolean().optional(),
            mcpServers: OwnedMcpServerIdsSchema.optional(),
          })
          .optional(),
        claudeDesktop: z
          .object({
            enabled: z.boolean().optional(),
            mcpServers: OwnedMcpServerIdsSchema.optional(),
          })
          .optional(),
      })
      .optional(),
    mcpBroker: McpBrokerConfigSchema.optional(),
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
