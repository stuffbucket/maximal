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

describe("validateAppConfig — Anthropic Messages model settings", () => {
  it("accepts missing overrides", () => {
    expect(
      validateAppConfig({ apps: { claudeCode: { enabled: true } } }),
    ).toEqual({
      apps: { claudeCode: { enabled: true } },
    })
  })

  it("round-trips route-scoped model selections", () => {
    const config = {
      anthropicMessages: {
        haikuModel: "gpt-5.6-mini",
        sonnetModel: "gpt-5.6",
        autoPermissionModel: "claude-haiku-5.5",
      },
    }
    expect(validateAppConfig(config)).toEqual(config)
  })

  it.each(["haikuModel", "sonnetModel", "autoPermissionModel"])(
    "rejects a blank %s selection",
    (key) => {
      expect(() =>
        validateAppConfig({ anthropicMessages: { [key]: "   " } }),
      ).toThrow(ConfigValidationError)
    },
  )

  it("keeps legacy Claude Code model overrides readable", () => {
    const config = {
      apps: {
        claudeCode: {
          fastModel: "gpt-5.6-mini",
          capableModel: "gpt-5.6",
          classifierModel: "claude-haiku-5.5",
        },
      },
    }
    expect(validateAppConfig(config)).toEqual(config)
  })

  it("preserves and reports unknown app keys", () => {
    const config = {
      apps: { claudeCode: { enabled: true, futureModelPolicy: "new" } },
    }
    expect(validateAppConfig(config)).toEqual(config)
    expect(detectUnknownKeys(config)).toContain(
      "apps.claudeCode.futureModelPolicy",
    )
  })
})

describe("validateAppConfig — parked mcpBroker", () => {
  it("accepts an old mcpBroker section silently and keeps it as-is", () => {
    const config = {
      mcpBroker: {
        enabled: true,
        servers: [
          {
            id: "workiq",
            label: "Work IQ",
            enabled: true,
            clients: ["claude-code"],
            catalog: "workiq",
            transport: { type: "stdio", command: "workiq", args: ["mcp"] },
          },
        ],
      },
    }
    expect(validateAppConfig(config)).toEqual(config)
    expect(detectUnknownKeys(config)).toEqual([])
  })

  it("does not validate the parked section's contents", () => {
    const config = { mcpBroker: { servers: "not-an-array" } }
    expect(validateAppConfig(config)).toEqual(config)
  })

  it("still validates the client ownership arrays", () => {
    const config = {
      apps: {
        claudeCode: { mcpServers: ["workiq"] },
        claudeDesktop: { mcpServers: ["workiq"] },
      },
    }
    expect(validateAppConfig(config)).toEqual(config)
    expect(() =>
      validateAppConfig({
        apps: { claudeCode: { mcpServers: ["Not Valid"] } },
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

function issuePaths(raw: unknown): Array<string> {
  try {
    validateAppConfig(raw)
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return error.issues.map((issue) => issue.path)
    }
    throw error
  }
  return []
}

describe("budget", () => {
  const budget = {
    display: { unit: "usd", creditUsd: 0.01 },
    limits: [
      {
        id: "everything",
        scope: { kind: "global" },
        limit: 200_000_000_000,
        limitReset: { follow: "copilot:premium_interactions" },
        warnAt: 0.8,
        action: "warn",
      },
      {
        id: "codex",
        scope: { kind: "key", id: "codex" },
        limit: 50_000_000_000,
        limitReset: "weekly",
        action: "block",
      },
      {
        id: "images-daily",
        label: "Images",
        scope: { kind: "plugin", id: "images" },
        limit: 30_000_000_000,
        limitReset: "daily",
        warnAt: 0.8,
        action: "block",
      },
    ],
  }

  it("accepts limits, the display unit and the conversion override", () => {
    const parsed: unknown = validateAppConfig({ budget })
    expect(parsed).toEqual({ budget })
    const empty: unknown = validateAppConfig({ budget: {} })
    expect(empty).toEqual({ budget: {} })
  })

  it("keeps keys a newer version wrote", () => {
    const newer = {
      budget: {
        ...budget,
        notify: true,
        limits: [{ ...budget.limits[1], holdTimeoutMs: 5 }],
      },
    }
    const parsed: unknown = validateAppConfig(newer)
    expect(parsed).toEqual(newer)
  })

  it("rejects bad limits with the offending path", () => {
    const limit = budget.limits[1]
    expect(
      issuePaths({ budget: { limits: [limit, { ...limit, limit: 1 }] } }),
    ).toEqual(["budget.limits.1.id"])
    expect(
      issuePaths({
        budget: { limits: [{ ...limit, scope: { kind: "key" } }] },
      }),
    ).toEqual(["budget.limits.0.scope.id"])
    expect(
      issuePaths({ budget: { limits: [{ ...limit, limitReset: "monthly" }] } }),
    ).toEqual(["budget.limits.0.limitReset"])
    expect(
      issuePaths({ budget: { limits: [{ ...limit, limit: -1 }] } }),
    ).toEqual(["budget.limits.0.limit"])
    expect(
      issuePaths({ budget: { display: { unit: "premium_requests" } } }),
    ).toEqual(["budget.display.unit"])
    expect(issuePaths({ budget: { display: { creditUsd: 0 } } })).toEqual([
      "budget.display.creditUsd",
    ])
  })
})
