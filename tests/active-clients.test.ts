/**
 * Unit coverage for the in-memory active-clients tracker.
 *
 * Covers: record + list within window, expiry by maxAgeSeconds,
 * distinct keys produce distinct entries, repeat (key, ua) updates
 * lastSeenAt instead of duplicating, and humanizeUserAgent fallback.
 */

import { beforeEach, describe, expect, test } from "bun:test"

import {
  __resetActiveClientsForTests,
  humanizeUserAgent,
  listActiveClients,
  recordClient,
} from "~/lib/active-clients"

beforeEach(() => {
  __resetActiveClientsForTests()
})

describe("recordClient / listActiveClients", () => {
  test("recorded client appears within the age window", () => {
    recordClient({
      apiKeyId: "key-a",
      apiKeyLabel: "Claude Code",
      userAgent: "Claude-Code/2.0",
    })
    const out = listActiveClients(60)
    expect(out.length).toBe(1)
    expect(out[0].label).toBe("Claude Code")
    expect(out[0].userAgent).toBe("Claude-Code/2.0")
    expect(out[0].ageSeconds).toBeLessThanOrEqual(1)
  })

  test("entries older than maxAgeSeconds are excluded", async () => {
    recordClient({
      apiKeyId: null,
      apiKeyLabel: null,
      userAgent: "Cline/0.5",
    })
    // Wait 1.1s so the entry is older than maxAgeSeconds=1 below.
    await new Promise((r) => setTimeout(r, 1100))
    expect(listActiveClients(1).length).toBe(0)
    expect(listActiveClients(60).length).toBe(1)
  })

  test("two distinct (apiKey, UA) pairs produce two entries", () => {
    recordClient({
      apiKeyId: "a",
      apiKeyLabel: "A",
      userAgent: "ClientOne/1.0",
    })
    recordClient({
      apiKeyId: "b",
      apiKeyLabel: "B",
      userAgent: "ClientOne/1.0",
    })
    expect(listActiveClients(60).length).toBe(2)
  })

  test("same (apiKey, UA) repeated → 1 entry with refreshed lastSeenAt", async () => {
    recordClient({
      apiKeyId: "a",
      apiKeyLabel: "A",
      userAgent: "ClientOne/1.0",
    })
    await new Promise((r) => setTimeout(r, 50))
    recordClient({
      apiKeyId: "a",
      apiKeyLabel: "A",
      userAgent: "ClientOne/1.0",
    })
    const out = listActiveClients(60)
    expect(out.length).toBe(1)
    // lastSeenAt was refreshed → ageSeconds is tiny.
    expect(out[0].ageSeconds).toBeLessThanOrEqual(1)
  })

  test("empty user-agent is ignored", () => {
    recordClient({ apiKeyId: "a", apiKeyLabel: "A", userAgent: "" })
    recordClient({ apiKeyId: "a", apiKeyLabel: "A", userAgent: "   " })
    expect(listActiveClients(60).length).toBe(0)
  })

  test("label falls back to humanized UA when apiKeyLabel is null", () => {
    recordClient({
      apiKeyId: null,
      apiKeyLabel: null,
      userAgent: "Claude-Code/2.0",
    })
    const out = listActiveClients(60)
    expect(out[0].label).toBe("Claude Code")
  })
})

describe("humanizeUserAgent", () => {
  test("known patterns map to friendly names", () => {
    expect(humanizeUserAgent("Claude-Code/2.1.0")).toBe("Claude Code")
    expect(humanizeUserAgent("Cline/0.5")).toBe("Cline")
    expect(humanizeUserAgent("OpenAI/Python 1.2.3")).toBe("OpenAI Python SDK")
    expect(humanizeUserAgent("openai/js 4.0")).toBe("OpenAI JS SDK")
    expect(humanizeUserAgent("Anthropic/Python 0.8")).toBe(
      "Anthropic Python SDK",
    )
    expect(humanizeUserAgent("curl/7.85.0")).toBe("curl")
    expect(humanizeUserAgent("HTTPie/3.2.1")).toBe("HTTPie")
  })

  test("fallback uses first token before '/' or whitespace", () => {
    expect(humanizeUserAgent("MyCustomTool/1.2.3")).toBe("MyCustomTool")
    expect(humanizeUserAgent("SomeAgent extra info")).toBe("SomeAgent")
  })

  test("fallback truncates long tokens to ~40 chars", () => {
    const long = "a".repeat(80)
    const out = humanizeUserAgent(long)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(out.endsWith("...")).toBe(true)
  })

  test("empty input → 'Unknown client'", () => {
    expect(humanizeUserAgent("")).toBe("Unknown client")
    expect(humanizeUserAgent("   ")).toBe("Unknown client")
  })
})
