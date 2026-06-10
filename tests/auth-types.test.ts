import { describe, expect, test } from "bun:test"

import {
  hostForAccountType,
  parseAccountType,
  toCopilotHost,
} from "~/lib/auth-types"

// `toCopilotHost`/`hostForAccountType` return the branded `CopilotHost`; coerce
// to a plain string in assertions so we can compare against string literals.
const asString = (host: string | null): string | null => host

describe("parseAccountType", () => {
  test("accepts the three valid account types", () => {
    expect(parseAccountType("individual")).toBe("individual")
    expect(parseAccountType("business")).toBe("business")
    expect(parseAccountType("enterprise")).toBe("enterprise")
  })

  test("throws on a typo, naming the valid values", () => {
    expect(() => parseAccountType("enterpise")).toThrow(
      /individual, business, enterprise/,
    )
  })

  test("throws on empty / unrelated input", () => {
    expect(() => parseAccountType("")).toThrow()
    expect(() => parseAccountType("Individual")).toThrow() // case-sensitive
  })
})

describe("toCopilotHost", () => {
  test("brands a well-formed https origin", () => {
    expect(
      asString(toCopilotHost("https://api.enterprise.githubcopilot.com")),
    ).toBe("https://api.enterprise.githubcopilot.com")
  })

  test("normalizes to the origin (drops path + trailing slash)", () => {
    expect(asString(toCopilotHost("https://api.githubcopilot.com/"))).toBe(
      "https://api.githubcopilot.com",
    )
    expect(
      asString(toCopilotHost("https://api.githubcopilot.com/v1/messages")),
    ).toBe("https://api.githubcopilot.com")
  })

  test("rejects non-https and malformed URLs as null", () => {
    expect(toCopilotHost("http://api.githubcopilot.com")).toBeNull()
    expect(toCopilotHost("api.githubcopilot.com")).toBeNull()
    expect(toCopilotHost("")).toBeNull()
    expect(toCopilotHost("not a url")).toBeNull()
  })
})

describe("hostForAccountType", () => {
  test("individual is served from the apex host (the subdomain 421s)", () => {
    expect(asString(hostForAccountType("individual"))).toBe(
      "https://api.githubcopilot.com",
    )
  })

  test("business / enterprise get their subdomain", () => {
    expect(asString(hostForAccountType("business"))).toBe(
      "https://api.business.githubcopilot.com",
    )
    expect(asString(hostForAccountType("enterprise"))).toBe(
      "https://api.enterprise.githubcopilot.com",
    )
  })
})
