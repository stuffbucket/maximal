/**
 * Parked: config-schema tests for the MCP broker's `mcpBroker` section.
 * Extracted from `tests/config-schema.test.ts`; the schema lives at
 * `parked/mcp/sidecar/src/lib/config/mcp-broker-schema.ts`. Not run by CI.
 */
import { describe, expect, it } from "bun:test"
import { z } from "zod"

import { McpBrokerConfigSchema } from "../../sidecar/src/lib/config/mcp-broker-schema"

class ConfigValidationError extends Error {}

/** Stand-in for the old `validateAppConfig` over just this section. */
function validateAppConfig(config: { mcpBroker?: unknown }): unknown {
  const parsed = z.object({ mcpBroker: McpBrokerConfigSchema.optional() }).safeParse(config)
  if (!parsed.success) throw new ConfigValidationError(parsed.error.message)
  return parsed.data
}

describe("validateAppConfig — MCP broker", () => {
  it("accepts a generic MCP broker endpoint", () => {
    const config = {
      mcpBroker: {
        enabled: true,
        supervision: {
          heartbeatIntervalMs: 2_000,
          heartbeatDeadlineMs: 6_000,
        },
        servers: [
          {
            id: "workiq",
            label: "Work IQ",
            enabled: true,
            transport: {
              type: "stdio" as const,
              command: "workiq",
              args: ["mcp"],
            },
            versionProbe: {
              args: ["--version"],
              timeoutMs: 5_000,
            },
            classification: {
              protocol: "legacy" as const,
              interaction: "interactive" as const,
              ownership: "exclusive" as const,
            },
            environment: {
              inherit: ["HOME", "PATH"],
            },
            elicitation: {
              defaultAction: "passthrough" as const,
              rules: [
                {
                  match: {
                    mechanisms: ["legacy-url" as const],
                    toolNames: ["get_debug_link"],
                  },
                  action: "maximal" as const,
                },
              ],
            },
          },
        ],
      },
    }

    expect(validateAppConfig(config)).toEqual(config)
  })

  it("rejects duplicate MCP server ids", () => {
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          servers: [
            {
              id: "duplicate",
              label: "One",
              transport: { type: "stdio", command: "one" },
            },
            {
              id: "duplicate",
              label: "Two",
              transport: { type: "stdio", command: "two" },
            },
          ],
        },
      }),
    ).toThrow(ConfigValidationError)
  })

  it("rejects unsafe legacy sharing", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({
        mcpBroker: {
          servers: [
            {
              id: "legacy-shared",
              label: "Legacy shared",
              transport: { type: "stdio", command: "legacy" },
              classification: {
                protocol: "legacy",
                ownership: "shareable",
              },
            },
          ],
        },
      })
    } catch (error) {
      if (error instanceof ConfigValidationError) thrown = error
    }

    expect(thrown?.issues[0]?.path).toBe(
      "mcpBroker.servers.0.classification.ownership",
    )
  })

  it("rejects an MCP elicitation rule without match criteria", () => {
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          servers: [
            {
              id: "ambiguous-rule",
              label: "Ambiguous rule",
              transport: { type: "stdio", command: "server" },
              elicitation: {
                rules: [{ match: {}, action: "maximal" }],
              },
            },
          ],
        },
      }),
    ).toThrow(ConfigValidationError)
  })

  it("rejects an MCP heartbeat deadline at or below its interval", () => {
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          supervision: {
            heartbeatIntervalMs: 5_000,
            heartbeatDeadlineMs: 5_000,
          },
        },
      }),
    ).toThrow(ConfigValidationError)
  })

  it("checks MCP supervision overrides against effective defaults", () => {
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          supervision: { heartbeatIntervalMs: 20_000 },
        },
      }),
    ).toThrow(ConfigValidationError)
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          supervision: { restartBackoffMinMs: 60_000 },
        },
      }),
    ).toThrow(ConfigValidationError)
  })

  it("accepts named MCP secret references", () => {
    const config = {
      mcpBroker: {
        servers: [
          {
            id: "secret-ref",
            label: "Secret ref",
            transport: { type: "stdio" as const, command: "server" },
            environment: {
              secretRefs: { SERVICE_TOKEN: "stored-token.v1" },
            },
          },
        ],
      },
    }

    expect(validateAppConfig(config)).toEqual(config)
  })

  it("rejects invalid MCP environment names", () => {
    expect(() =>
      validateAppConfig({
        mcpBroker: {
          servers: [
            {
              id: "invalid-env",
              label: "Invalid environment",
              transport: { type: "stdio", command: "server" },
              environment: { inherit: ["NOT-AN-ENV-NAME"] },
            },
          ],
        },
      }),
    ).toThrow(ConfigValidationError)
  })

  it("accepts an endpoint-specific MCP key and rejects a blank one", () => {
    const server = {
      id: "keyed",
      label: "Keyed",
      transport: { type: "stdio" as const, command: "server" },
    }
    expect(
      validateAppConfig({
        mcpBroker: { servers: [{ ...server, apiKey: "mcp-endpoint-key" }] },
      }),
    ).toEqual({
      mcpBroker: { servers: [{ ...server, apiKey: "mcp-endpoint-key" }] },
    })
    expect(() =>
      validateAppConfig({
        mcpBroker: { servers: [{ ...server, apiKey: "   " }] },
      }),
    ).toThrow(ConfigValidationError)
  })
})

describe("mcpBroker.catalog", () => {
  it("accepts an http(s) npm registry for install hints, nothing else", () => {
    const config = {
      mcpBroker: { catalog: { npmRegistry: "https://npm.example.test/npm/" } },
    }
    expect(validateAppConfig(config)).toEqual(config)
    for (const npmRegistry of ["npm.example.test", "ftp://npm.example.test/"]) {
      let thrown: ConfigValidationError | null = null
      try {
        validateAppConfig({ mcpBroker: { catalog: { npmRegistry } } })
      } catch (e) {
        if (e instanceof ConfigValidationError) thrown = e
      }
      expect(thrown?.issues[0]?.path).toBe("mcpBroker.catalog.npmRegistry")
    }
  })
})
