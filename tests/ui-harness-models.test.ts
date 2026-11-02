import { expect, test } from "bun:test"

import { createMockBackend } from "../scripts/ui-harness-api"
import { resolveScenario } from "../scripts/ui-harness-fixtures"

test("the healthy harness derives every model count from the same catalog", () => {
  const scenario = resolveScenario("signed-in")
  expect(scenario.models.count).toBe(scenario.models.models.length)
  expect(scenario.diagnostics.models_cached).toBe(scenario.models.models.length)
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
    effective: "claude-sonnet-4-7",
    source: "automatic",
    reason: "sonnet",
  })
})
