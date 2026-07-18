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

  it("accepts 'max' reasoning effort (GPT-5.6 ladder top)", () => {
    // Regression for the boot-rejection bug: before "max" was added to
    // ReasoningEffortSchema, a config setting any model's effort to the top of
    // the GPT-5.6 ladder failed validation and the proxy exited non-zero.
    const config = {
      modelReasoningEfforts: {
        "gpt-5.6-sol": "max" as const,
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

  it("keeps unknown top-level keys (passthrough)", () => {
    const config = { useMessagesApi: true, futureFlag: "not-yet-typed" }
    const parsed = validateAppConfig(config) as typeof config
    expect(parsed.futureFlag).toBe("not-yet-typed")
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
