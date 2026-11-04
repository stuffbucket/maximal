import { expect, test } from "bun:test"

import { createMockBackend } from "../scripts/ui-harness-api"

test("the signed-out harness exposes the remote quota auth contract", async () => {
  const backend = createMockBackend("signed-out")
  const response = await backend.handle(
    new Request("http://maximal.test/usage"),
  )

  expect(response?.status).toBe(401)
  expect(await response?.json()).toMatchObject({ error: "not_authenticated" })
})

test("the signed-out harness keeps local usage endpoints available", async () => {
  const backend = createMockBackend("signed-out")
  const [summary, sessions] = await Promise.all([
    backend.handle(new Request("http://maximal.test/token-usage")),
    backend.handle(new Request("http://maximal.test/token-usage/sessions")),
  ])

  expect(summary?.status).toBe(200)
  expect(sessions?.status).toBe(200)
})
