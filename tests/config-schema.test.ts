import { describe, expect, it } from "bun:test"

import {
  ConfigValidationError,
  detectUnknownKeys,
  validateAppConfig,
} from "~/lib/config/config-schema"

describe("validateAppConfig", () => {
  it("accepts an empty config", () => {
    expect(validateAppConfig({})).toEqual({})
  })

  it("accepts a realistic config", () => {
    const config = {
      smallModel: "gpt-5-mini",
      useMessagesApi: true,
      useFunctionApplyPatch: true,
      providers: {
        openrouter: {
          enabled: true,
          baseUrl: "https://openrouter.ai/api",
          apiKey: "sk-or-...",
          authType: "authorization" as const,
        },
      },
      modelReasoningEfforts: {
        "gpt-5.5": "xhigh" as const,
      },
    }
    expect(validateAppConfig(config)).toEqual(config)
  })

  it("rejects a typo'd authType with the offending key path", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({
        providers: {
          openrouter: {
            authType: "bearer", // not a valid value
          },
        },
      })
    } catch (e) {
      if (e instanceof ConfigValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    const issue = thrown?.issues.find((i) => i.path.includes("authType"))
    expect(issue?.path).toBe("providers.openrouter.authType")
  })

  it("rejects a wrong type with key path", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({ useMessagesApi: "yes" })
    } catch (e) {
      if (e instanceof ConfigValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown?.issues[0].path).toBe("useMessagesApi")
  })

  it("accepts and validates Codex routing intent", () => {
    expect(validateAppConfig({ apps: { codex: { enabled: true } } })).toEqual({
      apps: { codex: { enabled: true } },
    })

    expect(() =>
      validateAppConfig({ apps: { codex: { enabled: "yes" } } }),
    ).toThrow(ConfigValidationError)
    try {
      validateAppConfig({ apps: { codex: { enabled: "yes" } } })
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      if (error instanceof ConfigValidationError) {
        expect(error.issues[0].path).toBe("apps.codex.enabled")
      }
    }
  })

  it("accepts the autoRecoverAccount opt-in flag (boolean)", () => {
    expect(validateAppConfig({ autoRecoverAccount: true })).toEqual({
      autoRecoverAccount: true,
    })
  })

  it("rejects a non-boolean autoRecoverAccount with its key path", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({ autoRecoverAccount: "yes" })
    } catch (e) {
      if (e instanceof ConfigValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown?.issues[0].path).toBe("autoRecoverAccount")
  })

  it("rejects a bad reasoning effort value", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({
        modelReasoningEfforts: { "gpt-5": "ULTRA" },
      })
    } catch (e) {
      if (e instanceof ConfigValidationError) thrown = e
    }
    expect(thrown).not.toBeNull()
    expect(thrown?.issues[0].path).toBe("modelReasoningEfforts.gpt-5")
  })

  it("accepts ordered exact, glob, and regex model mappings", () => {
    const modelMappings = [
      {
        match: { type: "exact" as const, value: "codex-auto-review" },
        target: "gpt-5.6-luna",
      },
      {
        match: { type: "glob" as const, value: "review-*" },
        target: "gpt-5.6-luna",
      },
      {
        match: {
          type: "regex" as const,
          value: String.raw`^review-\\d+$`,
          flags: "u" as const,
        },
        target: "gpt-5.6-luna",
      },
    ]

    expect(validateAppConfig({ modelMappings })).toEqual({ modelMappings })
  })

  it("rejects an invalid model-mapping regex at its config path", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({
        modelMappings: [
          {
            match: { type: "regex", value: "[" },
            target: "gpt-5.6-luna",
          },
        ],
      })
    } catch (error) {
      if (error instanceof ConfigValidationError) thrown = error
    }

    expect(thrown?.issues[0]?.path).toBe("modelMappings.0.match.value")
  })

  it("rejects unsupported model-mapping regex flags", () => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({
        modelMappings: [
          {
            match: { type: "regex", value: "^review-", flags: "i" },
            target: "gpt-5.6-luna",
          },
        ],
      })
    } catch (error) {
      if (error instanceof ConfigValidationError) thrown = error
    }

    expect(thrown?.issues[0]?.path).toBe("modelMappings.0.match.flags")
  })

  it.each([
    [
      "match value",
      { match: { type: "exact", value: "" }, target: "model" },
      "modelMappings.0.match.value",
    ],
    [
      "target",
      { match: { type: "exact", value: "alias" }, target: "" },
      "modelMappings.0.target",
    ],
  ])("rejects an empty model-mapping %s", (_label, mapping, path) => {
    let thrown: ConfigValidationError | null = null
    try {
      validateAppConfig({ modelMappings: [mapping] })
    } catch (error) {
      if (error instanceof ConfigValidationError) thrown = error
    }

    expect(thrown?.issues[0]?.path).toBe(path)
  })

  it("keeps unknown top-level keys (passthrough)", () => {
    const config = { useMessagesApi: true, futureFlag: "not-yet-typed" }
    const parsed = validateAppConfig(config) as typeof config
    expect(parsed.futureFlag).toBe("not-yet-typed")
  })
})

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

describe("detectUnknownKeys", () => {
  it("returns unknown top-level keys", () => {
    expect(
      detectUnknownKeys({
        useMessagesApi: true,
        futureFlag: 1,
        anotherFutureFlag: 2,
      }),
    ).toEqual(["futureFlag", "anotherFutureFlag"])
  })

  it("returns empty array for fully-known config", () => {
    expect(
      detectUnknownKeys({ useMessagesApi: true, smallModel: "gpt-5-mini" }),
    ).toEqual([])
  })

  it("returns empty array for non-object input", () => {
    expect(detectUnknownKeys(null)).toEqual([])
    expect(detectUnknownKeys("string")).toEqual([])
    expect(detectUnknownKeys([])).toEqual([])
  })
})
