/**
 * Parked: the full `mcpBroker` config schema (the generic MCP broker's
 * `config.json` section). Extracted from `src/lib/config/config-schema.ts`
 * when the broker was parked; the live schema now accepts `mcpBroker` as
 * `z.unknown().optional()`. Not compiled or imported by the build.
 */

import { z } from "zod"

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

export const McpBrokerConfigSchema = z
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
