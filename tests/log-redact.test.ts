import { describe, expect, test } from "bun:test"

import { redactForLog, scrubSecrets } from "~/lib/platform/log-redact"

describe("scrubSecrets", () => {
  test("masks GitHub token shapes (gho_/ghp_/ghu_/ghr_/ghs_)", () => {
    for (const prefix of ["gho_", "ghp_", "ghu_", "ghr_", "ghs_"]) {
      const tok = `${prefix}AbCdEf0123456789AbCdEf0123456789`
      const out = scrubSecrets(`token is ${tok} ok`)
      expect(out).not.toContain(tok)
      expect(out).toContain("[redacted github token]")
    }
  })

  test("masks the Copilot bearer (tid=…) shape", () => {
    const tok = "tid=abc123def456ghi789;ol=org;exp=1700000000;sku=x:deadbeefsig"
    const out = scrubSecrets(`bearer ${tok}`)
    expect(out).not.toContain("tid=abc123def456ghi789")
    expect(out).toContain("[redacted copilot token]")
  })

  test("leaves ordinary auth log labels untouched", () => {
    for (const label of [
      "Logged in as octocat",
      "Copilot rejected the GitHub token; degrading",
      "Refreshing Copilot token",
      "GitHub token:",
    ]) {
      expect(scrubSecrets(label)).toBe(label)
    }
  })
})

