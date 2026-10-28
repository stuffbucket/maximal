import { describe, expect, test } from "bun:test"

import type { CodexModelInfo } from "~/apps/codex/models-catalog"
import type { AnthropicMessagesPayload } from "~/lib/models/anthropic-types"
import type { Model } from "~/services/copilot/get-models"

import {
  type RequestContextWindow,
  anthropicCacheTtlSeconds,
  resolveContextWindow,
  responsesCacheTtlSeconds,
} from "~/lib/token-usage/request-meta"
import { resolveResponsesCompactThreshold } from "~/routes/responses/utils"

const payload = (
  extra: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload => ({
  model: "claude-sonnet-4.5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
})

const model = (limits: Record<string, number>): Model =>
  ({ id: "m", capabilities: { limits } }) as unknown as Model

describe("anthropicCacheTtlSeconds", () => {
  test("is 0 without cache_control", () => {
    expect(
      anthropicCacheTtlSeconds(
        payload({ system: [{ type: "text", text: "s" }] }),
      ),
    ).toBe(0)
  })

  test("is 300 for plain or unrecognised cache_control", () => {
    expect(
      anthropicCacheTtlSeconds(
        payload({
          system: [
            { type: "text", text: "s", cache_control: { type: "ephemeral" } },
          ],
        }),
      ),
    ).toBe(300)
    expect(
      anthropicCacheTtlSeconds(
        payload({
          tools: [
            {
              name: "t",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
          ],
        }),
      ),
    ).toBe(300)
    expect(
      anthropicCacheTtlSeconds(
        payload({
          tools: [
            {
              name: "t",
              cache_control: { type: "ephemeral", ttl: "2h" },
            },
          ],
        }),
      ),
    ).toBe(300)
  })

  test("is 3600 for a 1h block in system, tools, messages or tool_result", () => {
    const oneHour = { type: "ephemeral", ttl: "1h" }
    expect(
      anthropicCacheTtlSeconds(
        payload({
          system: [{ type: "text", text: "s", cache_control: oneHour }],
        }),
      ),
    ).toBe(3600)
    expect(
      anthropicCacheTtlSeconds(
        payload({ tools: [{ name: "t", cache_control: oneHour }] }),
      ),
    ).toBe(3600)
    expect(
      anthropicCacheTtlSeconds(
        payload({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "x", cache_control: oneHour }],
            },
          ],
        }),
      ),
    ).toBe(3600)
    expect(
      anthropicCacheTtlSeconds(
        payload({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "t1",
                  content: [
                    { type: "text", text: "x", cache_control: oneHour },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(3600)
  })

  test("a 1h block wins over an earlier plain one", () => {
    expect(
      anthropicCacheTtlSeconds(
        payload({
          system: [
            { type: "text", text: "s", cache_control: { type: "ephemeral" } },
          ],
          tools: [
            {
              name: "t",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        }),
      ),
    ).toBe(3600)
  })
})

describe("responsesCacheTtlSeconds", () => {
  test("24h retention is a day, everything else is 5 minutes", () => {
    expect(responsesCacheTtlSeconds("24h")).toBe(86400)
    expect(responsesCacheTtlSeconds("in-memory")).toBe(300)
    expect(responsesCacheTtlSeconds(null)).toBe(300)
    expect(responsesCacheTtlSeconds(undefined)).toBe(300)
  })
})

describe("resolveContextWindow", () => {
  const catalog: Array<CodexModelInfo> = [
    {
      slug: "m",
      context_window: 272000,
      auto_compact_token_limit: 200000,
    },
  ]

  test("codex uses the catalog window and maximal's compact threshold", () => {
    expect(
      resolveContextWindow({
        client: "codex",
        model: model({ max_prompt_tokens: 128000 }),
        longContext: false,
        codexCatalog: catalog,
        maximalCompacts: true,
      }),
    ).toEqual({
      windowTokens: 272000,
      ceilingTokens: 128000,
      compactAtTokens: resolveResponsesCompactThreshold(128000),
      source: "codex-catalog",
    })
  })

  test("codex falls back to the catalog's own compact limit", () => {
    expect(
      resolveContextWindow({
        client: "codex",
        model: model({ max_prompt_tokens: 128000 }),
        longContext: false,
        codexCatalog: catalog,
      }),
    ).toEqual({
      windowTokens: 272000,
      ceilingTokens: 128000,
      compactAtTokens: 200000,
      source: "codex-catalog",
    })
  })

  test("codex without a usable catalog entry falls back to the listing", () => {
    const listed = model({
      max_context_window_tokens: 200000,
      max_prompt_tokens: 128000,
    })
    const expected: RequestContextWindow = {
      windowTokens: 200000,
      ceilingTokens: 128000,
      compactAtTokens: null,
      source: "model-listing",
    }
    // No entry for the model.
    expect(
      resolveContextWindow({
        client: "codex",
        model: listed,
        longContext: false,
        codexCatalog: [{ slug: "other", context_window: 1 }],
      }),
    ).toEqual(expected)
    // Empty and undefined catalogs.
    expect(
      resolveContextWindow({
        client: "codex",
        model: listed,
        longContext: false,
        codexCatalog: [],
      }),
    ).toEqual(expected)
    expect(
      resolveContextWindow({
        client: "codex",
        model: listed,
        longContext: false,
      }),
    ).toEqual(expected)
    // An entry without a numeric context_window keeps its compact limit.
    expect(
      resolveContextWindow({
        client: "codex",
        model: listed,
        longContext: false,
        codexCatalog: [
          { slug: "m", context_window: null, auto_compact_token_limit: 90000 },
        ],
      }),
    ).toEqual({ ...expected, compactAtTokens: 90000 })
  })

  test("claude-code with long context runs at 1M", () => {
    expect(
      resolveContextWindow({
        client: "claude-code",
        model: model({ max_prompt_tokens: 1_000_000 }),
        longContext: true,
      }),
    ).toEqual({
      windowTokens: 1_000_000,
      ceilingTokens: 1_000_000,
      compactAtTokens: null,
      source: "claude-1m",
    })
  })

  test("claude-code without long context follows the models endpoint", () => {
    expect(
      resolveContextWindow({
        client: "claude-code",
        model: model({
          max_context_window_tokens: 200000,
          max_prompt_tokens: 128000,
        }),
        longContext: false,
      }),
    ).toEqual({
      windowTokens: 200000,
      ceilingTokens: 128000,
      compactAtTokens: null,
      source: "models-endpoint",
    })
    expect(
      resolveContextWindow({
        client: "claude-code",
        model: model({ max_prompt_tokens: 128000 }),
        longContext: false,
      }).windowTokens,
    ).toBe(128000)
  })

  test("other clients use the model listing", () => {
    expect(
      resolveContextWindow({
        client: "other",
        model: model({ max_context_window_tokens: 200000 }),
        longContext: true,
      }),
    ).toEqual({
      windowTokens: 200000,
      ceilingTokens: null,
      compactAtTokens: null,
      source: "model-listing",
    })
  })

  test("an unknown model is all nulls", () => {
    expect(
      resolveContextWindow({
        client: "claude-code",
        model: undefined,
        longContext: false,
      }),
    ).toEqual({
      windowTokens: null,
      ceilingTokens: null,
      compactAtTokens: null,
      source: "model-listing",
    })
  })
})
