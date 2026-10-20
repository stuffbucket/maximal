import { z } from "zod"

const DurationSchema = z.number().int().min(100).max(3_600_000)
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_]\w*$/u)

export const ElicitationActionSchema = z.enum(["passthrough", "maximal", "deny"])
export const ElicitationMechanismSchema = z.enum([
  "legacy-form",
  "legacy-url",
  "modern-input-required",
])
export const ElicitationFieldTypeSchema = z.enum([
  "boolean",
  "string",
  "number",
  "integer",
  "enum",
])

/** Matches when every criterion it names matches; none named never matches. */
const ElicitationRuleSchema = z.strictObject({
  match: z
    .strictObject({
      toolNames: z.array(z.string().min(1).max(256)).min(1).max(128).optional(),
      mechanisms: z.array(ElicitationMechanismSchema).min(1).max(3).optional(),
      modes: z
        .array(z.enum(["form", "url"]))
        .min(1)
        .max(2)
        .optional(),
      fieldTypes: z.array(ElicitationFieldTypeSchema).min(1).max(5).optional(),
      urlHosts: z.array(z.string().min(1).max(253)).min(1).max(64).optional(),
      maxProperties: z.number().int().min(0).max(128).optional(),
    })
    .refine((match) => Object.keys(match).length > 0),
  action: ElicitationActionSchema,
})

/** Who answers a server's request for user input (a form or a URL). */
export const ElicitationPolicySchema = z.strictObject({
  /** passthrough: the client, if it can show this kind of request; otherwise
   *  Maximal. maximal: always Maximal. deny: decline without asking. */
  defaultAction: ElicitationActionSchema.default("passthrough"),
  rules: z.array(ElicitationRuleSchema).max(128).default([]),
  /** How long a request waits for an answer before it is cancelled. */
  timeoutMs: DurationSchema.default(300_000),
})

export const ResolvedMcpEndpointSchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
    label: z.string().min(1).max(128),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(16_384)).max(128).default([]),
    cwd: z.string().min(1).max(4096).optional(),
    environment: z
      .record(EnvironmentNameSchema, z.string().max(32_768))
      .superRefine((environment, context) => {
        if (Object.keys(environment).length > 256) {
          context.addIssue({
            code: "custom",
            message: "too many environment variables",
          })
        }
      })
      .default({}),
    protocol: z.enum(["auto", "legacy", "modern"]).default("auto"),
    interaction: z
      .enum(["auto", "interactive", "non-interactive"])
      .default("auto"),
    ownership: z.enum(["auto", "exclusive", "shareable"]).default("auto"),
    initializeTimeoutMs: DurationSchema.default(30_000),
    callTimeoutMs: DurationSchema.default(120_000),
    shutdownTimeoutMs: DurationSchema.default(2_000),
    /** Concurrent sessions, each with its own upstream instance. */
    maxSessions: z.number().int().min(1).max(64).default(8),
    /** Close a session after this long with no request and no open stream,
     *  which is how one abandoned without a DELETE is reclaimed. */
    sessionIdleTimeoutMs: DurationSchema.default(1_800_000),
    elicitation: ElicitationPolicySchema.default({
      defaultAction: "passthrough",
      rules: [],
      timeoutMs: 300_000,
    }),
  })
  .superRefine((endpoint, context) => {
    if (
      endpoint.ownership === "shareable"
      && (endpoint.protocol === "legacy"
        || endpoint.interaction === "interactive")
    ) {
      context.addIssue({
        code: "custom",
        message: "legacy or interactive endpoints cannot be shareable",
        path: ["ownership"],
      })
    }
  })

export const BrokerWireConfigurationSchema = z
  .strictObject({
    endpoints: z.array(ResolvedMcpEndpointSchema).max(64),
    httpBodyBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    heartbeatIntervalMs: DurationSchema.default(2_000),
  })
  .superRefine((configuration, context) => {
    const seen = new Set<string>()
    for (const [index, endpoint] of configuration.endpoints.entries()) {
      if (seen.has(endpoint.id)) {
        context.addIssue({
          code: "custom",
          message: "duplicate endpoint id",
          path: ["endpoints", index, "id"],
        })
      }
      seen.add(endpoint.id)
    }
  })

export type BrokerWireConfiguration = z.infer<
  typeof BrokerWireConfigurationSchema
>
export type ResolvedMcpEndpoint = z.infer<typeof ResolvedMcpEndpointSchema>
export type ElicitationPolicy = z.infer<typeof ElicitationPolicySchema>
export type ElicitationAction = z.infer<typeof ElicitationActionSchema>
export type ElicitationMechanism = z.infer<typeof ElicitationMechanismSchema>
export type ElicitationFieldType = z.infer<typeof ElicitationFieldTypeSchema>
