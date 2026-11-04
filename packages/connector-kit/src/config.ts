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

/** Microsoft Entra sign-in hosts an authority override may always name. */
const ENTRA_AUTHORITY_HOSTS: ReadonlyArray<string> = [
  "login.microsoftonline.com",
  "login.microsoft.com",
]

const httpUrl = () => z.url({ protocol: /^https?$/ })

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * An http(s) URL that is either exactly `fallback` (the code-level default,
 * which may be a loopback fake) or an `https:` URL on one of `hosts`. The
 * upstream token goes wherever this points, so Settings cannot redirect it.
 */
function trustedUrl(
  fallback: string,
  hosts: ReadonlyArray<string | undefined>,
  label: string,
) {
  const allowed = [...new Set(hosts.filter(Boolean))]
  return httpUrl().refine(
    (value) => {
      if (value === fallback) return true
      const url = new URL(value)
      return url.protocol === "https:" && allowed.includes(url.host)
    },
    {
      message: `${label} must be an https:// URL on ${allowed.join(" or ")}.`,
    },
  )
}

/** Hosts a config override of the endpoint may name. */
function allowedEndpointHosts(
  manifest: RemoteMcpConnectorManifest,
): Array<string> {
  return [
    hostOf(manifest.connector.endpoint),
    ...(manifest.connector.allowedHosts ?? []),
  ].filter((host): host is string => host !== undefined)
}

/**
 * The config schema for a connector: `{ endpoint }` defaulting to the
 * manifest's endpoint, plus `authority` for Entra connectors. `{}` is valid.
 * An override must be `https:` on an allowed host: the endpoint's host or
 * `connector.allowedHosts`; for the authority, its host or Microsoft's
 * sign-in hosts.
 */
export function connectorConfigSchema(
  manifest: RemoteMcpConnectorManifest,
): z.ZodType<ConnectorConfig> {
  const endpoint = trustedUrl(
    manifest.connector.endpoint,
    allowedEndpointHosts(manifest),
    "Endpoint",
  )
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
    authority: trustedUrl(
      auth.authority,
      [hostOf(auth.authority), ...ENTRA_AUTHORITY_HOSTS],
      "Sign-in authority",
    )
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
