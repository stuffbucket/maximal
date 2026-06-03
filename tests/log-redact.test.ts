import { describe, expect, test } from "bun:test"

import { redactForLog } from "~/lib/log-redact"

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
})
