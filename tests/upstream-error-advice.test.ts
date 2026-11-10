/**
 * The upstream-error advisor framework: parse an opaque Copilot error,
 * match it to an advisor, and compose a message that adds context + a
 * recovery step WITHOUT discarding the original error. Plus `forwardError`'s
 * integration (the model_not_supported case end-to-end).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "~/services/copilot/get-models"

import { forwardError, HTTPError } from "~/lib/errors/error"
import {
  adviseUpstreamError,
  composeAdvisedMessage,
  parseUpstreamError,
} from "~/lib/errors/upstream-error-advice"
import { state } from "~/lib/runtime-state/state"

function makeModel(over: Partial<Model> & { id: string; name: string }): Model {
  return {
    object: "model",
    preview: false,
    vendor: "anthropic",
    version: over.id,
    model_picker_enabled: true,
    capabilities: {
      family: "",
      type: "chat",
      tokenizer: "o200k_base",
      object: "model_capabilities",
      limits: {},
      supports: {},
    },
    ...over,
  }
}

const COPILOT_BODY = JSON.stringify({
  error: {
    message: "The requested model is not supported.",
    code: "model_not_supported",
    param: "model",
    type: "invalid_request_error",
  },
})

const SONNET = makeModel({ id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" })

describe("parseUpstreamError", () => {
  test("extracts nested error.message + error.code", () => {
    const u = parseUpstreamError(400, COPILOT_BODY)
    expect(u.message).toBe("The requested model is not supported.")
    expect(u.code).toBe("model_not_supported")
    expect(u.raw).toBe(COPILOT_BODY)
  })

  test("keeps the raw text as message for a non-JSON body", () => {
    const u = parseUpstreamError(502, "upstream boom")
    expect(u.message).toBe("upstream boom")
    expect(u.code).toBeNull()
  })
})

describe("composeAdvisedMessage", () => {
  test("frames context + recovery and preserves the original error line", () => {
    const msg = composeAdvisedMessage(
      { context: "Something went wrong.", recovery: "Do the thing." },
      { status: 400, message: "nope", code: "some_code", raw: "{}" },
    )
    expect(msg).toContain("Something went wrong.")
    expect(msg).toContain("Do the thing.")
    expect(msg).toContain("Upstream error (400): nope [some_code]")
  })

  test("omits the [code] bracket when there is no code", () => {
    const msg = composeAdvisedMessage(
      { context: "c", recovery: "r" },
      { status: 500, message: "boom", code: null, raw: "boom" },
    )
    expect(msg).toContain("Upstream error (500): boom")
    expect(msg).not.toContain("[")
  })
})

describe("adviseUpstreamError — model_not_supported", () => {
  test("matches by code and lists plan models with client-neutral recovery", () => {
    const msg = adviseUpstreamError(400, COPILOT_BODY, { models: [SONNET] })
    expect(msg).not.toBeNull()
    expect(msg).toContain("doesn't offer the requested model")
    // Client-neutral lead — the picker/explicit-id path, not a Claude-Code command.
    expect(msg).toContain("your client's model picker")
    // Claude Code's /model stays as a parenthetical hint, not the primary instruction.
    expect(msg).toContain("/model")
    // forwardId rewrites the dotted Copilot id to the /v1/models form.
    expect(msg).toContain("Claude Sonnet 4.5 (claude-sonnet-4-5-20260301)")
    // Original error preserved.
    expect(msg).toContain(
      "Upstream error (400): The requested model is not supported. "
        + "[model_not_supported]",
    )
  })

  test("matches by message text when code is absent", () => {
    const body = JSON.stringify({
      error: { message: "The requested model is not supported." },
    })
    expect(adviseUpstreamError(400, body, { models: [SONNET] })).not.toBeNull()
  })

  test("degrades gracefully when the catalog is empty", () => {
    const msg = adviseUpstreamError(400, COPILOT_BODY, { models: [] })
    expect(msg).toContain("couldn't read your Copilot model catalog")
    expect(msg).not.toContain("•")
  })

  test("drops variant ids and picker-disabled models from the list", () => {
    const msg = adviseUpstreamError(400, COPILOT_BODY, {
      models: [
        SONNET,
        makeModel({ id: "claude-sonnet-4.5-high", name: "Sonnet (high)" }),
        makeModel({ id: "x", name: "Hidden", model_picker_enabled: false }),
      ],
    })
    expect(msg).toContain("Claude Sonnet 4.5")
    expect(msg).not.toContain("high")
    expect(msg).not.toContain("Hidden")
  })

  test("returns null for non-400, and unrelated 400s (no false positives)", () => {
    expect(
      adviseUpstreamError(403, COPILOT_BODY, { models: [SONNET] }),
    ).toBeNull()
    const quota = JSON.stringify({ error: { message: "model rate limited" } })
    expect(adviseUpstreamError(400, quota, { models: [SONNET] })).toBeNull()
  })
})

describe("adviseUpstreamError — model on the wrong endpoint", () => {
  const LUNA = makeModel({
    id: "gpt-6-luna-decisions",
    name: "Luna Decisions",
    model_picker_enabled: false,
    supported_endpoints: ["/v1/decisions"],
  })
  const FLARE = makeModel({
    id: "gpt-image-2.5-flare",
    name: "Flare",
    model_picker_enabled: false,
    supported_endpoints: ["/v1/images/generations", "/v1/images/edits"],
  })
  const CATALOG = [SONNET, LUNA, FLARE]
  const IMAGES = "/v1/images/generations"

  test("names the model and endpoint and lists the models that serve it", () => {
    const msg = adviseUpstreamError(400, COPILOT_BODY, {
      models: CATALOG,
      call: {
        endpoint: IMAGES,
        model: "gpt-6-luna-decisions",
      },
    })
    expect(msg).toStartWith(
      "`gpt-6-luna-decisions` doesn't support `/v1/images/generations` "
        + "(it serves `/v1/decisions`).\n\n"
        + "Models that do: `gpt-image-2.5-flare`.",
    )
    expect(msg).not.toContain("on your plan")
    expect(msg).toContain(
      "Upstream error (400): The requested model is not supported. "
        + "[model_not_supported]",
    )
  })

  test("applies to the inference endpoints, with variants dropped and ids as /v1/models shows them", () => {
    const codex = makeModel({
      id: "gpt-5.3-codex",
      name: "Codex",
      supported_endpoints: ["/responses"],
    })
    const sonnet = {
      ...SONNET,
      supported_endpoints: ["/v1/messages", "/chat/completions"],
    }
    const variant = makeModel({
      id: "claude-sonnet-4.5-high",
      name: "Sonnet (high)",
      supported_endpoints: ["/chat/completions"],
    })
    const msg = adviseUpstreamError(400, COPILOT_BODY, {
      models: [codex, sonnet, variant],
      call: {
        endpoint: "/chat/completions",
        model: "gpt-5.3-codex",
      },
    })
    expect(msg).toStartWith(
      "`gpt-5.3-codex` doesn't support `/chat/completions` (it serves `/responses`).",
    )
    expect(msg).toContain("Models that do: `claude-sonnet-4-5-20260301`.")
    expect(msg).not.toContain("high")
  })

  test("says so when no catalog model serves the endpoint", () => {
    const msg = adviseUpstreamError(400, COPILOT_BODY, {
      models: [SONNET, LUNA],
      call: {
        endpoint: IMAGES,
        model: "gpt-6-luna-decisions",
      },
    })
    expect(msg).toContain(
      "No model in your Copilot catalog supports `/v1/images/generations`.",
    )
  })

  test("caps a long list of alternatives", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      makeModel({
        id: `img-${i}`,
        name: `Img ${i}`,
        supported_endpoints: [IMAGES],
      }),
    )
    const msg = adviseUpstreamError(400, COPILOT_BODY, {
      models: [LUNA, ...many],
      call: {
        endpoint: IMAGES,
        model: "gpt-6-luna-decisions",
      },
    })
    expect(msg).toContain("`img-11` and 3 more.")
    expect(msg).not.toContain("`img-12`")
  })

  test("keeps the plan advice for a model the catalog doesn't have", () => {
    const call = { endpoint: IMAGES, model: "gpt-nowhere" }
    expect(
      adviseUpstreamError(400, COPILOT_BODY, { models: CATALOG, call }),
    ).toBe(adviseUpstreamError(400, COPILOT_BODY, { models: CATALOG }))
    expect(
      adviseUpstreamError(400, COPILOT_BODY, { models: CATALOG, call }),
    ).toContain("doesn't offer the requested model on your plan")
  })

  test("keeps the plan advice when the model lists the endpoint or lists none", () => {
    const plan = adviseUpstreamError(400, COPILOT_BODY, { models: CATALOG })
    expect(
      adviseUpstreamError(400, COPILOT_BODY, {
        models: CATALOG,
        call: {
          endpoint: IMAGES,
          model: "gpt-image-2.5-flare",
        },
      }),
    ).toBe(plan)
    // SONNET has no supported_endpoints: unknown, not wrong.
    expect(
      adviseUpstreamError(400, COPILOT_BODY, {
        models: CATALOG,
        call: {
          endpoint: IMAGES,
          model: "claude-sonnet-4.5",
        },
      }),
    ).toBe(plan)
    expect(
      adviseUpstreamError(400, COPILOT_BODY, {
        models: CATALOG,
        call: { endpoint: IMAGES },
      }),
    ).toBe(plan)
  })

  test("leaves other errors alone", () => {
    const call = { endpoint: IMAGES, model: "gpt-6-luna-decisions" }
    expect(
      adviseUpstreamError(403, COPILOT_BODY, { models: CATALOG, call }),
    ).toBeNull()
    const other = JSON.stringify({ error: { message: "bad prompt" } })
    expect(
      adviseUpstreamError(400, other, { models: CATALOG, call }),
    ).toBeNull()
  })
})

// --- forwardError integration ------------------------------------------------

interface Captured {
  body: unknown
  status: number
}

function makeContextStub(): {
  ctx: {
    json: (body: unknown, status?: number) => Response
    header: () => void
  }
  captured: Captured
} {
  const captured: Captured = { body: undefined, status: 0 }
  const ctx = {
    json(body: unknown, status?: number): Response {
      captured.body = body
      captured.status = status ?? 200
      return new Response(JSON.stringify(body), { status: status ?? 200 })
    },
    header(): void {},
  }
  return { ctx, captured }
}

function messageOf(captured: Captured): string {
  return (captured.body as { error: { message: string } }).error.message
}

describe("forwardError integration", () => {
  const snapshot = state.models

  beforeEach(() => {
    state.models = { object: "list", data: [SONNET] }
  })
  afterEach(() => {
    state.models = snapshot
  })

  test("model_not_supported 400: reframes but preserves the original error", async () => {
    const { ctx, captured } = makeContextStub()
    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      new HTTPError("nope", new Response(COPILOT_BODY, { status: 400 })),
    )

    expect(captured.status).toBe(400)
    const msg = messageOf(captured)
    expect(msg).toContain("/model")
    expect(msg).toContain("Claude Sonnet 4.5 (claude-sonnet-4-5-20260301)")
    expect(msg).toContain("Upstream error (400):")
    expect(msg).toContain("model_not_supported")
  })

  test("the HTTPError's call reaches the advice", async () => {
    state.models = {
      object: "list",
      data: [
        SONNET,
        makeModel({
          id: "gpt-6-luna-decisions",
          name: "Luna",
          supported_endpoints: ["/v1/decisions"],
        }),
      ],
    }
    const { ctx, captured } = makeContextStub()
    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      new HTTPError("nope", new Response(COPILOT_BODY, { status: 400 }), {
        endpoint: "/v1/systemone",
        model: "gpt-6-luna-decisions",
      }),
    )

    expect(captured.status).toBe(400)
    expect(messageOf(captured)).toStartWith(
      "`gpt-6-luna-decisions` doesn't support `/v1/systemone`",
    )
  })

  test("unrelated upstream errors forward verbatim", async () => {
    const { ctx, captured } = makeContextStub()
    await forwardError(
      ctx as unknown as Parameters<typeof forwardError>[0],
      new HTTPError("boom", new Response("upstream boom", { status: 500 })),
    )

    expect(captured.status).toBe(500)
    expect(messageOf(captured)).toBe("upstream boom")
  })
})