describe("redactForLog", () => {
  test("keeps structural keys, redacts content strings", () => {
    const payload = {
      model: "claude-sonnet-4-5",
      stream: true,
      max_tokens: 1024,
      temperature: 0.7,
      system: "You are a helpful assistant with secret instructions.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "my private prompt with PII" },
            {
              type: "tool_result",
              tool_use_id: "toolu_123",
              content: "sensitive file contents",
            },
          ],
        },
      ],
    }

    const out = redactForLog(payload) as Record<string, unknown>

    // Structure / config kept verbatim.
    expect(out.model).toBe("claude-sonnet-4-5")
    expect(out.stream).toBe(true)
    expect(out.max_tokens).toBe(1024)
    expect(out.temperature).toBe(0.7)

    // Content redacted, length preserved.
    expect(out.system).toBe(`[redacted ${payload.system.length} chars]`)

    const msg = (out.messages as Array<Record<string, unknown>>)[0]
    expect(msg.role).toBe("user")
    const blocks = msg.content as Array<Record<string, unknown>>
    expect(blocks[0].type).toBe("text")
    expect(blocks[0].text).toBe("[redacted 26 chars]")
    expect(blocks[1].type).toBe("tool_result")
    expect(blocks[1].tool_use_id).toBe("toolu_123") // id is structural
    expect(blocks[1].content).toBe("[redacted 23 chars]")
  })

  test("keeps tool definitions' names/keys, redacts description text", () => {
    const payload = {
      tools: [
        {
          name: "get_weather",
          description: "Fetch the weather for a place — could carry hints",
          input_schema: {
            type: "object",
            properties: {
              location: { type: "string", description: "city name" },
            },
          },
        },
      ],
    }

    const out = redactForLog(payload) as {
      tools: Array<Record<string, unknown>>
    }
    const tool = out.tools[0]
    expect(tool.name).toBe("get_weather") // tool name kept
    expect(tool.description).toMatch(/^\[redacted \d+ chars\]$/) // prose redacted
    const schema = tool.input_schema as Record<string, unknown>
    expect(schema.type).toBe("object") // schema shape kept
    const props = schema.properties as Record<string, Record<string, unknown>>
    // Parameter *key* preserved (schema), nested description redacted.
    expect(props.location.type).toBe("string")
    expect(props.location.description).toMatch(/^\[redacted \d+ chars\]$/)
  })

  test("redacts unknown content-bearing keys by default (fail-closed)", () => {
    // A field we've never allowlisted — must default to redacted.
    const out = redactForLog({
      some_future_field: "leaked secret from a new API version",
    }) as Record<string, unknown>
    expect(out.some_future_field).toMatch(/^\[redacted \d+ chars\]$/)
  })

  test("keeps usage counts and numeric config", () => {
    const out = redactForLog({
      usage: { input_tokens: 10, output_tokens: 25 },
      stop_reason: "end_turn",
    }) as Record<string, unknown>
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 25 })
    expect(out.stop_reason).toBe("end_turn") // structural string kept
  })

  test("does not mutate the original payload", () => {
    const payload = { messages: [{ role: "user", text: "secret" }] }
    redactForLog(payload)
    expect(payload.messages[0].text).toBe("secret")
  })

  test("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { model: "x" }
    a.self = a
    const out = redactForLog(a) as Record<string, unknown>
    expect(out.model).toBe("x")
    expect(out.self).toBe("[circular]")
  })

  test("redacts strings inside arrays under non-structural keys", () => {
    const out = redactForLog({
      stop_sequences: ["END", "STOP"], // not allowlisted → redacted
    }) as Record<string, unknown>
    const seqs = out.stop_sequences as Array<string>
    expect(seqs[0]).toMatch(/^\[redacted \d+ chars\]$/)
  })

  test("redacts a bare top-level string (no key context → not structural)", () => {
    // A string passed with no parent key has keyContext === undefined,
    // which must be treated as non-structural and redacted. Pins the
    // `key !== undefined` half of isStructuralKey.
    expect(redactForLog("a bare secret string")).toMatch(
      /^\[redacted \d+ chars\]$/,
    )
  })

  test("passes top-level null through unchanged", () => {
    // null is not an object and not a string — kept verbatim. Pins the
    // `value === null` short-circuit in redactValue.
    expect(redactForLog(null)).toBeNull()
  })

  // ---------------------------------------------------------------------
  // Allowlist boundary. Each of these keys is part of the PII boundary:
  // its string value is logged VERBATIM. If any single key is dropped
  // from STRUCTURAL_STRING_KEYS in the source, the matching case below
  // flips to the redacted marker and fails. This pins the entire
  // allowlist against silent deletion (the mutation-testing gap).
  // ---------------------------------------------------------------------
  const ALLOWLISTED_KEYS = [
    "model",
    "object",
    "provider",
    "kind",
    "status",
    "source",
    "service_tier",
    "encoding",
    "role",
    "type",
    "name",
    "tool_name",
    "function_name",
    "stop_reason",
    "finish_reason",
    "stop",
    "id",
    "request_id",
    "session_id",
    "trace_id",
    "tool_use_id",
    "tool_call_id",
    "anthropic_version",
    "anthropic_beta",
    "version",
    "schema_version",
    "media_type",
    "mime_type",
    "detail",
    "reasoning_effort",
    "effort",
    "authtype",
  ] as const

  for (const key of ALLOWLISTED_KEYS) {
    test(`keeps the structural key "${key}" verbatim`, () => {
      const value = `sentinel-value-for-${key}`
      const out = redactForLog({ [key]: value }) as Record<string, unknown>
      // Verbatim — NOT the "[redacted N chars]" marker.
      expect(out[key]).toBe(value)
    })
  }

  test("the allowlist test set matches the documented PII boundary", () => {
    // Guards against the test list silently drifting from the spec: every
    // key must be unique and the count must equal the documented allowlist.
    expect(new Set(ALLOWLISTED_KEYS).size).toBe(ALLOWLISTED_KEYS.length)
    expect(ALLOWLISTED_KEYS.length).toBe(32)
  })

  test("the same string is kept under a structural key, redacted under a non-structural one", () => {
    const value = "identical-string-payload"
    // `name` is structural → kept; `description` is not → redacted. This
    // pins the isStructuralKey branch in redactValue for string leaves.
    const kept = redactForLog({ name: value }) as Record<string, unknown>
    const redacted = redactForLog({ description: value }) as Record<
      string,
      unknown
    >
    expect(kept.name).toBe(value)
    expect(redacted.description).toBe(`[redacted ${value.length} chars]`)
  })

  test("keeps strings in an array under a structural key verbatim", () => {
    // `stop` is allowlisted → array elements inherit the keep decision.
    const out = redactForLog({ stop: ["END", "STOP"] }) as Record<
      string,
      unknown
    >
    expect(out.stop).toEqual(["END", "STOP"])
  })

  test("array keep/redact tracks the parent key, not the element", () => {
    // Same element strings: kept under structural `stop`, redacted under
    // non-structural `stop_sequences`. Pins the array-recursion path.
    const value = "SAME"
    const kept = redactForLog({ stop: [value] }) as Record<string, unknown>
    const redacted = redactForLog({ stop_sequences: [value] }) as Record<
      string,
      unknown
    >
    expect((kept.stop as Array<string>)[0]).toBe(value)
    expect((redacted.stop_sequences as Array<string>)[0]).toBe(
      `[redacted ${value.length} chars]`,
    )
  })

  test("matches allowlisted keys case-insensitively", () => {
    // Source lowercases before lookup; an upper/mixed-case key still keeps.
    const out = redactForLog({
      Model: "claude-x",
      Stop_Reason: "end_turn",
    }) as Record<string, unknown>
    expect(out.Model).toBe("claude-x")
    expect(out.Stop_Reason).toBe("end_turn")
  })
})
