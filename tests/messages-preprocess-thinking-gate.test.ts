import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/lib/anthropic-types"

import { prepareMessagesApiPayload } from "../src/routes/messages/preprocess"

// Mutation-rigor coverage for the adaptive-thinking guard and the display gate
// of prepareMessagesApiPayload (on current main, post-#211):
//   - line 614  `selectedModel?.capabilities.supports.adaptive_thinking && !disableThink`
//   - line 623  `payload.thinking.display = incomingDisplay ?? "summarized"`
//   - line 625  `if (payload.model === "claude-opus-4.7")`  +  626 forced display
// These survivors are the durable gap neither #211 nor #215 pinned. Lives in
// its own companion file because messages-preprocess.test.ts already sits at
// the 800-line max-lines cap on main.

const adaptiveModel = (): Parameters<typeof prepareMessagesApiPayload>[1] =>
  ({ capabilities: { supports: { adaptive_thinking: true } } }) as never

const run = (
  overrides: Partial<AnthropicMessagesPayload>,
  model?: Parameters<typeof prepareMessagesApiPayload>[1],
): AnthropicMessagesPayload => {
  const payload: AnthropicMessagesPayload = {
    model: "gpt-5.4",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  }
  prepareMessagesApiPayload(payload, model)
  return payload
}

describe("prepareMessagesApiPayload — adaptive-thinking guard and display gate", () => {
  // Line 614 guard `selectedModel?.capabilities...adaptive_thinking && !disableThink`.
  // `selectedModel` is optional in the public signature (`selectedModel?: Model`)
  // and the sole call site (api-flows.ts) passes `options.selectedModel`, itself
  // `Model | undefined` (findEndpointModel can miss), so `undefined` is reachable.
  // The original short-circuits the `?.` to a falsy guard and the block is
  // skipped; the OptionalChaining mutant `selectedModel.` dereferences undefined
  // and throws, and the `&&` -> `||` mutant enters the block and sets thinking.
  // This is the durable `selectedModel === undefined` gap neither #211 nor #215
  // covered.
  test("leaves the payload untouched when selectedModel is undefined", () => {
    const payload = run({}, undefined)
    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })

  // Line 623 default: with an adaptive model and NO incoming display, the
  // display defaults to "summarized". Kills the `incomingDisplay ?? "summarized"`
  // -> `incomingDisplay && "summarized"` mutant (which yields `undefined`) and
  // the `"summarized"` -> `""` StringLiteral mutant. Also proves the line-614
  // guard actually FIRES (kills `!disableThink` -> `disableThink`, which would
  // skip the block and leave thinking undefined).
  test("defaults display to 'summarized' for an adaptive model when the client sent none", () => {
    const payload = run({}, adaptiveModel())
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
  })

  // Line 623/625, non-opus: the client explicitly asked for `display: "raw"`, so
  // #211's gate on the incoming display field preserves it, and a non-opus model
  // means the 625 opus gate must NOT fire. Kills 625 -> `if (true)` and 625
  // `===` -> `!==` (either would wrongly force "summarized" here).
  test("preserves an explicit non-summarized display on a non-opus model", () => {
    const payload = run(
      { thinking: { type: "adaptive", display: "raw" } },
      adaptiveModel(),
    )
    expect(payload.thinking).toEqual({ type: "adaptive", display: "raw" })
  })

  // Line 625/626, opus: same explicit `display: "raw"` from the client, but the
  // model IS "claude-opus-4.7" so the 625 gate MUST fire and 626 forces
  // "summarized". Kills 625 `if (false)`, 625 block-removal, 625 `=== ""`, 625
  // `!==`, and 626 -> `""` / body-removal.
  test("forces summarized display on claude-opus-4.7 even when the client sent 'raw'", () => {
    const payload = run(
      {
        model: "claude-opus-4.7",
        thinking: { type: "adaptive", display: "raw" },
      },
      adaptiveModel(),
    )
    expect(payload.thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
  })
})

// Ordering pins for the named pass pipeline (#234). prepareMessagesApiPayload is
// composed of an explicit ordered pass list; the load-bearing contract is that
// the adaptive-thinking pass runs LAST and reads the client's ORIGINAL thinking
// intent (the #210 home). These tests pin that a single call applies the whole
// pipeline in one pass — sampling strip AND thinking-intent honoring both hold —
// so a reorder that split the intent-read from the overwrite would regress here.
describe("prepareMessagesApiPayload — pass pipeline ordering (#234)", () => {
  test("honors client-disabled thinking AND strips sampling params in one pass", () => {
    // `thinking.type: "disabled"` is read by the adaptive pass BEFORE it would
    // overwrite payload.thinking; if that read were ordered after an overwrite,
    // the disable intent would be lost and adaptive thinking wrongly enabled.
    const payload = run(
      {
        thinking: { type: "disabled" },
        temperature: 1,
        top_p: 0.95,
      },
      adaptiveModel(),
    )
    // Adaptive rewrite suppressed: client explicitly disabled thinking.
    expect(payload.thinking).toEqual({ type: "disabled" })
    expect(payload.output_config).toBeUndefined()
    // Sampling-param pass still ran: adaptive model drops all three.
    expect(payload.temperature).toBeUndefined()
    expect(payload.top_p).toBeUndefined()
    expect(payload.top_k).toBeUndefined()
  })

  test("reads the incoming display before the adaptive overwrite", () => {
    // The explicit `display: "raw"` survives only because the pass captures it
    // before rewriting payload.thinking to a fresh `{type: "adaptive"}` object.
    const payload = run(
      { thinking: { type: "adaptive", display: "raw" } },
      adaptiveModel(),
    )
    expect(payload.thinking).toEqual({ type: "adaptive", display: "raw" })
  })
})
