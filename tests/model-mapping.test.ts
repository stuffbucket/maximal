import { describe, expect, it } from "bun:test"

import type { ModelMappingRule } from "~/lib/config/config"
import type { Model } from "~/services/copilot/get-models"

import {
  modelMappingErrorBody,
  resolveModelMapping,
} from "~/lib/models/model-mapping"

function makeModel(
  id: string,
  options: {
    enabled?: boolean
    endpoints?: Array<string>
  } = {},
): Model {
  return {
    id,
    name: id,
    version: id,
    vendor: "test",
    object: "model",
    preview: false,
    model_picker_enabled: options.enabled ?? true,
    supported_endpoints: options.endpoints ?? ["/responses"],
    capabilities: {
      family: id,
      limits: {},
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
  }
}

const models = [makeModel("gpt-5.6-luna"), makeModel("gpt-6-astra")]

function rule(
  type: "exact" | "glob" | "regex",
  value: string,
  target: string,
): ModelMappingRule {
  return { match: { type, value }, target }
}

describe("resolveModelMapping", () => {
  it.each([
    ["exact", "codex-auto-review", "codex-auto-review"],
    ["glob", "codex-*-review", "codex-auto-review"],
    ["regex", String.raw`^codex-[a-z]+-review$`, "codex-auto-review"],
  ] as const)("resolves a full-string %s match", (type, value, requested) => {
    expect(
      resolveModelMapping({
        requestedModel: requested,
        rules: [rule(type, value, "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toEqual({
      status: "resolved",
      requestedModel: requested,
      resolvedModel: "gpt-5.6-luna",
      model: models[0],
    })
  })

  it("requires glob and regex rules to match the complete ID", () => {
    expect(
      resolveModelMapping({
        requestedModel: "prefix-codex-auto-review-suffix",
        rules: [
          rule("glob", "codex-*-review", "gpt-5.6-luna"),
          rule("regex", "codex-auto-review", "gpt-5.6-luna"),
        ],
        models,
        endpoint: "/responses",
      }),
    ).toEqual({
      status: "unmatched",
      requestedModel: "prefix-codex-auto-review-suffix",
      resolvedModel: "prefix-codex-auto-review-suffix",
    })
  })

  it("treats glob question marks as one Unicode code point", () => {
    expect(
      resolveModelMapping({
        requestedModel: "review-🚀",
        rules: [rule("glob", "review-?", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "resolved", resolvedModel: "gpt-5.6-luna" })
    expect(
      resolveModelMapping({
        requestedModel: "review-ab",
        rules: [rule("glob", "review-?", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "unmatched" })
  })

  it("treats regex metacharacters in glob rules literally", () => {
    expect(
      resolveModelMapping({
        requestedModel: "review.+(final)",
        rules: [rule("glob", "review.+(final)", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "resolved" })
    expect(
      resolveModelMapping({
        requestedModel: "reviewZZfinal",
        rules: [rule("glob", "review.+(final)", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "unmatched" })
  })

  it("matches exact rules case-sensitively and treats glob syntax literally", () => {
    expect(
      resolveModelMapping({
        requestedModel: "Alias",
        rules: [rule("exact", "alias", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "unmatched" })
    expect(
      resolveModelMapping({
        requestedModel: "alias-value",
        rules: [rule("exact", "alias-*", "gpt-5.6-luna")],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "unmatched" })
  })

  it("uses only the first matching rule", () => {
    expect(
      resolveModelMapping({
        requestedModel: "codex-auto-review",
        rules: [
          rule("glob", "codex-*", "gpt-6-astra"),
          rule("exact", "codex-auto-review", "gpt-5.6-luna"),
        ],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "resolved", resolvedModel: "gpt-6-astra" })
  })

  it("does not recursively remap a target", () => {
    expect(
      resolveModelMapping({
        requestedModel: "codex-auto-review",
        rules: [
          rule("exact", "codex-auto-review", "gpt-5.6-luna"),
          rule("exact", "gpt-5.6-luna", "gpt-6-astra"),
        ],
        models,
        endpoint: "/responses",
      }),
    ).toMatchObject({ status: "resolved", resolvedModel: "gpt-5.6-luna" })
  })

  it.each([
    ["missing", [rule("exact", "alias", "missing")], models],
    [
      "disabled",
      [rule("exact", "alias", "disabled")],
      [...models, makeModel("disabled", { enabled: false })],
    ],
    [
      "unsupported-endpoint",
      [rule("exact", "alias", "chat-only")],
      [...models, makeModel("chat-only", { endpoints: ["/chat/completions"] })],
    ],
  ] as const)("rejects a matched %s target", (reason, rules, liveModels) => {
    expect(
      resolveModelMapping({
        requestedModel: "alias",
        rules: [...rules],
        models: [...liveModels],
        endpoint: "/responses",
      }),
    ).toEqual({
      status: "invalid-target",
      reason,
      requestedModel: "alias",
      resolvedModel: rules[0].target,
    })
  })

  it("returns a structured local error for an unavailable mapped target", () => {
    const result = resolveModelMapping({
      requestedModel: "review-alias",
      rules: [rule("exact", "review-alias", "missing-model")],
      models,
      endpoint: "/responses",
    })
    if (result.status !== "invalid-target") {
      throw new Error(`expected invalid target, got ${result.status}`)
    }

    expect(modelMappingErrorBody(result)).toEqual({
      error: {
        message:
          'Model mapping for "review-alias" targets unavailable model "missing-model".',
        type: "invalid_request_error",
      },
    })
  })

  it("rejects targets without endpoint metadata for fixed-wire ingress", () => {
    const target = makeModel("metadata-missing")
    delete target.supported_endpoints

    expect(
      resolveModelMapping({
        requestedModel: "alias",
        rules: [rule("exact", "alias", "metadata-missing")],
        models: [target],
        endpoint: "/responses",
      }),
    ).toEqual({
      status: "invalid-target",
      reason: "unsupported-endpoint",
      requestedModel: "alias",
      resolvedModel: "metadata-missing",
    })
  })

  it("allows endpoint-independent lookup for token counting", () => {
    const target = makeModel("chat-only", { endpoints: ["/chat/completions"] })
    expect(
      resolveModelMapping({
        requestedModel: "alias",
        rules: [rule("exact", "alias", "chat-only")],
        models: [target],
        endpoint: null,
      }),
    ).toEqual({
      status: "resolved",
      requestedModel: "alias",
      resolvedModel: "chat-only",
      model: target,
    })
  })
})
