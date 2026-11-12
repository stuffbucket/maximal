import { expect, test } from "bun:test"

import { createMockBackend } from "../scripts/ui-harness-api"
import { resolveScenario } from "../scripts/ui-harness-fixtures"
import { modelTypeLabel } from "../shell/src/ui/features/models/model-type-label"
import { ModelsListResponse } from "../src/lib/config/settings-types"

test("the healthy harness derives every model count from the same catalog", () => {
  const scenario = resolveScenario("signed-in")
  expect(scenario.models.count).toBe(scenario.models.models.length)
  expect(scenario.diagnostics.models_cached).toBe(scenario.models.models.length)
  expect(scenario.models.claude_code_auto.fast.effective).toBe(
    "claude-haiku-5-5",
  )
  expect(scenario.models.claude_code_auto.capable.effective).toBe(
    "claude-sonnet-5-5",
  )
  expect(scenario.models.claude_code_auto.classifier.effective).toBe(
    "claude-haiku-5-5",
  )
  expect(Date.now() - Date.parse(scenario.models.loaded_at ?? "")).toBeLessThan(
    5 * 60 * 1000,
  )
})

test("the signed-in fixture covers every current catalog model type", () => {
  const parsed = ModelsListResponse.parse(resolveScenario("signed-in").models)
  expect([...new Set(parsed.models.map((model) => model.type))]).toEqual([
    "chat",
    "decisions",
    "embeddings",
    "image",
  ])
  const ids = parsed.models.map((model) => model.id)
  for (const id of [
    "gpt-6-luna-decisions",
    "microsoft-decision-1",
    "gpt-image-2.5-flare",
  ]) {
    expect(ids).toContain(id)
  }
  for (const capability of [
    "vision",
    "tool_calls",
    "streaming",
    "reasoning",
  ] as const) {
    expect(parsed.models.some((model) => model.capabilities[capability])).toBe(
      true,
    )
    expect(parsed.models.some((model) => !model.capabilities[capability])).toBe(
      true,
    )
  }
})

test("model type labels stay readable for provider additions", () => {
  expect(modelTypeLabel("decisions")).toBe("Decision models")
  expect(modelTypeLabel("image")).toBe("Image models")
  expect(modelTypeLabel("future_model_kind")).toBe("Future model kind")
  expect(modelTypeLabel(" ")).toBe("Other models")
})

test("the harness rejects model choices production rejects", async () => {
  const backend = createMockBackend("signed-in")
  const response = await backend.handle(
    new Request("http://maximal.test/settings/api/models/claude-code-auto", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fast: "does-not-exist" }),
    }),
  )
  expect(response?.status).toBe(400)
})

test("the harness uses classifier-specific options", async () => {
  const backend = createMockBackend("signed-in")
  const response = await backend.handle(
    new Request("http://maximal.test/settings/api/models/claude-code-auto", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ classifier: "claude-sonnet-5-5" }),
    }),
  )
  expect(response?.status).toBe(400)
})

test("the harness uses the catalog reason when Automatic is restored", async () => {
  const backend = createMockBackend("signed-in")
  const response = await backend.handle(
    new Request("http://maximal.test/settings/api/models/claude-code-auto", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capable: null }),
    }),
  )
  const body = (await response?.json()) as ReturnType<
    typeof resolveScenario
  >["models"]
  expect(body.claude_code_auto.capable).toMatchObject({
    effective: "claude-sonnet-5-5",
    source: "automatic",
    reason: "sonnet",
  })
})
