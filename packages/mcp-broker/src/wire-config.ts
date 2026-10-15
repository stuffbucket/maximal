import { z } from "zod"

const DurationSchema = z.number().int().min(100).max(3_600_000)
const EnvironmentNameSchema = z.string().regex(/^[A-Za-z_]\w*$/u)

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
