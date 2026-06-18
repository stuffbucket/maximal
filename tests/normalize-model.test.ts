/**
 * `normalizeModel` is the single fetch-boundary guard that keeps a sparse
 * Copilot catalog entry from taking down the critical path. Copilot omits
 * `capabilities`, `capabilities.limits`, or `capabilities.supports` for
 * some models even though the `Model` type declares them required; the
 * boot-time filter, thinking-budget math, and `max_tokens` auto-fill all
 * trust that shape. These tests pin the contract:
 *
 *   1. container objects (`capabilities`, `limits`, `supports`) are always
 *      present after normalization — downstream `?? default` guards suffice;
 *   2. genuinely-absent leaf values stay `undefined` (NOT invented), so the
 *      UI can render them as "missing" rather than a made-up number.
 */

import { describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { normalizeModel } from "~/services/copilot/get-models"

describe("normalizeModel", () => {
  test("fills missing capabilities containers without inventing leaf values", () => {
    // The exact shape that crashed the field: no `capabilities` at all.
    const sparse = {
      id: "no-caps",
      name: "No Caps",
      object: "model",
      vendor: "unknown",
      version: "1",
      model_picker_enabled: true,
      preview: false,
    } as unknown as Model

    const out = normalizeModel(sparse)

    // Containers exist — downstream `.capabilities.limits.X` never throws.
    expect(out.capabilities).toBeDefined()
    expect(out.capabilities.limits).toEqual({})
    expect(out.capabilities.supports).toEqual({})
    // Tokenizer gets a working default (drives local token counting).
    expect(out.capabilities.tokenizer).toBe("o200k_base")
    expect(out.capabilities.family).toBe("")
    expect(out.capabilities.type).toBe("")
    // Leaf limits are NOT invented — they read as "missing", not zero.
    expect(out.capabilities.limits.max_context_window_tokens).toBeUndefined()
    expect(out.capabilities.limits.max_output_tokens).toBeUndefined()
  })

  test("fills only the missing nested object, preserving present ones", () => {
    const partial = {
      id: "has-limits-no-supports",
      name: "Partial",
      object: "model",
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      preview: false,
      capabilities: {
        family: "claude",
        object: "model_capabilities",
        type: "chat",
        tokenizer: "o200k_base",
        limits: { max_output_tokens: 4096 },
        // supports omitted
      },
    } as unknown as Model

    const out = normalizeModel(partial)

    // Present nested values survive untouched.
    expect(out.capabilities.limits.max_output_tokens).toBe(4096)
    expect(out.capabilities.family).toBe("claude")
    // The missing one is backfilled to an empty container.
    expect(out.capabilities.supports).toEqual({})
  })

  test("passes a complete model through unchanged", () => {
    const complete = {
      id: "complete",
      name: "Complete",
      object: "model",
      vendor: "anthropic",
      version: "1",
      model_picker_enabled: true,
      preview: false,
      capabilities: {
        family: "claude-opus-4.6",
        object: "model_capabilities",
        type: "chat",
        tokenizer: "o200k_base",
        limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 },
        supports: { vision: true, tool_calls: true, streaming: true },
      },
    } as Model

    const out = normalizeModel(complete)

    expect(out.capabilities.limits.max_context_window_tokens).toBe(200000)
    expect(out.capabilities.supports.vision).toBe(true)
    expect(out.id).toBe("complete")
  })
})
