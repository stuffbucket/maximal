import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { resolveSmallToolModel } from "~/lib/small-model"

/**
 * Build a minimal Model fixture — only the fields resolveSmallToolModel reads.
 */
function model(
  id: string,
  opts: { family?: string; toolCalls?: boolean } = {},
): Model {
  return {
    id,
    capabilities: {
      family: opts.family ?? "",
      supports: { tool_calls: opts.toolCalls ?? false },
    },
  } as unknown as Model
}

const CATALOG: Array<Model> = [
  model("gpt-5-mini", { family: "gpt-5-mini", toolCalls: true }),
  model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
  model("claude-opus-4-8-20260301", { family: "claude", toolCalls: true }),
  model("claude-haiku-4-5-20260301", {
    family: "claude-haiku",
    toolCalls: true,
  }),
  model("text-embedding-3-small", { family: "embedding", toolCalls: false }),
]

describe("resolveSmallToolModel", () => {
  test("honors an explicitly configured model even if weak", () => {
    // The user's explicit choice always wins — we never override it.
    expect(resolveSmallToolModel(CATALOG, "gpt-5-mini")).toBe("gpt-5-mini")
  })

  test("ignores an empty/whitespace configured value", () => {
    expect(resolveSmallToolModel(CATALOG, "")).toBe("claude-haiku-4-5-20260301")
    expect(resolveSmallToolModel(CATALOG, "   ")).toBe(
      "claude-haiku-4-5-20260301",
    )
  })

  test("prefers a tool-capable Claude haiku-class model", () => {
    expect(resolveSmallToolModel(CATALOG)).toBe("claude-haiku-4-5-20260301")
  })

  test("matches haiku class by family alone (id lacks 'haiku')", () => {
    // family says claude-haiku but the id doesn't contain "haiku" — the family
    // branch of the OR must still match, and it must beat the earlier gpt entry.
    const catalog = [
      model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
      model("cc-small-v2", { family: "claude-haiku", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("cc-small-v2")
  })

  test("matches haiku class by id when family omits it", () => {
    // family is bare "claude" (no haiku), id carries "haiku" — the id branch of
    // each OR must match. Ordered after a gpt entry to prove it's not fallback.
    const catalog = [
      model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
      model("claude-haiku-4-6", { family: "claude", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("claude-haiku-4-6")
  })

  test("does not treat a non-claude 'haiku' model as haiku-class", () => {
    // Only the id says haiku and family isn't claude — the claude half of the
    // leading AND must fail, so this is picked only as a tool-capable fallback,
    // never preferred over an actual claude-haiku later in the list.
    const catalog = [
      model("vendorx-haiku", { family: "vendorx", toolCalls: true }),
      model("claude-haiku-4-5", { family: "claude-haiku", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("claude-haiku-4-5")
  })

  test("does not treat a claude non-haiku model as haiku-class", () => {
    // family/id are claude but not haiku — the haiku half of the trailing AND
    // must fail, so opus is only a fallback, never preferred over a haiku.
    const catalog = [
      model("claude-opus-4-8", { family: "claude", toolCalls: true }),
      model("claude-haiku-4-5", { family: "claude-haiku", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("claude-haiku-4-5")
  })

  test("requires BOTH claude and haiku signals (rejects claude-only + haiku-only)", () => {
    // No single model has both a claude signal and a haiku signal, so none is
    // haiku-class; the first tool-capable model is the fallback. Kills the
    // ||-for-&& mutants: if either AND were an OR, one of these would qualify.
    const catalog = [
      model("claude-opus-4-8", { family: "claude", toolCalls: true }),
      model("vendorx-haiku", { family: "vendorx", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("claude-opus-4-8")
  })

  test("classifies a claude-prefixed id as haiku via startsWith", () => {
    // The claude signal comes solely from `id.startsWith("claude")` (family is
    // a non-matching value). Ordered after a gpt entry so it's only picked if
    // genuinely classified haiku — not as the tool-capable fallback. Kills the
    // startsWith→endsWith mutant ("claude-haiku-x" starts with but does not end
    // with "claude").
    const catalog = [
      model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
      model("claude-haiku-x", { family: "cc", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("claude-haiku-x")
  })

  test("does not pick a haiku model that cannot call tools", () => {
    const catalog = [
      model("claude-haiku-broken", {
        family: "claude-haiku",
        toolCalls: false,
      }),
      model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
    ]
    // Falls through to any tool-capable model rather than a non-tool haiku.
    expect(resolveSmallToolModel(catalog)).toBe("gpt-5.5")
  })

  test("falls back to any tool-capable model when no haiku exists", () => {
    const catalog = [
      model("text-embedding-3-small", {
        family: "embedding",
        toolCalls: false,
      }),
      model("gpt-5.5", { family: "gpt-5", toolCalls: true }),
    ]
    expect(resolveSmallToolModel(catalog)).toBe("gpt-5.5")
  })

  test("returns undefined when nothing is tool-capable", () => {
    const catalog = [
      model("text-embedding-3-small", {
        family: "embedding",
        toolCalls: false,
      }),
    ]
    expect(resolveSmallToolModel(catalog)).toBeUndefined()
  })

  test("returns undefined for an empty or missing catalog", () => {
    expect(resolveSmallToolModel([])).toBeUndefined()
    expect(resolveSmallToolModel(undefined)).toBeUndefined()
  })
})
