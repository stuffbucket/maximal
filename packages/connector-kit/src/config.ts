import type { JsonSchemaObject } from "@stuffbucket/maximal-plugin-sdk"

import { z } from "zod"

import type { RemoteMcpConnectorManifest } from "./manifest"

/** Validated config of a remote MCP connector. */
export interface ConnectorConfig {
  /** MCP endpoint (Streamable HTTP). */
  endpoint: string
  /** Microsoft Entra authority (Entra connectors only). */
  authority?: string
}

/** Marks a field the Settings form folds under "Advanced". */
export const ADVANCED = "x-maximal-advanced"

const httpUrl = () => z.url({ protocol: /^https?$/ })

/**
 * The config schema for a connector: `{ endpoint }` defaulting to the
 * manifest's endpoint, plus `authority` for Entra connectors. `{}` is valid.
 */
export function connectorConfigSchema(
  manifest: RemoteMcpConnectorManifest,
): z.ZodType<ConnectorConfig> {
  const endpoint = httpUrl()
    .default(manifest.connector.endpoint)
    .meta({
      title: "Endpoint",
      description: `${manifest.displayName} MCP endpoint (Streamable HTTP).`,
      [ADVANCED]: true,
    })
  const auth = manifest.connector.auth
  if (auth.type !== "entra") return z.object({ endpoint })
  return z.object({
    endpoint,
    authority: httpUrl()
      .default(auth.authority)
      .meta({
        title: "Sign-in authority",
        description: "Microsoft Entra authority used for sign-in.",
        [ADVANCED]: true,
      }),
  })
}

/** JSON Schema of the config (input side: defaults are not required). */
export function configJsonSchema(
  schema: z.ZodType<ConnectorConfig>,
): JsonSchemaObject {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>
  return { ...json, type: "object" }
}
