import { describe, expect, test } from "bun:test"

import { isAuthFatal, parseCopilotErrorBody } from "~/lib/copilot-error-parser"

describe("parseCopilotErrorBody", () => {
  test("empty JSON object yields generic default message", () => {
    const result = parseCopilotErrorBody("{}")
    expect(result.message).toBe("Copilot returned an error.")
    expect(result.remediationUrl).toBeNull()
  })
})

describe("isAuthFatal — 401 always fatal", () => {
  test("401 with empty message", () => {
    expect(isAuthFatal(401, { message: "", remediationUrl: null })).toBe(true)
  })

  test("401 with arbitrary non-auth message still fatal", () => {
    expect(
      isAuthFatal(401, {
        message: "model not on plan",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("401 with no URL still fatal", () => {
    expect(
      isAuthFatal(401, {
        message: "anything at all",
        remediationUrl: null,
      }),
    ).toBe(true)
  })
})

describe("isAuthFatal — 403 marker matches", () => {
  test("message contains 'terms of service'", () => {
    expect(
      isAuthFatal(403, {
        message: "You must accept the GitHub terms of service.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'Terms Of Service' (case insensitive)", () => {
    expect(
      isAuthFatal(403, {
        message: "Please review our Terms Of Service before continuing.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'terms-of-service'", () => {
    expect(
      isAuthFatal(403, {
        message: "Visit the terms-of-service page.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("URL contains '/site/terms'", () => {
    expect(
      isAuthFatal(403, {
        message: "Action required.",
        remediationUrl: "https://github.com/site/terms",
      }),
    ).toBe(true)
  })

  test("URL contains '/settings/copilot'", () => {
    expect(
      isAuthFatal(403, {
        message: "Action required.",
        remediationUrl: "https://github.com/settings/copilot",
      }),
    ).toBe(true)
  })

  test("URL contains '/copilot/signup'", () => {
    expect(
      isAuthFatal(403, {
        message: "Action required.",
        remediationUrl: "https://github.com/copilot/signup",
      }),
    ).toBe(true)
  })

  test("message contains 'not entitled'", () => {
    expect(
      isAuthFatal(403, {
        message: "User is not entitled to Copilot.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'license revoked'", () => {
    expect(
      isAuthFatal(403, {
        message: "Your license revoked by admin.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'license has been'", () => {
    expect(
      isAuthFatal(403, {
        message: "Your license has been deactivated.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'subscription has been'", () => {
    expect(
      isAuthFatal(403, {
        message: "Your subscription has been cancelled.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'subscription required'", () => {
    expect(
      isAuthFatal(403, {
        message: "A subscription required for this action.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'no copilot license'", () => {
    expect(
      isAuthFatal(403, {
        message: "There is no copilot license attached to your account.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })

  test("message contains 'accept the terms'", () => {
    expect(
      isAuthFatal(403, {
        message: "Please accept the terms to continue.",
        remediationUrl: null,
      }),
    ).toBe(true)
  })
})

describe("isAuthFatal — 403 negative cases", () => {
  test("model-not-on-plan message is not fatal", () => {
    expect(
      isAuthFatal(403, {
        message: "Model not available on your plan",
        remediationUrl: null,
      }),
    ).toBe(false)
  })

  test("quota-exhausted message is not fatal", () => {
    expect(
      isAuthFatal(403, {
        message: "Quota exhausted",
        remediationUrl: null,
      }),
    ).toBe(false)
  })

  test("empty message + null URL is not fatal", () => {
    expect(isAuthFatal(403, { message: "", remediationUrl: null })).toBe(false)
  })

  test("non-account GitHub URL is not fatal", () => {
    expect(
      isAuthFatal(403, {
        message: "See docs",
        remediationUrl: "https://github.com/cli/cli",
      }),
    ).toBe(false)
  })
})

describe("isAuthFatal — non-401/403 statuses always false", () => {
  test("402 with TOS marker in body is not fatal", () => {
    expect(
      isAuthFatal(402, {
        message: "You must accept the terms of service.",
        remediationUrl: "https://github.com/site/terms",
      }),
    ).toBe(false)
  })

  test("429 with 'license revoked' in body is not fatal", () => {
    expect(
      isAuthFatal(429, {
        message: "license revoked",
        remediationUrl: null,
      }),
    ).toBe(false)
  })

  test("500 with any marker is not fatal", () => {
    expect(
      isAuthFatal(500, {
        message: "not entitled",
        remediationUrl: "https://github.com/settings/copilot",
      }),
    ).toBe(false)
  })

  test("200 (defensive) is not fatal", () => {
    expect(
      isAuthFatal(200, {
        message: "terms of service",
        remediationUrl: "https://github.com/site/terms",
      }),
    ).toBe(false)
  })
})

describe("isAuthFatal — marker matching across message AND URL combined", () => {
  test("message 'Please accept' alone is not enough; URL marker wins", () => {
    expect(
      isAuthFatal(403, {
        message: "Please accept",
        remediationUrl: "https://github.com/site/terms",
      }),
    ).toBe(true)
  })

  test("message 'Please accept the terms' alone is enough with null URL", () => {
    expect(
      isAuthFatal(403, {
        message: "Please accept the terms",
        remediationUrl: null,
      }),
    ).toBe(true)
  })
})
